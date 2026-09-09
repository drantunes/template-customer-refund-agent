import { createClient } from "@libsql/client";
import { requireLocalDatabaseUrl } from "../src/mastra/lib/database-url.ts";
import {
  localFixtureBinding,
  resetLocalFixtures,
  seedLocalFixtures,
} from "../src/mastra/runtime/local-fixtures.ts";

const mode = process.argv[2];
if (mode !== "seed" && mode !== "reset")
  throw new Error("Usage: npm run local:seed | npm run local:reset");

const url = requireLocalDatabaseUrl();
const binding = localFixtureBinding();
const client = createClient({ url, timeout: 0 });
try {
  if (mode === "seed") {
    await seedLocalFixtures(client, binding);
    console.log(
      `Seeded deterministic local commerce fixtures for ${binding.tenantId}/${binding.providerAccountId}.`,
    );
  } else {
    await resetLocalFixtures(client, binding);
    console.log(
      `Reset local fixtures for ${binding.tenantId}/${binding.providerAccountId}; durable case and Mastra tables were untouched.`,
    );
  }
} finally {
  client.close();
}
