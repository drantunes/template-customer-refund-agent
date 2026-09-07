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

  it("rejects candidate row and binding tampering without changing the serving pointer or revision", async () => {
    const tamperBinding = {
      ...binding,
      tenantId: `tamper-${crypto.randomUUID()}`,
      providerAccountId: `tamper-${crypto.randomUUID()}`,
    };
    const client = createClient({ url: process.env.TURSO_DATABASE_URL! });
    const store = new KnowledgePublicationStore(client);
    const knownGood = await store.buildCandidate(tamperBinding, [
      document("refunds require approval", "v1"),
    ]);
    await store.activate(tamperBinding, knownGood.generationId, {
      generationId: undefined,
      revision: 0,
    });
    const expected = await store.publication(tamperBinding);
    const candidateDocuments = () => [
      {
        ...document("two document candidate one", "v2"),
        source: "policy://one",
      },
      {
        ...document("two document candidate two", "v2"),
        source: "policy://two",
      },
    ];
    const rejectTamperedCandidate = async (
      alter: (generationId: string) => Promise<void>,
    ) => {
      const candidate = await store.buildCandidate(
        tamperBinding,
        candidateDocuments(),
      );
      await alter(candidate.generationId);
      await expect(
        store.activate(tamperBinding, candidate.generationId, expected),
      ).rejects.toThrow(/incomplete or inactive|durable binding/);
      expect(await store.publication(tamperBinding)).toEqual(expected);
    };

    await rejectTamperedCandidate(async (generationId) => {
      await client.execute({
        sql: "DELETE FROM support_knowledge_documents WHERE generation_id = ? AND source = ?",
        args: [generationId, "policy://one"],
      });
    });
    await rejectTamperedCandidate(async (generationId) => {
      await client.execute({
        sql: "INSERT INTO support_knowledge_documents(generation_id, source, title, text, version, document_hash, effective_at, indexed_at, expires_at, provider_kind, provider_account_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)",
        args: [
          generationId,
          "policy://added",
          "Added policy",
          "added after candidate build",
          "v2",
          "forged",
          "2026-01-01T00:00:00.000Z",
          "2026-09-05T22:00:00.000Z",
          tamperBinding.providerKind,
          tamperBinding.providerAccountId,
        ],
      });
    });
    await rejectTamperedCandidate(async (generationId) => {
      await client.execute({
        sql: "UPDATE support_knowledge_documents SET text = ? WHERE generation_id = ? AND source = ?",
        args: [
          "refunds are automatically approved",
          generationId,
          "policy://one",
        ],
      });
    });
    await rejectTamperedCandidate(async (generationId) => {
      await client.execute({
        sql: "UPDATE support_knowledge_documents SET document_hash = ? WHERE generation_id = ? AND source = ?",
        args: ["forged", generationId, "policy://one"],
      });
    });
    await rejectTamperedCandidate(async (generationId) => {
      await client.execute({
        sql: "UPDATE support_knowledge_documents SET indexed_at = ? WHERE generation_id = ? AND source = ?",
        args: ["not-a-timestamp", generationId, "policy://one"],
      });
    });
    await rejectTamperedCandidate(async (generationId) => {
      await client.execute({
        sql: "UPDATE support_knowledge_documents SET indexed_at = ? WHERE generation_id = ? AND source = ?",
        args: ["2026-01-02T00:00:00.000Z", generationId, "policy://one"],
      });
    });
    await rejectTamperedCandidate(async (generationId) => {
      await client.execute({
        sql: "UPDATE support_knowledge_generations SET account_key = ? WHERE id = ?",
        args: ["foreign-account-key", generationId],
      });
    });
    await rejectTamperedCandidate(async (generationId) => {
      await client.execute({
        sql: "UPDATE support_knowledge_documents SET provider_account_id = ? WHERE generation_id = ? AND source = ?",
        args: ["foreign-account", generationId, "policy://one"],
      });
    });
    await rejectTamperedCandidate(async (generationId) => {
      await client.execute({
        sql: "UPDATE support_knowledge_generations SET account_key = ?, tenant_id = ?, provider_account_id = ? WHERE id = ?",
        args: [
          "foreign-account-key",
          "foreign-tenant",
          "foreign-account",
          generationId,
        ],
      });
    });
    await rejectTamperedCandidate(async (generationId) => {
      await client.execute({
        sql: "UPDATE support_knowledge_documents SET effective_at = ? WHERE generation_id = ? AND source = ?",
        args: ["2999-01-01T00:00:00.000Z", generationId, "policy://one"],
      });
    });
    await rejectTamperedCandidate(async (generationId) => {
      await client.execute({
        sql: "UPDATE support_knowledge_documents SET expires_at = ? WHERE generation_id = ? AND source = ?",
        args: ["2026-01-01T00:00:00.000Z", generationId, "policy://one"],
      });
    });

    const rebound = await store.buildCandidate(
      tamperBinding,
      candidateDocuments(),
    );
    const other = await store.buildCandidate(tamperBinding, [
      { ...document("unrelated candidate", "v3"), source: "policy://other" },
    ]);
    await client.execute({
      sql: "UPDATE support_knowledge_documents SET generation_id = ? WHERE generation_id = ? AND source = ?",
      args: [other.generationId, rebound.generationId, "policy://one"],
    });
    await expect(
      store.activate(tamperBinding, rebound.generationId, expected),
    ).rejects.toThrow("incomplete or inactive");
    expect(await store.publication(tamperBinding)).toEqual(expected);
  });

  it("rejects rollback of an altered historical generation without changing the current revision", async () => {
    const rollbackBinding = {
      ...binding,
      tenantId: `rollback-integrity-${crypto.randomUUID()}`,
      providerAccountId: `rollback-integrity-${crypto.randomUUID()}`,
    };
    const client = createClient({ url: process.env.TURSO_DATABASE_URL! });
    const store = new KnowledgePublicationStore(client);
    const historical = await store.buildCandidate(rollbackBinding, [
      document("historical refund policy", "v1"),
    ]);
    await store.activate(rollbackBinding, historical.generationId, {
      generationId: undefined,
      revision: 0,
    });
    const current = await store.buildCandidate(rollbackBinding, [
      document("current refund policy", "v2"),
    ]);
    await store.activate(
      rollbackBinding,
      current.generationId,
      await store.publication(rollbackBinding),
    );
    const expected = await store.publication(rollbackBinding);
    await client.execute({
      sql: "UPDATE support_knowledge_documents SET text = ? WHERE generation_id = ?",
      args: ["tampered historical policy", historical.generationId],
    });
    await expect(
      store.rollback(rollbackBinding, historical.generationId),
    ).rejects.toThrow("incomplete or inactive");
    expect(await store.publication(rollbackBinding)).toEqual(expected);
  });
});
