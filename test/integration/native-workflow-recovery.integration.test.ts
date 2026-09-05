import type { LanguageModelV2 } from "@ai-sdk/provider";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rm } from "node:fs/promises";

const files: string[] = [];
const runtimes: Array<{ shutdown(): Promise<void> }> = [];

function jsonModel(value: Record<string, unknown>): LanguageModelV2 {
  return {
    specificationVersion: "v2",
    provider: "phase003-test",
    modelId: "deterministic-json",
    supportedUrls: {},
    async doGenerate() {
      return {
        content: [{ type: "text" as const, text: JSON.stringify(value) }],
        finishReason: "stop" as const,
        usage: { inputTokens: 1, outputTokens: 1 },
        warnings: [],
      };
    },
    async doStream() {
      throw new Error(
        "This deterministic integration model only supports generate.",
      );
    },
  };
}

function refundModel(input: Record<string, unknown>): LanguageModelV2 {
  let called = false;
  return {
    specificationVersion: "v2",
    provider: "phase003-test",
    modelId: "deterministic-refund",
    supportedUrls: {},
    async doGenerate(options) {
      if (!called && options.tools?.some((tool) => tool.type === "function")) {
        called = true;
        return {
          content: [
            {
              type: "tool-call" as const,
              toolCallId: "native-tool-call",
              toolName: "issue_refund",
              input: JSON.stringify(input),
            },
          ],
          finishReason: "tool-calls" as const,
          usage: { inputTokens: 1, outputTokens: 1 },
          warnings: [],
        };
      }
      return {
        content: [{ type: "text" as const, text: "done" }],
        finishReason: "stop" as const,
        usage: { inputTokens: 1, outputTokens: 1 },
        warnings: [],
      };
    },
    async doStream() {
      throw new Error(
        "This deterministic integration model only supports generate.",
      );
    },
  };
}

