import { resolveDatabaseUrl } from "../src/mastra/lib/database-url.ts";

// npm starts this preload from the project root. Export an absolute URL before
// Mastra launches children from src/mastra/public or .mastra/output.
process.env.TURSO_DATABASE_URL = resolveDatabaseUrl();
