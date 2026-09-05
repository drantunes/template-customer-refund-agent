import { LibSQLVector } from "@mastra/libsql";
import { ModelRouterEmbeddingModel } from "@mastra/core/llm";
import { MDocument } from "@mastra/rag";
import type {
  KnowledgeEvidence,
  ProviderBinding,
} from "../providers/contracts";
import type { PublishedEvidence } from "./knowledge-publications";
import { createHash } from "node:crypto";

function resolveLibsqlConfig() {
  return {
    url: process.env.TURSO_DATABASE_URL || "file:./mastra.db",
    authToken: process.env.TURSO_AUTH_TOKEN || undefined,
  };
}

export const vectorStore = new LibSQLVector({
  id: "support-vectors",
  ...resolveLibsqlConfig(),
});

export const KNOWLEDGE_INDEX = "support_knowledge";
export const EMBEDDING_MODEL = "openai/text-embedding-3-small";
export const EMBEDDING_DIMENSION = 1536;

const indexNameForGeneration = (generationId: string) =>
  `${KNOWLEDGE_INDEX}_${createHash("sha256")
    .update(generationId)
    .digest("hex")
    .slice(0, 32)}`;

/** Builds an isolated physical index. Callers publish the matching SQL
 * generation only after this succeeds, preserving the previous serving pair. */
export async function buildPublishedVectorCandidate(
  binding: ProviderBinding,
  generationId: string,
  documents: KnowledgeEvidence[],
) {
  const indexName = indexNameForGeneration(generationId);
  await vectorStore.createIndex({
    indexName,
    dimension: EMBEDDING_DIMENSION,
    metric: "cosine",
  });
  const chunks: Array<{ text: string; metadata: Record<string, unknown> }> = [];
  for (const document of documents) {
    if (!document.effectiveAt)
      throw new Error(
        "Knowledge vector candidate lacks source effective time.",
      );
    const mdoc = MDocument.fromText(document.text, {
      title: document.title,
      source: document.source,
    });
    const pieces = await mdoc.chunk({
      strategy: "recursive",
      maxSize: 512,
      overlap: 50,
    });
    for (const piece of pieces)
      chunks.push({
        text: String(piece.text),
        metadata: {
          title: document.title,
          source: document.source,
          text: String(piece.text),
          version: document.version,
          documentHash: createHash("sha256")
            .update(
              JSON.stringify([
                document.source,
                document.version,
                document.text,
              ]),
            )
            .digest("hex"),
          generationId,
          effectiveAt: document.effectiveAt,
          indexedAt: new Date().toISOString(),
          expiresAt: document.expiresAt,
          tenantId: binding.tenantId,
          providerKind: binding.providerKind,
          providerAccountId: binding.providerAccountId,
        },
      });
  }
  if (chunks.length === 0)
    throw new Error("Knowledge vector candidate has no chunks.");
  const model = new ModelRouterEmbeddingModel(EMBEDDING_MODEL);
  const { embeddings } = await model.doEmbed({
    values: chunks.map((chunk) => chunk.text),
  });
  if (
    embeddings.length !== chunks.length ||
    embeddings.some(
      (embedding) =>
        embedding.length !== EMBEDDING_DIMENSION ||
        embedding.some((value) => !Number.isFinite(value)),
    )
  )
    throw new Error(
      "Knowledge vector candidate has invalid embedding dimensions.",
    );
  await vectorStore.upsert({
    indexName,
    vectors: embeddings,
    metadata: chunks.map((chunk) => chunk.metadata),
  });
}

/** Vector retrieval is optional at runtime, but always reads the SQL-selected
 * generation. It cannot inspect a candidate or an orphaned old index. */
export async function searchPublishedVector(
  binding: ProviderBinding,
  generationId: string,
  query: string,
  topK: number,
): Promise<PublishedEvidence[]> {
  const model = new ModelRouterEmbeddingModel(EMBEDDING_MODEL);
  const { embeddings } = await model.doEmbed({ values: [query] });
  if (
    embeddings.length !== 1 ||
    embeddings[0]?.length !== EMBEDDING_DIMENSION ||
    embeddings[0].some((value) => !Number.isFinite(value))
  )
    throw new Error("Knowledge vector query has invalid embedding dimensions.");
  const rows = await vectorStore.query({
    indexName: indexNameForGeneration(generationId),
    queryVector: embeddings[0]!,
    topK,
  });
  return rows
    .map((row) => {
      const metadata = row.metadata as Record<string, unknown>;
      if (
        metadata.tenantId !== binding.tenantId ||
        metadata.providerKind !== binding.providerKind ||
        metadata.providerAccountId !== binding.providerAccountId ||
        metadata.generationId !== generationId ||
        typeof metadata.documentHash !== "string" ||
        !metadata.documentHash ||
        !Number.isFinite(Date.parse(String(metadata.effectiveAt))) ||
        !Number.isFinite(Date.parse(String(metadata.indexedAt)))
      )
        throw new Error("Knowledge vector result has invalid provenance.");
      return {
        title: String(metadata.title),
        text: String(metadata.text),
        source: String(metadata.source),
        version: String(metadata.version),
        score: row.score,
        documentHash: String(metadata.documentHash),
        generationId,
        effectiveAt: String(metadata.effectiveAt),
        indexedAt: String(metadata.indexedAt),
        expiresAt:
          typeof metadata.expiresAt === "string"
            ? metadata.expiresAt
            : undefined,
        providerKind: String(metadata.providerKind),
        providerAccountId: String(metadata.providerAccountId),
      };
    })
    .filter(
      (entry) =>
        entry.providerKind === binding.providerKind &&
        entry.providerAccountId === binding.providerAccountId &&
        !entry.effectiveAt.includes("undefined") &&
        Date.parse(entry.effectiveAt) <= Date.now() &&
        (!entry.expiresAt || Date.parse(entry.expiresAt) > Date.now()),
    );
}
