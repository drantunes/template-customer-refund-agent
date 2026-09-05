import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const inheritedDatabaseUrl = process.env.TURSO_DATABASE_URL;
const inheritedAuthToken = process.env.TURSO_AUTH_TOKEN;
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
