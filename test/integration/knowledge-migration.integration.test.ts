import { createClient } from "@libsql/client";
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { LocalRuntime } from "../../src/mastra/runtime/local-runtime";
import { POLICY_DOCUMENTS } from "../../src/mastra/knowledge/policy-docs";

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { force: true })));
});

describe("Phase 003 local knowledge migration", () => {
  it("backfills only known versioned fixture applicability and leaves unknown records unpublished", async () => {
    const path = `/private/tmp/knowledge-phase003-${crypto.randomUUID()}.db`;
    paths.push(path, `${path}-shm`, `${path}-wal`);
    const client = createClient({ url: `file:${path}` });
    const known = POLICY_DOCUMENTS.find(
      (document) => document.source === "duplicate-charge-policy",
    )!;
    await client.executeMultiple(`
      CREATE TABLE local_knowledge (
        tenant_id TEXT NOT NULL, provider_account_id TEXT NOT NULL,
        source TEXT NOT NULL, title TEXT NOT NULL, text TEXT NOT NULL,
        version TEXT NOT NULL,
        PRIMARY KEY(tenant_id, provider_account_id, source)
      );
    `);
    await client.batch([
      {
        sql: "INSERT INTO local_knowledge VALUES (?, ?, ?, ?, ?, ?)",
        args: [
          "local-demo",
          "local-demo",
          known.source,
          known.title,
          known.text,
          "local-v1",
        ],
      },
      {
        sql: "INSERT INTO local_knowledge VALUES (?, ?, ?, ?, ?, ?)",
        args: [
          "local-demo",
          "local-demo",
          "imported://unknown",
          "Unknown import",
          "No authoritative applicability metadata.",
          "import-v7",
        ],
      },
    ]);
    const runtime = new LocalRuntime(client);
    const binding = {
      tenantId: "local-demo",
      providerKind: "local" as const,
      providerAccountId: "local-demo",
      externalConversationId: "migration-test",
    };
    expect(
      await runtime.fetchDocument(binding, "duplicate-charge-policy"),
    ).toMatchObject({ effectiveAt: "2026-01-01T00:00:00.000Z" });
    expect(
      await runtime.fetchDocument(binding, "imported://unknown"),
    ).toMatchObject({
      effectiveAt: undefined,
    });
    client.close();
  });
});
