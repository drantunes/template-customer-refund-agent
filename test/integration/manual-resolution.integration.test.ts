import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CaseStore } from "../../src/mastra/lib/case-store";
import { deliverOutbox } from "../../src/mastra/runtime/outbox";
import type { ProviderRegistry } from "../../src/mastra/providers/contracts";

const files: string[] = [];
async function fixture() {
  const path = join(tmpdir(), `manual-resolution-${crypto.randomUUID()}.db`);
  files.push(path, `${path}-wal`, `${path}-shm`);
  const store = new CaseStore({ url: `file:${path}` });
  const timestamp = "2026-09-11T12:00:00.000Z";
  const binding = {
    tenantId: "local-demo",
    providerKind: "intercom" as const,
    providerAccountId: "app-test",
    externalConversationId: "conversation-test",
  };
  await store.create({
    id: "case-manual",
    externalId: "event-manual",
    source: "intercom-conversation",
    customer: { email: "jordan@example.test", name: "Jordan Kim" },
    subject: "Escalated fixture",
    messages: [
      {
        id: "customer-message",
        author: "customer",
        body: "Please help",
        createdAt: timestamp,
      },
    ],
    status: "escalated",
    createdAt: timestamp,
    updatedAt: timestamp,
    metadata: {
      ownerId: "customer-jordan",
      activeTurnId: "turn-manual",
      providerBinding: binding,
    },
  });
  await store.getClient().execute({
    sql: "INSERT INTO support_turns(id, case_id, event_id, sequence, state, created_at, updated_at, message_data, outcome_data) VALUES (?, ?, ?, 1, 'escalated', ?, ?, ?, ?)",
    args: [
      "turn-manual",
      "case-manual",
      "event-manual",
      timestamp,
      timestamp,
      JSON.stringify({
        id: "customer-message",
        author: "customer",
        body: "Please help",
        createdAt: timestamp,
      }),
      JSON.stringify({ status: "escalated" }),
    ],
  });
  return store;
}
afterEach(async () => {
  await Promise.all(files.splice(0).map((file) => rm(file, { force: true })));
});

describe("manual resolution", () => {
  it("creates one internal message and ordered note/close intents, then replays exactly once", async () => {
    const store = await fixture();
    const command = {
      caseId: "case-manual",
      tenantId: "local-demo",
      actorId: "support-agent-demo",
      expectedVersion: 1,
      expectedTurnId: "turn-manual",
      idempotencyKey: "manual-resolution-key-001",
      internalNote: "Reviewed with the customer; close the conversation.",
    };
    const [left, right] = await Promise.all([
      store.resolveManually(command),
      store.resolveManually(command),
    ]);
    expect([left.state, right.state].sort()).toEqual(["accepted", "replayed"]);
    expect((await store.get("case-manual"))?.status).toBe("resolved");
    const outbox = await store
      .getClient()
      .execute(
        "SELECT id, operation, state FROM support_outbox WHERE case_id = 'case-manual' ORDER BY id",
      );
    expect(outbox.rows).toMatchObject([
      { operation: "note", state: "pending" },
      { operation: "status", state: "pending" },
    ]);
    const [note] = await store.claimOutbox(1);
    expect(note).toMatchObject({ operation: "note" });
    await store.completeOutbox(
      note!.id,
      { receipt: "fixture" },
      note!.leaseToken,
    );
    expect(await store.claimOutbox(1)).toMatchObject([{ operation: "status" }]);
    const conflict = await store.resolveManually({
      ...command,
      internalNote: "Different note",
    });
    expect(conflict).toMatchObject({ state: "conflict" });
    await store.close();
  });

  it("does not resolve while a dispatch is active", async () => {
    const store = await fixture();
    await store.getClient().execute({
      sql: "INSERT INTO support_dispatch(id, case_id, turn_id, run_id, state, attempts, created_at, updated_at) VALUES ('dispatch-active', 'case-manual', 'turn-other', 'run-other', 'pending', 0, ?, ?)",
      args: [new Date().toISOString(), new Date().toISOString()],
    });
    const result = await store.resolveManually({
      caseId: "case-manual",
      tenantId: "local-demo",
      actorId: "support-agent-demo",
      expectedVersion: 1,
      expectedTurnId: "turn-manual",
      idempotencyKey: "manual-resolution-key-002",
      internalNote: "Do not apply",
    });
    expect(result).toMatchObject({ state: "conflict" });
    expect((await store.get("case-manual"))?.status).toBe("escalated");
    await store.close();
  });

  it("supersedes queued manual note and close after a customer follow-up", async () => {
    const store = await fixture();
    await store.resolveManually({
      caseId: "case-manual",
      tenantId: "local-demo",
      actorId: "support-agent-demo",
      expectedVersion: 1,
      expectedTurnId: "turn-manual",
      idempotencyKey: "manual-resolution-key-003",
      internalNote: "This must not reach a later customer turn.",
    });
    await store.appendFollowUp({
      caseId: "case-manual",
      eventId: "customer-follow-up",
      runId: "run-follow-up",
      message: {
        id: "customer-follow-up-message",
        author: "customer",
        body: "One more question",
        createdAt: new Date().toISOString(),
      },
    });
    let effects = 0;
    const registry: ProviderRegistry = {
      support: () => ({
        kind: "intercom",
        normalizeInbound: async () => {
          throw new Error("not used");
        },
        deliver: async () => {
          effects += 1;
          return { receiptId: "reply", deliveredAt: new Date().toISOString() };
        },
        addInternalNote: async () => {
          effects += 1;
          return { receiptId: "note", deliveredAt: new Date().toISOString() };
        },
        updateStatus: async () => {
          effects += 1;
          return { receiptId: "close", deliveredAt: new Date().toISOString() };
        },
      }),
      commerce: () => {
        throw new Error("not used");
      },
      transactions: () => {
        throw new Error("not used");
      },
      knowledge: () => {
        throw new Error("not used");
      },
    };
    await deliverOutbox(registry, 10, store);
    expect(effects).toBe(0);
    expect(
      await store
        .getClient()
        .execute(
          "SELECT state FROM support_outbox WHERE case_id = 'case-manual' ORDER BY id",
        ),
    ).toMatchObject({
      rows: [{ state: "superseded" }, { state: "superseded" }],
    });
    await store.close();
  });
});
