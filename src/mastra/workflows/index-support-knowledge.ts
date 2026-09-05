import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { knowledgePublicationStore } from "../lib/knowledge-publications";
import { buildPublishedVectorCandidate } from "../lib/vector-store";
import { defaultLocalBinding } from "../runtime/local-runtime";
import {
  ensureProviderFixtures,
  providerRegistry,
  resolveConfiguredBinding,
} from "../providers/registry";

const chunkAndEmbedStep = createStep({
  id: "chunk-and-embed-docs",
  description:
    "Chunk each policy document and embed the chunks with the Gateway embedding model.",
  inputSchema: z.object({}),
  outputSchema: z.object({ indexed: z.number(), generationId: z.string() }),
  execute: async () => {
    const binding = resolveConfiguredBinding(defaultLocalBinding());
    await ensureProviderFixtures(binding);
    const knowledge = providerRegistry(binding).knowledge(binding);
    const documents = await Promise.all(
      (await knowledge.listChanged(binding)).map(async ({ source }) => {
        const document = await knowledge.fetchDocument(binding, source);
        if (!document)
          throw new Error(
            `Knowledge document ${source} disappeared during indexing.`,
          );
        return document;
      }),
    );
    // Fetch and validate the full replacement before changing the serving
    // pointer. The local lexical path is intentionally authoritative when no
    // embedding credential is configured; a vector implementation may cache
    // this same immutable generation but must never become a second source.
    const previousGenerationId =
      await knowledgePublicationStore.activeGeneration(binding);
    const candidate = await knowledgePublicationStore.buildCandidate(
      binding,
      documents,
    );
    // The vector index is blue/green too. Any chunk/embed/upsert error leaves
    // the SQL serving pointer untouched, so both lexical and vector readers
    // continue to observe the prior published generation.
    if (process.env.SUPPORT_KNOWLEDGE_RETRIEVAL === "vector")
      await buildPublishedVectorCandidate(
        binding,
        candidate.generationId,
        documents,
      );
    await knowledgePublicationStore.activate(
      binding,
      candidate.generationId,
      previousGenerationId,
    );
    return candidate;
  },
});

export const indexSupportKnowledgeWorkflow = createWorkflow({
  id: "index-support-knowledge",
  description:
    "Chunks and embeds the refund/shipping/subscription/escalation policy docs into the vector store.",
  inputSchema: z.object({}),
  outputSchema: z.object({ indexed: z.number(), generationId: z.string() }),
})
  .then(chunkAndEmbedStep)
  .commit();
