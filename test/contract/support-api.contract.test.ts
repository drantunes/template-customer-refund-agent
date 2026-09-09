import { afterEach, describe, expect, it } from "vitest";
import { getActiveSupportAdapter } from "../../src/mastra/integrations/active-adapter";
import {
  mockEmailPayloadSchema,
  supportOpenApiDocument,
} from "../../src/mastra/server/contracts";
import { supportRoutes } from "../../src/mastra/server/routes";

const originalSource = process.env.SUPPORT_SOURCE;

afterEach(() => {
  if (originalSource === undefined) delete process.env.SUPPORT_SOURCE;
  else process.env.SUPPORT_SOURCE = originalSource;
});

describe("support API contract", () => {
  it("matches the complete normalized Zod-derived OpenAPI document", () => {
    expect(supportOpenApiDocument).toMatchSnapshot();
  });

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

  it("keeps registered route methods and documented success response schemas in OpenAPI", () => {
    const registeredRoutes = supportRoutes.map((route) => ({
      method: route.method.toLowerCase(),
      path: route.path.replace(/:([^/]+)/g, "{$1}"),
    }));

    expect(Object.keys(supportOpenApiDocument.paths).sort()).toEqual(
      registeredRoutes.map((route) => route.path).sort(),
    );
    for (const { method, path } of registeredRoutes) {
      const operation =
        supportOpenApiDocument.paths[
          path as keyof typeof supportOpenApiDocument.paths
        ];
      const operationForMethod = operation[
        method as keyof typeof operation
      ] as { responses: Record<string, { content?: unknown }> };
      expect(
        Object.entries(operationForMethod.responses).some(
          ([status, response]) =>
            status.startsWith("2") && response.content !== undefined,
        ),
      ).toBe(true);
      expect(operationForMethod).toHaveProperty("responses");
    }
  });

  it("documents the local bearer boundary and explicit public exceptions", () => {
    expect(supportOpenApiDocument.components.securitySchemes).toEqual({
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "Local session",
      },
    });
    for (const path of [
      "/support/auth/login",
      "/support/webhooks/intercom",
      "/support/webhooks/stripe",
    ]) {
      const operation =
        supportOpenApiDocument.paths[
          path as keyof typeof supportOpenApiDocument.paths
        ];
      const method = "get" in operation ? operation.get : operation.post;
      expect(method.security).toEqual([]);
    }
    for (const { path } of supportRoutes) {
      if (
        [
          "/support/auth/login",
          "/support/webhooks/intercom",
          "/support/webhooks/stripe",
        ].includes(path)
      )
        continue;
      const documentedPath = path.replace(
        /:([^/]+)/g,
        "{$1}",
      ) as keyof typeof supportOpenApiDocument.paths;
      const operation = supportOpenApiDocument.paths[documentedPath];
      const method = "get" in operation ? operation.get : operation.post;
      expect(method.security).toBeUndefined();
      expect(supportOpenApiDocument.security).toEqual([{ bearerAuth: [] }]);
    }
    const openApi = supportOpenApiDocument.paths["/support/openapi.json"].get;
    expect(openApi.security).toBeUndefined();
  });

  it("reports unsupported providers instead of silently using mock", () => {
    process.env.SUPPORT_SOURCE = "unsupported-provider";

    expect(() => getActiveSupportAdapter()).toThrow(
      'Unsupported SUPPORT_SOURCE "unsupported-provider"',
    );
  });
});
