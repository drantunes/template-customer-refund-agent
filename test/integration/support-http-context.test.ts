import { rm } from "node:fs/promises";
import { RequestContext } from "@mastra/core/request-context";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { supportCaseSchema } from "../../src/mastra/domain/support-case";
import { caseStore } from "../../src/mastra/lib/case-store";
import { inboundSupportResponseSchema } from "../../src/mastra/server/contracts";
import {
  supportCaseApproveRoute,
  supportCaseRejectRoute,
} from "../../src/mastra/server/routes";
import { issueLocalSession } from "../../src/mastra/server/auth";
import {
  deterministicRefundModel,
  type DeterministicRefundModel,
} from "../fixtures/deterministic-language-model";

const databaseFiles: string[] = [];
const mastraRuntimes: Array<{ shutdown(): Promise<void> }> = [];
const closeSharedClients: Array<() => Promise<void>> = [];
const approverHeaders = {
  authorization: `Bearer ${issueLocalSession({ id: "approver-demo" })}`,
};
const customerHeaders = {
  authorization: `Bearer ${issueLocalSession({ id: "customer-alex" })}`,
};
const jordanHeaders = {
  authorization: `Bearer ${issueLocalSession({ id: "customer-jordan" })}`,
};
const otherTenantHeaders = {
  authorization: `Bearer ${issueLocalSession({ id: "other-tenant-agent" })}`,
};

async function bindApprovalFixture(store: typeof caseStore, caseId: string) {
  const fingerprint = `fingerprint-${caseId}`;
  const current = await store.get(caseId);
  const turnId = (current!.metadata as Record<string, unknown>).activeTurnId;
  if (typeof turnId !== "string")
    throw new Error("Expected the durable dispatch turn for approval binding.");
  await store.update(caseId, {
    metadata: {
      ...current!.metadata,
      refundCommand: { fingerprint },
      nativeApproval: {
        runId: `native-${caseId}`,
        toolCallId: `tool-${caseId}`,
        fingerprint,
        // The native approval must bind to the same durable dispatch turn.
        // A made-up legacy turn makes the route correctly fence the request
        // before the mocked resume can begin.
        turnId,
      },
    },
  });
  await store.saveAction(caseId, "refund-command", fingerprint, {
    fingerprint,
  });
  return fingerprint;
}

function supportApp(mastra: unknown) {
  const app = new Hono();
  app.use("/support/*", async (c, next) => {
    const requestContext = new RequestContext();
    requestContext.setRaw("correlationId", c.req.header("x-correlation-id"));
    c.set("mastra", mastra as never);
    c.set("requestContext", requestContext);
    await next();
  });
  return app;
}

function approvalApp(mastra: unknown) {
  const app = supportApp(mastra);
  app.post("/support/cases/:caseId/approve", supportCaseApproveRoute.handler);
  app.post("/support/cases/:caseId/reject", supportCaseRejectRoute.handler);
  return app;
}

