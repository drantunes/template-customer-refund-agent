import { expect, test } from "@playwright/test";
import { serve } from "@hono/node-server";
import { once } from "node:events";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { Hono } from "hono";
import { RequestContext } from "@mastra/core/request-context";
import {
  deterministicJsonModel,
  deterministicRefundModel,
  type DeterministicRefundModel,
} from "../fixtures/deterministic-language-model";
import { temporaryDatabasePath } from "../support/temp-path";

type Runtime = Awaited<ReturnType<typeof loadDeterministicRuntime>>;
const captureDocumentationScreenshots =
  process.env.CAPTURE_LOCAL_DEMO_SCREENSHOTS === "1";

async function captureDocumentationScreenshot(
  page: import("@playwright/test").Page,
  name: "local-demo-portal.png" | "local-demo-admin.png",
) {
  if (!captureDocumentationScreenshots) return;
  const assets = resolve(import.meta.dirname, "../../docs/assets");
  await mkdir(assets, { recursive: true });
  await page.screenshot({ path: resolve(assets, name), fullPage: true });
}

const requestedApiPort = process.env.E2E_API_PORT ?? "4111";
const e2eApiPort = Number(requestedApiPort);
if (!Number.isInteger(e2eApiPort) || e2eApiPort < 1 || e2eApiPort > 65_535)
  throw new Error("E2E_API_PORT must be an integer from 1 through 65535.");

async function loadDeterministicRuntime() {
  const databasePath = temporaryDatabasePath("phase003-e2e");
  process.env.TURSO_DATABASE_URL = `file:${databasePath}`;
  delete process.env.TURSO_AUTH_TOKEN;
  process.env.SUPPORT_SOURCE = "mock";
  process.env.COMMERCE_SOURCE = "mock";
  process.env.PHASE003_DISABLE_EVALS = "1";
  process.env.LOCAL_AUTH_SIGNING_KEY =
    "phase003-playwright-signing-key-must-be-at-least-32-characters";
  process.env.OPENAI_API_KEY = "phase003-playwright-placeholder";

  const { mastra, shutdownLocalMastra } =
    await import("../../src/mastra/index");
  const { caseStore } = await import("../../src/mastra/lib/case-store");
  const triageAgent = mastra.getAgent("triageAgent");
  const responseAgent = mastra.getAgent("responseAgent");
  const refundExecutionAgent = mastra.getAgent("refundExecutionAgent");
  triageAgent.__updateModel({
    model: deterministicJsonModel({
      intent: "duplicate_charge",
      urgency: "normal",
      sentiment: "negative",
      requiresHumanReview: true,
      confidence: 1,
      rationale: "Deterministic browser triage.",
    }) as never,
  });
  responseAgent.__updateModel({
    model: deterministicJsonModel({
      draftResponse: "A deterministic refund response.",
      citedSources: ["duplicate-charge-policy"],
      recommendRefund: true,
      refundAmount: 20,
      refundCurrency: "USD",
      refundReason: "duplicate charge",
      requiresEscalation: false,
    }) as never,
  });
  const refundModels = new Map<string, DeterministicRefundModel>();
  const resolveRefundModel = async () => {
    const action = await caseStore
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
  };
  refundExecutionAgent.__updateModel({ model: resolveRefundModel });
  return {
    caseStore,
    databasePath,
    mastra,
    shutdownLocalMastra,
  };
}

async function startSupportApi(runtime: Runtime) {
  const routes = await import("../../src/mastra/server/routes");
  const app = new Hono();
  app.use("/support/*", async (c, next) => {
    const requestContext = new RequestContext();
    requestContext.setRaw("correlationId", c.req.header("x-correlation-id"));
    c.set("mastra", runtime.mastra);
    c.set("requestContext", requestContext);
    await next();
  });
  app.post("/support/auth/login", routes.supportLoginRoute.handler);
  app.post("/support/inbound", routes.supportInboundRoute.handler);
  app.get("/support/cases", routes.supportCasesListRoute.handler);
  app.get("/support/cases/:caseId", routes.supportCaseDetailRoute.handler);
  app.post(
    "/support/cases/:caseId/follow-ups",
    routes.supportCaseFollowUpRoute.handler,
  );
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

async function createCustomerCase(
  page: import("@playwright/test").Page,
  subject: string,
) {
  const newMessage = page.getByRole("button", { name: "New message" });
  if (await newMessage.isVisible()) await newMessage.click();
  await page.getByLabel("Subject").fill(subject);
  await page.getByLabel("Message").fill("Please refund the duplicate charge.");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("Your message is on its way")).toBeVisible();
  await page.keyboard.press("Escape");
}

