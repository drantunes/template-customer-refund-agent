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
  it("indexes and searches the temporary libSQL vector store with deterministic embeddings", async () => {
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

    const [{ mastra }, { KNOWLEDGE_INDEX, vectorStore }] = await Promise.all([
      import("../../src/mastra/index"),
      import("../../src/mastra/lib/vector-store"),
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

    const results = await vectorStore.query({
      indexName: KNOWLEDGE_INDEX,
      queryVector: [1, ...Array(1535).fill(0)],
      topK: 3,
    });
    expect(results).not.toHaveLength(0);
    expect(results[0]?.metadata).toMatchObject({ source: expect.any(String) });
  });
});