async function loadDeterministicRuntime() {
  const databasePath = `/private/tmp/phase001-http-context-${crypto.randomUUID()}.db`;
  databaseFiles.push(
    databasePath,
    `${databasePath}-shm`,
    `${databasePath}-wal`,
  );
  process.env.TURSO_DATABASE_URL = `file:${databasePath}`;
  process.env.SUPPORT_SOURCE = "mock";
  vi.resetModules();
  // The HTTP boundary exercises registered agents and workflows, but not the
  // evaluator product. Prevent the composition root from registering a judge
  // model that could make an unrelated provider request in the background.
  vi.doMock("../../src/mastra/evals", () => ({
    responseAgentScorers: {},
    triageAgentScorers: {},
    supportEvalScorerRegistry: {},
  }));
  vi.doMock("@mastra/core/llm", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@mastra/core/llm")>();
    return {
      ...actual,
      ModelRouterEmbeddingModel: class DeterministicEmbeddingModel {},
    };
  });

  // index loads the provider registry through a circular workflow graph. Load
  // it before leaves so vi.resetModules cannot expose a partially initialized
  // local-runtime export to concurrent dynamic imports.
  const { mastra } = await import("../../src/mastra/index");
  const { closeSharedLocalSqliteClient } =
    await import("../../src/mastra/lib/sqlite-client");
  const { issueRefundTool } =
    await import("../../src/mastra/tools/issue-refund");
  const { lookupOrderTool } =
    await import("../../src/mastra/tools/lookup-order");
  const { responseAgent } =
    await import("../../src/mastra/agents/response-agent");
  const { searchSupportKnowledgeTool } =
    await import("../../src/mastra/tools/search-support-knowledge");
  const { triageAgent } = await import("../../src/mastra/agents/triage-agent");
  const { refundExecutionAgent } =
    await import("../../src/mastra/agents/refund-execution-agent");
  const routes = await import("../../src/mastra/server/routes");

  vi.spyOn(triageAgent, "generate").mockResolvedValue({
    object: {
      intent: "duplicate_charge",
      urgency: "normal",
      sentiment: "negative",
      requiresHumanReview: true,
      confidence: 1,
      rationale: "Deterministic HTTP context test.",
    },
    usage: { inputTokens: 1, outputTokens: 1 },
    response: { modelId: "deterministic/triage" },
  } as never);
  vi.spyOn(responseAgent, "generate").mockResolvedValue({
    object: {
      draftResponse: "A deterministic refund response.",
      citedSources: ["duplicate-charge-policy"],
      recommendRefund: true,
      refundAmount: 49,
      refundCurrency: "USD",
      refundReason: "duplicate charge",
      requiresEscalation: false,
    },
    usage: { inputTokens: 1, outputTokens: 1 },
    response: { modelId: "deterministic/response" },
  } as never);
  vi.spyOn(searchSupportKnowledgeTool, "execute").mockResolvedValue({
    sources: [
      {
        metadata: {
          title: "Duplicate charge policy",
          source: "duplicate-charge-policy",
          text: "Synthetic policy evidence.",
        },
        score: 1,
      },
    ],
  } as never);
  vi.spyOn(issueRefundTool, "execute");
  let refundModel: DeterministicRefundModel | undefined;
  const executionModel = async () => {
    if (refundModel) return refundModel;
    const action = await (
      await import("../../src/mastra/lib/case-store")
    ).caseStore
      .getClientForTests()
      .execute(
        "SELECT data FROM support_actions WHERE kind = 'refund-command' ORDER BY created_at DESC LIMIT 1",
      );
    const command = JSON.parse(String(action.rows[0]?.data ?? "{}")) as {
      approvalCaseId: string;
      orderId: string;
      amount: { minor: number; currency: string };
      reason: string;
      idempotencyKey: string;
      fingerprint: string;
    };
    refundModel = deterministicRefundModel({
      caseId: command.approvalCaseId,
      orderId: command.orderId,
      amount: command.amount.minor / 100,
      currency: command.amount.currency,
      reason: command.reason,
      idempotencyKey: command.idempotencyKey,
      fingerprint: command.fingerprint,
    });
    return refundModel;
  };
  refundExecutionAgent.__updateModel({ model: executionModel });
  mastra
    .getAgent("refundExecutionAgent")
    .__updateModel({ model: executionModel });
  mastraRuntimes.push(mastra);
  closeSharedClients.push(closeSharedLocalSqliteClient);

  const app = supportApp(mastra);
  app.post("/support/inbound", routes.supportInboundRoute.handler);
  app.get("/support/cases/:caseId", routes.supportCaseDetailRoute.handler);
  app.post(
    "/support/cases/:caseId/approve",
    routes.supportCaseApproveRoute.handler,
  );
  app.post(
    "/support/cases/:caseId/follow-ups",
    routes.supportCaseFollowUpRoute.handler,
  );
  return {
    app,
    mastra,
    caseStore: (await import("../../src/mastra/lib/case-store")).caseStore,
    issueRefundTool,
    lookupOrderTool,
    responseAgent,
    searchSupportKnowledgeTool,
    triageAgent,
  };
}

