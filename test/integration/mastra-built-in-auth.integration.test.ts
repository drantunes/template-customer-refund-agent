import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHonoServer } from "@mastra/deployer/server";
import { issueLocalSession } from "../../src/mastra/server/auth";

const databases: string[] = [];
const shutdowns: Array<() => Promise<void>> = [];

async function configuredServer() {
  const path = `/private/tmp/phase003-built-in-auth-${crypto.randomUUID()}.db`;
  databases.push(path, `${path}-shm`, `${path}-wal`);
  process.env.TURSO_DATABASE_URL = `file:${path}`;
  process.env.SUPPORT_SOURCE = "mock";
  vi.resetModules();
  vi.doMock("@mastra/core/llm", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@mastra/core/llm")>();
    return {
      ...actual,
      ModelRouterEmbeddingModel: class DeterministicEmbeddingModel {},
    };
  });
  vi.doMock("../../src/mastra/evals", () => ({
    responseAgentScorers: {},
    triageAgentScorers: {},
    supportEvalScorerRegistry: {},
  }));
  const { mastra, shutdownLocalMastra } =
    await import("../../src/mastra/index");
  shutdowns.push(shutdownLocalMastra);
  return createHonoServer(mastra, { browserStream: false });
}

afterEach(async () => {
  await Promise.allSettled(shutdowns.splice(0).map((shutdown) => shutdown()));
  vi.restoreAllMocks();
  vi.doUnmock("../../src/mastra/evals");
  vi.doUnmock("@mastra/core/llm");
  await Promise.all(
    databases.splice(0).map((path) => rm(path, { force: true })),
  );
});

describe("configured Mastra built-in API authorization", () => {
  it("denies unauthenticated and authenticated principals from direct agent APIs", async () => {
    const server = await configuredServer();
    const unauthenticated = await server.request(
      "http://support.test/api/agents",
    );
    expect(unauthenticated.status).toBe(401);
    const customer = await server.request("http://support.test/api/agents", {
      headers: {
        authorization: `Bearer ${issueLocalSession({ id: "customer-alex" })}`,
      },
    });
    expect(customer.status).toBe(403);
    const approver = await server.request("http://support.test/api/workflows", {
      headers: {
        authorization: `Bearer ${issueLocalSession({ id: "approver-demo" })}`,
      },
    });
    expect(approver.status).toBe(403);
  });
});
