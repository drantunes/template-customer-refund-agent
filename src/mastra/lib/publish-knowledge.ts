import type { ProviderBinding } from "../providers/contracts";
import {
  ensureProviderFixtures,
  providerRegistry,
  resolveConfiguredBinding,
} from "../providers/registry";
import { buildPublishedVectorCandidate } from "./vector-store";
import { knowledgePublicationStore } from "./knowledge-publications";

/** Build a complete replacement outside the serving pointer, then publish it
 * only against the revision observed before provider reads. */
export async function publishKnowledge(
  requestedBinding: ProviderBinding,
  options: { onlyIfMissing?: boolean } = {},
) {
  const binding = resolveConfiguredBinding(requestedBinding);
  const base = await knowledgePublicationStore.publication(binding);
  if (options.onlyIfMissing && base.generationId)
    return { generationId: base.generationId, indexed: 0, base };
  await ensureProviderFixtures(binding);
  const knowledge = providerRegistry(binding).knowledge(binding);
  const refs = await knowledge.listChanged(binding);
  const documents = await Promise.all(
    refs.map(async ({ source }) => {
      const document = await knowledge.fetchDocument(binding, source);
      if (!document)
        throw new Error(
          `Knowledge document ${source} disappeared during indexing.`,
        );
      return document;
    }),
  );
  const candidate = await knowledgePublicationStore.buildCandidate(
    binding,
    documents,
    base,
  );
  if (process.env.SUPPORT_KNOWLEDGE_RETRIEVAL === "vector")
    await buildPublishedVectorCandidate(
      binding,
      candidate.generationId,
      documents,
    );
  try {
    await knowledgePublicationStore.activate(
      binding,
      candidate.generationId,
      base,
    );
  } catch (error) {
    // Concurrent first readers may finish the same trusted initialization.
    // Return only the winner; a stale reindex remains an explicit failure.
    if (
      options.onlyIfMissing &&
      (await knowledgePublicationStore.activeGeneration(binding))
    ) {
      const winner = await knowledgePublicationStore.publication(binding);
      if (!winner.generationId) throw error;
      return { generationId: winner.generationId, indexed: 0, base: winner };
    }
    throw error;
  }
  return candidate;
}
