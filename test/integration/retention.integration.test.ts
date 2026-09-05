import { rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { LibSQLStore } from "@mastra/libsql";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CaseStore } from "../../src/mastra/lib/case-store";
import { purgeExpiredWorkflowSnapshots } from "../../src/mastra/runtime/local-runtime";

const files: string[] = [];
const execFileAsync = promisify(execFile);

async function storeForTest() {
  const path = `/private/tmp/phase003-retention-${crypto.randomUUID()}.db`;
  files.push(path, `${path}-shm`, `${path}-wal`);
  const store = new CaseStore({ url: `file:${path}` });
  await store.list();
  return store;
}

afterEach(async () => {
  await Promise.all(files.splice(0).map((file) => rm(file, { force: true })));
});

describe("DEC-015 retention", () => {
  it("uses installed LibSQL retention for persisted Mastra memory and traces, then fails stale pending work closed", async () => {
    const store = await storeForTest();
    const now = new Date("2026-09-05T00:00:00.000Z");
    const old = "2026-05-01T00:00:00.000Z";
    const client = store.getClientForTests();
    const mastraStorage = new LibSQLStore({
      id: `retention-${crypto.randomUUID()}`,
      client,
      retention: {
        memory: {
          messages: { maxAge: "90d" },
          resources: { maxAge: "90d" },
          threads: { maxAge: "90d" },
        },
        observability: { spans: { maxAge: "30d" } },
      },
    });
    await mastraStorage.init();
    await client.execute({
      sql: "INSERT INTO mastra_messages(id, thread_id, content, role, type, createdAt, resourceId) VALUES (?, ?, ?, ?, ?, ?, ?)",
      args: [
        "memory-pii",
        "thread-pii",
        JSON.stringify({ content: "alex@example.com" }),
        "user",
        "text",
        old,
        "resource-pii",
      ],
    });
    await client.execute({
      sql: "INSERT INTO mastra_resources(id, workingMemory, metadata, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)",
      args: ["resource-pii", "alex@example.com", "{}", old, old],
    });
    await client.execute({
      sql: "INSERT INTO mastra_threads(id, resourceId, title, metadata, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)",
      args: ["thread-pii", "resource-pii", "alex@example.com", "{}", old, old],
    });
    await client.execute({
      sql: "INSERT INTO mastra_ai_spans(traceId, spanId, name, spanType, isEvent, startedAt, createdAt, input) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      args: [
        "trace-pii",
        "span-pii",
        "support",
        "agent_run",
        false,
        old,
        old,
        JSON.stringify({ email: "alex@example.com" }),
      ],
    });
    // Memory/telemetry pruning excludes workflow snapshots. The app deletes a
    // snapshot only after its corresponding case has reached terminal
    // retention; an active snapshot remains recoverable.
    await client.execute({
      sql: "INSERT INTO mastra_workflow_snapshot(workflow_name, run_id, resourceId, snapshot, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)",
      args: [
        "resolveSupportCaseWorkflow",
        "native-approval-still-recoverable",
        "resource-pii",
        JSON.stringify({ status: "suspended", email: "alex@example.com" }),
        old,
        old,
      ],
    });
    await client.execute({
      sql: "INSERT INTO mastra_workflow_snapshot(workflow_name, run_id, resourceId, snapshot, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)",
      args: [
        "resolveSupportCaseWorkflow",
        "active-native-approval",
        "resource-active",
        JSON.stringify({ status: "suspended", email: "alex@example.com" }),
        now.toISOString(),
        now.toISOString(),
      ],
    });
    await store.create({
      id: "pending-case",
      externalId: "pending-event",
      source: "mock-email",
      customer: { email: "alex@example.com" },
      subject: "Pending private request",
      messages: [
        {
          id: "pending-message",
          author: "customer",
          body: "Do not delete before resolution",
          createdAt: old,
        },
      ],
      status: "waiting_approval",
      createdAt: old,
      updatedAt: old,
      workflowRunId: "native-approval-still-recoverable",
      metadata: {
        providerBinding: {
          tenantId: "local-demo",
          providerKind: "local",
          providerAccountId: "local-demo",
          externalConversationId: "pending",
        },
        rawPayload: { email: "alex@example.com" },
        refundCommand: {
          fingerprint: "pending-fingerprint",
          idempotencyKey: "pending-key",
          reason: "alex@example.com",
        },
      },
    });
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const mastraResult = await mastraStorage.prune();
    vi.useRealTimers();
    const result = await store.enforceRetention(() => now);
    const snapshotsDeleted = await purgeExpiredWorkflowSnapshots(
      mastraStorage,
      result,
    );
    expect(result).toMatchObject({
      rawPayloadsRedacted: 1,
      casesRedacted: 1,
      tracesRedacted: 0,
      pendingCasesExpired: 1,
      expiredWorkflowRunIds: ["native-approval-still-recoverable"],
    });
    expect(snapshotsDeleted).toEqual([
      "resolveSupportCaseWorkflow:native-approval-still-recoverable",
    ]);
    expect(mastraResult).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: "mastra_messages", deleted: 1 }),
        expect.objectContaining({ table: "mastra_resources", deleted: 1 }),
        expect.objectContaining({ table: "mastra_threads", deleted: 1 }),
        expect.objectContaining({ table: "mastra_ai_spans", deleted: 1 }),
      ]),
    );
    expect(
      (await client.execute("SELECT content FROM mastra_messages")).rows,
    ).toEqual([]);
    expect(
      (await client.execute("SELECT workingMemory FROM mastra_resources")).rows,
    ).toEqual([]);
    expect(
      (await client.execute("SELECT input FROM mastra_ai_spans")).rows,
    ).toEqual([]);
    expect(
      (
        await client.execute(
          "SELECT run_id FROM mastra_workflow_snapshot ORDER BY run_id",
        )
      ).rows,
    ).toEqual([{ run_id: "active-native-approval" }]);
    const pending = await store.get("pending-case");
    expect(pending).toMatchObject({
      status: "failed",
      messages: [],
      customer: { email: "redacted@invalid.local" },
      metadata: {
        pendingRetentionExpiredAt: now.toISOString(),
        refundCommand: {
          fingerprint: "pending-fingerprint",
          idempotencyKey: "pending-key",
        },
      },
    });
    expect(pending?.metadata).not.toHaveProperty("rawPayload");
    expect(pending?.metadata).not.toHaveProperty("refundCommand.reason");
    await store.close();
  });

  it("redacts raw payloads, traces and expired customer content while preserving replay and the audit window", async () => {
    const store = await storeForTest();
    const now = new Date("2026-09-05T00:00:00.000Z");
    const createdAt = new Date("2026-05-01T00:00:00.000Z").toISOString();
    await store.create({
      id: "expired-case",
      externalId: "expired-event",
      source: "mock-email",
      customer: { email: "alex@example.com", name: "Alex" },
      subject: "Private order data",
      messages: [
        {
          id: "expired-message",
          author: "customer",
          body: "My address is secret",
          createdAt,
        },
      ],
      status: "resolved",
      createdAt,
      updatedAt: createdAt,
      traceId: "trace-private",
      metadata: {
        providerBinding: {
          tenantId: "local-demo",
          providerKind: "local",
          providerAccountId: "local-demo",
          externalConversationId: "private-conversation",
        },
        rawPayload: { email: "alex@example.com", secret: "do-not-retain" },
      },
    });
    await store.recordEffect("replay-key", "fingerprint", {
      refundId: "REF-1",
    });
    await store.getClientForTests().execute({
      sql: "INSERT INTO support_audit(id, case_id, kind, data, created_at) VALUES (?, ?, ?, ?, ?)",
      args: [
        "recent-audit",
        "expired-case",
        "financial-effect",
        "{}",
        "2026-01-01T00:00:00.000Z",
      ],
    });
    await store.getClientForTests().execute({
      sql: "INSERT INTO support_audit(id, case_id, kind, data, created_at) VALUES (?, ?, ?, ?, ?)",
      args: [
        "old-audit",
        "expired-case",
        "financial-effect",
        "{}",
        "2025-01-01T00:00:00.000Z",
      ],
    });

    await expect(store.enforceRetention(() => now)).resolves.toMatchObject({
      rawPayloadsRedacted: 1,
      casesRedacted: 1,
      tracesRedacted: 1,
      auditsDeleted: 1,
      messagesDeleted: 1,
      mastraMessagesDeleted: 0,
      mastraSpansDeleted: 0,
      pendingCasesExpired: 0,
      expiredWorkflowRunIds: [],
    });
    const redacted = await store.get("expired-case");
    expect(redacted).toMatchObject({
      customer: { email: "redacted@invalid.local" },
      subject: "Redacted support case",
      messages: [],
      metadata: { retentionRedactedAt: now.toISOString() },
    });
    expect(redacted?.traceId).toBeUndefined();
    const messages = await store
      .getClientForTests()
      .execute("SELECT data FROM support_messages WHERE case_id = ?", [
        "expired-case",
      ]);
    expect(messages.rows).toEqual([]);
    expect(await store.idempotency("replay-key")).toEqual({
      fingerprint: "fingerprint",
      effect: { refundId: "REF-1" },
    });
    const audits = await store
      .getClientForTests()
      .execute("SELECT id FROM support_audit ORDER BY id");
    expect(audits.rows).toEqual([{ id: "recent-audit" }]);
    await store.close();
  });

  it("minimizes every expired durable customer copy and removes the enumerated snapshot families", async () => {
    const store = await storeForTest();
    const now = new Date("2026-09-05T00:00:00.000Z");
    const old = "2026-05-01T00:00:00.000Z";
    const client = store.getClientForTests();
    await store.create({
      id: "all-copies-case",
      externalId: "all-copies-event",
      source: "mock-email",
      customer: { email: "SYNTHETIC-COPY-003@example.test" },
      subject: "SYNTHETIC-COPY-003",
      messages: [
        {
          id: "all-copies-message",
          author: "customer",
          body: "SYNTHETIC-COPY-003",
          createdAt: old,
        },
      ],
      status: "waiting_approval",
      createdAt: old,
      updatedAt: old,
      workflowRunId: "inbound-run",
      metadata: {
        providerBinding: {
          tenantId: "local-demo",
          providerKind: "local",
          providerAccountId: "local-demo",
          externalConversationId: "all-copies",
        },
        rawPayload: "SYNTHETIC-COPY-003",
        refundCommand: {
          fingerprint: "replay-fingerprint",
          idempotencyKey: "replay-key-003",
          reason: "SYNTHETIC-COPY-003",
        },
      },
    });
    await client.executeMultiple(`
      INSERT INTO support_turns(id, case_id, event_id, sequence, state, created_at, updated_at, run_id, message_data, outcome_data) VALUES ('turn-inbound', 'all-copies-case', 'all-copies-event', 1, 'pending', '${old}', '${old}', 'inbound-run', '{"body":"SYNTHETIC-COPY-003"}', '{"draft":"SYNTHETIC-COPY-003"}');
      INSERT INTO support_turns(id, case_id, event_id, sequence, state, created_at, updated_at, run_id, message_data, outcome_data) VALUES ('turn-native', 'all-copies-case', 'all-copies-native-event', 2, 'waiting_approval', '${old}', '${old}', 'durable-native-run', '{"body":"SYNTHETIC-COPY-003"}', '{"approval":"SYNTHETIC-COPY-003"}');
      INSERT INTO support_dispatch(id, case_id, turn_id, run_id, state, attempts, lease_until, lease_token, last_error, created_at, updated_at) VALUES ('dispatch-copies', 'all-copies-case', 'turn-inbound', 'resolution-run', 'suspended', 1, '${old}', 'SYNTHETIC-COPY-003', 'SYNTHETIC-COPY-003', '${old}', '${old}');
      INSERT INTO support_outbox(id, case_id, binding, body, status, state, attempts, receipt, last_error, created_at, updated_at) VALUES ('outbox-copies', 'all-copies-case', '{}', 'SYNTHETIC-COPY-003', 'failed', 'failed', 1, 'SYNTHETIC-COPY-003', 'SYNTHETIC-COPY-003', '${old}', '${old}');
      INSERT INTO support_decisions(id, case_id, turn_id, command_fingerprint, native_run_id, native_tool_call_id, principal_id, approved, note, created_at) VALUES ('decision-agentic', 'all-copies-case', 'turn-inbound', 'fingerprint-agentic', 'native-agentic-run', 'tool-call', 'approver-demo', 1, 'SYNTHETIC-COPY-003', '${old}');
      INSERT INTO support_decisions(id, case_id, turn_id, command_fingerprint, native_run_id, native_tool_call_id, principal_id, approved, note, created_at) VALUES ('decision-durable', 'all-copies-case', 'turn-native', 'fingerprint-durable', 'durable-native-run', 'tool-call-2', 'approver-demo', 1, 'SYNTHETIC-COPY-003', '${old}');
      INSERT INTO support_actions(id, case_id, kind, fingerprint, data, created_at) VALUES ('action-copies', 'all-copies-case', 'refund', 'action-fingerprint', '{"reason":"SYNTHETIC-COPY-003"}', '${old}');
      INSERT INTO support_audit(id, case_id, kind, data, created_at) VALUES ('audit-financial-window', 'all-copies-case', 'financial-effect', '{"reason":"SYNTHETIC-COPY-003"}', '${old}');
      CREATE TABLE IF NOT EXISTS local_refunds (refund_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, provider_account_id TEXT NOT NULL, order_id TEXT NOT NULL, amount_minor INTEGER NOT NULL, currency TEXT NOT NULL, reason TEXT NOT NULL, issued_at TEXT NOT NULL);
      INSERT INTO local_refunds(refund_id, tenant_id, provider_account_id, order_id, amount_minor, currency, reason, issued_at) VALUES ('refund-copies', 'local-demo', 'local-demo', 'order-1', 100, 'USD', 'SYNTHETIC-COPY-003', '${old}');
    `);
    await store.recordEffect("replay-key-003", "replay-fingerprint", {
      refundId: "refund-copies",
    });
    const mastraStorage = new LibSQLStore({
      id: `retention-copies-${crypto.randomUUID()}`,
      client,
    });
    await mastraStorage.init();
    for (const [workflowName, runId] of [
      ["ingest-support-case", "ingress-storage-uuid"],
      ["resolve-support-case", "resolution-storage-uuid"],
      ["agentic-loop", "native-agentic-storage-uuid"],
      ["durable-agentic-loop", "durable-native-storage-uuid"],
      ["agentic-loop", "active-native-run"],
    ])
      await client.execute({
        sql: "INSERT INTO mastra_workflow_snapshot(workflow_name, run_id, snapshot, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)",
        args: [
          workflowName,
          runId,
          runId === "active-native-run"
            ? '{"input":{"caseId":"active-case"},"content":"active recovery"}'
            : '{"input":{"caseId":"all-copies-case"},"content":"SYNTHETIC-COPY-003"}',
          old,
          old,
        ],
      });

    const result = await store.enforceRetention(() => now);
    const deleted = await purgeExpiredWorkflowSnapshots(mastraStorage, result);
    expect(result).toMatchObject({
      turnsRedacted: 2,
      outboxRecordsRedacted: 1,
      dispatchesExpired: 1,
      decisionsRedacted: 2,
      actionsRedacted: 1,
      financialReasonsRedacted: 1,
    });
    expect(deleted.sort()).toEqual([
      "agentic-loop:native-agentic-storage-uuid",
      "durable-agentic-loop:durable-native-storage-uuid",
      "ingest-support-case:ingress-storage-uuid",
      "resolve-support-case:resolution-storage-uuid",
    ]);
    const retained = await client.execute(
      "SELECT run_id FROM mastra_workflow_snapshot ORDER BY run_id",
    );
    expect(retained.rows).toEqual([{ run_id: "active-native-run" }]);
    await client.execute({
      sql: "INSERT INTO mastra_workflow_snapshot(workflow_name, run_id, snapshot, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)",
      args: [
        "agentic-loop",
        "retry-native-storage-uuid",
        '{"input":{"caseId":"all-copies-case"}}',
        old,
        old,
      ],
    });
    const workflowStore = await mastraStorage.getStore("workflows");
    const failingStorage = {
      getStore: async () => ({
        ...workflowStore,
        listWorkflowRuns: workflowStore!.listWorkflowRuns.bind(workflowStore),
        deleteWorkflowRunById: async () => {
          throw new Error("injected supported-delete failure");
        },
      }),
    } as never;
    await expect(
      purgeExpiredWorkflowSnapshots(failingStorage, result),
    ).rejects.toThrow("injected supported-delete failure");
    const retryRetention = await store.enforceRetention(() => now);
    expect(retryRetention.expiredCaseIds).toEqual(["all-copies-case"]);
    expect(
      await purgeExpiredWorkflowSnapshots(mastraStorage, retryRetention),
    ).toEqual(["agentic-loop:retry-native-storage-uuid"]);
    const copies = await client.execute(`
      SELECT data FROM support_cases WHERE id = 'all-copies-case'
      UNION ALL SELECT data FROM support_messages WHERE case_id = 'all-copies-case'
      UNION ALL SELECT COALESCE(message_data, '') || COALESCE(outcome_data, '') FROM support_turns WHERE case_id = 'all-copies-case'
      UNION ALL SELECT body || COALESCE(receipt, '') || COALESCE(last_error, '') FROM support_outbox WHERE case_id = 'all-copies-case'
      UNION ALL SELECT COALESCE(last_error, '') FROM support_dispatch WHERE case_id = 'all-copies-case'
      UNION ALL SELECT COALESCE(note, '') FROM support_decisions WHERE case_id = 'all-copies-case'
      UNION ALL SELECT data FROM support_actions WHERE case_id = 'all-copies-case'
      UNION ALL SELECT reason FROM local_refunds WHERE refund_id = 'refund-copies'
    `);
    expect(JSON.stringify(copies.rows)).not.toContain("SYNTHETIC-COPY-003");
    // Financial audit content keeps its 365-day retention window; identifiers
    // and the idempotency row remain so cleanup cannot authorize a new effect.
    expect(
      await client.execute(
        "SELECT data FROM support_audit WHERE id = 'audit-financial-window'",
      ),
    ).toMatchObject({ rows: [{ data: '{"reason":"SYNTHETIC-COPY-003"}' }] });
    await expect(
      store.recordEffect("replay-key-003", "different-fingerprint", {}),
    ).rejects.toThrow();
    await store.close();
  });

  it("runs the local-only CLI against the same bounded durable cleanup contract", async () => {
    const path = `/private/tmp/phase003-retention-cli-${crypto.randomUUID()}.db`;
    files.push(path, `${path}-shm`, `${path}-wal`);
    const store = new CaseStore({ url: `file:${path}` });
    const old = "2026-05-01T00:00:00.000Z";
    await store.acceptInbound(
      {
        id: "cli-retention-case",
        externalId: "cli-retention-event",
        source: "mock-email",
        customer: { email: "SYNTHETIC-CLI-003@example.test" },
        subject: "SYNTHETIC-CLI-003",
        messages: [
          {
            id: "cli-retention-message",
            author: "customer",
            body: "SYNTHETIC-CLI-003",
            createdAt: old,
          },
        ],
        status: "resolved",
        createdAt: old,
        updatedAt: old,
        metadata: {
          providerBinding: {
            tenantId: "local-demo",
            providerKind: "local",
            providerAccountId: "local-demo",
            externalConversationId: "cli-retention",
          },
          rawPayload: "SYNTHETIC-CLI-003",
        },
      },
      "cli-retention-event",
      "cli-inbound-run",
    );
    const client = store.getClientForTests();
    const storage = new LibSQLStore({
      id: `retention-cli-${crypto.randomUUID()}`,
      client,
    });
    await storage.init();
    await client.execute({
      sql: "INSERT INTO mastra_workflow_snapshot(workflow_name, run_id, snapshot, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)",
      args: [
        "ingest-support-case",
        "cli-ingress-storage-uuid",
        '{"body":"SYNTHETIC-CLI-003"}',
        old,
        old,
      ],
    });
    await store.close();
    const { stdout } = await execFileAsync(
      process.execPath,
      ["scripts/retention.mjs"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          TURSO_DATABASE_URL: `file:${path}`,
        },
      },
    );
    const output = JSON.parse(stdout) as {
      cases: { casesRedacted: number };
      snapshotsDeleted: string[];
    };
    expect(output.cases.casesRedacted).toBe(1);
    expect(output.snapshotsDeleted).toEqual([
      "ingest-support-case:cli-ingress-storage-uuid",
    ]);
  });

  it("upgrades populated v6/v7 turn history to v8 and refuses every unsupported downgrade without mutation", async () => {
    const path = `/private/tmp/phase003-migration-${crypto.randomUUID()}.db`;
    files.push(path, `${path}-shm`, `${path}-wal`);
    const store = new CaseStore({ url: `file:${path}` });
    await store.migrate(6);
    await expect(store.migrate(5)).rejects.toThrow(
      "Refusing unsupported downgrade from support schema v6 to v5.",
    );
    await store.migrate(7);
    await expect(store.migrate(6)).rejects.toThrow(
      "Refusing unsupported downgrade from support schema v7 to v6.",
    );
    const client = store.getClientForTests();
    const createdAt = "2026-09-05T00:00:00.000Z";
    const caseData = JSON.stringify({
      id: "migration-case",
      externalId: "migration-event",
      source: "mock-email",
      customer: { email: "migration@example.test" },
      subject: "migration",
      messages: [
        {
          id: "migration-message-one",
          author: "customer",
          body: "first immutable turn",
          createdAt,
        },
        {
          id: "migration-message-two",
          author: "customer",
          body: "second immutable turn",
          createdAt,
        },
      ],
      status: "resolved",
      createdAt,
      updatedAt: createdAt,
      metadata: {
        providerBinding: {
          tenantId: "local-demo",
          providerKind: "local",
          providerAccountId: "local-demo",
          externalConversationId: "migration",
        },
      },
    });
    await client.execute({
      sql: "INSERT INTO support_cases(id, source, external_id, data, created_at, updated_at, version, tenant_id, provider_account_id, provider_binding) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      args: [
        "migration-case",
        "mock-email",
        "migration-event",
        caseData,
        createdAt,
        createdAt,
        1,
        "local-demo",
        "local-demo",
        JSON.stringify({
          tenantId: "local-demo",
          providerKind: "local",
          providerAccountId: "local-demo",
          externalConversationId: "migration",
        }),
      ],
    });
    await client.executeMultiple(`
      INSERT INTO support_turns(id, case_id, event_id, sequence, state, created_at, updated_at, run_id) VALUES ('migration-turn-one', 'migration-case', 'migration-event', 1, 'resolved', '${createdAt}', '${createdAt}', 'migration-run-one');
      INSERT INTO support_turns(id, case_id, event_id, sequence, state, created_at, updated_at, run_id) VALUES ('migration-turn-two', 'migration-case', 'migration-event-two', 2, 'resolved', '${createdAt}', '${createdAt}', 'migration-run-two');
    `);
    await store.migrate(8);
    await store.migrate(8);
    const beforeRefusal = await client.execute(`
      SELECT
        (SELECT group_concat(version, ',') FROM support_schema_migrations) AS versions,
        (SELECT group_concat(id, ',') FROM support_turns WHERE case_id = 'migration-case' ORDER BY id) AS turns,
        (SELECT group_concat(message_data, '|') FROM support_turns WHERE case_id = 'migration-case' ORDER BY id) AS messages
    `);
    await expect(store.migrate(7)).rejects.toThrow(
      "Refusing unsupported downgrade from support schema v8 to v7.",
    );
    const afterRefusal = await client.execute(`
      SELECT
        (SELECT group_concat(version, ',') FROM support_schema_migrations) AS versions,
        (SELECT group_concat(id, ',') FROM support_turns WHERE case_id = 'migration-case' ORDER BY id) AS turns,
        (SELECT group_concat(message_data, '|') FROM support_turns WHERE case_id = 'migration-case' ORDER BY id) AS messages
    `);
    expect(afterRefusal.rows).toEqual(beforeRefusal.rows);
    expect(afterRefusal.rows[0]).toMatchObject({
      versions: "1,2,3,4,5,6,7,8",
      turns: "migration-turn-one,migration-turn-two",
    });
    await store.close();
    const reopened = new CaseStore({ url: `file:${path}` });
    expect(await reopened.get("migration-case")).toMatchObject({
      id: "migration-case",
      externalId: "migration-event",
    });
    await reopened.close();
  });
});
