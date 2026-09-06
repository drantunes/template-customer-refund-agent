import { rm } from "node:fs/promises";
import type { LanguageModelV2 } from "@ai-sdk/provider";
import { RequestContext } from "@mastra/core/request-context";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deterministicJsonModel } from "../fixtures/deterministic-language-model";

const databaseFiles: string[] = [];
const runtimes: Array<{ shutdown(): Promise<void> }> = [];
const closeClients: Array<() => Promise<void>> = [];

function supervisorModel(
  foreignBinding: Record<string, string>,
): LanguageModelV2 {
  let call = 0;
  const tool = (toolName: string, input: Record<string, unknown>) => ({
    content: [
      {
        type: "tool-call" as const,
        toolCallId: `supervisor-call-${call}`,
        toolName,
        input: JSON.stringify(input),
      },
    ],
    finishReason: "tool-calls" as const,
    usage: { inputTokens: 1, outputTokens: 1 },
    warnings: [],
  });
  return {
    specificationVersion: "v2",
    provider: "phase004-test",
    modelId: "authenticated-supervisor",
    supportedUrls: {},
    async doGenerate() {
      call += 1;
      switch (call) {
        case 1:
          return tool("lookup_order", { orderId: "ORD-1001" });
        case 2:
          return tool("search_support_knowledge", {
            queryText: "duplicate charge policy",
            topK: 1,
          });
        case 3:
          return tool("agent-triageAgent", {
            prompt: "Classify the duplicate charge request.",
          });
        case 4:
          return tool("agent-responseAgent", {
            prompt: "Draft a read-only escalation; refunds require approval.",
          });
        case 5:
          return {
            content: [
              {
                type: "text" as const,
                text: "The order and policy were reviewed. Refund approval remains required.",
              },
            ],
            finishReason: "stop" as const,
            usage: { inputTokens: 1, outputTokens: 1 },
            warnings: [],
          };
        case 6:
          return tool("lookup_order", {
            orderId: "ORD-1001",
            binding: foreignBinding,
          });
        default:
          return {
            content: [
              {
                type: "text" as const,
                text: "The foreign account was not read; this remains a read-only case review.",
              },
            ],
            finishReason: "stop" as const,
            usage: { inputTokens: 1, outputTokens: 1 },
            warnings: [],
          };
      }
    },
    async doStream() {
      throw new Error("deterministic test model only supports generate");
    },
  };
}

afterEach(async () => {
  await Promise.allSettled(
    runtimes.splice(0).map((runtime) => runtime.shutdown()),
  );
  await Promise.allSettled(closeClients.splice(0).map((close) => close()));
  vi.restoreAllMocks();
  delete process.env.SUPPORT_KNOWLEDGE_RETRIEVAL;
  await Promise.all(
    databaseFiles.splice(0).map((path) => rm(path, { force: true })),
  );
});

