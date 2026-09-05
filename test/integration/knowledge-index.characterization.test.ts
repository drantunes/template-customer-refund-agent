import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

const databaseFiles: string[] = [];

afterEach(async () => {
  vi.doUnmock("@mastra/core/llm");
  await Promise.all(
    databaseFiles.splice(0).map((path) => rm(path, { force: true })),
  );
});

describe("support knowledge index", () => {
  it("publishes and searches an authoritative generation without model credentials", async () => {
    const databasePath = `/private/tmp/phase001-rag-${crypto.randomUUID()}.db`;
    databaseFiles.push(
      databasePath,
      `${databasePath}-shm`,
      `${databasePath}-wal`,
    );
    process.env.TURSO_DATABASE_URL = `file:${databasePath}`;
    vi.resetModules();
    vi.doMock("@mastra/core/llm", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@mastra/core/llm")>();
      return {
        ...actual,
        ModelRouterEmbeddingModel: class DeterministicEmbeddingModel {
          async doEmbed({ values }: { values: string[] }) {
            return {
              embeddings: values.map(() => [1, ...Array(1535).fill(0)]),
            };
          }
        },
      };
    });

    const [{ mastra }, { searchSupportKnowledgeTool }] = await Promise.all([
      import("../../src/mastra/index"),
      import("../../src/mastra/tools/search-support-knowledge"),
    ]);
    const run = await mastra
      .getWorkflow("indexSupportKnowledgeWorkflow")
      .createRun();
    const indexed = await run.start({ inputData: {} });
    expect(indexed).toMatchObject({
      status: "success",
      result: { indexed: expect.any(Number) },
    });
    expect(
      indexed.status === "success" && indexed.result.indexed,
    ).toBeGreaterThan(0);
    const results = await searchSupportKnowledgeTool.execute({
      queryText: "duplicate charge refund policy",
      topK: 3,
      binding: {
        tenantId: "local-demo",
        providerKind: "local",
        providerAccountId: "local-demo",
        externalConversationId: "test",
      },
    });
    expect(results.sources).not.toHaveLength(0);
    expect(results.sources[0]?.metadata).toMatchObject({
      source: expect.any(String),
      generationId: expect.any(String),
      documentHash: expect.any(String),
    });
  });
});
