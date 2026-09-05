import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  legacyAmountToMoney,
  refundFingerprint,
} from "../../src/mastra/lib/money";
import type { ProviderBinding } from "../../src/mastra/providers/contracts";
import {
  deterministicJsonModel,
  deterministicRefundModel,
} from "../fixtures/deterministic-language-model";

const databaseFiles: string[] = [];
const mastraRuntimes: Array<{ shutdown(): Promise<void> }> = [];

async function loadCharacterizationRuntime(draft: {
  recommendRefund: boolean;
  requiresEscalation: boolean;
  refundAmount?: number;
}) {
  const databasePath = `/private/tmp/phase001-characterization-${crypto.randomUUID()}.db`;
  databaseFiles.push(
    databasePath,
    `${databasePath}-shm`,
    `${databasePath}-wal`,
  );
  process.env.TURSO_DATABASE_URL = `file:${databasePath}`;
  process.env.SUPPORT_SOURCE = "mock";
  process.env.PHASE003_DISABLE_EVALS = "1";
  vi.resetModules();
  vi.doMock("@mastra/core/llm", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@mastra/core/llm")>();
    return {
      ...actual,
      ModelRouterEmbeddingModel: class DeterministicEmbeddingModel {
        async doEmbed({ values }: { values: string[] }) {
          return {
            embeddings: values.map(() => Array.from({ length: 1536 }, () => 0)),
          };
        }
      },
    };
  });

  // index loads the provider registry through a circular workflow graph. Load
  // that graph before its leaves so vi.resetModules cannot expose a partially
  // initialized local-runtime export to a concurrent dynamic import.
  const { mastra } = await import("../../src/mastra/index");
  const { caseStore } = await import("../../src/mastra/lib/case-store");
  const { mockSupportAdapter } =
    await import("../../src/mastra/integrations/mock-support");
  const { triageAgent } = await import("../../src/mastra/agents/triage-agent");
  const { responseAgent } =
    await import("../../src/mastra/agents/response-agent");
  const { issueRefundTool } =
    await import("../../src/mastra/tools/issue-refund");
  const { refundExecutionAgent } =
    await import("../../src/mastra/agents/refund-execution-agent");

  triageAgent.__updateModel({
    model: deterministicJsonModel({
      intent: "duplicate_charge",
      urgency: "normal",
      sentiment: "negative",
      requiresHumanReview: draft.recommendRefund,
      confidence: 1,
      rationale: "Deterministic characterization double.",
    }),
  });
  responseAgent.__updateModel({
    model: deterministicJsonModel({
      draftResponse:
        "A deterministic response grounded in the duplicate-charge policy.",
      citedSources: ["duplicate-charge-policy"],
      recommendRefund: draft.recommendRefund,
      refundAmount: draft.refundAmount,
      refundCurrency: draft.recommendRefund ? "USD" : undefined,
      refundReason: draft.recommendRefund ? "duplicate charge" : undefined,
      requiresEscalation: draft.requiresEscalation,
      escalationReason: draft.requiresEscalation
        ? "Deterministic escalation."
        : undefined,
    }),
  });

  const normalized = await mockSupportAdapter.normalizeInbound({
    externalId: `characterization-${crypto.randomUUID()}`,
    from: "alex@example.com",
    subject: "I was charged twice",
    body: "Please refund the duplicate subscription charge.",
  });
  const runId = `characterization-run-${crypto.randomUUID()}`;
  const accepted = await caseStore.acceptInbound(
    { id: `case_${crypto.randomUUID()}`, status: "new", ...normalized },
    `event_${crypto.randomUUID()}`,
    runId,
  );
  const supportCase = await caseStore.get(accepted.caseId);
  if (!supportCase) throw new Error("Expected accepted support case.");
  const [turn] = await caseStore.turns(supportCase.id);
  if (!turn) throw new Error("Expected an immutable inbound turn.");
  await caseStore.update(supportCase.id, {
    workflowRunId: runId,
    metadata: { ...supportCase.metadata, activeTurnId: turn.id },
  });
  const executionModel = async () => {
    const action = await caseStore.getClientForTests().execute({
      sql: "SELECT data FROM support_actions WHERE kind = 'refund-command' ORDER BY created_at DESC LIMIT 1",
    });
    const command = JSON.parse(String(action.rows[0]?.data ?? "{}")) as {
      approvalCaseId?: string;
      orderId?: string;
      amount?: { minor?: number; currency?: string };
      reason?: string;
      idempotencyKey?: string;
      fingerprint?: string;
    };
    return deterministicRefundModel({
      caseId: command.approvalCaseId,
      orderId: command.orderId,
      amount: (command.amount?.minor ?? 0) / 100,
      currency: command.amount?.currency,
      reason: command.reason,
      idempotencyKey: command.idempotencyKey,
      fingerprint: command.fingerprint,
    }) as never;
  };
  refundExecutionAgent.__updateModel({ model: executionModel });
  mastra.getAgent("refundExecutionAgent").__updateModel({
    model: executionModel,
  });
  mastraRuntimes.push(mastra);

  return {
    mastra,
    caseStore,
    supportCase,
    issueRefundTool,
  };
}