describe("registered support supervisor read-only acceptance", () => {
  it("executes two authenticated native turns with real specialists, scoped reads, and denied foreign binding", async () => {
    const databasePath = `/private/tmp/phase004-supervisor-${crypto.randomUUID()}.db`;
    databaseFiles.push(
      databasePath,
      `${databasePath}-shm`,
      `${databasePath}-wal`,
    );
    process.env.TURSO_DATABASE_URL = `file:${databasePath}`;
    process.env.PHASE003_DISABLE_EVALS = "1";
    vi.resetModules();

    const [
      { mastra },
      { caseStore },
      { publishKnowledge },
      providers,
      { localRuntime },
      auth,
      routes,
      sqlite,
      supportCase,
    ] = await Promise.all([
      import("../../src/mastra/index"),
      import("../../src/mastra/lib/case-store"),
      import("../../src/mastra/lib/publish-knowledge"),
      import("../../src/mastra/providers/registry"),
      import("../../src/mastra/runtime/local-runtime"),
      import("../../src/mastra/server/auth"),
      import("../../src/mastra/server/routes"),
      import("../../src/mastra/lib/sqlite-client"),
      import("../../src/mastra/domain/support-case"),
    ]);
    runtimes.push(mastra);
    closeClients.push(sqlite.closeSharedLocalSqliteClient);

    const binding = {
      tenantId: "local-demo",
      providerKind: "local" as const,
      providerAccountId: "local-demo",
      externalConversationId: `supervisor-primary-${crypto.randomUUID()}`,
    };
    const foreignBinding = {
      tenantId: "other-tenant",
      providerKind: "local" as const,
      providerAccountId: "other-account",
      externalConversationId: `supervisor-foreign-${crypto.randomUUID()}`,
    };
    providers.registerProviderRegistry(localRuntime, [foreignBinding]);
    await providers.ensureProviderFixtures(binding);
    await providers.ensureProviderFixtures(foreignBinding);
    await publishKnowledge(binding);
    const createCase = async (
      id: string,
      ownerId: string,
      customerEmail: string,
      providerBinding: typeof binding | typeof foreignBinding,
    ) =>
      caseStore.acceptInbound(
        {
          id,
          externalId: `supervisor-event-${id}`,
          source: "mock-email",
          status: "new",
          subject: "Duplicate charge",
          customer: { email: customerEmail },
          messages: [
            {
              id: `message-${id}`,
              author: "customer",
              body: "Please investigate this duplicate charge.",
              createdAt: new Date().toISOString(),
            },
          ],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          metadata: {
            ownerId,
            providerBinding,
            providerBindings: {
              support: providerBinding,
              commerce: providerBinding,
              transactions: providerBinding,
              knowledge: providerBinding,
            },
          },
        },
        `event-${id}`,
        `run-${id}`,
      );
    const caseId = `supervisor-primary-${crypto.randomUUID()}`;
    await createCase(caseId, "customer-alex", "alex@example.com", binding);
    // Register a real second tenant/account before the model attempts to bind
    // its scoped read to it. A valid account is not authority for this case.
    await createCase(
      `supervisor-foreign-${crypto.randomUUID()}`,
      "other-tenant-agent",
      "agent@other.test",
      foreignBinding,
    );

    mastra.getAgent("triageAgent").__updateModel({
      model: deterministicJsonModel({
        intent: "duplicate_charge",
        urgency: "normal",
        sentiment: "neutral",
        requiresHumanReview: false,
        confidence: 0.9,
        rationale: "The request identifies a duplicate charge.",
      }) as never,
    });
    mastra.getAgent("responseAgent").__updateModel({
      model: deterministicJsonModel({
        draftResponse: "A specialist will review the duplicate charge.",
        citedSources: ["Duplicate Charge Policy"],
        recommendRefund: false,
        requiresEscalation: true,
        escalationReason: "Refund approval remains required.",
      }) as never,
    });
    const supervisor = mastra.getAgent("supportSupervisorAgent");
    supervisor.__updateModel({
      model: supervisorModel(foreignBinding) as never,
    });

    const app = new Hono();
    app.use("/support/*", async (c, next) => {
      c.set("mastra", mastra as never);
      c.set("requestContext", new RequestContext());
      await next();
    });
    app.post(
      "/support/cases/:caseId/supervisor",
      routes.supportCaseSupervisorRoute.handler,
    );
    const client = caseStore.getClientForTests();
    const counts = async () =>
      client.execute(
        "SELECT (SELECT COUNT(*) FROM support_cases) cases, (SELECT COUNT(*) FROM support_actions) actions, (SELECT COUNT(*) FROM support_outbox) outbox, (SELECT COUNT(*) FROM local_orders) orders, (SELECT COUNT(*) FROM local_knowledge) knowledge, (SELECT COUNT(*) FROM support_knowledge_generations) generations",
      );
    const before = JSON.stringify((await counts()).rows[0]);
    const headers = {
      "content-type": "application/json",
      authorization: `Bearer ${auth.issueLocalSession({ id: "support-agent-demo" })}`,
    };
    const first = await app.request(
      `http://support.test/support/cases/${caseId}/supervisor`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          message: "Inspect order and policy, then classify and draft.",
        }),
      },
    );
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      text: string;
      toolNames: string[];
      toolResults: Array<{
        toolName: string;
        result?: unknown;
        isError: boolean;
      }>;
    };
    expect(firstBody.text).toContain("Refund approval remains required");
    expect(firstBody.toolNames).toEqual([
      "lookup_order",
      "search_support_knowledge",
      "agent-triageAgent",
      "agent-responseAgent",
    ]);
    expect(firstBody.toolResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolName: "lookup_order",
          isError: false,
          result: expect.objectContaining({
            found: true,
            order: expect.objectContaining({ orderId: "ORD-1001" }),
          }),
        }),
        expect.objectContaining({
          toolName: "search_support_knowledge",
          isError: false,
          result: expect.objectContaining({
            sources: expect.arrayContaining([expect.anything()]),
          }),
        }),
        expect.objectContaining({
          toolName: "agent-triageAgent",
          isError: false,
        }),
        expect.objectContaining({
          toolName: "agent-responseAgent",
          isError: false,
        }),
      ]),
    );
    expect(JSON.stringify((await counts()).rows[0])).toBe(before);

    const second = await app.request(
      `http://support.test/support/cases/${caseId}/supervisor`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          message: "Now try the other registered account.",
        }),
      },
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      text: string;
      toolResults: Array<{
        toolName: string;
        result?: unknown;
        isError: boolean;
      }>;
    };
    expect(secondBody.text).toContain("foreign account was not read");
    expect(secondBody.toolResults).toEqual([
      expect.objectContaining({ toolName: "lookup_order", isError: true }),
    ]);
    expect(JSON.stringify(secondBody.toolResults[0]?.result)).toContain(
      "does not match the durable case",
    );
    const threadId = supportCase.threadIdForCase(caseId, binding.tenantId);
    const messages = await client.execute({
      sql: "SELECT COUNT(*) AS count FROM mastra_messages WHERE thread_id = ?",
      args: [threadId],
    });
    expect(Number(messages.rows[0]?.count)).toBeGreaterThanOrEqual(4);
    expect(JSON.stringify((await counts()).rows[0])).toBe(before);
    expect(Object.keys(await supervisor.listTools()).sort()).toEqual([
      "lookup_customer_refund_history",
      "lookup_order",
      "lookup_subscription",
      "search_support_knowledge",
    ]);
    const denied = await app.request(
      `http://support.test/support/cases/${caseId}/supervisor`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${auth.issueLocalSession({
            id: "other-tenant-agent",
          })}`,
        },
        body: JSON.stringify({ message: "Inspect it." }),
      },
    );
    expect(denied.status).toBe(403);
  });
});
