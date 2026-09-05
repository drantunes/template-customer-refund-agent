import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { CaseStore } from "../../src/mastra/lib/case-store";
import { defaultLocalBinding } from "../../src/mastra/runtime/local-runtime";
import type { SupportCase } from "../../src/mastra/domain/support-case";

const files: string[] = [];
const stores: CaseStore[] = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(files.splice(0).map((file) => rm(file, { force: true })));
});

async function createConversation() {
  const path = `/private/tmp/phase003-turn-${crypto.randomUUID()}.db`;
  files.push(path, `${path}-shm`, `${path}-wal`);
  const store = new CaseStore({ url: `file:${path}` });
  stores.push(store);
  const binding = defaultLocalBinding("conversation-turns");
  const supportCase: SupportCase = {
    id: "case-turns",
    externalId: "event-initial",
    source: "mock-email",
    customer: { email: "alex@example.com" },
    subject: "Refund",
    messages: [
      {
        id: "message-initial",
        author: "customer",
        body: "I need a refund",
        createdAt: new Date().toISOString(),
      },
    ],
    status: "new",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: { providerBinding: binding, ownerId: "customer-alex" },
  };
  await store.acceptInbound(supportCase, "event-initial", "run-initial");
  return { store, binding, path };
}

describe("per-turn conversation persistence", () => {
  it("deduplicates inbound events, serializes concurrent follow-ups, and survives restart", async () => {
    const { store, path } = await createConversation();
    const first = await store.claimDispatchForStart(
      "case-turns",
      "run-initial",
    );
    expect(first).toBeDefined();
    await store.markDispatchStarted(first!.id, first!.leaseToken);
    await store.update("case-turns", {
      workflowRunId: "run-initial",
      metadata: {
        ...(await store.get("case-turns"))!.metadata,
        activeTurnId: first!.turnId,
      },
    });

    const [a, b, duplicate] = await Promise.all([
      store.appendFollowUp({
        caseId: "case-turns",
        eventId: "event-follow-up-a",
        runId: "run-follow-up-a",
        message: {
          id: "message-a",
          author: "customer",
          body: "Please update me",
          createdAt: new Date().toISOString(),
        },
      }),
      store.appendFollowUp({
        caseId: "case-turns",
        eventId: "event-follow-up-b",
        runId: "run-follow-up-b",
        message: {
          id: "message-b",
          author: "customer",
          body: "This is urgent",
          createdAt: new Date().toISOString(),
        },
      }),
      store.appendFollowUp({
        caseId: "case-turns",
        eventId: "event-initial",
        runId: "ignored-run",
        message: {
          id: "duplicate",
          author: "customer",
          body: "duplicate",
          createdAt: new Date().toISOString(),
        },
      }),
    ]);
    expect(a.appended).toBe(true);
    expect(b.appended).toBe(true);
    expect(duplicate.appended).toBe(false);
    expect(
      (await store.turns("case-turns")).map((turn) => turn.sequence),
    ).toEqual([1, 2, 3]);
    // A running turn fences later pending work; no concurrent workflow may claim it.
    expect(await store.claimDispatch()).toEqual([]);
    await store.completeDispatch(
      first!.id,
      "completed",
      undefined,
      first!.leaseToken,
    );

    const [next] = await store.claimDispatch();
    expect(next).toMatchObject({ caseId: "case-turns", state: "claimed" });
    expect([a.turnId, b.turnId]).toContain(next!.turnId);
    await store.completeDispatch(
      next!.id,
      "completed",
      undefined,
      next!.leaseToken,
    );

    // A reopened store sees the unclaimed remaining turn and continues it.
    await store.close();
    stores.splice(stores.indexOf(store), 1);
    const reopened = new CaseStore({ url: `file:${path}` });
    stores.push(reopened);
    const [recovered] = await reopened.claimDispatch();
    expect(recovered).toMatchObject({ caseId: "case-turns", state: "claimed" });
  });

  it("invalidates only the waiting turn and permits a second immutable command decision", async () => {
    const { store } = await createConversation();
    const [firstTurn] = await store.turns("case-turns");
    const firstFingerprint = "a".repeat(64);
    await store.saveAction("case-turns", "refund-command", firstFingerprint, {
      command: 1,
    });
    await store.update("case-turns", {
      status: "waiting_approval",
      metadata: {
        ...(await store.get("case-turns"))!.metadata,
        activeTurnId: firstTurn.id,
        nativeApproval: { turnId: firstTurn.id, fingerprint: firstFingerprint },
      },
    });
    await store.recordApprovalDecision({
      caseId: "case-turns",
      turnId: firstTurn.id,
      commandFingerprint: firstFingerprint,
      principalId: "approver-demo",
      approved: false,
    });
    // Restore a pending native decision to model a new inbound message arriving
    // before the prior approval is submitted; its decision record remains audit history.
    await store.update("case-turns", {
      status: "waiting_approval",
      approval: undefined,
    });
    const appended = await store.appendFollowUp({
      caseId: "case-turns",
      eventId: "event-second-command",
      runId: "run-second-command",
      message: {
        id: "message-second-command",
        author: "customer",
        body: "Refund another item",
        createdAt: new Date().toISOString(),
      },
    });
    expect(appended.appended).toBe(true);
    expect((await store.get("case-turns"))?.approval).toBeUndefined();
    const secondTurn = (await store.turns("case-turns")).at(-1)!;
    const secondFingerprint = "b".repeat(64);
    await store.saveAction("case-turns", "refund-command", secondFingerprint, {
      command: 2,
    });
    await store.update("case-turns", {
      status: "waiting_approval",
      metadata: {
        ...(await store.get("case-turns"))!.metadata,
        activeTurnId: secondTurn.id,
        nativeApproval: {
          turnId: secondTurn.id,
          fingerprint: secondFingerprint,
        },
      },
    });
    expect(
      await store.recordApprovalDecision({
        caseId: "case-turns",
        turnId: secondTurn.id,
        commandFingerprint: secondFingerprint,
        principalId: "approver-demo",
        approved: true,
      }),
    ).toMatchObject({ won: true });
    expect(
      (await store.approvalDecision("case-turns", firstTurn.id))?.approved,
    ).toBe(false);
    expect(
      (await store.approvalDecision("case-turns", secondTurn.id))?.approved,
    ).toBe(true);
  });
});