async function createTerminalCase(
  runtime: Runtime,
  input: { id: string; ownerId: string; email: string; subject: string },
) {
  const createdAt = new Date().toISOString();
  await runtime.caseStore.create({
    id: input.id,
    externalId: `${input.id}-event`,
    source: "mock-email",
    customer: { email: input.email },
    subject: input.subject,
    messages: [
      {
        id: `${input.id}-message`,
        author: "customer",
        body: "Synthetic terminal case for browser session isolation.",
        createdAt,
      },
    ],
    status: "resolved",
    createdAt,
    updatedAt: createdAt,
    metadata: {
      ownerId: input.ownerId,
      providerBinding: {
        tenantId: "local-demo",
        providerKind: "local",
        providerAccountId: "local-demo",
        externalConversationId: input.id,
      },
    },
  });
}

test("renders the local deterministic demo and reaches the signed-in portal", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByText("Welcome to the demo")).toBeVisible();
  await page.getByRole("link", { name: "Let's go" }).click();
  await expect(page).toHaveURL(/\/portal$/);
  await expect(page.getByText("Sign in to the local demo")).toBeVisible();
});

async function assertMountedSessionIsolation(
  page: import("@playwright/test").Page,
  runtime: Runtime,
) {
  let releaseOldPortalList: (() => void) | undefined;
  let delayNextPortalList = true;
  let resolveOldPortalListCompleted: (() => void) | undefined;
  const oldPortalListCompleted = new Promise<void>((resolve) => {
    resolveOldPortalListCompleted = resolve;
  });
  await createTerminalCase(runtime, {
    id: "alex-terminal-session-case",
    ownerId: "customer-alex",
    email: "alex@example.com",
    subject: "Alex terminal session case",
  });
  await createTerminalCase(runtime, {
    id: "jordan-terminal-session-case",
    ownerId: "customer-jordan",
    email: "jordan@example.com",
    subject: "Jordan terminal session case",
  });

  await page.goto("/portal");
  await signIn(page, "alex@example.com", "local-customer-alex");
  await expect(page.getByText("Alex terminal session case")).toBeVisible();

  const oldPortalListStarted = new Promise<void>((resolve) => {
    void page.route("**/support/cases", async (route) => {
      if (!delayNextPortalList) {
        await route.continue();
        return;
      }
      delayNextPortalList = false;
      const response = await route.fetch();
      resolve();
      await new Promise<void>((release) => {
        releaseOldPortalList = release;
      });
      await route.fulfill({ response });
      resolveOldPortalListCompleted?.();
    });
  });
  await page.getByRole("button", { name: "Refresh cases" }).click();
  await oldPortalListStarted;

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByText("Sign in to the local demo")).toBeVisible();
  await expect(page.getByText("Alex terminal session case")).toHaveCount(0);
  await signIn(page, "jordan@example.com", "local-customer-jordan");
  await expect(page.getByText("Jordan terminal session case")).toBeVisible();
  await expect(page.getByText("Alex terminal session case")).toHaveCount(0);

  releaseOldPortalList?.();
  await oldPortalListCompleted;
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await expect(page.getByText("Alex terminal session case")).toHaveCount(0);

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByText("Sign in to the local demo")).toBeVisible();
  await page.goto("/admin");
  await signIn(page, "approver@local.test", "local-approver");
  await expect(page.getByText("Alex terminal session case")).toBeVisible();

  let releaseOldAdminList: (() => void) | undefined;
  let delayNextAdminList = true;
  let resolveOldAdminListCompleted: (() => void) | undefined;
  const oldAdminListCompleted = new Promise<void>((resolve) => {
    resolveOldAdminListCompleted = resolve;
  });
  const oldAdminListStarted = new Promise<void>((resolve) => {
    void page.route("**/support/cases", async (route) => {
      if (!delayNextAdminList) {
        await route.continue();
        return;
      }
      delayNextAdminList = false;
      const response = await route.fetch();
      resolve();
      await new Promise<void>((release) => {
        releaseOldAdminList = release;
      });
      await route.fulfill({ response });
      resolveOldAdminListCompleted?.();
    });
  });
  await oldAdminListStarted;
  await page.getByLabel("More admin actions").click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page.getByText("Sign in to the local demo")).toBeVisible();
  await expect(page.getByText("Alex terminal session case")).toHaveCount(0);
  await signIn(page, "agent@other.test", "local-other-agent");
  await expect(
    page.getByText("This session cannot review refunds."),
  ).toBeVisible();
  releaseOldAdminList?.();
  await oldAdminListCompleted;
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await expect(page.getByText("Alex terminal session case")).toHaveCount(0);
}

