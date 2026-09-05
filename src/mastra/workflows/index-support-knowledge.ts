import { createStep, createWorkflow } from "@mastra/core/workflows";
import { ModelRouterEmbeddingModel } from "@mastra/core/llm";
import { MDocument } from "@mastra/rag";
import { z } from "zod";
import { POLICY_DOCUMENTS } from "../knowledge/policy-docs";
import {
  EMBEDDING_DIMENSION,
  EMBEDDING_MODEL,
  KNOWLEDGE_INDEX,
  vectorStore,
} from "../lib/vector-store";

const chunkAndEmbedStep = createStep({
  id: "chunk-and-embed-docs",
  description:
    "Chunk each policy document and embed the chunks with the Gateway embedding model.",
  inputSchema: z.object({}),
  outputSchema: z.object({ indexed: z.number() }),
  execute: async () => {
    // Re-indexing is idempotent: drop and recreate the index rather than
    // accumulating duplicates across repeated runs of this workflow.
    const indexes = await vectorStore.listIndexes();
    if (indexes.includes(KNOWLEDGE_INDEX)) {
      await vectorStore.deleteIndex({ indexName: KNOWLEDGE_INDEX });
    }
    await vectorStore.createIndex({
      indexName: KNOWLEDGE_INDEX,
      dimension: EMBEDDING_DIMENSION,
      metric: "cosine",
    });

    const chunks: Array<{ text: string; metadata: Record<string, unknown> }> =
      [];
    for (const doc of POLICY_DOCUMENTS) {
      const mdoc = MDocument.fromText(doc.text, {
        title: doc.title,
        source: doc.source,
      });
      const docChunks = await mdoc.chunk({
        strategy: "recursive",
        maxSize: 512,
        overlap: 50,
      });
      for (const chunk of docChunks) {
        chunks.push({
          text: String(chunk.text),
          metadata: {
            title: doc.title,
            source: doc.source,
            text: String(chunk.text),
          },
        });
      }
    }

    if (chunks.length === 0) return { indexed: 0 };

    const embeddingModel = new ModelRouterEmbeddingModel(EMBEDDING_MODEL);
    const { embeddings } = await embeddingModel.doEmbed({
      values: chunks.map((c) => c.text),
    });

    await vectorStore.upsert({
      indexName: KNOWLEDGE_INDEX,
      vectors: embeddings,
      metadata: chunks.map((c) => c.metadata),
    });

    return { indexed: chunks.length };
  },
});

export const indexSupportKnowledgeWorkflow = createWorkflow({
  id: "index-support-knowledge",
  description:
    "Chunks and embeds the refund/shipping/subscription/escalation policy docs into the vector store.",
  inputSchema: z.object({}),
  outputSchema: z.object({ indexed: z.number() }),
})
  .then(chunkAndEmbedStep)
  .commit();
