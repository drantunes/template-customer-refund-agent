import { rm } from "node:fs/promises";
import { LibSQLStore } from "@mastra/libsql";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CaseStore } from "../../src/mastra/lib/case-store";
import { purgeExpiredWorkflowSnapshots } from "../../src/mastra/runtime/local-runtime";

const files: string[] = [];

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
    await purgeExpiredWorkflowSnapshots(
      mastraStorage,
      result.expiredWorkflowRunIds,
    );
    expect(result).toMatchObject({
      rawPayloadsRedacted: 1,
      casesRedacted: 1,
      tracesRedacted: 0,
      pendingCasesExpired: 1,
      expiredWorkflowRunIds: ["native-approval-still-recoverable"],
    });
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

    await expect(store.enforceRetention(() => now)).resolves.toEqual({
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
});