async function startQueuedWorkflow(
  runtime: Awaited<ReturnType<typeof loadCharacterizationRuntime>>,
) {
  const { recoverLocalWorkflows } =
    await import("../../src/mastra/runtime/local-runtime");
  expect(
    await recoverLocalWorkflows(runtime.mastra, 10, runtime.caseStore),
  ).toBe(1);
  const supportCase = await runtime.caseStore.get(runtime.supportCase.id);
  expect(supportCase).toMatchObject({ status: "waiting_approval" });
  return supportCase!;
}

async function decideNativeApproval(
  runtime: Awaited<ReturnType<typeof loadCharacterizationRuntime>>,
  approved: boolean,
) {
  const supportCase = await runtime.caseStore.get(runtime.supportCase.id);
  if (!supportCase) throw new Error("Expected a suspended support case.");
  const native = (supportCase.metadata as Record<string, unknown>)
    .nativeApproval as {
    runId?: string;
    toolCallId?: string;
    turnId?: string;
    fingerprint?: string;
  };
  if (
    !native?.runId ||
    !native.toolCallId ||
    !native.turnId ||
    !native.fingerprint
  )
    throw new Error("Expected a native approval binding.");
  const decision = await runtime.caseStore.recordApprovalDecision({
    caseId: runtime.supportCase.id,
    turnId: native.turnId,
    commandFingerprint: native.fingerprint,
    principalId: "approver-demo",
    approved,
    nativeRunId: native.runId,
    nativeToolCallId: native.toolCallId,
  });
  expect(decision.won).toBe(true);
  const { recoverApprovedNativeDecisions } =
    await import("../../src/mastra/runtime/local-runtime");
  expect(
    await recoverApprovedNativeDecisions(runtime.mastra, runtime.caseStore, {
      disableScorers: true,
    }),
  ).toBe(1);
}

afterEach(async () => {
  await Promise.all(
    mastraRuntimes.splice(0).map((runtime) => runtime.shutdown()),
  );
  vi.restoreAllMocks();
  vi.doUnmock("@mastra/core/llm");
  await Promise.all(
    databaseFiles.splice(0).map((file) => rm(file, { force: true })),
  );
});