async function setup(
  caseId: string,
  configuredBinding?: {
    tenantId: string;
    providerKind: "local";
    providerAccountId: string;
    externalConversationId: string;
  },
) {
  const path = `/private/tmp/phase003-native-workflow-${crypto.randomUUID()}.db`;
  files.push(path, `${path}-shm`, `${path}-wal`);
  process.env.TURSO_DATABASE_URL = `file:${path}`;
  process.env.SUPPORT_SOURCE = "mock";
  vi.resetModules();
  // Evaluators are not the subject of this recovery test.  Remove their
  // registered scorer boundary before constructing the real agents so a
  // workflow run cannot invoke the production judge model.
  vi.doMock("../../src/mastra/evals", () => ({
    responseAgentScorers: {},
    triageAgentScorers: {},
    supportEvalScorerRegistry: {},
  }));

  const { mastra } = await import("../../src/mastra/index");
  runtimes.push(mastra);
  const { caseStore } = await import("../../src/mastra/lib/case-store");
  const { defaultLocalBinding, localRuntime, recoverApprovedNativeDecisions } =
    await import("../../src/mastra/runtime/local-runtime");
  const { triageAgent } = await import("../../src/mastra/agents/triage-agent");
  const { responseAgent } =
    await import("../../src/mastra/agents/response-agent");
  const { refundExecutionAgent } =
    await import("../../src/mastra/agents/refund-execution-agent");

  // These spies replace only the provider transport. The registered Agents,
  // native approval snapshot, tool execution, workflow suspension and resume
  // all run through installed Mastra code.
  triageAgent.__updateModel({
    model: jsonModel({
      intent: "duplicate_charge",
      urgency: "normal",
      sentiment: "negative",
      requiresHumanReview: true,
      confidence: 1,
      rationale: "Deterministic duplicate-charge triage.",
    }) as never,
  });
  responseAgent.__updateModel({
    model: jsonModel({
      draftResponse: "We will process the duplicate-charge refund.",
      citedSources: ["duplicate-charge-policy"],
      recommendRefund: true,
      refundAmount: 20,
      refundCurrency: "USD",
      refundReason: "duplicate charge",
      requiresEscalation: false,
    }) as never,
  });

  const binding =
    configuredBinding ?? defaultLocalBinding(`conversation-${caseId}`);
  await localRuntime.seed(binding);
  if (configuredBinding) {
    const { registerProviderRegistry } =
      await import("../../src/mastra/providers/registry");
    const { createLocalLoopbackFacade, LoopbackHttpProviderRegistry } =
      await import("../../src/mastra/providers/loopback-http");
    registerProviderRegistry(
      new LoopbackHttpProviderRegistry(createLocalLoopbackFacade(localRuntime)),
      [binding],
    );
  }
  const createdAt = new Date().toISOString();
  await caseStore.acceptInbound(
    {
      id: caseId,
      externalId: `event-${caseId}`,
      source: "mock-email",
      customer: { email: "alex@example.com" },
      subject: "I was charged twice",
      messages: [
        {
          id: `message-${caseId}`,
          author: "customer",
          body: "Please refund the duplicate charge.",
          createdAt,
        },
      ],
      status: "new",
      createdAt,
      updatedAt: createdAt,
      metadata: { providerBinding: binding, ownerId: "customer-alex" },
    },
    `event-${caseId}`,
    `workflow-${caseId}`,
  );
  const executionModel = async () => {
    const action = await caseStore.getClientForTests().execute({
      sql: "SELECT data FROM support_actions WHERE case_id = ? AND kind = 'refund-command'",
      args: [caseId],
    });
    const command = JSON.parse(String(action.rows[0]?.data ?? "{}")) as {
      idempotencyKey?: string;
      fingerprint?: string;
    };
    const input = {
      caseId,
      orderId: "ORD-1001",
      amount: 20,
      currency: "USD",
      reason: "duplicate charge",
      idempotencyKey: command.idempotencyKey,
      fingerprint: command.fingerprint,
    };
    return refundModel(input) as never;
  };
  refundExecutionAgent.__updateModel({ model: executionModel });
  // Workflows obtain this restricted agent through the Mastra registry.
  mastra.getAgent("refundExecutionAgent").__updateModel({
    model: executionModel,
  });

  const dispatch = await caseStore.claimDispatchForStart(
    caseId,
    `workflow-${caseId}`,
  );
  if (!dispatch) throw new Error("Expected the initial workflow dispatch.");
  await caseStore.markDispatchStarted(dispatch.id, dispatch.leaseToken);
  await caseStore.update(caseId, {
    workflowRunId: `workflow-${caseId}`,
    metadata: {
      ...((await caseStore.get(caseId))!.metadata as Record<string, unknown>),
      activeTurnId: dispatch.turnId,
    },
  });
  const initialRun = await mastra
    .getWorkflow("resolveSupportCaseWorkflow")
    .createRun({ runId: `workflow-${caseId}`, disableScorers: true });
  const initial = await initialRun.start({ inputData: { caseId } });
  await caseStore.completeDispatch(
    dispatch.id,
    initial.status === "suspended" ? "suspended" : "completed",
    undefined,
    dispatch.leaseToken,
  );
  const supportCase = await caseStore.get(caseId);
  expect(supportCase).toMatchObject({ status: "waiting_approval" });
  const native = (supportCase!.metadata as Record<string, unknown>)
    .nativeApproval as {
    runId: string;
    toolCallId: string;
    fingerprint: string;
    turnId: string;
  };
  expect(native).toMatchObject({
    runId: expect.any(String),
    toolCallId: expect.any(String),
    fingerprint: expect.any(String),
    turnId: expect.any(String),
  });
  return {
    binding,
    caseStore,
    mastra,
    native,
    recoverApprovedNativeDecisions,
  };
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.shutdown()));
  vi.doUnmock("../../src/mastra/evals");
  vi.restoreAllMocks();
  await Promise.all(files.splice(0).map((file) => rm(file, { force: true })));
});

