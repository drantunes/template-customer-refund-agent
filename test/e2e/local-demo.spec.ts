import { expect, test } from "@playwright/test";
import { serve } from "@hono/node-server";
import { once } from "node:events";
import { rm } from "node:fs/promises";
import { Hono } from "hono";
import { RequestContext } from "@mastra/core/request-context";
import {
  deterministicJsonModel,
  deterministicRefundModel,
  type DeterministicRefundModel,
} from "../fixtures/deterministic-language-model";
import { temporaryDatabasePath } from "../support/temp-path";

const e2eApiPort = Number(process.env.E2E_API_PORT ?? "4111");
type Runtime = Awaited<ReturnType<typeof loadDeterministicRuntime>>;

async function loadDeterministicRuntime() {
  const databasePath = temporaryDatabasePath("phase008-admin-e2e");
  process.env.TURSO_DATABASE_URL = `file:${databasePath}`;
  process.env.SUPPORT_SOURCE = "mock";
  process.env.COMMERCE_SOURCE = "mock";
  process.env.LOCAL_AUTH_SIGNING_KEY =
    "phase008-playwright-signing-key-must-be-at-least-32-characters";
  delete process.env.TURSO_AUTH_TOKEN;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
  const { mastra, shutdownLocalMastra } =
    await import("../../src/mastra/index");
  const { caseStore } = await import("../../src/mastra/lib/case-store");
  mastra.getAgent("triageAgent").__updateModel({
    model: deterministicJsonModel({
      intent: "duplicate_charge",
      urgency: "normal",
      sentiment: "negative",
      requiresHumanReview: false,
      confidence: 1,
      rationale: "Deterministic browser triage.",
    }) as never,
  });
  mastra.getAgent("responseAgent").__updateModel({
    model: deterministicJsonModel({
      draftResponse: "A deterministic refund response.",
      citedSources: ["duplicate-charge-policy"],
      selectedPolicyExcerpts: [
        {
          source: "duplicate-charge-policy",
          excerpt:
            "If a customer's order or subscription shows more than one charge for the same billing period, the duplicate charge is eligible for a **full refund of the extra charge only**.",
        },
      ],
      recommendRefund: true,
      refundAmount: 20,
      refundCurrency: "USD",
      refundReason: "duplicate charge",
      requiresEscalation: false,
    }) as never,
  });
  const refundModels = new Map<string, DeterministicRefundModel>();
  mastra.getAgent("refundExecutionAgent").__updateModel({
    model: async () => {
      const action = await caseStore
        .getClient()
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
      let model = refundModels.get(command.fingerprint);
      if (!model) {
        model = deterministicRefundModel({
          caseId: command.approvalCaseId,
          orderId: command.orderId,
          amount: command.amount.minor / 100,
          currency: command.amount.currency,
          reason: command.reason,
          idempotencyKey: command.idempotencyKey,
          fingerprint: command.fingerprint,
        });
        refundModels.set(command.fingerprint, model);
      }
      return model;
    },
  });
  return { caseStore, databasePath, mastra, shutdownLocalMastra };
}

async function startSupportApi(runtime: Runtime) {
  const routes = await import("../../src/mastra/server/routes");
  const app = new Hono();
  app.use("/support/*", async (c, next) => {
    const requestContext = new RequestContext();
    c.set("mastra", runtime.mastra);
    c.set("requestContext", requestContext);
    await next();
  });
  app.post("/support/auth/login", routes.supportLoginRoute.handler);
  app.post("/support/inbound", routes.supportInboundRoute.handler);
  app.get("/support/cases", routes.supportCasesListRoute.handler);
  app.post(
    "/support/cases/:caseId/approve",
    routes.supportCaseApproveRoute.handler,
  );
  app.get(
    "/support/monitoring/summary",
    routes.supportMonitoringSummaryRoute.handler,
  );
  const server = serve({
    fetch: app.fetch,
    hostname: "127.0.0.1",
    port: e2eApiPort,
  });
  if (!server.listening) await once(server, "listening");
  return () =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
}

async function signIn(
  page: import("@playwright/test").Page,
  email: string,
  password: string,
) {
  await expect(page.getByText("Sign in to the local demo")).toBeVisible();
  await page.locator("#session-email").fill(email);
  await page.locator("#session-password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test("keeps the local admin approval UI after the customer portal is removed", async ({
  page,
}) => {
  const runtime = await loadDeterministicRuntime();
  const stopServer = await startSupportApi(runtime);
  try {
    const login = await fetch(
      `http://127.0.0.1:${e2eApiPort}/support/auth/login`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "alex@example.com",
          password: "local-customer-alex",
        }),
      },
    );
    const { token } = (await login.json()) as { token: string };
    const created = await fetch(
      `http://127.0.0.1:${e2eApiPort}/support/inbound`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          externalId: "phase008-admin-approval",
          from: "alex@example.com",
          subject: "Approve this synthetic refund",
          body: "Please refund the duplicate charge for ORD-1001.",
        }),
      },
    );
    const { caseId } = (await created.json()) as { caseId: string };
    await expect
      .poll(async () => (await runtime.caseStore.get(caseId))?.status)
      .toBe("waiting_approval");
    await page.goto("/admin");
    await signIn(page, "approver@local.test", "local-approver");
    await expect(page.getByText("Support admin")).toBeVisible();
    await page
      .getByRole("button", { name: "Approve this synthetic refund" })
      .click();
    await expect(page.getByText("Refund approval requested")).toBeVisible();
    await page.route(`**/support/cases/${caseId}/approve`, (route) =>
      route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ error: "Authentication required." }),
      }),
    );
    await page.getByRole("button", { name: "Approve refund" }).click();
    await expect(page.getByText("Sign in to the local demo")).toBeVisible();
    expect(await runtime.caseStore.approvalDecision(caseId)).toBeUndefined();
    await page.unroute(`**/support/cases/${caseId}/approve`);
    await signIn(page, "approver@local.test", "local-approver");
    await page
      .getByRole("button", { name: "Approve this synthetic refund" })
      .click();
    await page.getByRole("button", { name: "Approve refund" }).click();
    await expect(page.getByText("Refund approved")).toBeVisible();
    await expect
      .poll(async () => (await runtime.caseStore.get(caseId))?.status)
      .toBe("resolved");
    const effects = await runtime.caseStore
      .getClient()
      .execute(
        "SELECT COUNT(*) AS count FROM local_refunds WHERE tenant_id = ? AND provider_account_id = ?",
        ["local-demo", "local-demo"],
      );
    expect(Number(effects.rows[0]?.count)).toBe(1);
  } finally {
    await stopServer();
    await runtime.shutdownLocalMastra();
    await Promise.all(
      [
        runtime.databasePath,
        `${runtime.databasePath}-shm`,
        `${runtime.databasePath}-wal`,
      ].map((path) => rm(path, { force: true })),
    );
  }
});
