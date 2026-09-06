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

  it("aggregates native cost contexts and real delayed and failed provider-port spans", async () => {
    const { mastra } = await configuredServer();
    const { caseStore } = await import("../../src/mastra/lib/case-store");
    const { computeMonitoringSummary } =
      await import("../../src/mastra/lib/monitoring");
    const { defaultLocalBinding, deliverOutbox, localRuntime } =
      await import("../../src/mastra/runtime/local-runtime");
    const binding = defaultLocalBinding("operational-span-conversation");
    await localRuntime.seed(binding);
    const observability = mastra.observability.getSelectedInstance({})!;
    const root = observability.startSpan({
      name: "phase004-operational-test",
      type: SpanType.WORKFLOW_RUN,
    });
    const createdAt = new Date().toISOString();
    const makeCase = (id: string) => ({
      id,
      externalId: id,
      source: "mock-email" as const,
      customer: { email: "alex@example.com" },
      subject: "Operational span fixture",
      messages: [],
      status: "resolved" as const,
      createdAt,
      updatedAt: createdAt,
      traceId: root.traceId,
      metadata: { ownerId: "customer-alex", providerBinding: binding },
    });
    const slowCase = makeCase("operational-span-slow");
    const failingCase = makeCase("operational-span-failure");
    await caseStore.create(slowCase);
    await caseStore.create(failingCase);
    await caseStore.enqueueDelivery({
      id: "operational-span-slow-outbox",
      caseId: slowCase.id,
      binding,
      body: "slow synthetic delivery",
      status: "resolved",
    });
    await caseStore.enqueueDelivery({
      id: "operational-span-failure-outbox",
      caseId: failingCase.id,
      binding,
      body: "failing synthetic delivery",
      status: "resolved",
    });
    const support = localRuntime.support(binding);
    const registry = {
      support: () => ({
        kind: "local" as const,
        normalizeInbound: support.normalizeInbound.bind(support),
        addInternalNote: support.addInternalNote.bind(support),
        updateStatus: support.updateStatus.bind(support),
        deliver: async (...args: Parameters<typeof support.deliver>) => {
          if (args[3] === "operational-span-failure-outbox")
            throw new Error("synthetic provider failure");
          await new Promise<void>((resolve) => setTimeout(resolve, 15));
          return support.deliver(...args);
        },
      }),
      commerce: localRuntime.commerce.bind(localRuntime),
      transactions: localRuntime.transactions.bind(localRuntime),
      knowledge: localRuntime.knowledge.bind(localRuntime),
    };
    await deliverOutbox(registry, 10, caseStore, {
      mastra,
      tracingContext: { currentSpan: root },
    });

    const knownCost = root.createChildSpan({
      name: "known-native-cost",
      type: SpanType.MODEL_GENERATION,
      attributes: {
        model: "native-known",
        usage: { inputTokens: 3, outputTokens: 2 },
        costContext: { estimatedCost: 0.000123, costUnit: "usd" },
      },
    });
    knownCost.end();
    const unknownCost = root.createChildSpan({
      name: "unknown-native-cost",
      type: SpanType.MODEL_GENERATION,
      attributes: {
        model: "native-unknown",
        usage: { inputTokens: 4, outputTokens: 1 },
        costContext: { estimatedCost: 7, costUnit: "credits" },
      },
    });
    unknownCost.end();
    root.end();
    await mastra.observability.flush();

    const summary = await computeMonitoringSummary(mastra, binding.tenantId);
    expect(summary.telemetry.providerCalls).toContainEqual({
      operation: "support.deliver",
      calls: 2,
      errorRate: 0.5,
      p95Ms: expect.any(Number),
    });
    expect(
      summary.telemetry.providerCalls.find(
        (item) => item.operation === "support.deliver",
      )?.p95Ms,
    ).toBeGreaterThanOrEqual(10);
    expect(summary.telemetry.modelUsage).toContainEqual({
      model: "native-known",
      inputTokens: 3,
      outputTokens: 2,
      estimatedCostMicrosUsd: 123,
    });
    expect(summary.telemetry.modelUsage).toContainEqual({
      model: "native-unknown",
      inputTokens: 4,
      outputTokens: 1,
      estimatedCostMicrosUsd: null,
    });
    expect(summary.telemetry.unavailable).toContain("partial-model-cost");
  });

  it("keeps tenant domain metrics available when a trusted trace read fails", async () => {
    const { mastra, server } = await configuredServer();
    const { caseStore } = await import("../../src/mastra/lib/case-store");
    const { defaultLocalBinding } =
      await import("../../src/mastra/runtime/local-runtime");
    const binding = defaultLocalBinding("partial-trace-read");
    const createdAt = new Date().toISOString();
    await caseStore.create({
      id: "partial-trace-read-case",
      externalId: "partial-trace-read-event",
      source: "mock-email",
      customer: { email: "alex@example.com" },
      subject: "Trace retention fixture",
      messages: [],
      status: "resolved",
      createdAt,
      updatedAt: createdAt,
      traceId: "missing-or-unreadable-trace",
      metadata: { ownerId: "customer-alex", providerBinding: binding },
    });
    const storage = (await mastra.getStorage()!.getStore("observability")) as {
      getTrace(args: { traceId: string }): Promise<unknown>;
    };
    vi.spyOn(storage, "getTrace").mockRejectedValueOnce(
      new Error("synthetic retained-trace read failure"),
    );
    const response = await server.request(
      "http://support.test/support/monitoring/summary",
      {
        headers: {
          authorization: `Bearer ${issueLocalSession({ id: "admin-demo" })}`,
        },
      },
    );
    expect(response.status).toBe(200);
    const summary = (await response.json()) as {
      casesConsidered: number;
      funnel: { resolved: number };
      telemetry: { unavailable: string[] };
    };
    expect(summary.casesConsidered).toBe(1);
    expect(summary.funnel.resolved).toBe(1);
    expect(summary.telemetry.unavailable).toContain("partial-trace-read");
  });
});
