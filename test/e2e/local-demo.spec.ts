import { expect, test } from "@playwright/test";
import { serve } from "@hono/node-server";
import { once } from "node:events";
import { rm } from "node:fs/promises";
import { Hono } from "hono";

type Runtime = Awaited<ReturnType<typeof loadDeterministicRuntime>>;

async function loadDeterministicRuntime() {
  const databasePath = `/private/tmp/phase001-e2e-${crypto.randomUUID()}.db`;
  process.env.TURSO_DATABASE_URL = `file:${databasePath}`;
  process.env.SUPPORT_SOURCE = "mock";
  // Constructor-time provider validation requires a key. The harness replaces every
  // generation and embedding execution before a workflow begins, so this placeholder
  // cannot reach an external provider.
  process.env.OPENAI_API_KEY = "phase001-playwright-placeholder";

  const [{ mastra }, { caseStore }] = await Promise.all([
    import("../../src/mastra/index"),
    import("../../src/mastra/lib/case-store"),
  ]);
  const triageAgent = mastra.getAgent("triageAgent");
  const responseAgent = mastra.getAgent("responseAgent");
  const searchTool = mastra.getTool("searchSupportKnowledgeTool");

  triageAgent.generate = async () =>
    ({
      object: {
        intent: "duplicate_charge",
        urgency: "normal",
        sentiment: "negative",
        requiresHumanReview: true,
        confidence: 1,
        rationale: "Playwright deterministic model double.",
      },
      usage: { inputTokens: 1, outputTokens: 1 },
      response: { modelId: "deterministic/triage" },
    }) as never;
  responseAgent.generate = async (messages) => {
    const noRefund = JSON.stringify(messages).includes("update my address");
    return {
      object: {
        draftResponse: "A deterministic refund response.",
        citedSources: ["duplicate-charge-policy"],
        recommendRefund: !noRefund,
        refundAmount: noRefund ? undefined : 49,
        refundCurrency: noRefund ? undefined : "USD",
        refundReason: noRefund ? undefined : "duplicate charge",
        requiresEscalation: false,
      },
      usage: { inputTokens: 1, outputTokens: 1 },
      response: { modelId: "deterministic/response" },
    } as never;
  };
  searchTool.execute = async () =>
    ({
      sources: [
        {
          metadata: {
            title: "Duplicate charge policy",
            source: "duplicate-charge-policy",
            text: "Deterministic policy evidence.",
          },
          score: 1,
        },
      ],
    }) as never;

  return { caseStore, databasePath, mastra };
}

async function startSupportApi(runtime: Runtime) {
  const routes = await import("../../src/mastra/server/routes");
  const app = new Hono();
  app.use("/support/*", async (c, next) => {
    c.set("mastra", runtime.mastra);
    await next();
  });
  app.post("/support/inbound", routes.supportInboundRoute.handler);
  app.get("/support/cases", routes.supportCasesListRoute.handler);
  app.get("/support/cases/:caseId", routes.supportCaseDetailRoute.handler);
  app.post(
    "/support/cases/:caseId/approve",
    routes.supportCaseApproveRoute.handler,
  );
  app.post(
    "/support/cases/:caseId/reject",
    routes.supportCaseRejectRoute.handler,
  );
  app.post(
    "/support/cases/:caseId/feedback",
    routes.supportCaseFeedbackRoute.handler,
  );
  app.get(
    "/support/monitoring/summary",
    routes.supportMonitoringSummaryRoute.handler,
  );
  app.post(
    "/support/knowledge/reindex",
    routes.supportKnowledgeReindexRoute.handler,
  );
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 4111 });
  if (!server.listening) await once(server, "listening");
  return () =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
}

test("renders the local deterministic demo and reaches the portal", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByText("Welcome to the demo")).toBeVisible();
  await page.getByRole("link", { name: "Let's go" }).click();
  await expect(page).toHaveURL(/\/portal$/);
  await expect(
    page.getByRole("heading", { name: "Customer portal" }),
  ).toBeVisible();
});

test("submits through real handlers and lets admin approve or reject the workflow", async ({
  page,
}) => {
  const runtime = await loadDeterministicRuntime();
  const stopServer = await startSupportApi(runtime);
  try {
    await page.goto("/portal");
    await page.getByLabel("Subject").fill("I was charged twice");
    await page
      .getByLabel("Message")
      .fill("Please refund the duplicate charge.");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByText("Your message is on its way")).toBeVisible();

    await expect
      .poll(async () => (await runtime.caseStore.list())[0]?.status)
      .toBe("waiting_approval");
    const supportCase = (await runtime.caseStore.list())[0]!;
    await page.goto(`/admin/${supportCase.id}`);
    await expect(page.getByText("Refund approval requested")).toBeVisible();
    await page.getByRole("button", { name: "Approve refund" }).click();
    await expect(page.getByText("Refund approved")).toBeVisible();
    await expect
      .poll(async () => (await runtime.caseStore.get(supportCase.id))?.status)
      .toBe("resolved");
    await page.goto("/portal");
    await page.getByRole("button", { name: "New message" }).click();
    await page.getByLabel("Subject").fill("Duplicate charge requires review");
    await page
      .getByLabel("Message")
      .fill("Please refund the duplicate charge.");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect
      .poll(async () => (await runtime.caseStore.list()).length)
      .toBe(2);
    const rejectedCase = (await runtime.caseStore.list()).find(
      (candidate) => candidate.id !== supportCase.id,
    );
    expect(rejectedCase).toBeDefined();
    await expect
      .poll(async () => (await runtime.caseStore.get(rejectedCase!.id))?.status)
      .toBe("waiting_approval");
    await page.goto(`/admin/${rejectedCase!.id}`);
    await page.getByRole("button", { name: "Reject and escalate" }).click();
    await expect(
      page.getByText("Refund rejected and case escalated"),
    ).toBeVisible();
    await expect
      .poll(async () => (await runtime.caseStore.get(rejectedCase!.id))?.status)
      .toBe("escalated");
    await page.goto("/portal");
    await page.getByRole("button", { name: "New message" }).click();
    await page.getByLabel("Subject").fill("How do I update my address?");
    await page.getByLabel("Message").fill("I need help updating my address.");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect
      .poll(async () => (await runtime.caseStore.list()).length)
      .toBe(3);
    const resolvedCase = (await runtime.caseStore.list()).find(
      (candidate) =>
        candidate.id !== supportCase.id && candidate.id !== rejectedCase!.id,
    );
    expect(resolvedCase).toBeDefined();
    await expect
      .poll(async () => (await runtime.caseStore.get(resolvedCase!.id))?.status)
      .toBe("resolved");
    await expect(
      page.getByText("A deterministic refund response.").first(),
    ).toBeVisible();

    const malformed = await page.evaluate(async () => {
      const response = await fetch("/support/inbound", {
        body: "{not-json",
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      return { body: await response.json(), status: response.status };
    });
    expect(malformed).toEqual({
      body: { error: "Invalid JSON body." },
      status: 400,
    });
    expect(await runtime.caseStore.list()).toHaveLength(3);
  } finally {
    await stopServer();
    await Promise.all(
      [
        runtime.databasePath,
        `${runtime.databasePath}-shm`,
        `${runtime.databasePath}-wal`,
      ].map((path) => rm(path, { force: true })),
    );
  }
});
