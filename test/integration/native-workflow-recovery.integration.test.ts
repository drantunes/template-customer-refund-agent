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
  loopbackFailure?: (
    request: Request,
  ) => "timeout" | "429" | "500" | "drop-after-commit" | undefined,
  refund?: { amount: number; currency: string },
  options?: { deferInitialWorkflow?: boolean },
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
  const {
    defaultLocalBinding,
    localRuntime,
    purgeExpiredWorkflowSnapshots,
    recoverApprovedNativeDecisions,
  } = await import("../../src/mastra/runtime/local-runtime");
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
  const refundAmount = refund?.amount ?? 20;
  const refundCurrency = refund?.currency ?? "USD";
  responseAgent.__updateModel({
    model: jsonModel({
      draftResponse: "We will process the duplicate-charge refund.",
      citedSources: ["duplicate-charge-policy"],
      recommendRefund: true,
      refundAmount,
      refundCurrency,
      refundReason: "duplicate charge",
      requiresEscalation: false,
    }) as never,
  });

  const binding =
    configuredBinding ?? defaultLocalBinding(`conversation-${caseId}`);
  await localRuntime.seed(binding);
  const { legacyAmountToMoney } = await import("../../src/mastra/lib/money");
  await caseStore.getClientForTests().execute({
    sql: "UPDATE local_orders SET currency = ?, amount_minor = ? WHERE tenant_id = ? AND provider_account_id = ? AND order_id = ?",
    args: [
      refundCurrency,
      legacyAmountToMoney(refundAmount + 1_000, refundCurrency).minor,
      binding.tenantId,
      binding.providerAccountId,
      "ORD-1001",
    ],
  });
  if (configuredBinding) {
    const { registerProviderRegistry } =
      await import("../../src/mastra/providers/registry");
    const { createLocalLoopbackFacade, LoopbackHttpProviderRegistry } =
      await import("../../src/mastra/providers/loopback-http");
    registerProviderRegistry(
      new LoopbackHttpProviderRegistry(
        createLocalLoopbackFacade(localRuntime, loopbackFailure),
      ),
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
  let executionCaseId = caseId;
  const selectExecutionCase = (id: string) => {
    executionCaseId = id;
  };
  const executionModel = async () => {
    const executionCase = await caseStore.get(executionCaseId);
    if (!executionCase)
      throw new Error(`Execution case ${executionCaseId} is missing.`);
    const activeTurnId = (executionCase.metadata as Record<string, unknown>)
      .activeTurnId;
    if (typeof activeTurnId !== "string" || !activeTurnId)
      throw new Error(
        `Execution case ${executionCaseId} has no active workflow turn.`,
      );
    const action = await caseStore.getClientForTests().execute({
      sql: "SELECT action.data FROM support_actions AS action JOIN support_turns AS turn ON turn.case_id = action.case_id AND turn.command_fingerprint = action.fingerprint WHERE action.case_id = ? AND action.kind = 'refund-command' AND turn.id = ? LIMIT 1",
      args: [executionCaseId, activeTurnId],
    });
    const command = JSON.parse(String(action.rows[0]?.data ?? "{}")) as {
      approvalCaseId?: string;
      idempotencyKey?: string;
      fingerprint?: string;
    };
    const input = {
      caseId: command.approvalCaseId ?? executionCaseId,
      orderId: "ORD-1001",
      amount: refundAmount,
      currency: refundCurrency,
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

  if (options?.deferInitialWorkflow)
    return {
      binding,
      caseStore,
      mastra,
      selectExecutionCase,
      purgeExpiredWorkflowSnapshots,
      recoverApprovedNativeDecisions,
    };

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
  const initial = await initialRun.start({
    inputData: { caseId, turnId: dispatch.turnId },
  });
  await caseStore.completeDispatch(
    dispatch.id,
    initial.status === "suspended" ? "suspended" : "completed",
    undefined,
    dispatch.leaseToken,
  );
  const supportCase = await caseStore.get(caseId);
  if (refund && refund.amount > 1000)
    return {
      binding,
      caseStore,
      mastra,
      selectExecutionCase,
      purgeExpiredWorkflowSnapshots,
      recoverApprovedNativeDecisions,
    };
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
    selectExecutionCase,
    purgeExpiredWorkflowSnapshots,
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
  it("removes an expired real native snapshot while preserving another active native approval", async () => {
    const caseId = "retention-real-native";
    const {
      binding,
      caseStore,
      mastra,
      purgeExpiredWorkflowSnapshots,
      selectExecutionCase,
    } = await setup(caseId);
    const supportCase = await caseStore.get(caseId);
    const native = (supportCase!.metadata as Record<string, unknown>)
      .nativeApproval as { runId: string };
    const activeCaseId = "retention-active-native";
    const activeRunId = `workflow-${activeCaseId}`;
    const createdAt = new Date().toISOString();
    await caseStore.acceptInbound(
      {
        id: activeCaseId,
        externalId: `event-${activeCaseId}`,
        source: "mock-email",
        customer: { email: "alex@example.com" },
        subject: "I was charged twice again",
        messages: [
          {
            id: `message-${activeCaseId}`,
            author: "customer",
            body: "Please review another duplicate charge.",
            createdAt,
          },
        ],
        status: "new",
        createdAt,
        updatedAt: createdAt,
        metadata: { providerBinding: binding, ownerId: "customer-alex" },
      },
      `event-${activeCaseId}`,
      activeRunId,
    );
    const activeDispatch = await caseStore.claimDispatchForStart(
      activeCaseId,
      activeRunId,
    );
    if (!activeDispatch) throw new Error("Expected active native dispatch.");
    expect(await caseStore.activateDispatch(activeDispatch)).toBe(true);
    selectExecutionCase(activeCaseId);
    const activeResult = await (
      await mastra
        .getWorkflow("resolveSupportCaseWorkflow")
        .createRun({ runId: activeRunId, disableScorers: true })
    ).start({
      inputData: { caseId: activeCaseId, turnId: activeDispatch.turnId },
    });
    expect(activeResult.status).toBe("suspended");
    await caseStore.completeDispatch(
      activeDispatch.id,
      "suspended",
      undefined,
      activeDispatch.leaseToken,
    );
    const activeNative = (
      (await caseStore.get(activeCaseId))!.metadata as Record<string, unknown>
    ).nativeApproval as { runId: string };
    const workflows = await mastra.getStorage()?.getStore("workflows");
    const before = await workflows?.listWorkflowRuns({ perPage: false });
    const nativeSnapshot = before?.runs.find(
      (run) => run.runId === native.runId,
    );
    expect([
      "agentic-loop",
      "durable-agentic-loop",
      "executionWorkflow",
    ]).toContain(nativeSnapshot?.workflowName);
    const activeSnapshot = before?.runs.find(
      (run) => run.runId === activeNative.runId,
    );
    expect([
      "agentic-loop",
      "durable-agentic-loop",
      "executionWorkflow",
    ]).toContain(activeSnapshot?.workflowName);
    const old = "2026-05-01T00:00:00.000Z";
    await caseStore.getClientForTests().execute({
      sql: "UPDATE support_cases SET created_at = ? WHERE id = ?",
      args: [old, caseId],
    });
    const retention = await caseStore.enforceRetention(
      () => new Date("2026-09-05T00:00:00.000Z"),
    );
    const deleted = await purgeExpiredWorkflowSnapshots(
      mastra.getStorage(),
      retention,
    );
    expect(deleted).toContain(
      `${nativeSnapshot!.workflowName}:${native.runId}`,
    );
    expect(
      (await workflows?.listWorkflowRuns({ perPage: false }))?.runs.some(
        (run) => run.runId === native.runId,
      ),
    ).toBe(false);
    expect(
      (await workflows?.listWorkflowRuns({ perPage: false }))?.runs.some(
        (run) => run.runId === activeNative.runId,
      ),
    ).toBe(true);
  });

  it("expires an actual registered inbound workflow snapshot after seven days", async () => {
    const caseId = `retention-ingest-${crypto.randomUUID()}`;
    const { caseStore, mastra, purgeExpiredWorkflowSnapshots } =
      await setup(caseId);
    const runId = `ingest-snapshot-${crypto.randomUUID()}`;
    const ingested = await (
      await mastra
        .getWorkflow("ingestSupportCaseWorkflow")
        .createRun({ runId, disableScorers: true })
    ).start({
      inputData: {
        payload: {
          externalId: `ingest-event-${crypto.randomUUID()}`,
          conversationId: `conversation-${caseId}`,
          from: "alex@example.com",
          subject: "A retention-bound inbound request",
          body: "Please review this duplicate charge.",
        },
        ingress: {
          id: "customer-alex",
          email: "alex@example.com",
          tenantId: "local-demo",
          roles: ["customer"],
        },
      },
    });
    expect(ingested.status).toBe("success");
    await vi.waitFor(async () => {
      expect((await caseStore.get(ingested.result.caseId))?.status).toBe(
        "waiting_approval",
      );
    });
    const workflows = await mastra.getStorage()?.getStore("workflows");
    const created = (
      await workflows?.listWorkflowRuns({ perPage: false })
    )?.runs.find((run) => run.runId === runId);
    expect(created).toMatchObject({
      runId,
      workflowName: "ingest-support-case",
    });
    const aged = "2026-08-20T00:00:00.000Z";
    await caseStore.getClientForTests().execute({
      sql: "UPDATE mastra_workflow_snapshot SET createdAt = ?, updatedAt = ? WHERE workflow_name = ? AND run_id = ?",
      args: [aged, aged, created!.workflowName, runId],
    });
    expect(
      await purgeExpiredWorkflowSnapshots(mastra.getStorage(), {
        rawWorkflowSnapshotBefore: "2026-08-27T00:00:00.000Z",
        expiredCaseIds: [],
        expiredWorkflowRunIds: [],
      }),
    ).toContain(`${created!.workflowName}:${runId}`);
    expect(
      (await workflows?.listWorkflowRuns({ perPage: false }))?.runs.some(
        (run) => run.runId === runId,
      ),
    ).toBe(false);
  });

  it("invalidates a real pending native approval when a follow-up is appended", async () => {
    const caseId = `follow-up-invalidates-native-${crypto.randomUUID()}`;
    const { caseStore, native } = await setup(caseId);
    const followUp = await caseStore.appendFollowUp({
      caseId,
      eventId: `follow-up-invalidates-event-${crypto.randomUUID()}`,
      runId: `follow-up-invalidates-run-${crypto.randomUUID()}`,
      message: {
        id: `follow-up-invalidates-message-${crypto.randomUUID()}`,
        author: "customer",
        body: "Please reconsider this request with new information.",
        createdAt: new Date().toISOString(),
      },
    });
    expect(followUp).toMatchObject({
      appended: true,
      turnId: expect.any(String),
    });
    const invalidated = await caseStore.get(caseId);
    expect(invalidated).toMatchObject({ status: "new" });
    expect(
      (invalidated!.metadata as Record<string, unknown>).nativeApproval,
    ).toBeUndefined();
    expect(
      await caseStore.approvalDecision(caseId, native.turnId),
    ).toBeUndefined();
    expect(await caseStore.nativeDecisionsNeedingRecovery()).toEqual([]);
    expect(await localRefundCount(caseStore)).toBe(0);
  });

  it("reopens a pre-suspension command binding with the same fingerprint and rejects a changed command", async () => {
    const caseId = `bind-crash-${crypto.randomUUID()}`;
    const { caseStore, mastra } = await setup(
      caseId,
      undefined,
      undefined,
      undefined,
      { deferInitialWorkflow: true },
    );
    const dispatch = await caseStore.claimDispatchForStart(
      caseId,
      `workflow-${caseId}`,
    );
    if (!dispatch) throw new Error("Expected the initial workflow dispatch.");
    await caseStore.markDispatchStarted(dispatch.id, dispatch.leaseToken);
    const beforeFault = await caseStore.get(caseId);
    await caseStore.update(caseId, {
      workflowRunId: `workflow-${caseId}`,
      metadata: {
        ...beforeFault!.metadata,
        activeTurnId: dispatch.turnId,
      },
    });
    const originalBind = caseStore.bindTurnCommand.bind(caseStore);
    const bind = vi
      .spyOn(caseStore, "bindTurnCommand")
      .mockImplementation(async (boundCaseId, turnId, fingerprint) => {
        await originalBind(boundCaseId, turnId, fingerprint);
        throw new Error("injected crash after durable command binding");
      });
    const executionAgent = mastra.getAgent("refundExecutionAgent");
    const generate = vi.spyOn(executionAgent, "generate");
    const initial = await mastra
      .getWorkflow("resolveSupportCaseWorkflow")
      .createRun({ runId: `workflow-${caseId}`, disableScorers: true });
    const initialResult = await initial.start({
      inputData: { caseId, turnId: dispatch.turnId },
    });
    bind.mockRestore();
    expect(initialResult.status).toBe("failed");
    expect(generate).not.toHaveBeenCalled();
    const boundTurn = await caseStore.turn(caseId, dispatch.turnId);
    expect(boundTurn?.commandFingerprint).toEqual(expect.any(String));
    expect(
      await caseStore.getAction(
        caseId,
        "refund-command",
        boundTurn!.commandFingerprint!,
      ),
    ).toMatchObject({ fingerprint: boundTurn!.commandFingerprint });

    // A process exit cannot leave a failed Mastra snapshot behind. Remove the
    // test's caught-exception snapshot through Mastra's supported storage API,
    // then let the normal durable dispatcher reopen the same workflow run.
    const workflowStore = await mastra.getStorage()?.getStore?.("workflows");
    if (!workflowStore)
      throw new Error("Expected the configured workflow storage.");
    await workflowStore.deleteWorkflowRunById({
      workflowName: "resolve-support-case",
      runId: `workflow-${caseId}`,
    });
    expect(
      await mastra
        .getWorkflow("resolveSupportCaseWorkflow")
        .getWorkflowRunById(`workflow-${caseId}`),
    ).toBeNull();
    await mastra.shutdown();
    runtimes.splice(runtimes.indexOf(mastra), 1);
    vi.resetModules();
    const { mastra: reopenedMastra } = await import("../../src/mastra/index");
    const { caseStore: reopenedStore } =
      await import("../../src/mastra/lib/case-store");
    const { triageAgent: reopenedTriageAgent } =
      await import("../../src/mastra/agents/triage-agent");
    const { responseAgent: reopenedResponseAgent } =
      await import("../../src/mastra/agents/response-agent");
    const { refundExecutionAgent: reopenedExecutionAgent } =
      await import("../../src/mastra/agents/refund-execution-agent");
    runtimes.push(reopenedMastra);
    reopenedTriageAgent.__updateModel({
      model: jsonModel({
        intent: "duplicate_charge",
        urgency: "normal",
        sentiment: "negative",
        requiresHumanReview: true,
        confidence: 1,
        rationale: "Deterministic duplicate-charge triage.",
      }) as never,
    });
    reopenedResponseAgent.__updateModel({
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
    const reopenedExecutionModel = async () => {
      const action = await reopenedStore.getClientForTests().execute({
        sql: "SELECT data FROM support_actions WHERE case_id = ? AND kind = 'refund-command' ORDER BY created_at DESC LIMIT 1",
        args: [caseId],
      });
      const command = JSON.parse(String(action.rows[0]?.data ?? "{}")) as {
        idempotencyKey?: string;
        fingerprint?: string;
      };
      return refundModel({
        caseId,
        orderId: "ORD-1001",
        amount: 20,
        currency: "USD",
        reason: "duplicate charge",
        idempotencyKey: command.idempotencyKey,
        fingerprint: command.fingerprint,
      }) as never;
    };
    reopenedExecutionAgent.__updateModel({ model: reopenedExecutionModel });
    reopenedMastra
      .getAgent("refundExecutionAgent")
      .__updateModel({ model: reopenedExecutionModel });
    await reopenedStore.getClientForTests().execute({
      sql: "UPDATE support_dispatch SET lease_until = ? WHERE id = ?",
      args: ["2000-01-01T00:00:00.000Z", dispatch.id],
    });
    const { recoverLocalWorkflows } =
      await import("../../src/mastra/runtime/local-runtime");
    expect(await recoverLocalWorkflows(reopenedMastra, 1, reopenedStore)).toBe(
      1,
    );
    const recovered = await reopenedStore.get(caseId);
    const native = (recovered!.metadata as Record<string, unknown>)
      .nativeApproval as {
      fingerprint: string;
      runId: string;
      turnId: string;
    };
    expect(recovered?.status).toBe("waiting_approval");
    expect(native).toMatchObject({
      fingerprint: boundTurn!.commandFingerprint,
      turnId: dispatch.turnId,
      runId: expect.any(String),
    });
    await expect(
      reopenedStore.bindTurnCommand(
        caseId,
        dispatch.turnId,
        "different-command-fingerprint",
      ),
    ).rejects.toThrow("already bound, or changed");
    const decision = await reopenedStore.recordApprovalDecision({
      caseId,
      turnId: native.turnId,
      commandFingerprint: native.fingerprint,
      principalId: "approver-demo",
      approved: true,
      nativeRunId: native.runId,
      nativeToolCallId: "native-tool-call",
    });
    expect(decision.won).toBe(true);
    const { recoverApprovedNativeDecisions } =
      await import("../../src/mastra/runtime/local-runtime");
    expect(
      await recoverApprovedNativeDecisions(reopenedMastra, reopenedStore, {
        disableScorers: true,
      }),
    ).toBe(1);
    expect(await localRefundCount(reopenedStore)).toBe(1);
    expect(await reopenedStore.get(caseId)).toMatchObject({
      status: "resolved",
      refundResult: { status: "executed", amount: 20 },
    });
  });

  it("executes exact at-limit JPY and KWD commands through the registered native Agent", async () => {
    for (const currency of ["JPY", "KWD"]) {
      const caseId = `currency-${currency}-${crypto.randomUUID()}`;
      const { caseStore, mastra, native, recoverApprovedNativeDecisions } =
        await setup(caseId, undefined, undefined, {
          amount: 1000,
          currency,
        });
      await caseStore.recordApprovalDecision({
        caseId,
        turnId: native.turnId,
        commandFingerprint: native.fingerprint,
        principalId: "approver-demo",
        approved: true,
        nativeRunId: native.runId,
        nativeToolCallId: native.toolCallId,
      });
      expect(
        await recoverApprovedNativeDecisions(mastra, caseStore, {
          disableScorers: true,
        }),
      ).toBe(1);
      expect((await caseStore.get(caseId))?.refundResult).toMatchObject({
        amount: 1000,
        currency,
        status: "executed",
      });
    }
  });

  it("does not present a native command above the exact JPY/KWD policy limit", async () => {
    for (const currency of ["JPY", "KWD"]) {
      const caseId = `currency-over-${currency}-${crypto.randomUUID()}`;
      const { caseStore } = await setup(caseId, undefined, undefined, {
        amount: currency === "JPY" ? 1001 : 1000.001,
        currency,
      });
      expect(await localRefundCount(caseStore)).toBe(0);
      expect((await caseStore.get(caseId))?.status).toBe("escalated");
    }
  });

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

  it("executes a completed follow-up refund as a distinct native approval and delivery", async () => {
    const caseId = `second-approved-refund-${crypto.randomUUID()}`;
    const {
      caseStore,
      mastra,
      native: firstNative,
      recoverApprovedNativeDecisions,
    } = await setup(caseId);
    await caseStore.recordApprovalDecision({
      caseId,
      turnId: firstNative.turnId,
      commandFingerprint: firstNative.fingerprint,
      principalId: "approver-demo",
      approved: true,
      nativeRunId: firstNative.runId,
      nativeToolCallId: firstNative.toolCallId,
    });
    expect(
      await recoverApprovedNativeDecisions(mastra, caseStore, {
        disableScorers: true,
      }),
    ).toBe(1);
    expect((await caseStore.get(caseId))?.status).toBe("resolved");
    const firstTurn = await caseStore.turn(caseId, firstNative.turnId);
    expect(firstTurn).toMatchObject({
      commandFingerprint: firstNative.fingerprint,
      outcome: {
        status: "resolved",
        refundResult: { amount: 20, status: "executed" },
      },
    });

    const followUp = await caseStore.appendFollowUp({
      caseId,
      eventId: `second-approved-event-${crypto.randomUUID()}`,
      runId: `second-approved-run-${crypto.randomUUID()}`,
      message: {
        id: `second-approved-message-${crypto.randomUUID()}`,
        author: "customer",
        body: "Please issue the separately reviewed duplicate-charge refund.",
        createdAt: new Date().toISOString(),
      },
    });
    expect(followUp).toMatchObject({
      appended: true,
      turnId: expect.any(String),
    });
    const { recoverLocalWorkflows } =
      await import("../../src/mastra/runtime/local-runtime");
    expect(await recoverLocalWorkflows(mastra, 1, caseStore)).toBe(1);
    const secondSuspended = await caseStore.get(caseId);
    const secondNative = (secondSuspended!.metadata as Record<string, unknown>)
      .nativeApproval as {
      fingerprint: string;
      runId: string;
      toolCallId: string;
      turnId: string;
    };
    expect(secondSuspended?.status).toBe("waiting_approval");
    expect(secondNative).toMatchObject({ turnId: followUp.turnId });
    expect(secondNative.turnId).not.toBe(firstNative.turnId);
    expect(secondNative.runId).not.toBe(firstNative.runId);
    expect(secondNative.fingerprint).not.toBe(firstNative.fingerprint);

    const secondDecision = await caseStore.recordApprovalDecision({
      caseId,
      turnId: secondNative.turnId,
      commandFingerprint: secondNative.fingerprint,
      principalId: "approver-demo",
      approved: true,
      nativeRunId: secondNative.runId,
      nativeToolCallId: secondNative.toolCallId,
    });
    expect(secondDecision.won).toBe(true);
    expect(
      await recoverApprovedNativeDecisions(mastra, caseStore, {
        disableScorers: true,
      }),
    ).toBe(1);
    expect(await localRefundCount(caseStore)).toBe(2);

    const turns = await caseStore.turns(caseId);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({
      id: firstNative.turnId,
      commandFingerprint: firstNative.fingerprint,
      outcome: {
        status: "resolved",
        refundResult: { amount: 20, status: "executed" },
      },
    });
    expect(turns[1]).toMatchObject({
      id: secondNative.turnId,
      commandFingerprint: secondNative.fingerprint,
      outcome: {
        status: "resolved",
        refundResult: { amount: 20, status: "executed" },
      },
    });
    const persisted = await caseStore.getClientForTests().execute({
      sql: "SELECT turn_id, command_fingerprint FROM support_decisions WHERE case_id = ? ORDER BY created_at, id",
      args: [caseId],
    });
    expect(persisted.rows).toEqual([
      {
        turn_id: firstNative.turnId,
        command_fingerprint: firstNative.fingerprint,
      },
      {
        turn_id: secondNative.turnId,
        command_fingerprint: secondNative.fingerprint,
      },
    ]);
    const outbox = await caseStore.getClientForTests().execute({
      sql: "SELECT id, status FROM support_outbox WHERE case_id = ? ORDER BY id",
      args: [caseId],
    });
    expect(outbox.rows).toEqual(
      expect.arrayContaining([
        {
          id: `outbox_${caseId}_${firstNative.turnId}_final`,
          status: "resolved",
        },
        {
          id: `outbox_${caseId}_${secondNative.turnId}_final`,
          status: "resolved",
        },
      ]),
    );
    expect(outbox.rows).toHaveLength(2);
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
    const dispatch = await caseStore.claimDispatchForResume(
      caseId,
      (await caseStore.get(caseId))!.workflowRunId,
      native.turnId,
    );
    const { withDispatchLeaseScope } =
      await import("../../src/mastra/lib/dispatch-lease-scope");
    const { resumeApprovedNativeTool } =
      await import("../../src/mastra/providers/native-execution");
    // Fault exactly after the provider commits its idempotency/effect row and
    // before issue_refund can project refundResult onto the case.
    const originalUpdate = caseStore.update.bind(caseStore);
    let projectionFault = true;
    const update = vi
      .spyOn(caseStore, "update")
      .mockImplementation(async (id, patch, expectedVersion) => {
        if (projectionFault && patch.refundResult) {
          projectionFault = false;
          throw new Error("injected post-provider projection crash");
        }
        return originalUpdate(id, patch, expectedVersion);
      });
    await withDispatchLeaseScope(
      {
        dispatchId: dispatch!.id,
        caseId,
        turnId: native.turnId,
        leaseToken: dispatch!.leaseToken!,
      },
      () =>
        resumeApprovedNativeTool({
          mastra,
          approved: true,
          scope: {
            caseId,
            turnId: native.turnId,
            nativeRunId: native.runId,
            nativeToolCallId: native.toolCallId,
            commandFingerprint: native.fingerprint,
            dispatchId: dispatch!.id,
            leaseToken: dispatch!.leaseToken!,
          },
        }),
    );
    update.mockRestore();
    await caseStore.completeDispatch(
      dispatch!.id,
      "suspended",
      undefined,
      dispatch!.leaseToken,
    );
    expect(await localRefundCount(caseStore)).toBe(1);

    expect((await caseStore.get(caseId))?.refundResult).toBeUndefined();

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
    expect((await caseStore.get(caseId))?.refundResult).toMatchObject({
      amount: 20,
      status: "executed",
    });
    expect(await caseStore.get(caseId)).toMatchObject({
      status: "resolved",
      refundResult: { status: "executed", amount: 20 },
    });
  });

  it("fails closed when the verified owner or current order owner changes while native approval is suspended", async () => {
    const caseId = `owner-change-${crypto.randomUUID()}`;
    const { caseStore, mastra, native } = await setup(caseId);
    await caseStore.recordApprovalDecision({
      caseId,
      turnId: native.turnId,
      commandFingerprint: native.fingerprint,
      principalId: "approver-demo",
      approved: true,
      nativeRunId: native.runId,
      nativeToolCallId: native.toolCallId,
    });
    // This models a provider-side ownership correction after the immutable
    // command/snapshot exists. The provider transaction, not model input,
    // makes the final decision.
    await caseStore.getClientForTests().execute({
      sql: "UPDATE local_orders SET customer_email = ? WHERE tenant_id = ? AND order_id = ?",
      args: ["jordan@example.com", "local-demo", "ORD-1001"],
    });
    const dispatch = await caseStore.claimDispatchForResume(
      caseId,
      (await caseStore.get(caseId))!.workflowRunId,
      native.turnId,
    );
    const { withDispatchLeaseScope } =
      await import("../../src/mastra/lib/dispatch-lease-scope");
    const { resumeApprovedNativeTool } =
      await import("../../src/mastra/providers/native-execution");
    await withDispatchLeaseScope(
      {
        dispatchId: dispatch!.id,
        caseId,
        turnId: native.turnId,
        leaseToken: dispatch!.leaseToken!,
      },
      () =>
        resumeApprovedNativeTool({
          mastra,
          approved: true,
          scope: {
            caseId,
            turnId: native.turnId,
            nativeRunId: native.runId,
            nativeToolCallId: native.toolCallId,
            commandFingerprint: native.fingerprint,
            dispatchId: dispatch!.id,
            leaseToken: dispatch!.leaseToken!,
          },
        }),
    );
    expect(await localRefundCount(caseStore)).toBe(0);
    expect((await caseStore.get(caseId))?.refundResult).toBeUndefined();
  });

  it("rechecks an escalation policy changed after native suspension before any provider effect", async () => {
    const caseId = `policy-change-${crypto.randomUUID()}`;
    const { caseStore, mastra, native } = await setup(caseId);
    await caseStore.recordApprovalDecision({
      caseId,
      turnId: native.turnId,
      commandFingerprint: native.fingerprint,
      principalId: "approver-demo",
      approved: true,
      nativeRunId: native.runId,
      nativeToolCallId: native.toolCallId,
    });
    const before = await caseStore.get(caseId);
    await caseStore.update(caseId, {
      draft: {
        ...before!.draft!,
        requiresEscalation: true,
        escalationReason: "Risk policy changed while awaiting approval.",
      },
    });
    const dispatch = await caseStore.claimDispatchForResume(
      caseId,
      before!.workflowRunId,
      native.turnId,
    );
    const { withDispatchLeaseScope } =
      await import("../../src/mastra/lib/dispatch-lease-scope");
    const { resumeApprovedNativeTool } =
      await import("../../src/mastra/providers/native-execution");
    await withDispatchLeaseScope(
      {
        dispatchId: dispatch!.id,
        caseId,
        turnId: native.turnId,
        leaseToken: dispatch!.leaseToken!,
      },
      () =>
        resumeApprovedNativeTool({
          mastra,
          approved: true,
          scope: {
            caseId,
            turnId: native.turnId,
            nativeRunId: native.runId,
            nativeToolCallId: native.toolCallId,
            commandFingerprint: native.fingerprint,
            dispatchId: dispatch!.id,
            leaseToken: dispatch!.leaseToken!,
          },
        }),
    );
    expect(await localRefundCount(caseStore)).toBe(0);
  });

  it("reconciles a committed loopback HTTP refund after its response is dropped", async () => {
    const caseId = `loopback-drop-${crypto.randomUUID()}`;
    const binding = {
      tenantId: "local-demo",
      providerKind: "local" as const,
      providerAccountId: `drop-${caseId}`,
      externalConversationId: `drop-conversation-${caseId}`,
    };
    const { caseStore, mastra, native, recoverApprovedNativeDecisions } =
      await setup(caseId, binding, (request) =>
        request.url.endsWith("/transactions/issue-refund")
          ? "drop-after-commit"
          : undefined,
      );
    await caseStore.recordApprovalDecision({
      caseId,
      turnId: native.turnId,
      commandFingerprint: native.fingerprint,
      principalId: "approver-demo",
      approved: true,
      nativeRunId: native.runId,
      nativeToolCallId: native.toolCallId,
    });
    const dispatch = await caseStore.claimDispatchForResume(
      caseId,
      (await caseStore.get(caseId))!.workflowRunId,
      native.turnId,
    );
    const { withDispatchLeaseScope } =
      await import("../../src/mastra/lib/dispatch-lease-scope");
    const { resumeApprovedNativeTool } =
      await import("../../src/mastra/providers/native-execution");
    await withDispatchLeaseScope(
      {
        dispatchId: dispatch!.id,
        caseId,
        turnId: native.turnId,
        leaseToken: dispatch!.leaseToken!,
      },
      () =>
        resumeApprovedNativeTool({
          mastra,
          approved: true,
          scope: {
            caseId,
            turnId: native.turnId,
            nativeRunId: native.runId,
            nativeToolCallId: native.toolCallId,
            commandFingerprint: native.fingerprint,
            dispatchId: dispatch!.id,
            leaseToken: dispatch!.leaseToken!,
          },
        }),
    );
    await caseStore.completeDispatch(
      dispatch!.id,
      "suspended",
      undefined,
      dispatch!.leaseToken,
    );
    expect(await localRefundCount(caseStore)).toBe(1);
    expect((await caseStore.get(caseId))?.refundResult).toBeUndefined();
    expect(
      await recoverApprovedNativeDecisions(mastra, caseStore, {
        disableScorers: true,
      }),
    ).toBe(1);
    expect((await caseStore.get(caseId))?.refundResult).toMatchObject({
      amount: 20,
      status: "executed",
    });
    expect(await localRefundCount(caseStore)).toBe(1);
  });

  it("rejects a lease reclaimed between the tool precheck and effect transaction", async () => {
    const caseId = `lease-race-${crypto.randomUUID()}`;
    const { caseStore, mastra, native } = await setup(caseId);
    const { localRuntime } =
      await import("../../src/mastra/runtime/local-runtime");
    await caseStore.recordApprovalDecision({
      caseId,
      turnId: native.turnId,
      commandFingerprint: native.fingerprint,
      principalId: "approver-demo",
      approved: true,
      nativeRunId: native.runId,
      nativeToolCallId: native.toolCallId,
    });
    const dispatch = await caseStore.claimDispatchForResume(
      caseId,
      (await caseStore.get(caseId))!.workflowRunId,
      native.turnId,
    );
    const originalIssue = localRuntime.issueRefund.bind(localRuntime);
    let expired = false;
    const issue = vi
      .spyOn(localRuntime, "issueRefund")
      .mockImplementation(async (command, authorization) => {
        if (!expired) {
          expired = true;
          await caseStore.getClientForTests().execute({
            sql: "UPDATE support_dispatch SET lease_until = ? WHERE id = ?",
            args: ["2000-01-01T00:00:00.000Z", dispatch!.id],
          });
        }
        return originalIssue(command, authorization);
      });
    const { withDispatchLeaseScope } =
      await import("../../src/mastra/lib/dispatch-lease-scope");
    const { resumeApprovedNativeTool } =
      await import("../../src/mastra/providers/native-execution");
    await withDispatchLeaseScope(
      {
        dispatchId: dispatch!.id,
        caseId,
        turnId: native.turnId,
        leaseToken: dispatch!.leaseToken!,
      },
      () =>
        resumeApprovedNativeTool({
          mastra,
          approved: true,
          scope: {
            caseId,
            turnId: native.turnId,
            nativeRunId: native.runId,
            nativeToolCallId: native.toolCallId,
            commandFingerprint: native.fingerprint,
            dispatchId: dispatch!.id,
            leaseToken: dispatch!.leaseToken!,
          },
        }),
    );
    issue.mockRestore();
    expect(expired).toBe(true);
    expect(await localRefundCount(caseStore)).toBe(0);
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
      "current durable workflow dispatch lease",
    );
    // A correctly shaped Agent context and a valid durable decision still do
    // not create financial authority before Mastra's official native resume.
    const directDispatch = await caseStore.claimDispatchForResume(
      caseId,
      (await caseStore.get(caseId))!.workflowRunId,
      native.turnId,
    );
    const { withDispatchLeaseScope } =
      await import("../../src/mastra/lib/dispatch-lease-scope");
    await expect(
      withDispatchLeaseScope(
        {
          dispatchId: directDispatch!.id,
          caseId,
          turnId: native.turnId,
          leaseToken: directDispatch!.leaseToken!,
        },
        () =>
          issueRefundTool.execute!(input, {
            agent: {
              agentId: "refund-execution-agent",
              toolCallId: native.toolCallId,
            },
          } as never),
      ),
    ).rejects.toThrow("approved native refund agent tool context");
    await caseStore.completeDispatch(
      directDispatch!.id,
      "suspended",
      undefined,
      directDispatch!.leaseToken,
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
    const dispatch = await caseStore.claimDispatchForResume(
      caseId,
      (await caseStore.get(caseId))!.workflowRunId,
      native.turnId,
    );
    const { resumeApprovedNativeTool } =
      await import("../../src/mastra/providers/native-execution");
    await withDispatchLeaseScope(
      {
        dispatchId: dispatch!.id,
        caseId,
        turnId: native.turnId,
        leaseToken: dispatch!.leaseToken!,
      },
      () =>
        resumeApprovedNativeTool({
          mastra,
          approved: true,
          scope: {
            caseId,
            turnId: native.turnId,
            nativeRunId: native.runId,
            nativeToolCallId: native.toolCallId,
            commandFingerprint: native.fingerprint,
            dispatchId: dispatch!.id,
            leaseToken: dispatch!.leaseToken!,
          },
        }),
    );
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
