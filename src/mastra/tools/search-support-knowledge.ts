import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  ensureProviderFixtures,
  providerRegistry,
  resolveConfiguredBinding,
} from "../providers/registry";

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
        }),
      }),
    ),
  }),
  execute: async ({ queryText, topK, binding }) => {
    const configured = resolveConfiguredBinding(binding);
    await ensureProviderFixtures(configured);
    const evidence = await providerRegistry(configured)
      .knowledge(configured)
      .search(configured, queryText, topK);
    return {
      sources: evidence.map((entry) => ({
        document: entry.text,
        score: entry.score,
        metadata: {
          title: entry.title,
          source: entry.source,
          text: entry.text,
          version: entry.version,
        },
      })),
    };
  },
});
