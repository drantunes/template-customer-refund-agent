import { afterEach, describe, expect, it, vi } from "vitest";
import { listCases, submitCase } from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("support API client", () => {
  it("sends the shared inbound DTO and returns the documented acceptance envelope", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          caseId: "case-1",
          workflowRunId: "run-1",
          status: "processing",
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      submitCase({
        externalId: "web-1",
        from: "alex@example.test",
        subject: "Help",
        body: "Please help.",
      }),
    ).resolves.toEqual({
      caseId: "case-1",
      workflowRunId: "run-1",
      status: "processing",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/support/inbound",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"externalId":"web-1"'),
      }),
    );
  });

  it("uses the documented list envelope", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ cases: [] }), { status: 200 }),
        ),
    );

    await expect(listCases("alex@example.test")).resolves.toEqual({
      cases: [],
    });
  });
});