test("runs customer follow-up, native approval, rejection, access denial, and session lifecycle", async ({
  page,
}) => {
  const runtime = await loadDeterministicRuntime();
  const stopServer = await startSupportApi(runtime);
  try {
    await assertMountedSessionIsolation(page, runtime);
    await page.evaluate(() => localStorage.removeItem("support-demo:session"));
    await page.goto("/portal");
    await signIn(page, "alex@example.com", "local-customer-alex");
    await expect(
      page.getByRole("heading", { name: "Customer portal" }),
    ).toBeVisible();
    await page.evaluate(() => {
      const key = "support-demo:session";
      const value = JSON.parse(localStorage.getItem(key) ?? "{}");
      localStorage.setItem(
        key,
        JSON.stringify({ ...value, expiresAt: "2000-01-01T00:00:00.000Z" }),
      );
    });
    await page.reload();
    await expect(page.getByText("Sign in to the local demo")).toBeVisible();
    await signIn(page, "alex@example.com", "local-customer-alex");
    await expect(page.getByText("Alex terminal session case")).toBeVisible();
    await page.getByRole("button", { name: "New message" }).click();

    await createCustomerCase(page, "I was charged twice");
    await expect
      .poll(
        async () =>
          (await runtime.caseStore.list()).find((entry) =>
            entry.id.startsWith("case_"),
          )?.status,
      )
      .toBe("waiting_approval");
    await expect(
      page.getByText("A refund was recommended and is waiting for approval."),
    ).toBeVisible();
    await captureDocumentationScreenshot(page, "local-demo-portal.png");
    const supportCase = (await runtime.caseStore.list()).find((entry) =>
      entry.id.startsWith("case_"),
    )!;
    const firstTurn = (supportCase.metadata as Record<string, unknown>)
      .activeTurnId;
    const conversation = (
      (supportCase.metadata as Record<string, unknown>).providerBinding as {
        externalConversationId: string;
      }
    ).externalConversationId;
    await page
      .getByLabel("Follow-up message")
      .fill("Please keep this in the same conversation.");
    await page.getByRole("button", { name: "Send follow-up" }).click();
    await expect
      .poll(
        async () =>
          (await runtime.caseStore.get(supportCase.id))?.messages.length,
      )
      .toBe(2);
    await expect
      .poll(async () => (await runtime.caseStore.get(supportCase.id))?.status)
      .toBe("waiting_approval");
    const afterFollowUp = (await runtime.caseStore.get(supportCase.id))!;
    expect(afterFollowUp.messages).toHaveLength(2);
    expect(
      (afterFollowUp.metadata as Record<string, unknown>).activeTurnId,
    ).not.toBe(firstTurn);
    expect(
      (
        (afterFollowUp.metadata as Record<string, unknown>).providerBinding as {
          externalConversationId: string;
        }
      ).externalConversationId,
    ).toBe(conversation);
    const triageMemory = await runtime.mastra
      .getAgent("triageAgent")
      .getMemory();
    expect(triageMemory).toBeDefined();
    await triageMemory!.settled();
    const alexResourceId = "tenant_local-demo_owner_customer-alex";
    const supportThreadId = `tenant_local-demo_conversation_${supportCase.id}`;
    const supportThread = await triageMemory!.getThreadById({
      threadId: supportThreadId,
    });
    // These values come from Mastra's persisted thread record, not an ID helper.
    // The owner itself is a trusted case-store binding, established from the
    // signed browser session rather than the inbound payload.
    expect((supportCase.metadata as Record<string, unknown>).ownerId).toBe(
      "customer-alex",
    );
    expect(supportThread).toMatchObject({
      id: supportThreadId,
      resourceId: alexResourceId,
    });
    const fingerprint = (
      (afterFollowUp.metadata as Record<string, unknown>).refundCommand as {
        fingerprint: string;
      }
    ).fingerprint;

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByText("Sign in to the local demo")).toBeVisible();
    await page.goto(`/admin/${supportCase.id}`);
    await signIn(page, "approver@local.test", "local-approver");
    await expect(page.getByText("Refund approval requested")).toBeVisible();
    await expect(page.locator("code")).toContainText(fingerprint);
    await expect(page.getByRole("heading", { name: "Monitoring" })).toHaveCount(
      0,
    );
    expect(
      await page.evaluate(async () => {
        const session = JSON.parse(
          localStorage.getItem("support-demo:session") ?? "{}",
        );
        return (
          await fetch("/support/monitoring/summary", {
            headers: { authorization: `Bearer ${session.token}` },
          })
        ).status;
      }),
    ).toBe(403);
    await expect(page.getByText(/Request failed:/)).toHaveCount(0);
    await captureDocumentationScreenshot(page, "local-demo-admin.png");
    await page.getByRole("button", { name: "Approve refund" }).click();
    await expect(page.getByText("Refund approved")).toBeVisible();
    await expect
      .poll(async () => (await runtime.caseStore.get(supportCase.id))?.status)
      .toBe("resolved");
    expect(
      await runtime.caseStore.approvalDecision(supportCase.id),
    ).toMatchObject({
      approved: true,
      principalId: "approver-demo",
      commandFingerprint: fingerprint,
    });
    const effects = await runtime.caseStore
      .getClientForTests()
      .execute(
        "SELECT COUNT(*) AS count FROM local_refunds WHERE tenant_id = ? AND provider_account_id = ?",
        ["local-demo", "local-demo"],
      );
    expect(Number(effects.rows[0]?.count)).toBe(1);

    await page.getByLabel("More admin actions").click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await expect(page.getByText("Sign in to the local demo")).toBeVisible();

    await runtime.caseStore.create({
      id: "owner-denied",
      externalId: "owner-denied-event",
      source: "mock-email",
      customer: { email: "jordan@example.com" },
      subject: "Other owner",
      messages: [],
      status: "new",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {
        ownerId: "customer-jordan",
        providerBinding: {
          tenantId: "local-demo",
          providerKind: "local",
          providerAccountId: "local-demo",
          externalConversationId: "owner-denied",
        },
      },
    });
    await runtime.caseStore.create({
      id: "tenant-denied",
      externalId: "tenant-denied-event",
      source: "mock-email",
      customer: { email: "alex@example.com" },
      subject: "Other tenant",
      messages: [],
      status: "new",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {
        ownerId: "customer-alex",
        providerBinding: {
          tenantId: "other-tenant",
          providerKind: "local",
          providerAccountId: "other-tenant",
          externalConversationId: "tenant-denied",
        },
      },
    });
    await page.goto("/portal");
    await signIn(page, "alex@example.com", "local-customer-alex");
    await expect(
      page.getByRole("heading", { name: "Customer portal" }),
    ).toBeVisible();
    await expect(page.getByText("I was charged twice")).toBeVisible();
    await page.getByRole("button", { name: "New message" }).click();
    const denied = await page.evaluate(async () => {
      const session = JSON.parse(
        localStorage.getItem("support-demo:session") ?? "{}",
      );
      return Promise.all(
        ["owner-denied", "tenant-denied"].map(
          async (caseId) =>
            (
              await fetch(`/support/cases/${caseId}`, {
                headers: { authorization: `Bearer ${session.token}` },
              })
            ).status,
        ),
      );
    });
    expect(denied).toEqual([403, 403]);

    await createCustomerCase(page, "A separate refund request for review");
    await expect
      .poll(
        async () =>
          (await runtime.caseStore.list()).filter((entry) =>
            entry.id.startsWith("case_"),
          ).length,
      )
      .toBe(2);
    const rejected = (await runtime.caseStore.list()).find(
      (entry) => entry.id !== supportCase.id && entry.id.startsWith("case_"),
    )!;
    await expect
      .poll(async () => (await runtime.caseStore.get(rejected.id))?.status)
      .toBe("waiting_approval");
    const rejectedFingerprint = (
      (
        (await runtime.caseStore.get(rejected.id))!.metadata as Record<
          string,
          unknown
        >
      ).refundCommand as { fingerprint: string }
    ).fingerprint;
    const rejectedThreadId = `tenant_local-demo_conversation_${rejected.id}`;
    const rejectedThread = await triageMemory!.getThreadById({
      threadId: rejectedThreadId,
    });
    expect(rejectedThread).toMatchObject({
      id: rejectedThreadId,
      resourceId: alexResourceId,
    });
    const alexThreads = await triageMemory!.listThreads({
      filter: { resourceId: alexResourceId },
      perPage: false,
    });
    expect(alexThreads.threads.map((thread) => thread.id)).toEqual(
      expect.arrayContaining([supportThreadId, rejectedThreadId]),
    );
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.goto(`/admin/${rejected.id}`);
    await signIn(page, "approver@local.test", "local-approver");
    await expect(page.locator("code")).toContainText(rejectedFingerprint);
    await page.getByRole("button", { name: "Reject and escalate" }).click();
    await expect(
      page.getByText("Refund rejected and case escalated"),
    ).toBeVisible();
    await expect
      .poll(async () => (await runtime.caseStore.get(rejected.id))?.status)
      .toBe("escalated");
    expect(await runtime.caseStore.approvalDecision(rejected.id)).toMatchObject(
      {
        approved: false,
        principalId: "approver-demo",
        commandFingerprint: rejectedFingerprint,
      },
    );
    const effectsAfterRejection = await runtime.caseStore
      .getClientForTests()
      .execute(
        "SELECT COUNT(*) AS count FROM local_refunds WHERE tenant_id = ? AND provider_account_id = ?",
        ["local-demo", "local-demo"],
      );
    expect(Number(effectsAfterRejection.rows[0]?.count)).toBe(1);

    await page.getByLabel("More admin actions").click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await page.goto("/portal");
    await signIn(page, "jordan@example.com", "local-customer-jordan");
    await expect(page.getByText("Jordan terminal session case")).toBeVisible();
    await page.getByRole("button", { name: "New message" }).click();
    await createCustomerCase(page, "Jordan's separate refund request");
    await expect
      .poll(
        async () =>
          (await runtime.caseStore.list()).filter((entry) =>
            entry.id.startsWith("case_"),
          ).length,
      )
      .toBe(3);
    const jordanCase = (await runtime.caseStore.list()).find(
      (entry) =>
        entry.id.startsWith("case_") &&
        entry.customer.email === "jordan@example.com",
    )!;
    await expect
      .poll(async () => (await runtime.caseStore.get(jordanCase.id))?.status)
      .toBe("waiting_approval");
    const jordanThreadId = `tenant_local-demo_conversation_${jordanCase.id}`;
    const jordanThread = await triageMemory!.getThreadById({
      threadId: jordanThreadId,
    });
    expect((jordanCase.metadata as Record<string, unknown>).ownerId).toBe(
      "customer-jordan",
    );
    expect(jordanThread).toMatchObject({
      id: jordanThreadId,
      resourceId: "tenant_local-demo_owner_customer-jordan",
    });
    expect(jordanThread?.resourceId).not.toBe(alexResourceId);
    const alexThreadsAfterJordan = await triageMemory!.listThreads({
      filter: { resourceId: alexResourceId },
      perPage: false,
    });
    expect(
      alexThreadsAfterJordan.threads.map((thread) => thread.id),
    ).not.toContain(jordanThreadId);
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
    delete process.env.PHASE003_DISABLE_EVALS;
  }
});
