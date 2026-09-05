import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

const inheritedDatabaseSentinel = `file:${join(tmpdir(), `phase001-vitest-inherited-sentinel-${randomUUID()}.db`)}`;
const databaseIsolationSetup = ["test/support/database-isolation.setup.ts"];

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/unit/**/*.test.ts"],
          environment: "node",
          env: {
            TURSO_AUTH_TOKEN: "phase001-vitest-sentinel-token",
            TURSO_DATABASE_URL: inheritedDatabaseSentinel,
          },
          setupFiles: databaseIsolationSetup,
        },
      },
      {
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts"],
          environment: "node",
          fileParallelism: false,
          env: {
            TURSO_AUTH_TOKEN: "phase001-vitest-sentinel-token",
            TURSO_DATABASE_URL: inheritedDatabaseSentinel,
          },
          setupFiles: databaseIsolationSetup,
        },
      },
      {
        test: {
          name: "contract",
          include: ["test/contract/**/*.test.ts"],
          environment: "node",
          env: {
            TURSO_AUTH_TOKEN: "phase001-vitest-sentinel-token",
            TURSO_DATABASE_URL: inheritedDatabaseSentinel,
          },
          setupFiles: databaseIsolationSetup,
        },
      },
      {
        test: {
          name: "eval",
          include: ["test/eval/**/*.test.ts"],
          environment: "node",
          env: {
            TURSO_AUTH_TOKEN: "phase001-vitest-sentinel-token",
            TURSO_DATABASE_URL: inheritedDatabaseSentinel,
          },
          setupFiles: databaseIsolationSetup,
        },
      },
      {
        test: {
          name: "web-unit",
          include: ["web/src/**/*.unit.test.ts"],
          environment: "node",
          env: {
            TURSO_AUTH_TOKEN: "phase001-vitest-sentinel-token",
            TURSO_DATABASE_URL: inheritedDatabaseSentinel,
          },
          setupFiles: databaseIsolationSetup,
        },
      },
      {
        test: {
          name: "web-integration",
          include: ["web/src/**/*.integration.test.ts"],
          environment: "node",
          env: {
            TURSO_AUTH_TOKEN: "phase001-vitest-sentinel-token",
            TURSO_DATABASE_URL: inheritedDatabaseSentinel,
          },
          setupFiles: databaseIsolationSetup,
        },
      },
      {
        test: {
          name: "web-contract",
          include: ["web/src/**/*.contract.test.ts"],
          environment: "node",
          env: {
            TURSO_AUTH_TOKEN: "phase001-vitest-sentinel-token",
            TURSO_DATABASE_URL: inheritedDatabaseSentinel,
          },
          setupFiles: databaseIsolationSetup,
        },
      },
      {
        test: {
          name: "web-eval",
          include: ["web/src/**/*.eval.test.ts"],
          environment: "node",
          env: {
            TURSO_AUTH_TOKEN: "phase001-vitest-sentinel-token",
            TURSO_DATABASE_URL: inheritedDatabaseSentinel,
          },
          setupFiles: databaseIsolationSetup,
        },
      },
    ],
  },
});