afterEach(async () => {
  await Promise.allSettled(
    mastraRuntimes.splice(0).map((runtime) => runtime.shutdown()),
  );
  await Promise.allSettled(
    closeSharedClients.splice(0).map((close) => close()),
  );
  vi.restoreAllMocks();
  vi.doUnmock("../../src/mastra/evals");
  vi.doUnmock("@mastra/core/llm");
  await Promise.all(
    databaseFiles.splice(0).map((file) => rm(file, { force: true })),
  );
});

describe("support approval HTTP boundary", () => {
  it.each([
    ["approve", undefined, false],
    ["approve", '{"commandFingerprint":"fingerprint","note":"ok"}', true],
    ["approve", "  \n", false],
    ["approve", "{not-json", false],
    ["reject", undefined, false],
    ["reject", '{"commandFingerprint":"fingerprint","note":"ok"}', true],
    ["reject", "  \n", false],
    ["reject", "{not-json", false],
  ])(
    "%s honors optional and malformed request bodies through Hono",
    async (action, body, shouldResume) => {
      const resume = vi.fn().mockResolvedValue({ status: "success" });
      const mastra = {
        getAgent: () => ({
          approveToolCallGenerate: vi.fn(),
          declineToolCallGenerate: vi.fn(),
        }),
        getWorkflow: () => ({
          createRun: async () => ({ resume }),
        }),
      };
      vi.spyOn(caseStore, "get").mockResolvedValue({
        id: "case-waiting",
        customer: { email: "alex@example.com" },
        status: "waiting_approval",
        workflowRunId: "run-waiting",
        metadata: {
          providerBinding: { tenantId: "local-demo" },
          refundCommand: { fingerprint: "fingerprint" },
          nativeApproval: {
            runId: "native-run",
            toolCallId: "native-call",
            fingerprint: "fingerprint",
            turnId: "turn-waiting",
          },
        },
      } as never);
      vi.spyOn(caseStore, "recordApprovalDecision").mockResolvedValue({
        won: true,
      });
      vi.spyOn(caseStore, "claimDispatchForResume").mockResolvedValue({
        id: "dispatch-waiting",
        caseId: "case-waiting",
        runId: "run-waiting",
        state: "claimed",
        attempts: 1,
        wasStarted: true,
        leaseToken: "lease-waiting",
      });
      vi.spyOn(caseStore, "update").mockResolvedValue({
        id: "case-waiting",
        status: "processing",
      } as never);
      vi.spyOn(caseStore, "renewDispatchLease").mockResolvedValue(true);
      vi.spyOn(caseStore, "completeDispatch").mockResolvedValue(true);
      const app = approvalApp(mastra);
      const response = await app.request(
        `http://support.test/support/cases/case-waiting/${action}`,
        {
          method: "POST",
          headers: approverHeaders,
          ...(body === undefined ? {} : { body }),
        },
      );

      expect(response.status).toBe(shouldResume ? 200 : 400);
      expect(resume).toHaveBeenCalledTimes(shouldResume ? 1 : 0);
      if (shouldResume) {
        expect(resume).toHaveBeenCalledWith(
          expect.objectContaining({
            requestContext: expect.any(RequestContext),
            resumeData: expect.objectContaining({
              approved: action === "approve",
              approverId: "approver-demo",
            }),
          }),
        );
      } else {
        await expect(response.json()).resolves.toEqual({
          error: "Invalid approval payload.",
        });
      }
    },
  );
});

