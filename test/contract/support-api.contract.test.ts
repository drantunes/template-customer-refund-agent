import { afterEach, describe, expect, it } from "vitest";
import { getActiveSupportAdapter } from "../../src/mastra/integrations/active-adapter";
import {
  mockEmailPayloadSchema,
  supportOpenApiDocument,
} from "../../src/mastra/server/contracts";

const originalSource = process.env.SUPPORT_SOURCE;

afterEach(() => {
  if (originalSource === undefined) delete process.env.SUPPORT_SOURCE;
  else process.env.SUPPORT_SOURCE = originalSource;
});

describe("support API contract", () => {
  it("rejects an invalid inbound DTO without accepting a partial payload", () => {
    const result = mockEmailPayloadSchema.safeParse({
      externalId: "only-an-id",
    });

    expect(result.success).toBe(false);
  });

  it("documents every case-id path parameter in OpenAPI", () => {
    for (const path of [
      "/support/cases/{caseId}",
      "/support/cases/{caseId}/approve",
      "/support/cases/{caseId}/reject",
      "/support/cases/{caseId}/feedback",
    ]) {
      const operation =
        supportOpenApiDocument.paths[
          path as keyof typeof supportOpenApiDocument.paths
        ];
      const method = "get" in operation ? operation.get : operation.post;
      expect(method.parameters).toContainEqual(
        expect.objectContaining({ in: "path", name: "caseId", required: true }),
      );
    }
  });

  it("keeps every public support endpoint and its success response in OpenAPI", () => {
    const expectedPaths = [
      "/support/inbound",
      "/support/cases",
      "/support/cases/{caseId}",
      "/support/cases/{caseId}/approve",
      "/support/cases/{caseId}/reject",
      "/support/cases/{caseId}/feedback",
      "/support/monitoring/summary",
      "/support/knowledge/reindex",
      "/support/openapi.json",
    ];

    expect(Object.keys(supportOpenApiDocument.paths).sort()).toEqual(
      expectedPaths.sort(),
    );
    for (const path of expectedPaths) {
      const operation =
        supportOpenApiDocument.paths[
          path as keyof typeof supportOpenApiDocument.paths
        ];
      const method = "get" in operation ? operation.get : operation.post;
      expect(
        Object.keys(method.responses).some((status) => status.startsWith("2")),
      ).toBe(true);
    }
  });

  it("reports unsupported providers instead of silently using mock", () => {
    process.env.SUPPORT_SOURCE = "unsupported-provider";

    expect(() => getActiveSupportAdapter()).toThrow(
      'Unsupported SUPPORT_SOURCE "unsupported-provider"',
    );
  });
});
