import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHonoServer } from "@mastra/deployer/server";
import { SpanType } from "@mastra/core/observability";
import { TestExporter } from "@mastra/observability";
import { issueLocalSession } from "../../src/mastra/server/auth";
import { deterministicJsonModel } from "../fixtures/deterministic-language-model";

const databases: string[] = [];
const shutdowns: Array<() => Promise<void>> = [];

async function configuredServer() {
  const path = `/private/tmp/phase003-built-in-auth-${crypto.randomUUID()}.db`;
  databases.push(path, `${path}-shm`, `${path}-wal`);
  process.env.TURSO_DATABASE_URL = `file:${path}`;
  process.env.SUPPORT_SOURCE = "mock";
  vi.resetModules();
  vi.doMock("@mastra/core/llm", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@mastra/core/llm")>();
    return {
      ...actual,
      ModelRouterEmbeddingModel: class DeterministicEmbeddingModel {},
    };
  });
  vi.doMock("../../src/mastra/evals", () => ({
    responseAgentScorers: {},
    triageAgentScorers: {},
    supportEvalScorerRegistry: {},
  }));
  const { mastra, shutdownLocalMastra } =
    await import("../../src/mastra/index");
  shutdowns.push(shutdownLocalMastra);
  return {
    mastra,
    server: await createHonoServer(mastra, { browserStream: false }),
  };
}

afterEach(async () => {
  await Promise.allSettled(shutdowns.splice(0).map((shutdown) => shutdown()));
  vi.restoreAllMocks();
  vi.doUnmock("../../src/mastra/evals");
  vi.doUnmock("@mastra/core/llm");
  await Promise.all(
    databases.splice(0).map((path) => rm(path, { force: true })),
  );
});