describe("resolve support case WIP characterization", () => {
  it("recovers a pre-start dispatch through the installed Mastra run API", async () => {
    const { mastra, caseStore, supportCase } =
      await loadCharacterizationRuntime({
        recommendRefund: true,
        requiresEscalation: false,
        refundAmount: 49,
      });
    const caseId = `recovery_${crypto.randomUUID()}`;
    const runId = `run_${crypto.randomUUID()}`;
    await caseStore.acceptInbound(
      {
        ...supportCase,
        id: caseId,
        externalId: `recovery-event-${crypto.randomUUID()}`,
        messages: supportCase.messages.map((message) => ({
          ...message,
          id: `message_${crypto.randomUUID()}`,
        })),
      },
      `event_${crypto.randomUUID()}`,
      runId,
    );
    const { recoverLocalWorkflows } =
      await import("../../src/mastra/runtime/local-runtime");
    await recoverLocalWorkflows(mastra, 10, caseStore);
    expect(
      await mastra
        .getWorkflow("resolveSupportCaseWorkflow")
        .getWorkflowRunById(runId),
    ).toMatchObject({ status: "suspended" });
    const dispatch = await caseStore.getClientForTests().execute({
      sql: "SELECT state FROM support_dispatch WHERE case_id = ?",
      args: [caseId],
    });
    expect(dispatch.rows[0]).toMatchObject({ state: "suspended" });
  });

  it("suspends a refund recommendation, then resolves after the existing workflow approval checkpoint", async () => {
    const runtime = await loadCharacterizationRuntime({
      recommendRefund: true,
      requiresEscalation: false,
      refundAmount: 49,
    });
    const { caseStore, supportCase } = runtime;
    const suspended = await startQueuedWorkflow(runtime);
    expect(
      (await caseStore.get(supportCase.id))?.policyMatches?.[0]?.source,
    ).toBe("duplicate-charge-policy");
    expect(
      (suspended.metadata as Record<string, unknown>).nativeApproval,
    ).toBeDefined();

    await decideNativeApproval(runtime, true);
    expect(await caseStore.get(supportCase.id)).toMatchObject({
      status: "resolved",
      approval: { approved: true, approverId: "approver-demo" },
      refundResult: { amount: 49, status: "executed" },
    });
  });

  it("escalates when the existing approval checkpoint is rejected", async () => {
    const runtime = await loadCharacterizationRuntime({
      recommendRefund: true,
      requiresEscalation: false,
      refundAmount: 49,
    });
    const { caseStore, supportCase } = runtime;
    await startQueuedWorkflow(runtime);
    await decideNativeApproval(runtime, false);
    expect(await caseStore.get(supportCase.id)).toMatchObject({
      status: "escalated",
      approval: { approved: false, approverId: "approver-demo" },
    });
  });

  it("rejects a direct refund-tool bypass before approval and refuses a tampered persisted command after approval", async () => {
    const runtime = await loadCharacterizationRuntime({
      recommendRefund: true,
      requiresEscalation: false,
      refundAmount: 49,
    });
    const { caseStore, issueRefundTool, supportCase } = runtime;
    const suspended = await startQueuedWorkflow(runtime);
    expect(suspended).toBeDefined();
    if (!suspended) throw new Error("Expected workflow to suspend the case.");
    const command = (suspended.metadata as Record<string, unknown>)
      .refundCommand as {
      orderId: string;
      amount: number;
      currency: string;
      reason: string;
      idempotencyKey: string;
      fingerprint: string;
    };
    await expect(
      issueRefundTool.execute({ caseId: supportCase.id, ...command }),
    ).rejects.toThrow("persisted approved local decision");
    await caseStore.update(supportCase.id, {
      metadata: {
        ...suspended.metadata,
        refundCommand: {
          ...command,
          amount: command.amount - 1,
          fingerprint: refundFingerprint({
            binding: (
              suspended.metadata.providerBindings as {
                transactions: ProviderBinding;
              }
            ).transactions,
            approvalCaseId: supportCase.id,
            orderId: command.orderId,
            amount: legacyAmountToMoney(command.amount - 1, command.currency),
            reason: command.reason,
            idempotencyKey: command.idempotencyKey,
          }),
        },
      },
    });
    await decideNativeApproval(runtime, true);
    expect((await caseStore.get(supportCase.id))?.refundResult).toBeUndefined();
  });

  it("marks a detached workflow start failed when its refund quote exceeds the remaining balance", async () => {
    const runtime = await loadCharacterizationRuntime({
      recommendRefund: true,
      requiresEscalation: false,
      refundAmount: 49,
    });
    const { mastra, caseStore } = runtime;
    await startQueuedWorkflow(runtime);
    await decideNativeApproval(runtime, true);

    const payload = {
      externalId: `exhausted-balance-${crypto.randomUUID()}`,
      from: "alex@example.com",
      subject: "I was charged twice again",
      body: "Please refund the duplicate subscription charge.",
    };
    const ingested = await (
      await mastra.getWorkflow("ingestSupportCaseWorkflow").createRun()
    ).start({ inputData: { payload } });

    expect(ingested.status).toBe("success");
    await vi.waitFor(async () => {
      expect(await caseStore.get(ingested.result.caseId)).toMatchObject({
        status: "failed",
        escalationReason: "Workflow start failed.",
      });
    });
    const dispatch = await caseStore.getClientForTests().execute({
      sql: "SELECT state FROM support_dispatch WHERE case_id = ?",
      args: [ingested.result.caseId],
    });
    expect(dispatch.rows[0]).toMatchObject({ state: "failed" });
  });

  it("escalates a deterministic policy decision that does not require a refund", async () => {
    const { mastra, caseStore, supportCase } =
      await loadCharacterizationRuntime({
        recommendRefund: false,
        requiresEscalation: true,
      });
    const run = await mastra
      .getWorkflow("resolveSupportCaseWorkflow")
      .createRun({ runId: supportCase.workflowRunId!, disableScorers: true });

    const result = await run.start({ inputData: { caseId: supportCase.id } });

    expect(result.status).toBe("success");
    expect(await caseStore.get(supportCase.id)).toMatchObject({
      status: "escalated",
      escalationReason: "Deterministic escalation.",
    });
  });

  it("reports a failed workflow when the deterministic triage transport returns an invalid result", async () => {
    const { mastra, supportCase } = await loadCharacterizationRuntime({
      recommendRefund: false,
      requiresEscalation: false,
    });
    const { triageAgent } =
      await import("../../src/mastra/agents/triage-agent");
    triageAgent.__updateModel({ model: deterministicJsonModel({}) });
    const run = await mastra
      .getWorkflow("resolveSupportCaseWorkflow")
      .createRun({ runId: supportCase.workflowRunId!, disableScorers: true });

    const result = await run.start({ inputData: { caseId: supportCase.id } });

    expect(result.status).toBe("failed");
  });

  it("persists an inbound case once and returns the same case for a duplicate event", async () => {
    const { mastra, caseStore } = await loadCharacterizationRuntime({
      recommendRefund: false,
      requiresEscalation: false,
    });
    const workflow = mastra.getWorkflow("ingestSupportCaseWorkflow");
    const payload = {
      externalId: `ingest-${crypto.randomUUID()}`,
      from: "alex@example.com",
      subject: "I was charged twice",
      body: "Please refund the duplicate subscription charge.",
    };

    const [first, second] = await Promise.all([
      (await workflow.createRun()).start({ inputData: { payload } }),
      (await workflow.createRun()).start({ inputData: { payload } }),
    ]);

    expect(first.status).toBe("success");
    expect(second.status).toBe("success");
    expect(first.result.caseId).toBe(second.result.caseId);
    expect(
      (await caseStore.list()).filter(
        (supportCase) => supportCase.externalId === payload.externalId,
      ),
    ).toHaveLength(1);
    await vi.waitFor(async () => {
      expect((await caseStore.get(first.result.caseId))?.status).toBe(
        "resolved",
      );
      expect(
        (
          await caseStore.getClientForTests().execute({
            sql: "SELECT state FROM support_dispatch WHERE case_id = ?",
            args: [first.result.caseId],
          })
        ).rows[0],
      ).toMatchObject({ state: "completed" });
    });
  });
});
