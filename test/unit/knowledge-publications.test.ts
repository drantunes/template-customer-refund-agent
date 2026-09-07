import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KnowledgePublicationStore } from "../../src/mastra/lib/knowledge-publications";

const binding = {
  tenantId: `tenant-a-${crypto.randomUUID()}`,
  providerKind: "local" as const,
  providerAccountId: `account-a-${crypto.randomUUID()}`,
  externalConversationId: "conversation-a",
};
const document = (text: string, version: string) => ({
  title: "Refund policy",
  source: "policy://refund",
  text,
  version,
  effectiveAt: "2026-01-01T00:00:00.000Z",
  score: 1,
});

describe("knowledge publication generations", () => {
  afterEach(() => vi.useRealTimers());
  it("serves only the activated tenant generation, keeps failures and stale writers from replacing it, and rolls back", async () => {
    const store = new KnowledgePublicationStore(
      createClient({ url: process.env.TURSO_DATABASE_URL! }),
    );
    const first = await store.buildCandidate(binding, [
      document("refunds require approval", "v1"),
    ]);
    await store.activate(binding, first.generationId, {
      generationId: undefined,
      revision: 0,
    });
    expect(
      (await store.search(binding, "refund approval", 5)).map(
        (entry) => entry.generationId,
      ),
    ).toEqual([first.generationId]);
    expect((await store.search(binding, "refund", 1))[0]).toMatchObject({
      effectiveAt: "2026-01-01T00:00:00.000Z",
      documentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });

    await expect(store.buildCandidate(binding, [])).rejects.toThrow(
      "no documents",
    );
    expect(await store.activeGeneration(binding)).toBe(first.generationId);

    const next = await store.buildCandidate(binding, [
      document("shipping only", "v2"),
    ]);
    await expect(
      store.activate(binding, next.generationId, {
        generationId: undefined,
        revision: 0,
      }),
    ).rejects.toThrow("compare-and-set");
    expect(await store.activeGeneration(binding)).toBe(first.generationId);

    await store.activate(
      binding,
      next.generationId,
      await store.publication(binding),
    );
    expect(await store.activeGeneration(binding)).toBe(next.generationId);
    await store.rollback(binding, first.generationId);
    expect(await store.activeGeneration(binding)).toBe(first.generationId);
    // The pointer again names the first generation, but its monotonic
    // revision changed. A writer fetched at revision 1 cannot exploit that
    // ABA shape to replace the rollback result.
    await expect(
      store.activate(binding, next.generationId, {
        generationId: first.generationId,
        revision: 1,
      }),
    ).rejects.toThrow("compare-and-set");
    expect(
      await store.search(
        { ...binding, tenantId: "tenant-b", providerAccountId: "account-b" },
        "refund",
        5,
      ),
    ).toEqual([]);

    await expect(
      store.buildCandidate(binding, [
        { ...document("missing effective time", "v3"), effectiveAt: undefined },
      ]),
    ).rejects.toThrow("effective time");
    await expect(
      store.buildCandidate(binding, [
        document("one", "v4"),
        document("two", "v5"),
      ]),
    ).rejects.toThrow("conflicting source versions");
  });

  it("normalizes offset expiry instants and excludes evidence at the exact expiry boundary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-05T22:00:00.000Z"));
    const offsetBinding = {
      ...binding,
      tenantId: `offset-${crypto.randomUUID()}`,
      providerAccountId: `offset-${crypto.randomUUID()}`,
    };
    const store = new KnowledgePublicationStore(
      createClient({ url: process.env.TURSO_DATABASE_URL! }),
    );
    const candidate = await store.buildCandidate(offsetBinding, [
      {
        ...document("offset expiry", "offset-v1"),
        expiresAt: "2026-09-06T03:00:00+03:00",
      },
    ]);
    await store.activate(offsetBinding, candidate.generationId, {
      generationId: undefined,
      revision: 0,
    });
    expect((await store.search(offsetBinding, "offset", 1))[0]?.expiresAt).toBe(
      "2026-09-06T00:00:00.000Z",
    );
    vi.setSystemTime(new Date("2026-09-06T00:00:00.000Z"));
    expect(await store.search(offsetBinding, "offset", 1)).toEqual([]);
  });

  it("rejects duplicate and conflicting payloads for one provider/source version identity", async () => {
    const identityBinding = {
      ...binding,
      tenantId: `identity-${crypto.randomUUID()}`,
      providerAccountId: `identity-${crypto.randomUUID()}`,
    };
    const store = new KnowledgePublicationStore(
      createClient({ url: process.env.TURSO_DATABASE_URL! }),
    );
    const canonical = document("refunds require approval", "v1");

    await expect(
      store.buildCandidate(identityBinding, [canonical, { ...canonical }]),
    ).rejects.toThrow("duplicate document identity");
    await expect(
      store.buildCandidate(identityBinding, [
        canonical,
        document("refunds are automatically approved", "v1"),
      ]),
    ).rejects.toThrow("conflicting source/version payload");
  });

  it("keeps a known-good publication active when activation or rollback finds expired evidence", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-05T22:00:00.000Z"));
    const expiryBinding = {
      ...binding,
      tenantId: `expiry-${crypto.randomUUID()}`,
      providerAccountId: `expiry-${crypto.randomUUID()}`,
    };
    const store = new KnowledgePublicationStore(
      createClient({ url: process.env.TURSO_DATABASE_URL! }),
    );
    const knownGood = await store.buildCandidate(expiryBinding, [
      document("refunds require approval", "v1"),
    ]);
    await store.activate(expiryBinding, knownGood.generationId, {
      generationId: undefined,
      revision: 0,
    });

    const expiresBeforeActivation = await store.buildCandidate(expiryBinding, [
      {
        ...document("expired before activation", "v2"),
        expiresAt: "2026-09-05T22:00:05.000Z",
      },
    ]);
    vi.setSystemTime(new Date("2026-09-05T22:00:05.000Z"));
    await expect(
      store.activate(
        expiryBinding,
        expiresBeforeActivation.generationId,
        await store.publication(expiryBinding),
      ),
    ).rejects.toThrow("incomplete or inactive");
    expect(await store.activeGeneration(expiryBinding)).toBe(
      knownGood.generationId,
    );

    vi.setSystemTime(new Date("2026-09-05T22:00:06.000Z"));
    const expiresBeforeRollback = await store.buildCandidate(expiryBinding, [
      {
        ...document("expires before rollback", "v3"),
        expiresAt: "2026-09-05T22:00:10.000Z",
      },
    ]);
    await store.activate(
      expiryBinding,
      expiresBeforeRollback.generationId,
      await store.publication(expiryBinding),
    );
    const replacement = await store.buildCandidate(expiryBinding, [
      document("refunds require a documented review", "v4"),
    ]);
    await store.activate(
      expiryBinding,
      replacement.generationId,
      await store.publication(expiryBinding),
    );

    vi.setSystemTime(new Date("2026-09-05T22:00:10.000Z"));
    await expect(
      store.rollback(expiryBinding, expiresBeforeRollback.generationId),
    ).rejects.toThrow("incomplete or inactive");
    expect(await store.activeGeneration(expiryBinding)).toBe(
      replacement.generationId,
    );
    expect(
      (await store.search(expiryBinding, "documented review", 1))[0]
        ?.generationId,
    ).toBe(replacement.generationId);
  });
});
