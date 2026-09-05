import { createClient } from "@libsql/client";
import { describe, expect, it } from "vitest";
import { KnowledgePublicationStore } from "../../src/mastra/lib/knowledge-publications";

const binding = {
  tenantId: "tenant-a",
  providerKind: "local" as const,
  providerAccountId: "account-a",
  externalConversationId: "conversation-a",
};
const document = (text: string, version: string) => ({
  title: "Refund policy",
  source: "policy://refund",
  text,
  version,
  score: 1,
});

describe("knowledge publication generations", () => {
  it("serves only the activated tenant generation, keeps failures and stale writers from replacing it, and rolls back", async () => {
    const store = new KnowledgePublicationStore(
      createClient({ url: process.env.TURSO_DATABASE_URL! }),
    );
    const first = await store.buildCandidate(binding, [
      document("refunds require approval", "v1"),
    ]);
    await store.activate(binding, first.generationId, undefined);
    expect(
      (await store.search(binding, "refund approval", 5)).map(
        (entry) => entry.generationId,
      ),
    ).toEqual([first.generationId]);

    await expect(store.buildCandidate(binding, [])).rejects.toThrow(
      "no documents",
    );
    expect(await store.activeGeneration(binding)).toBe(first.generationId);

    const next = await store.buildCandidate(binding, [
      document("shipping only", "v2"),
    ]);
    await expect(
      store.activate(binding, next.generationId, undefined),
    ).rejects.toThrow("compare-and-set");
    expect(await store.activeGeneration(binding)).toBe(first.generationId);

    await store.activate(binding, next.generationId, first.generationId);
    expect(await store.activeGeneration(binding)).toBe(next.generationId);
    await store.rollback(binding, first.generationId);
    expect(await store.activeGeneration(binding)).toBe(first.generationId);
    expect(
      await store.search(
        { ...binding, tenantId: "tenant-b", providerAccountId: "account-b" },
        "refund",
        5,
      ),
    ).toEqual([]);
  });
});
