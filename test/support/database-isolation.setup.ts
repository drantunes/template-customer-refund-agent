import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const inheritedDatabaseUrl = process.env.TURSO_DATABASE_URL;
process.env.LOCAL_AUTH_SIGNING_KEY =
  "phase003-test-signing-key-must-be-at-least-32-chars";
const inheritedAuthToken = process.env.TURSO_AUTH_TOKEN;
// Eval projects must never inherit an opt-in paid retrieval route or provider
// credentials from a developer shell. Deterministic transports are the only
// allowed validation transport in this test process.
delete process.env.SUPPORT_KNOWLEDGE_RETRIEVAL;
delete process.env.OPENAI_API_KEY;
delete process.env.OPENAI_BASE_URL;
const databaseDirectory = mkdtempSync(join(tmpdir(), "phase001-vitest-"));
const databasePath = join(databaseDirectory, "support.db");

process.env.PHASE001_TEST_DATABASE_DIRECTORY = databaseDirectory;
process.env.PHASE001_TEST_DATABASE_URL = `file:${databasePath}`;
process.env.PHASE001_TEST_INHERITED_DATABASE_SENTINEL =
  inheritedDatabaseUrl?.startsWith(
    `file:${join(tmpdir(), "phase001-vitest-inherited-sentinel-")}`,
  ) && inheritedAuthToken === "phase001-vitest-sentinel-token"
    ? "present"
    : "missing";
process.env.PHASE001_TEST_INHERITED_DATABASE_SENTINEL_PATH =
  process.env.PHASE001_TEST_INHERITED_DATABASE_SENTINEL === "present"
    ? inheritedDatabaseUrl!.replace("file:", "")
    : "";
process.env.TURSO_DATABASE_URL = process.env.PHASE001_TEST_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;

afterAll(() => {
  rmSync(databaseDirectory, { force: true, recursive: true });
});
