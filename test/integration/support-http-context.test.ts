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

const databaseFiles: string[] = [];
const mastraRuntimes: Array<{ shutdown(): Promise<void> }> = [];

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
  const { issueRefundTool } =
    await import("../../src/mastra/tools/issue-refund");
  const { responseAgent } =
    await import("../../src/mastra/agents/response-agent");
  const { searchSupportKnowledgeTool } =
    await import("../../src/mastra/tools/search-support-knowledge");
  const { triageAgent } = await import("../../src/mastra/agents/triage-agent");
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
  mastraRuntimes.push(mastra);

  const app = supportApp(mastra);
  app.post("/support/inbound", routes.supportInboundRoute.handler);
  app.post(
    "/support/cases/:caseId/approve",
    routes.supportCaseApproveRoute.handler,
  );
  return {
    app,
    mastra,
    caseStore: (await import("../../src/mastra/lib/case-store")).caseStore,
    issueRefundTool,
    responseAgent,
    searchSupportKnowledgeTool,
    triageAgent,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.doUnmock("@mastra/core/llm");
  await Promise.allSettled(
    mastraRuntimes.splice(0).map((runtime) => runtime.shutdown()),
  );
  await Promise.all(
    databaseFiles.splice(0).map((file) => rm(file, { force: true })),
  );
});

describe("support approval HTTP boundary", () => {
  it.each([
    ["approve", undefined, true],
    ["approve", '{"approverId":"alex","note":"ok"}', true],
    ["approve", "  \n", true],
    ["approve", "{not-json", false],
    ["reject", undefined, true],
    ["reject", '{"approverId":"alex","note":"ok"}', true],
    ["reject", "  \n", true],
    ["reject", "{not-json", false],
  ])(
    "%s honors optional and malformed request bodies through Hono",
    async (action, body, shouldResume) => {
      const resume = vi.fn().mockResolvedValue({ status: "success" });
      const mastra = {
        getWorkflow: () => ({
          createRun: async () => ({ resume }),
        }),
      };
      vi.spyOn(caseStore, "get").mockResolvedValue({
        id: "case-waiting",
        status: "waiting_approval",
        workflowRunId: "run-waiting",
      } as never);
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
      vi.spyOn(caseStore, "completeDispatch").mockResolvedValue(undefined);
      const app = approvalApp(mastra);
      const response = await app.request(
        `http://support.test/support/cases/case-waiting/${action}`,
        {
          method: "POST",
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
              approverId:
                body === undefined || body.trim() === ""
                  ? "demo-support-lead"
                  : "alex",
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

    vi.useFakeTimers();
    try {
      const request = app.request(
        `http://support.test/support/cases/${caseId}/approve`,
        { method: "POST" },
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

    vi.useFakeTimers();
    try {
      const request = app.request(
        `http://support.test/support/cases/${caseId}/approve`,
        { method: "POST" },
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
      { method: "POST" },
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

    const approved = await app.request(
      `http://support.test/support/cases/${caseId}/approve`,
      {
        headers: { "x-correlation-id": "approval-correlation" },
        method: "POST",
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
    ).toBe("approval-correlation");
  });
});