describe("support workflow HTTP context propagation", () => {
  it("rejects cross-tenant and cross-owner inbound conversation mutation before dispatch", async () => {
    const { app, caseStore: runtimeCaseStore } =
      await loadDeterministicRuntime();
    const conversationId = `owner-scope-${crypto.randomUUID()}`;
    const alex = await app.request("http://support.test/support/inbound", {
      method: "POST",
      headers: { "content-type": "application/json", ...customerHeaders },
      body: JSON.stringify({
        externalId: `owner-scope-alex-${crypto.randomUUID()}`,
        conversationId,
        from: "alex@example.com",
        subject: "Alex request",
        body: "Please help with my duplicate charge.",
      }),
    });
    expect(alex.status).toBe(200);
    const alexBody = inboundSupportResponseSchema.parse(await alex.json());
    await vi.waitFor(async () =>
      expect((await runtimeCaseStore.get(alexBody.caseId))?.status).toBe(
        "waiting_approval",
      ),
    );

    const crossOwner = await app.request(
      "http://support.test/support/inbound",
      {
        method: "POST",
        headers: { "content-type": "application/json", ...jordanHeaders },
        body: JSON.stringify({
          externalId: `owner-scope-jordan-${crypto.randomUUID()}`,
          conversationId,
          from: "jordan@example.com",
          subject: "Jordan request",
          body: "Append this to Alex's conversation.",
        }),
      },
    );
    expect(crossOwner.status).toBe(403);

    const crossTenant = await app.request(
      "http://support.test/support/inbound",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...otherTenantHeaders,
        },
        body: JSON.stringify({
          externalId: `tenant-scope-${crypto.randomUUID()}`,
          from: "alex@example.com",
          subject: "Wrong tenant",
          body: "This must not allocate a run.",
        }),
      },
    );
    expect(crossTenant.status).toBe(403);
  });

  it("uses verified workflow scope for commerce reads and omits staff-only fields from the customer case DTO", async () => {
    const {
      app,
      caseStore: runtimeCaseStore,
      lookupOrderTool,
    } = await loadDeterministicRuntime();
    await expect(
      lookupOrderTool.execute({ customerEmail: "alex@example.com" }),
    ).rejects.toThrow("verified workflow turn scope");

    const inbound = await app.request("http://support.test/support/inbound", {
      method: "POST",
      headers: { "content-type": "application/json", ...customerHeaders },
      body: JSON.stringify({
        externalId: `customer-dto-${crypto.randomUUID()}`,
        from: "alex@example.com",
        subject: "DTO projection",
        body: "Please help with a duplicate charge.",
      }),
    });
    const { caseId } = inboundSupportResponseSchema.parse(await inbound.json());
    await vi.waitFor(async () =>
      expect((await runtimeCaseStore.get(caseId))?.status).toBe(
        "waiting_approval",
      ),
    );
    const current = await runtimeCaseStore.get(caseId);
    const { withTrustedCommerceScope } =
      await import("../../src/mastra/lib/trusted-run-scope");
    await expect(
      withTrustedCommerceScope(
        { caseId, ownerId: "customer-alex", tenantId: "local-demo" },
        () => lookupOrderTool.execute({ orderId: "ORD-1002" }),
      ),
    ).resolves.toEqual({ found: false });
    await runtimeCaseStore.update(caseId, {
      escalationReason: "Internal staff-only reason",
      metadata: {
        ...current!.metadata,
        rawPayload: { secret: "must not leak" },
      },
    });
    const detail = await app.request(
      `http://support.test/support/cases/${caseId}`,
      { headers: customerHeaders },
    );
    expect(detail.status).toBe(200);
    const dto = (await detail.json()) as Record<string, unknown>;
    expect(dto).not.toHaveProperty("escalationReason");
    expect(dto.metadata).toEqual({});
  });

  it("renews the persisted approval dispatch lease while a real API resume is slow", async () => {
    const {
      app,
      caseStore: runtimeCaseStore,
      mastra,
    } = await loadDeterministicRuntime();
    const caseId = `slow-resume-${crypto.randomUUID()}`;
    const runId = `slow-resume-run-${crypto.randomUUID()}`;
    const createdAt = "2026-09-05T00:00:00.000Z";
    await runtimeCaseStore.acceptInbound(
      {
        id: caseId,
        externalId: `event-${caseId}`,
        source: "mock-email",
        status: "new",
        customer: { email: "alex@example.com" },
        subject: "Slow approval",
        messages: [
          {
            id: `message-${caseId}`,
            author: "customer",
            body: "Please refund the duplicate charge.",
            createdAt,
          },
        ],
        createdAt,
        updatedAt: createdAt,
        metadata: {
          ownerId: "customer-alex",
          providerBinding: {
            tenantId: "local-demo",
            providerKind: "local",
            providerAccountId: "local-demo",
            externalConversationId: `conversation-${caseId}`,
          },
        },
      },
      `event-${caseId}`,
      runId,
    );
    await runtimeCaseStore.update(caseId, {
      status: "waiting_approval",
      workflowRunId: runId,
    });
    await runtimeCaseStore.getClientForTests().execute({
      sql: "UPDATE support_dispatch SET state = 'suspended', lease_until = NULL, lease_token = NULL WHERE case_id = ?",
      args: [caseId],
    });
    const fingerprint = await bindApprovalFixture(runtimeCaseStore, caseId);

    let resumeStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resumeStarted = resolve;
    });
    let release!: (result: { status: "success" }) => void;
    const slowResult = new Promise<{ status: "success" }>((resolve) => {
      release = resolve;
    });
    vi.spyOn(mastra, "getWorkflow").mockReturnValue({
      createRun: async () => ({
        resume: async () => {
          resumeStarted();
          return slowResult;
        },
      }),
    } as never);
    vi.spyOn(mastra, "getAgent").mockReturnValue({
      approveToolCallGenerate: async () => undefined,
      declineToolCallGenerate: async () => undefined,
    } as never);

    // Keep SQLite's retry backoff on real timers while driving only the
    // approval heartbeat interval deterministically.
    vi.useFakeTimers({ doNotFake: ["setTimeout", "nextTick", "setImmediate"] });
    try {
      const request = app.request(
        `http://support.test/support/cases/${caseId}/approve`,
        {
          method: "POST",
          headers: approverHeaders,
          body: JSON.stringify({ commandFingerprint: fingerprint }),
        },
      );
      await started;
      await vi.advanceTimersByTimeAsync(30_000);
      const lease = await runtimeCaseStore.getClientForTests().execute({
        sql: "SELECT state, lease_until FROM support_dispatch WHERE case_id = ?",
        args: [caseId],
      });
      expect(lease.rows[0]).toMatchObject({ state: "claimed" });
      expect(Date.parse(String(lease.rows[0].lease_until))).toBeGreaterThan(
        Date.now(),
      );
      expect(await runtimeCaseStore.claimDispatch()).toEqual([]);
      release({ status: "success" });
      expect((await request).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns a conflict without a stale failure projection when approval renewal loses ownership", async () => {
    const {
      app,
      caseStore: runtimeCaseStore,
      mastra,
    } = await loadDeterministicRuntime();
    const caseId = `lost-resume-${crypto.randomUUID()}`;
    const runId = `lost-resume-run-${crypto.randomUUID()}`;
    const createdAt = "2026-09-05T00:00:00.000Z";
    await runtimeCaseStore.acceptInbound(
      {
        id: caseId,
        externalId: `event-${caseId}`,
        source: "mock-email",
        status: "new",
        customer: { email: "alex@example.com" },
        subject: "Lost approval lease",
        messages: [
          {
            id: `message-${caseId}`,
            author: "customer",
            body: "Please refund the duplicate charge.",
            createdAt,
          },
        ],
        createdAt,
        updatedAt: createdAt,
        metadata: {
          providerBinding: {
            tenantId: "local-demo",
            providerKind: "local",
            providerAccountId: "local-demo",
            externalConversationId: `conversation-${caseId}`,
          },
        },
      },
      `event-${caseId}`,
      runId,
    );
    await runtimeCaseStore.update(caseId, {
      status: "waiting_approval",
      workflowRunId: runId,
    });
    await runtimeCaseStore.getClientForTests().execute({
      sql: "UPDATE support_dispatch SET state = 'suspended', lease_until = NULL, lease_token = NULL WHERE case_id = ?",
      args: [caseId],
    });
    const fingerprint = await bindApprovalFixture(runtimeCaseStore, caseId);

    let resumeStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resumeStarted = resolve;
    });
    let release!: (result: { status: "success" }) => void;
    const slowResult = new Promise<{ status: "success" }>((resolve) => {
      release = resolve;
    });
    vi.spyOn(mastra, "getWorkflow").mockReturnValue({
      createRun: async () => ({
        resume: async () => {
          resumeStarted();
          return slowResult;
        },
      }),
    } as never);
    vi.spyOn(mastra, "getAgent").mockReturnValue({
      approveToolCallGenerate: async () => undefined,
      declineToolCallGenerate: async () => undefined,
    } as never);

    vi.useFakeTimers({ doNotFake: ["setTimeout", "nextTick", "setImmediate"] });
    try {
      const request = app.request(
        `http://support.test/support/cases/${caseId}/approve`,
        {
          method: "POST",
          headers: approverHeaders,
          body: JSON.stringify({ commandFingerprint: fingerprint }),
        },
      );
      await started;
      await runtimeCaseStore.getClientForTests().execute({
        sql: "UPDATE support_dispatch SET lease_token = ? WHERE case_id = ?",
        args: ["current-owner", caseId],
      });
      await vi.advanceTimersByTimeAsync(10_000);
      release({ status: "success" });
      expect((await request).status).toBe(409);
      expect(
        (
          await runtimeCaseStore.getClientForTests().execute({
            sql: "SELECT state, lease_token FROM support_dispatch WHERE case_id = ?",
            args: [caseId],
          })
        ).rows[0],
      ).toMatchObject({ state: "claimed", lease_token: "current-owner" });
      expect((await runtimeCaseStore.get(caseId))?.status).toBe("processing");
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers a persisted pre-start Mastra run and then approves it through the real API", async () => {
    const {
      app,
      caseStore: runtimeCaseStore,
      mastra,
    } = await loadDeterministicRuntime();
    const { recoverLocalWorkflows } =
      await import("../../src/mastra/runtime/local-runtime");
    const id = `recovered-${crypto.randomUUID()}`;
    const createdAt = "2026-09-05T00:00:00.000Z";
    const runId = crypto.randomUUID();
    await runtimeCaseStore.acceptInbound(
      {
        id,
        externalId: `event-${id}`,
        source: "mock-email",
        status: "new",
        customer: { email: "alex@example.com" },
        subject: "Recovered pre-start refund",
        messages: [
          {
            id: `message-${id}`,
            author: "customer",
            body: "Please refund the duplicate charge.",
            createdAt,
          },
        ],
        createdAt,
        updatedAt: createdAt,
        metadata: {
          providerBinding: {
            tenantId: "local-demo",
            providerKind: "local",
            providerAccountId: "local-demo",
            externalConversationId: `conversation-${id}`,
          },
          ownerId: "customer-alex",
        },
      },
      `event-${id}`,
      runId,
    );
    await recoverLocalWorkflows(mastra, 10, runtimeCaseStore);
    await vi.waitFor(async () => {
      const recovered = await runtimeCaseStore.get(id);
      expect(recovered?.status).toBe("waiting_approval");
      expect(recovered?.workflowRunId).toEqual(expect.any(String));
    });
    const approved = await app.request(
      `http://support.test/support/cases/${id}/approve`,
      {
        method: "POST",
        headers: approverHeaders,
        body: JSON.stringify({
          commandFingerprint:
            (
              (await runtimeCaseStore.get(id))!.metadata as Record<
                string,
                unknown
              >
            ).refundCommand &&
            (
              (
                (await runtimeCaseStore.get(id))!.metadata as Record<
                  string,
                  unknown
                >
              ).refundCommand as { fingerprint: string }
            ).fingerprint,
        }),
      },
    );
    expect(approved.status).toBe(200);
    await vi.waitFor(async () =>
      expect((await runtimeCaseStore.get(id))?.status).toBe("resolved"),
    );
  });

  it("passes the Hono RequestContext from inbound and approval requests to specialists and registered tools", async () => {
    const {
      app,
      caseStore: runtimeCaseStore,
      issueRefundTool,
      mastra,
      responseAgent,
      searchSupportKnowledgeTool,
      triageAgent,
    } = await loadDeterministicRuntime();

    const inbound = await app.request("http://support.test/support/inbound", {
      body: JSON.stringify({
        externalId: `http-context-${crypto.randomUUID()}`,
        from: "alex@example.com",
        subject: "I was charged twice",
        body: "Please refund the duplicate subscription charge.",
      }),
      headers: {
        "content-type": "application/json",
        "x-correlation-id": "inbound-correlation",
        ...customerHeaders,
      },
      method: "POST",
    });
    expect(inbound.status).toBe(200);
    const { caseId } = inboundSupportResponseSchema.parse(await inbound.json());

    await vi.waitFor(async () => {
      expect((await runtimeCaseStore.get(caseId))?.status).toBe(
        "waiting_approval",
      );
    });
    for (const requestContext of [
      vi.mocked(triageAgent.generate).mock.calls[0]?.[1]?.requestContext,
      vi.mocked(responseAgent.generate).mock.calls[0]?.[1]?.requestContext,
      vi.mocked(searchSupportKnowledgeTool.execute).mock.calls[0]?.[1]
        ?.requestContext,
    ]) {
      expect(requestContext).toBeInstanceOf(RequestContext);
      expect(requestContext?.getRaw("correlationId")).toBe(
        "inbound-correlation",
      );
    }
    expect(
      vi.mocked(searchSupportKnowledgeTool.execute).mock.calls[0]?.[1]
        ?.tracingContext,
    ).toBeDefined();

    const approveNative = vi.spyOn(
      mastra.getAgent("refundExecutionAgent"),
      "approveToolCallGenerate",
    );

    const approved = await app.request(
      `http://support.test/support/cases/${caseId}/approve`,
      {
        headers: {
          "x-correlation-id": "approval-correlation",
          ...approverHeaders,
        },
        method: "POST",
        body: JSON.stringify({
          commandFingerprint: (
            (
              (await runtimeCaseStore.get(caseId))!.metadata as Record<
                string,
                unknown
              >
            ).refundCommand as { fingerprint: string }
          ).fingerprint,
        }),
      },
    );
    expect(approved.status).toBe(200);
    expect(supportCaseSchema.safeParse(await approved.json()).success).toBe(
      true,
    );
    expect(vi.mocked(issueRefundTool.execute)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        requestContext: expect.any(RequestContext),
      }),
    );
    expect(
      vi
        .mocked(issueRefundTool.execute)
        .mock.calls[0]?.[1]?.requestContext?.getRaw("correlationId"),
    ).toBe("inbound-correlation");
    // Native Agent snapshots retain the context from the tool-call run. The
    // approval boundary still supplies the new Hono context to the official
    // resume API, where its authenticated decision is durably recorded.
    expect(
      approveNative.mock.calls[0]?.[0]?.requestContext?.getRaw("correlationId"),
    ).toBe("approval-correlation");
  });
});