describe("configured Mastra built-in API authorization", () => {
  it("gives local staff and admins a credential-backed read-only Studio registry scope", async () => {
    const { server } = await configuredServer();
    const unauthenticated = await server.request(
      "http://support.test/api/agents",
    );
    expect(unauthenticated.status).toBe(401);

    const signIn = await server.request(
      "http://support.test/api/auth/credentials/sign-in",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "agent@local.test",
          password: "local-support-agent",
        }),
      },
    );
    expect(signIn.status).toBe(200);
    const staffSession = (await signIn.json()) as { token: string };
    const staffHeaders = { authorization: `Bearer ${staffSession.token}` };
    const capabilities = await server.request(
      "http://support.test/api/auth/capabilities",
      { headers: staffHeaders },
    );
    expect(capabilities.status).toBe(200);
    expect(await capabilities.json()).toMatchObject({
      enabled: true,
      user: { id: "support-agent-demo", email: "agent@local.test" },
    });
    expect(
      (
        await server.request("http://support.test/api/agents", {
          headers: staffHeaders,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await server.request("http://support.test/api/workflows", {
          headers: staffHeaders,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await server.request("http://support.test/api/tools", {
          headers: staffHeaders,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await server.request("http://support.test/api/agents/triage-agent", {
          headers: staffHeaders,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await server.request(
          "http://support.test/api/workflows/resolve-support-case",
          { headers: staffHeaders },
        )
      ).status,
    ).toBe(200);

    const admin = await server.request("http://support.test/api/workflows", {
      headers: {
        authorization: `Bearer ${issueLocalSession({ id: "admin-demo" })}`,
      },
    });
    expect(admin.status).toBe(200);

    const customer = await server.request("http://support.test/api/agents", {
      headers: {
        authorization: `Bearer ${issueLocalSession({ id: "customer-alex" })}`,
      },
    });
    expect(customer.status).toBe(403);
    const otherTenant = await server.request(
      "http://support.test/api/workflows",
      {
        headers: {
          authorization: `Bearer ${issueLocalSession({ id: "other-tenant-agent" })}`,
        },
      },
    );
    expect(otherTenant.status).toBe(403);
    expect(
      (
        await server.request(
          "http://support.test/api/workflows/resolveSupportCaseWorkflow/runs",
          { headers: staffHeaders },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await server.request("http://support.test/api/workflows/run-counts", {
          headers: staffHeaders,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await server.request(
          "http://support.test/api/tools/issue-refund/execute",
          {
            method: "POST",
            headers: { ...staffHeaders, "content-type": "application/json" },
            body: JSON.stringify({ data: {} }),
          },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await server.request("http://support.test/api/memory/threads", {
          headers: staffHeaders,
        })
      ).status,
    ).toBe(403);
  });

  it("redacts application prose before configured span and log storage export", async () => {
    const { mastra } = await configuredServer();
    const observability = mastra.observability.getSelectedInstance({})!;
    const logExporter = new TestExporter();
    observability.registerExporter!(logExporter);
    const span = observability.startSpan({
      name: "support-privacy-probe",
      type: SpanType.GENERIC,
      input: {
        body: "SYNTHETIC-PRIVATE-NOTE-003 customer@example.test",
        secret: "SYNTHETIC-SECRET-003",
      },
      metadata: {
        customerMessage: "SYNTHETIC-PRIVATE-NOTE-003",
        caseId: "case-diagnostic-003",
        status: "failed",
      },
    });
    span.error({
      error: new Error("SYNTHETIC-ERROR-003 customer@example.test"),
      endSpan: true,
    });

    mastra
      .getLogger()
      .child({
        customerMessage: "SYNTHETIC-PRIVATE-NOTE-003",
        customerEmail: "customer@example.test",
        caseId: "case-diagnostic-003",
      })
      .error("SYNTHETIC-PRIVATE-NOTE-003", {
        status: "failed",
        error: new Error("SYNTHETIC-ERROR-003"),
        secret: "SYNTHETIC-SECRET-003",
      });
    await mastra.observability.flush();

    const store = (await mastra.getStorage()!.getStore("observability")) as {
      getTrace(args: { traceId: string }): Promise<unknown>;
    };
    const trace = await store.getTrace({ traceId: span.traceId });
    const exportedLogs = logExporter.getLogEvents();
    expect(exportedLogs).toHaveLength(1);
    const exported = JSON.stringify({ trace, exportedLogs });
    for (const marker of [
      "SYNTHETIC-PRIVATE-NOTE-003",
      "SYNTHETIC-SECRET-003",
      "SYNTHETIC-ERROR-003",
      "customer@example.test",
    ])
      expect(exported).not.toContain(marker);
    expect(exported).toContain("case-diagnostic-003");
    expect(exported).toContain("failed");
  });

  it("flushes real registered generation spans to LibSQL and preserves numeric usage", async () => {
    const { mastra } = await configuredServer();
    const { triageResultSchema } =
      await import("../../src/mastra/domain/support-case");
    const triage = mastra.getAgent("triageAgent");
    triage.__updateModel({
      model: deterministicJsonModel({
        intent: "other",
        urgency: "normal",
        sentiment: "neutral",
        requiresHumanReview: false,
        confidence: 0.9,
        rationale: "synthetic",
      }) as never,
    });
    const result = await triage.generate(
      [{ role: "user", content: "Synthetic trace request." }],
      { structuredOutput: { schema: triageResultSchema } },
    );
    expect(result.traceId).toBeTruthy();
    await mastra.observability.flush();
    const store = (await mastra.getStorage()!.getStore("observability")) as {
      getTrace(args: { traceId: string }): Promise<{
        spans: Array<{
          spanType: string;
          attributes?: Record<string, unknown>;
        }>;
      } | null>;
    };
    const trace = await store.getTrace({ traceId: result.traceId! });
    expect(
      trace?.spans.some((span) => span.spanType === "model_generation"),
    ).toBe(true);
    expect(
      trace?.spans.some((span) => span.spanType === "model_inference"),
    ).toBe(true);
    const generation = trace?.spans.find(
      (span) => span.spanType === "model_generation",
    );
    expect(generation?.attributes).toMatchObject({
      usage: { inputTokens: 1, outputTokens: 1 },
    });
  });
});
