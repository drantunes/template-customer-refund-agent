import { LibSQLVector } from "@mastra/libsql";

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
