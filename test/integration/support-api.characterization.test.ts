import { describe, expect, it, vi } from "vitest";

vi.mock("@mastra/core/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mastra/core/llm")>();
  return {
    ...actual,
    ModelRouterEmbeddingModel: class DeterministicEmbeddingModel {},
  };
});

import {
  supportCasesListRoute,
  supportInboundRoute,
} from "../../src/mastra/server/routes";

function responseContext(rawBody: string) {
  return {
    req: {
      text: async () => rawBody,
    },
    get: () => undefined,
    json: (body: unknown, status = 200) => ({ body, status }),
  };
}

describe("support API WIP characterization", () => {
  it("rejects malformed inbound JSON at the HTTP boundary", async () => {
    const response = await supportInboundRoute.handler(
      responseContext("{not-json") as never,
    );

    expect(response).toEqual({
      body: { error: "Invalid JSON body." },
      status: 400,
    });
  });

  it("returns the list envelope used by the demo UI", async () => {
    const response = await supportCasesListRoute.handler({
      req: { query: () => undefined },
      json: (body: unknown, status = 200) => ({ body, status }),
    } as never);

    expect(response).toMatchObject({
      status: 200,
      body: { cases: expect.any(Array) },
    });
  });
});