describe("native approval workflow recovery", () => {
  it("automatically recovers a durable approval before native resume exactly once", async () => {
    const caseId = `decision-crash-${crypto.randomUUID()}`;
    const {
      binding,
      caseStore,
      mastra,
      native,
      recoverApprovedNativeDecisions,
    } = await setup(caseId);
    const decision = await caseStore.recordApprovalDecision({
      caseId,
      turnId: native.turnId,
      commandFingerprint: native.fingerprint,
      principalId: "approver-demo",
      approved: true,
      nativeRunId: native.runId,
      nativeToolCallId: native.toolCallId,
    });
    expect(decision.won).toBe(true);

    expect(
      await recoverApprovedNativeDecisions(mastra, caseStore, {
        disableScorers: true,
      }),
    ).toBe(1);
    expect(
      await recoverApprovedNativeDecisions(mastra, caseStore, {
        disableScorers: true,
      }),
    ).toBe(0);
    expect(await localRefundCount(caseStore)).toBe(1);
    expect(
      await caseStore.approvalDecision(caseId, native.turnId),
    ).toMatchObject({
      approved: true,
      commandFingerprint: native.fingerprint,
    });
    expect(await caseStore.get(caseId)).toMatchObject({
      status: "resolved",
      refundResult: { amount: 20, status: "executed" },
    });
    expect(
      (
        await import("../../src/mastra/runtime/local-runtime")
      ).localRuntime.refunds(binding, "ORD-1001"),
    ).resolves.toHaveLength(1);
  });

  it("reuses a durable effect after a crash before workflow completion", async () => {
    const caseId = `effect-crash-${crypto.randomUUID()}`;
    const { caseStore, mastra, native, recoverApprovedNativeDecisions } =
      await setup(caseId);
    await caseStore.recordApprovalDecision({
      caseId,
      turnId: native.turnId,
      commandFingerprint: native.fingerprint,
      principalId: "approver-demo",
      approved: true,
      nativeRunId: native.runId,
      nativeToolCallId: native.toolCallId,
    });
    // This is the actual native Agent transition and financial tool execution;
    // intentionally omit workflow.resume to model a process crash in between.
    await mastra.getAgent("refundExecutionAgent").approveToolCallGenerate({
      runId: native.runId,
      toolCallId: native.toolCallId,
    });
    expect(await localRefundCount(caseStore)).toBe(1);

    expect(
      await recoverApprovedNativeDecisions(mastra, caseStore, {
        disableScorers: true,
      }),
    ).toBe(1);
    expect(
      await recoverApprovedNativeDecisions(mastra, caseStore, {
        disableScorers: true,
      }),
    ).toBe(0);
    expect(await localRefundCount(caseStore)).toBe(1);
    expect(await caseStore.get(caseId)).toMatchObject({
      status: "resolved",
      refundResult: { status: "executed", amount: 20 },
    });
  });

  it("recovers a durable rejection without creating a financial effect", async () => {
    const caseId = `decline-crash-${crypto.randomUUID()}`;
    const {
      binding,
      caseStore,
      mastra,
      native,
      recoverApprovedNativeDecisions,
    } = await setup(caseId);
    await caseStore.recordApprovalDecision({
      caseId,
      turnId: native.turnId,
      commandFingerprint: native.fingerprint,
      principalId: "approver-demo",
      approved: false,
      nativeRunId: native.runId,
      nativeToolCallId: native.toolCallId,
    });

    expect(
      await recoverApprovedNativeDecisions(mastra, caseStore, {
        disableScorers: true,
      }),
    ).toBe(1);
    expect(
      await recoverApprovedNativeDecisions(mastra, caseStore, {
        disableScorers: true,
      }),
    ).toBe(0);
    expect(await localRefundCount(caseStore)).toBe(0);
    expect(
      await (
        await import("../../src/mastra/runtime/local-runtime")
      ).localRuntime.refunds(binding, "ORD-1001"),
    ).toEqual([]);
    expect(await caseStore.get(caseId)).toMatchObject({
      status: "escalated",
      approval: { approved: false, approverId: "approver-demo" },
    });
  });

  it("refuses a cross-tenant command or a non-approver at the financial boundary", async () => {
    const caseId = `effect-denial-${crypto.randomUUID()}`;
    const { caseStore, native } = await setup(caseId);
    await caseStore.recordApprovalDecision({
      caseId,
      turnId: native.turnId,
      commandFingerprint: native.fingerprint,
      principalId: "approver-demo",
      approved: true,
      nativeRunId: native.runId,
      nativeToolCallId: native.toolCallId,
    });
    const command = (await caseStore.getAction(
      caseId,
      "refund-command",
      native.fingerprint,
    )) as {
      approvalCaseId: string;
      binding: {
        tenantId: string;
        providerKind: "local";
        providerAccountId: string;
        externalConversationId: string;
      };
      orderId: string;
      amount: { currency: string; minor: number };
      reason: string;
      idempotencyKey: string;
      fingerprint: string;
    };
    const { refundFingerprint } = await import("../../src/mastra/lib/money");
    const { localRuntime } =
      await import("../../src/mastra/runtime/local-runtime");
    await expect(
      localRuntime.issueRefund({ ...command, fingerprint: "tampered" }),
    ).rejects.toThrow("fingerprint was tampered with");
    const crossTenant = {
      ...command,
      binding: { ...command.binding, tenantId: "other-tenant" },
    };
    crossTenant.fingerprint = refundFingerprint(crossTenant);
    await expect(localRuntime.issueRefund(crossTenant)).rejects.toThrow(
      "approved native refund tool context",
    );

    const persisted = await caseStore.get(caseId);
    await caseStore.update(caseId, {
      metadata: {
        ...persisted!.metadata,
        nativeApproval: {
          ...((persisted!.metadata as Record<string, unknown>)
            .nativeApproval as Record<string, unknown>),
          toolCallId: "stale-tool-call",
        },
      },
    });
    await expect(localRuntime.issueRefund(command)).rejects.toThrow(
      "approved native refund tool context",
    );

    await caseStore.getClientForTests().execute({
      sql: "UPDATE support_decisions SET principal_id = ? WHERE case_id = ? AND turn_id = ?",
      args: ["support-agent-demo", caseId, native.turnId],
    });
    await expect(localRuntime.issueRefund(command)).rejects.toThrow(
      "approved native refund tool context",
    );
    expect(await localRefundCount(caseStore)).toBe(0);
  });

  it("does not treat durable approval metadata as direct tool or HTTP authority", async () => {
    const caseId = `native-context-${crypto.randomUUID()}`;
    const binding = {
      tenantId: "local-demo",
      providerKind: "local" as const,
      providerAccountId: `loopback-${caseId}`,
      externalConversationId: `conversation-${caseId}`,
    };
    const { caseStore, mastra, native } = await setup(caseId, binding);
    const { createLocalLoopbackFacade, LoopbackHttpProviderRegistry } =
      await import("../../src/mastra/providers/loopback-http");
    const { localRuntime } =
      await import("../../src/mastra/runtime/local-runtime");
    const { issueRefundTool } =
      await import("../../src/mastra/tools/issue-refund");
    await caseStore.recordApprovalDecision({
      caseId,
      turnId: native.turnId,
      commandFingerprint: native.fingerprint,
      principalId: "approver-demo",
      approved: true,
      nativeRunId: native.runId,
      nativeToolCallId: native.toolCallId,
    });
    const command = (await caseStore.getAction(
      caseId,
      "refund-command",
      native.fingerprint,
    )) as {
      orderId: string;
      amount: { currency: string; minor: number };
      reason: string;
      idempotencyKey: string;
      fingerprint: string;
      binding: typeof binding;
      approvalCaseId: string;
    };
    const input = {
      caseId,
      orderId: command.orderId,
      amount: command.amount.minor / 100,
      currency: command.amount.currency,
      reason: command.reason,
      idempotencyKey: command.idempotencyKey,
      fingerprint: command.fingerprint,
    };
    await expect(issueRefundTool.execute!(input, {} as never)).rejects.toThrow(
      "approved native refund agent tool context",
    );
    const loopback = new LoopbackHttpProviderRegistry(
      createLocalLoopbackFacade(localRuntime),
    );
    await expect(
      loopback.transactions(binding).issueRefund(command),
    ).rejects.toThrow("missing or invalid native refund authorization");
    expect(await localRefundCount(caseStore)).toBe(0);

    // The same configured HTTP adapter accepts only the authorization created
    // by Mastra while it executes the approved native tool call.
    await mastra.getAgent("refundExecutionAgent").approveToolCallGenerate({
      runId: native.runId,
      toolCallId: native.toolCallId,
    });
    expect(await localRefundCount(caseStore)).toBe(1);
  });

  it("does not reconcile an effect with the wrong immutable fingerprint", async () => {
    const caseId = `effect-mismatch-${crypto.randomUUID()}`;
    const { caseStore, mastra, native, recoverApprovedNativeDecisions } =
      await setup(caseId);
    await caseStore.recordApprovalDecision({
      caseId,
      turnId: native.turnId,
      commandFingerprint: native.fingerprint,
      principalId: "approver-demo",
      approved: true,
      nativeRunId: native.runId,
      nativeToolCallId: native.toolCallId,
    });
    const command = (await caseStore.getAction(
      caseId,
      "refund-command",
      native.fingerprint,
    )) as { idempotencyKey: string };
    await caseStore.recordEffect(command.idempotencyKey, "wrong-fingerprint", {
      refundId: "wrong-effect",
    });

    expect(
      await recoverApprovedNativeDecisions(mastra, caseStore, {
        disableScorers: true,
      }),
    ).toBe(0);
    expect(await localRefundCount(caseStore)).toBe(0);
    expect(await caseStore.get(caseId)).toMatchObject({ status: "failed" });
  });
});

async function localRefundCount(caseStore: {
  getClientForTests(): { execute(sql: string): Promise<{ rows: unknown[] }> };
}) {
  const result = await caseStore
    .getClientForTests()
    .execute("SELECT COUNT(*) AS total FROM local_refunds");
  return Number((result.rows[0] as { total?: number }).total ?? 0);
}
