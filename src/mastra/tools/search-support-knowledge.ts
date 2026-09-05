import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  ensureProviderFixtures,
  providerRegistry,
  resolveConfiguredBinding,
} from "../providers/registry";
import { knowledgePublicationStore } from "../lib/knowledge-publications";
import { searchPublishedVector } from "../lib/vector-store";

const bindingSchema = z.object({
  tenantId: z.string(),
  providerKind: z.literal("local"),
  providerAccountId: z.string(),
  externalConversationId: z.string(),
});

/** Provider-backed lookup keeps case knowledge binding independent of vectors. */
export const searchSupportKnowledgeTool = createTool({
  id: "search_support_knowledge",
  description:
    "Search policy evidence through the case-persisted knowledge port.",
  inputSchema: z.object({
    queryText: z.string().min(1),
    topK: z.number().int().min(1).max(20).default(5),
    binding: bindingSchema,
  }),
  outputSchema: z.object({
    sources: z.array(
      z.object({
        document: z.string(),
        score: z.number(),
        metadata: z.object({
          title: z.string(),
          source: z.string(),
          text: z.string(),
          version: z.string(),
          documentHash: z.string(),
          generationId: z.string(),
          effectiveAt: z.string(),
          indexedAt: z.string(),
          expiresAt: z.string().optional(),
          providerKind: z.string(),
          providerAccountId: z.string(),
        }),
      }),
    ),
  }),
  execute: async ({ queryText, topK, binding }) => {
    const configured = resolveConfiguredBinding(binding);
    await ensureProviderFixtures(configured);
    // Bootstrap a serving generation only when this account has never been
    // published. Subsequent searches never ask the provider directly.
    if (!(await knowledgePublicationStore.activeGeneration(configured))) {
      const provider = providerRegistry(configured).knowledge(configured);
      const refs = await provider.listChanged(configured);
      const documents = await Promise.all(
        refs.map(async ({ source }) => {
          const document = await provider.fetchDocument(configured, source);
          if (!document)
            throw new Error(
              `Knowledge document ${source} disappeared during initial publication.`,
            );
          return document;
        }),
      );
      const candidate = await knowledgePublicationStore.buildCandidate(
        configured,
        documents,
      );
      await knowledgePublicationStore.activate(
        configured,
        candidate.generationId,
        undefined,
      );
    }
    const lexicalEvidence = await knowledgePublicationStore.search(
      configured,
      queryText,
      topK,
    );
    const generationId =
      await knowledgePublicationStore.activeGeneration(configured);
    const evidence =
      process.env.SUPPORT_KNOWLEDGE_RETRIEVAL === "vector" && generationId
        ? await searchPublishedVector(generationId, queryText, topK)
        : lexicalEvidence;
    return {
      sources: evidence.map((entry) => ({
        document: entry.text,
        score: entry.score,
        metadata: {
          title: entry.title,
          source: entry.source,
          text: entry.text,
          version: entry.version,
          documentHash: entry.documentHash,
          generationId: entry.generationId,
          effectiveAt: entry.effectiveAt,
          indexedAt: entry.indexedAt,
          expiresAt: entry.expiresAt,
          providerKind: entry.providerKind,
          providerAccountId: entry.providerAccountId,
        },
      })),
    };
  },
});
