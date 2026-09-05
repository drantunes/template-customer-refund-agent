import { ModelRouterEmbeddingModel } from "@mastra/core/llm";
import { createVectorQueryTool } from "@mastra/rag";
import {
  EMBEDDING_MODEL,
  KNOWLEDGE_INDEX,
  vectorStore,
} from "../lib/vector-store";

export const searchSupportKnowledgeTool = createVectorQueryTool({
  id: "search_support_knowledge",
  description:
    "Semantic search over indexed support/refund/shipping/subscription policy documents. Use this before making any claim about policy or refund eligibility.",
  vectorStoreName: "supportKnowledge",
  vectorStore,
  indexName: KNOWLEDGE_INDEX,
  model: new ModelRouterEmbeddingModel(EMBEDDING_MODEL),
});
