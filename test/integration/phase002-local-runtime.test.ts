import { rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { promisify } from "node:util";
import { createClient } from "@libsql/client";
import {
  CaseStore,
  StaleCaseWriteError,
} from "../../src/mastra/lib/case-store";
import {
  legacyAmountToMoney,
  money,
  moneyToLegacyAmount,
  refundFingerprint,
} from "../../src/mastra/lib/money";
import {
  deliverOutbox,
  LocalRuntime,
  recoverLocalWorkflows,
} from "../../src/mastra/runtime/local-runtime";
import { serializeSqliteClient } from "../../src/mastra/lib/sqlite-client";
import {
  createLocalLoopbackFacade,
  type LoopbackFetch,
  LoopbackHttpCommerceProvider,
  LoopbackHttpProviderRegistry,
} from "../../src/mastra/providers/loopback-http";
import type {
  CaseProviderBindings,
  ProviderBinding,
  ProviderRegistry,
} from "../../src/mastra/providers/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

const files: string[] = [];
const execFileAsync = promisify(execFile);
const binding: ProviderBinding = {
  tenantId: "tenant-a",
  providerKind: "local",
  providerAccountId: "account-a",
  externalConversationId: "conversation-a",
};
function supportCase(id: string, externalId = id) {
  const createdAt = "2026-09-05T00:00:00.000Z";
  return {
    id,
    externalId,
    source: "mock-email" as const,
    customer: { email: "alex@example.com" },
    subject: "Duplicate",
    messages: [
      {
        id: `message-${id}`,
        author: "customer" as const,
        body: "Refund please",
        createdAt,
      },
    ],
    status: "new" as "new" | "waiting_approval",
    createdAt,
    updatedAt: createdAt,
    metadata: { providerBinding: binding },
  };
}
async function approvedCommand(store: CaseStore, key: string, minor: number) {
  const amount = money("USD", minor);
  const base = {
    approvalCaseId: `approval-${key}`,
    binding,
    orderId: "ORD-1001",
    amount,
    reason: "duplicate",
    idempotencyKey: key,
  };
  const command = { ...base, fingerprint: refundFingerprint(base) };
  await store.create({
    ...supportCase(base.approvalCaseId),
    status: "waiting_approval",
    approval: { approved: true, approverId: "local-approver" },
    metadata: { providerBinding: binding, refundCommand: command },
  });
  await store.saveAction(
    base.approvalCaseId,
    "refund-command",
    command.fingerprint,
    command,
  );
  return command;
}
async function runtime() {
  const path = `/private/tmp/phase002-${crypto.randomUUID()}.db`;
  files.push(path, `${path}-shm`, `${path}-wal`);
  const store = new CaseStore({ url: `file:${path}` });
  await store.list();
  return { path, store, local: new LocalRuntime(store.getClientForTests()) };
}

async function realLoopback(fetcher: LoopbackFetch) {
  const server = createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const request = new Request(`http://loopback${incoming.url}`, {
      method: incoming.method,
      headers: incoming.headers as HeadersInit,
      body: chunks.length ? Buffer.concat(chunks) : undefined,
    });
    const response = await fetcher(request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No loopback port.");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    fetch: async (request: Request) =>
      fetch(`${baseUrl}${new URL(request.url).pathname}`, {
        method: request.method,
        headers: request.headers,
        body: request.method === "GET" ? undefined : await request.text(),
      }),
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

afterEach(async () => {
  await Promise.all(files.splice(0).map((file) => rm(file, { force: true })));
});

describe("Phase 002 persistent local runtime", () => {
  it("migrates legacy data down and up without touching unrelated tables, then rejects stale writes", async () => {
    const { store } = await runtime();
    await store
      .getClientForTests()
      .execute("CREATE TABLE mastra_owned_probe (id TEXT PRIMARY KEY)");
    await store
      .getClientForTests()
      .execute("INSERT INTO mastra_owned_probe VALUES ('keep')");
    await store.create(supportCase("legacy"));
    await store.migrate(1);
    await store.migrate(2);
    expect((await store.get("legacy"))?.externalId).toBe("legacy");
    expect(
      (
        await store
          .getClientForTests()
          .execute("SELECT id FROM mastra_owned_probe")
      ).rows,
    ).toHaveLength(1);
    await store.update("legacy", { subject: "Changed" }, 1);
    await expect(
      store.update("legacy", { subject: "Stale" }, 1),
    ).rejects.toBeInstanceOf(StaleCaseWriteError);
    await store.close();
  });

  it("reopens a tenant-scoped database and permits the same provider event identity in independent accounts", async () => {
    const { path, store } = await runtime();
    const secondBinding = {
      ...binding,
      tenantId: "tenant-b",
      providerAccountId: "account-b",
    };
    await store.acceptInbound(
      supportCase("tenant-a", "shared-event"),
      "event-a",
      "run-a",
    );
    const caseB = supportCase("tenant-b", "shared-event");
    caseB.metadata.providerBinding = secondBinding;
    await expect(
      store.acceptInbound(caseB, "event-b", "run-b"),
    ).resolves.toEqual({
      caseId: "tenant-b",
      isNew: true,
    });
    await store.close();

    const reopened = new CaseStore({ url: `file:${path}` });
    expect((await reopened.list()).map((entry) => entry.id).sort()).toEqual([
      "tenant-a",
      "tenant-b",
    ]);
    await reopened.close();
  });

  it("persists independent port bindings and rejects a later redirect", async () => {
    const { store } = await runtime();
    const commerce = {
      ...binding,
      tenantId: "tenant-commerce",
      providerAccountId: "account-commerce",
    };
    const bindings: CaseProviderBindings = {
      support: binding,
      commerce,
      transactions: binding,
      knowledge: binding,
    };
    const created = await store.create({
      ...supportCase("bound-case"),
      metadata: { providerBindings: bindings },
    });
    expect(
      (created.metadata.providerBindings as CaseProviderBindings).commerce,
    ).toEqual(commerce);
    await expect(
      store.update("bound-case", {
        metadata: {
          providerBindings: {
            ...bindings,
            transactions: { ...binding, providerAccountId: "redirected" },
          },
        },
      }),
    ).rejects.toThrow("transactions provider binding is immutable");
    await store.close();
  });

  it("rolls a failed case-identity migration back without recording a completed version", async () => {
    const { store } = await runtime();
    await store.create(supportCase("bad-migration"));
    await store.migrate(3);
    await store.getClientForTests().execute({
      sql: "UPDATE support_cases SET provider_binding = 'not-json' WHERE id = ?",
      args: ["bad-migration"],
    });
    await expect(store.migrate(4)).rejects.toThrow();
    const versions = await store
      .getClientForTests()
      .execute(
        "SELECT version FROM support_schema_migrations ORDER BY version",
      );
    expect(versions.rows.map((row) => Number(row.version))).toEqual([1, 2, 3]);
    expect(
      await store
        .getClientForTests()
        .execute("SELECT id FROM support_cases WHERE id = 'bad-migration'"),
    ).toMatchObject({
      rows: [expect.objectContaining({ id: "bad-migration" })],
    });
    await store.close();
  });

  it("deduplicates inbound acceptance atomically and keeps its generated dispatch durable after reopen", async () => {
    const { store } = await runtime();
    const first = await store.acceptInbound(
      supportCase("case-one", "event-one"),
      "event-one",
      "run-one",
    );
    const second = await store.acceptInbound(
      supportCase("case-two", "event-one"),
      "event-one",
      "run-two",
    );
    expect(first).toEqual({ caseId: "case-one", isNew: true });
    expect(second).toEqual({ caseId: "case-one", isNew: false });
    const dispatch = await store
      .getClientForTests()
      .execute(
        "SELECT run_id, state FROM support_dispatch WHERE case_id = 'case-one'",
      );
    expect(dispatch.rows[0]).toMatchObject({
      run_id: "run-one",
      state: "pending",
    });
    await store.close();
  });

  it("retries a real competing SQLite seed after the holder commits on the event loop", async () => {
    const { path, store, local } = await runtime();
    const holderClient = createClient({ url: `file:${path}`, timeout: 0 });
    await holderClient.execute("PRAGMA busy_timeout = 0");
    await holderClient.execute("BEGIN IMMEDIATE");

    const release = new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        void holderClient.execute("COMMIT").then(() => resolve(), reject);
      }, 20);
    });
    await expect(local.seed(binding)).resolves.toBeUndefined();
    await release;
    expect(await local.findOrder(binding, "", "ORD-1001")).toBeTruthy();
    holderClient.close();
    await store.close();
  });

  it("keeps a serialized transaction fenced through a failed commit until rollback or close", async () => {
    let commitAttempts = 0;
    let rollbacks = 0;
    let executes = 0;
    const rawTransaction = {
      commit: async () => {
        commitAttempts += 1;
        throw new Error("commit failed");
      },
      rollback: async () => {
        rollbacks += 1;
      },
      close: () => undefined,
      execute: async () => ({ rows: [] }),
    };
    const client = serializeSqliteClient({
      closed: false,
      protocol: "file",
      execute: async () => {
        executes += 1;
        return { rows: [] };
      },
      transaction: async () => rawTransaction,
      batch: async () => [],
      executeMultiple: async () => undefined,
      migrate: async () => undefined,
      sync: async () => undefined,
      reconnect: async () => undefined,
      close: () => undefined,
    } as never);
    const transaction = await client.transaction("write");
    await expect(transaction.commit()).rejects.toThrow("commit failed");
    const queued = client.execute("SELECT 1");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(executes).toBe(0);
    await transaction.rollback();
    await queued;
    expect(commitAttempts).toBe(1);
    expect(rollbacks).toBe(1);
    expect(executes).toBe(1);

    const closedTransaction = await client.transaction("write");
    const releasedByClose = client.execute("SELECT 1");
    await closedTransaction.close();
    await releasedByClose;
    expect(executes).toBe(2);
  });

  it("uses minor units and durable command fingerprints to prevent over-refund and conflicting replay", async () => {
    const { store, local } = await runtime();
    await local.seed(binding);
    const commandA = await approvedCommand(store, "case-a", 2400);
    const first = await local.issueRefund(commandA);
    const replay = await local.issueRefund(commandA);
    expect(replay).toMatchObject({ refundId: first.refundId, replayed: true });
    const conflictingBase = { ...commandA, amount: money("USD", 2300) };
    const conflicting = {
      ...conflictingBase,
      fingerprint: refundFingerprint(conflictingBase),
    };
    await store.update(commandA.approvalCaseId, {
      metadata: { providerBinding: binding, refundCommand: conflicting },
    });
    await expect(local.issueRefund(conflicting)).rejects.toThrow(
      "matching persisted approved command",
    );
    await local.issueRefund(await approvedCommand(store, "case-b", 2500));
    await expect(
      local.issueRefund(await approvedCommand(store, "case-c", 1)),
    ).rejects.toThrow("remaining balance");
    await store.close();
  });

  it("rejects malformed and concurrent over-refunds against one persisted balance", async () => {
    const { path, store, local } = await runtime();
    await local.seed(binding);
    await expect(
      local.issueRefund(await approvedCommand(store, "zero", 0)),
    ).rejects.toThrow("positive safe integer");
    const secondClient = createClient({ url: `file:${path}` });
    const secondRuntime = new LocalRuntime(secondClient);
    const concurrentA = await approvedCommand(store, "concurrent-a", 3000);
    const concurrentB = await approvedCommand(store, "concurrent-b", 3000);
    const results = await Promise.allSettled([
      local.issueRefund(concurrentA),
      secondRuntime.issueRefund(concurrentB),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(await local.refunds(binding, "ORD-1001")).toHaveLength(1);
    secondClient.close();
    await store.close();
  });

  it("seeds and resets only the requested binding and rejects ambiguous local lookups", async () => {
    const { store, local } = await runtime();
    const other = {
      ...binding,
      tenantId: "tenant-b",
      providerAccountId: "account-b",
    };
    await local.seed(binding);
    await local.seed(other);
    const documents = await local.listChanged(binding);
    expect(documents).toContainEqual(
      expect.objectContaining({ source: "duplicate-charge-policy" }),
    );
    await expect(
      local.fetchDocument(binding, "duplicate-charge-policy"),
    ).resolves.toMatchObject({ version: "local-v1" });
    await store.getClientForTests().execute({
      sql: "INSERT INTO local_orders VALUES (?, ?, 'ORD-extra', 'alex@example.com', 'Extra', 100, 'USD', 'fulfilled', 1, '2026-09-05T00:00:00.000Z')",
      args: [binding.tenantId, binding.providerAccountId],
    });
    await expect(local.findOrder(binding, "alex@example.com")).rejects.toThrow(
      "Ambiguous",
    );
    await local.reset(binding);
    expect(
      await local.findOrder(other, "alex@example.com", "ORD-1001"),
    ).toBeTruthy();
    expect(
      await local.findOrder(binding, "alex@example.com", "ORD-1001"),
    ).toBeUndefined();
    await store.close();
  });

  it("keeps CLI fixtures and delivery receipts intact when reset sees a durable effect", async () => {
    const path = `/private/tmp/phase002-cli-${crypto.randomUUID()}.db`;
    files.push(path, `${path}-shm`, `${path}-wal`);
    const environment = {
      ...process.env,
      TURSO_DATABASE_URL: `file:${path}`,
      LOCAL_FIXTURE_TENANT: binding.tenantId,
      LOCAL_FIXTURE_ACCOUNT: binding.providerAccountId,
    };
    await execFileAsync(
      process.execPath,
      ["scripts/local-fixtures.mjs", "seed"],
      {
        cwd: process.cwd(),
        env: environment,
      },
    );
    await execFileAsync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { createClient } from "@libsql/client"; const client = createClient({ url: ${JSON.stringify(`file:${path}`)}, timeout: 0 }); await client.execute({ sql: "INSERT INTO local_deliveries VALUES (?, ?, 'receipt-key', 'payload', '{}')", args: [${JSON.stringify(binding.tenantId)}, ${JSON.stringify(binding.providerAccountId)}] }); client.close();`,
      ],
      { cwd: process.cwd() },
    );

    await expect(
      execFileAsync(process.execPath, ["scripts/local-fixtures.mjs", "reset"], {
        cwd: process.cwd(),
        env: environment,
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "durable refund/idempotency or delivery effects",
      ),
    });
    const verification = await execFileAsync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { createClient } from "@libsql/client"; const client = createClient({ url: ${JSON.stringify(`file:${path}`)}, timeout: 0 }); const orders = await client.execute({ sql: "SELECT order_id FROM local_orders WHERE tenant_id = ? AND provider_account_id = ? AND order_id = 'ORD-1001'", args: [${JSON.stringify(binding.tenantId)}, ${JSON.stringify(binding.providerAccountId)}] }); const receipts = await client.execute({ sql: "SELECT receipt FROM local_deliveries WHERE tenant_id = ? AND provider_account_id = ? AND idempotency_key = 'receipt-key'", args: [${JSON.stringify(binding.tenantId)}, ${JSON.stringify(binding.providerAccountId)}] }); console.log(JSON.stringify({ orders: orders.rows.length, receipts: receipts.rows.length })); client.close();`,
      ],
      { cwd: process.cwd() },
    );
    expect(JSON.parse(verification.stdout)).toEqual({ orders: 1, receipts: 1 });
  });

  it("shares local commerce conformance through the optional loopback HTTP boundary", async () => {
    const { store, local } = await runtime();
    await local.seed(binding);
    const direct = await local.findOrder(binding, "", "ORD-1001");
    const http = new LoopbackHttpCommerceProvider(
      createLocalLoopbackFacade(local),
    );
    expect(await http.findOrder(binding, "", "ORD-1001")).toEqual(direct);
    expect(await http.findSubscription(binding, "alex@example.com")).toEqual(
      await local.findSubscription(binding, "alex@example.com"),
    );
    expect(await http.refunds(binding, "ORD-1001")).toEqual(
      await local.refunds(binding, "ORD-1001"),
    );
    const rateLimited = new LoopbackHttpCommerceProvider(
      createLocalLoopbackFacade(local, () => "429"),
    );
    await expect(
      rateLimited.findOrder(binding, "", "ORD-1001"),
    ).rejects.toThrow("429");
    const timeout = new LoopbackHttpCommerceProvider(
      createLocalLoopbackFacade(local, () => "timeout"),
      5,
    );
    await expect(timeout.findOrder(binding, "", "ORD-1001")).rejects.toThrow(
      "timeout",
    );
    await store.close();
  });

  it("conforms through loopback HTTP for support, transaction, and knowledge ports, including a dropped refund response", async () => {
    const { store, local } = await runtime();
    await local.seed(binding);
    const server = await realLoopback(createLocalLoopbackFacade(local));
    const http = new LoopbackHttpProviderRegistry(server.fetch);
    const normalized = await http.support(binding).normalizeInbound({
      externalId: "loopback-inbound",
      from: "alex@example.com",
      body: "A message through the HTTP boundary.",
    });
    expect(normalized).toMatchObject({
      externalId: "loopback-inbound",
      customer: { email: "alex@example.com" },
    });
    const directReceipt = await local
      .support(binding)
      .deliver(binding, "reply", "resolved", "loopback-receipt");
    expect(
      await http
        .support(binding)
        .deliver(binding, "reply", "resolved", "loopback-receipt"),
    ).toEqual(directReceipt);
    await expect(
      http
        .support(binding)
        .deliver(binding, "altered reply", "resolved", "loopback-receipt"),
    ).rejects.toThrow("different content");
    expect(
      await http.knowledge(binding).search(binding, "duplicate charge", 3),
    ).toEqual(await local.search(binding, "duplicate charge", 3));
    expect(
      await http
        .knowledge(binding)
        .fetchDocument(binding, "duplicate-charge-policy"),
    ).toEqual(await local.fetchDocument(binding, "duplicate-charge-policy"));
    const command = await approvedCommand(store, "loopback-drop", 100);
    expect(await http.transactions(binding).quoteRefund(command)).toEqual(
      await local.quoteRefund(command),
    );
    const dropped = new LoopbackHttpProviderRegistry(
      createLocalLoopbackFacade(local, () => "drop-after-commit"),
      5,
    );
    await expect(
      dropped.transactions(binding).issueRefund(command),
    ).rejects.toThrow("timeout");
    expect(await local.issueRefund(command)).toMatchObject({ replayed: true });
    await server.close();
    await store.close();
  });

  it("restarts claimable work but leaves suspended approvals untouched", async () => {
    const { store } = await runtime();
    const active = supportCase(`recovery-active-${crypto.randomUUID()}`);
    const suspended = supportCase(`recovery-suspended-${crypto.randomUUID()}`);
    suspended.status = "waiting_approval";
    await store.acceptInbound(active, `event-${active.id}`, `run-${active.id}`);
    await store.acceptInbound(
      suspended,
      `event-${suspended.id}`,
      `run-${suspended.id}`,
    );
    const restart = vi.fn().mockResolvedValue({ status: "success" });
    const start = vi.fn().mockResolvedValue({ status: "success" });
    await recoverLocalWorkflows(
      {
        getWorkflow: () => ({
          createRun: async () => ({ restart, start }),
          getWorkflowRunById: async (runId: string) =>
            runId === `run-${suspended.id}`
              ? { status: "suspended" }
              : { status: "running" },
        }),
      },
      10,
      store,
    );
    expect(restart).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
    const dispatches = await store.getClientForTests().execute({
      sql: "SELECT case_id, state FROM support_dispatch WHERE case_id IN (?, ?)",
      args: [active.id, suspended.id],
    });
    expect(dispatches.rows).toContainEqual(
      expect.objectContaining({ case_id: active.id, state: "completed" }),
    );
    expect(dispatches.rows).toContainEqual(
      expect.objectContaining({ case_id: suspended.id, state: "suspended" }),
    );
    await store.close();
  });

  it("starts a dispatch that was persisted before its first workflow run instead of restarting a nonexistent run", async () => {
    const { store } = await runtime();
    const pending = supportCase(`recovery-pending-${crypto.randomUUID()}`);
    await store.acceptInbound(
      pending,
      `event-${pending.id}`,
      `run-${pending.id}`,
    );
    const restart = vi.fn().mockResolvedValue({ status: "success" });
    const start = vi.fn().mockResolvedValue({ status: "success" });
    await recoverLocalWorkflows(
      {
        getWorkflow: () => ({
          createRun: async () => ({
            runId: `run-${pending.id}`,
            restart,
            start,
          }),
          getWorkflowRunById: async () => undefined,
        }),
      },
      10,
      store,
    );
    expect(start).toHaveBeenCalledWith({ inputData: { caseId: pending.id } });
    expect(restart).not.toHaveBeenCalled();
    expect((await store.get(pending.id))?.workflowRunId).toBe(
      `run-${pending.id}`,
    );
    await store.close();
  });

  it("recovers an active post-approval snapshot even if the durable case still says waiting", async () => {
    const { store } = await runtime();
    const pending = supportCase("post-approval");
    pending.status = "waiting_approval";
    await store.acceptInbound(
      pending,
      "post-approval-event",
      "post-approval-run",
    );
    const restart = vi.fn().mockResolvedValue({ status: "success" });
    await recoverLocalWorkflows(
      {
        getWorkflow: () => ({
          createRun: async () => ({ restart }),
          getWorkflowRunById: async () => ({ status: "running" }),
        }),
      },
      10,
      store,
    );
    expect(restart).toHaveBeenCalledOnce();
    expect(
      (
        await store.getClientForTests().execute({
          sql: "SELECT state FROM support_dispatch WHERE case_id = ?",
          args: [pending.id],
        })
      ).rows[0],
    ).toMatchObject({ state: "completed" });
    await store.close();
  });

  it("backfills a resumable dispatch for a migrated waiting approval case", async () => {
    const { store } = await runtime();
    const legacy = supportCase("legacy-resume");
    legacy.status = "waiting_approval";
    legacy.workflowRunId = "legacy-run";
    await store.create(legacy);
    const claim = await store.claimDispatchForResume(
      legacy.id,
      legacy.workflowRunId,
    );
    expect(claim).toMatchObject({
      caseId: legacy.id,
      runId: "legacy-run",
      state: "claimed",
    });
    await store.close();
  });

  it("persists recovery failure on the case as well as the dispatch", async () => {
    const { store } = await runtime();
    const failed = supportCase("recovery-failure");
    await store.acceptInbound(
      failed,
      "recovery-failure-event",
      "recovery-failure-run",
    );
    await recoverLocalWorkflows(
      {
        getWorkflow: () => ({
          createRun: async () => ({
            restart: async () => ({ status: "failed" }),
          }),
          getWorkflowRunById: async () => ({ status: "running" }),
        }),
      },
      10,
      store,
    );
    expect(await store.get(failed.id)).toMatchObject({ status: "failed" });
    await store.close();
  });

  it("never fresh-starts a terminal Mastra snapshot", async () => {
    const { store } = await runtime();
    const terminal = supportCase("terminal-run");
    await store.acceptInbound(terminal, "terminal-event", "terminal-run-id");
    const start = vi.fn();
    const restart = vi.fn();
    await recoverLocalWorkflows(
      {
        getWorkflow: () => ({
          createRun: async () => ({ start, restart }),
          getWorkflowRunById: async () => ({ status: "failed" }),
        }),
      },
      10,
      store,
    );
    expect(start).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
    expect(await store.get(terminal.id)).toMatchObject({ status: "failed" });
    await store.close();
  });

  it("reclaims a delivery after an effect-before-receipt crash and reuses the provider receipt", async () => {
    const { store, local } = await runtime();
    await local.seed(binding);
    await store.enqueueDelivery({
      id: "outbox-crash",
      caseId: "case-crash",
      binding,
      body: "We resolved your case.",
      status: "resolved",
    });
    const [claimed] = await store.claimOutbox();
    const receipt = await local
      .support(binding)
      .deliver(binding, claimed.body, claimed.status, claimed.id);
    await store.getClientForTests().execute({
      sql: "UPDATE support_outbox SET lease_until = ? WHERE id = ?",
      args: ["2000-01-01T00:00:00.000Z", claimed.id],
    });
    await deliverOutbox(local, 10, store);
    const persisted = await store.getClientForTests().execute({
      sql: "SELECT state, receipt FROM support_outbox WHERE id = ?",
      args: [claimed.id],
    });
    expect(persisted.rows[0]).toMatchObject({
      state: "delivered",
      receipt: JSON.stringify(receipt),
    });
    await store.close();
  });

  it("replays identical delivery content atomically and rejects a conversation redirect", async () => {
    const { store, local } = await runtime();
    const support = local.support(binding);
    const first = await support.deliver(
      binding,
      "reply",
      "resolved",
      "receipt-key",
    );
    await expect(
      support.deliver(binding, "reply", "resolved", "receipt-key"),
    ).resolves.toEqual(first);
    await expect(
      support.deliver(
        { ...binding, externalConversationId: "other-conversation" },
        "reply",
        "resolved",
        "receipt-key",
      ),
    ).rejects.toThrow("different content");
    await store.close();
  });

  it("keeps 429 delivery failures claimable while surfacing permanent 4xx failures", async () => {
    const { store, local } = await runtime();
    const support = local.support(binding);
    const registry = (message: string): ProviderRegistry => ({
      support: () => ({
        kind: "local",
        normalizeInbound: support.normalizeInbound.bind(support),
        deliver: async () => {
          throw new Error(message);
        },
        addInternalNote: support.addInternalNote.bind(support),
        updateStatus: support.updateStatus.bind(support),
      }),
      commerce: () => local,
      transactions: () => local,
      knowledge: () => local,
    });
    await store.enqueueDelivery({
      id: "outbox-429",
      caseId: "case-429",
      binding,
      body: "retry me",
      status: "resolved",
    });
    await deliverOutbox(registry("Loopback HTTP 429"), 10, store);
    const after429 = await store
      .getClientForTests()
      .execute("SELECT state FROM support_outbox WHERE id = 'outbox-429'");
    expect(after429.rows[0]).toMatchObject({ state: "pending" });
    await store.enqueueDelivery({
      id: "outbox-400",
      caseId: "case-400",
      binding,
      body: "do not retry",
      status: "resolved",
    });
    await deliverOutbox(registry("Loopback HTTP 400"), 10, store);
    const after400 = await store
      .getClientForTests()
      .execute("SELECT state FROM support_outbox WHERE id = 'outbox-400'");
    expect(after400.rows[0]).toMatchObject({ state: "failed" });
    await store.close();
  });

  it("fences stale leases, renews healthy claims, and visibly fails exhausted abandoned work", async () => {
    const { store } = await runtime();
    await store.create(supportCase("fenced-case"));
    await store.enqueueDelivery({
      id: "fenced",
      caseId: "fenced-case",
      binding,
      body: "reply",
      status: "resolved",
    });
    const [first] = await store.claimOutbox();
    expect(await store.renewOutboxLease(first.id, first.leaseToken!)).toBe(
      true,
    );
    await store.getClientForTests().execute({
      sql: "UPDATE support_outbox SET lease_until = ? WHERE id = ?",
      args: ["2000-01-01T00:00:00.000Z", first.id],
    });
    const [second] = await store.claimOutbox();
    await store.completeOutbox(first.id, { stale: true }, first.leaseToken);
    expect(
      (
        await store.getClientForTests().execute({
          sql: "SELECT state FROM support_outbox WHERE id = ?",
          args: [first.id],
        })
      ).rows[0],
    ).toMatchObject({ state: "claimed" });
    await store.retryOutbox(second.id, "crash", false, second.leaseToken);
    const [third] = await store.claimOutbox();
    await store.getClientForTests().execute({
      sql: "UPDATE support_outbox SET lease_until = ? WHERE id = ?",
      args: ["2000-01-01T00:00:00.000Z", third.id],
    });
    await store.claimOutbox();
    expect(
      (
        await store.getClientForTests().execute({
          sql: "SELECT state, last_error FROM support_outbox WHERE id = ?",
          args: [first.id],
        })
      ).rows[0],
    ).toMatchObject({ state: "failed" });
    expect((await store.get("fenced-case"))?.metadata).toMatchObject({
      deliveryStatus: "failed",
    });
    await store.close();
  });

  it("uses currency-specific decimal exponents at the legacy boundary", () => {
    expect(legacyAmountToMoney(100, "JPY")).toEqual({
      currency: "JPY",
      minor: 100,
    });
    expect(legacyAmountToMoney(1.23, "KWD")).toEqual({
      currency: "KWD",
      minor: 1230,
    });
    expect(moneyToLegacyAmount({ currency: "KWD", minor: 1230 })).toBe(1.23);
    expect(() => legacyAmountToMoney(1, "ZZZ")).toThrow(
      "Unsupported currency precision",
    );
  });

  it("rejects malformed HTTP provider results before they reach persisted effects", async () => {
    const malformed = new LoopbackHttpCommerceProvider(async () =>
      Response.json({
        orderId: "ORD",
        customerEmail: "a@example.com",
        product: "x",
        amount: { currency: "???", minor: 0.5 },
        status: "fulfilled",
        chargeCount: 1,
        placedAt: "not-a-date",
      }),
    );
    await expect(malformed.findOrder(binding, "", "ORD")).rejects.toThrow();
  });
});
