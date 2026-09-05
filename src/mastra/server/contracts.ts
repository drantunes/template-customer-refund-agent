import { z } from "zod";
import { caseFeedbackSchema, supportCaseSchema } from "../domain/support-case";

export const mockEmailPayloadSchema = z
  .object({
    externalId: z.string().min(1),
    from: z.email(),
    fromName: z.string().min(1).optional(),
    subject: z.string().optional(),
    body: z.string().min(1),
    receivedAt: z.iso.datetime().optional(),
  })
  .strict();

export const inboundSupportResponseSchema = z.object({
  caseId: z.string(),
  workflowRunId: z.string().optional(),
  status: z.literal("processing"),
});

export const caseListResponseSchema = z.object({
  cases: z.array(supportCaseSchema),
});
export const approvalRequestSchema = z.object({
  approverId: z.string().min(1).optional(),
  note: z.string().max(2_000).optional(),
});
export const feedbackRequestSchema = caseFeedbackSchema.pick({
  rating: true,
  comment: true,
});
export const errorResponseSchema = z.object({ error: z.string() });
export const reindexResponseSchema = z.object({
  indexed: z.number().int().nonnegative(),
});

const caseIdParameter = {
  name: "caseId",
  in: "path",
  required: true,
  schema: { type: "string" },
} as const;

const jsonSchema = (schema: z.core.$ZodType) => z.toJSONSchema(schema);

/** A derived OpenAPI 3.1 document used by the local route and contract checks. */
export const supportOpenApiDocument = {
  openapi: "3.1.0",
  info: { title: "Support demo API", version: "0.1.0" },
  paths: {
    "/support/inbound": {
      post: {
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: jsonSchema(mockEmailPayloadSchema) },
          },
        },
        responses: {
          "200": {
            description: "Ingestion accepted",
            content: {
              "application/json": {
                schema: jsonSchema(inboundSupportResponseSchema),
              },
            },
          },
          "400": {
            description: "Invalid payload",
            content: {
              "application/json": { schema: jsonSchema(errorResponseSchema) },
            },
          },
        },
      },
    },
    "/support/cases": {
      get: {
        responses: {
          "200": {
            description: "Case inbox",
            content: {
              "application/json": {
                schema: jsonSchema(caseListResponseSchema),
              },
            },
          },
        },
      },
    },
    "/support/cases/{caseId}": {
      get: {
        parameters: [caseIdParameter],
        responses: {
          "200": {
            description: "Support case",
            content: {
              "application/json": { schema: jsonSchema(supportCaseSchema) },
            },
          },
          "404": {
            description: "Case not found",
            content: {
              "application/json": { schema: jsonSchema(errorResponseSchema) },
            },
          },
        },
      },
    },
    "/support/cases/{caseId}/approve": {
      post: {
        parameters: [caseIdParameter],
        requestBody: {
          required: false,
          content: {
            "application/json": { schema: jsonSchema(approvalRequestSchema) },
          },
        },
        responses: {
          "200": {
            description: "Updated support case",
            content: {
              "application/json": { schema: jsonSchema(supportCaseSchema) },
            },
          },
        },
      },
    },
    "/support/cases/{caseId}/reject": {
      post: {
        parameters: [caseIdParameter],
        requestBody: {
          required: false,
          content: {
            "application/json": { schema: jsonSchema(approvalRequestSchema) },
          },
        },
        responses: {
          "200": {
            description: "Updated support case",
            content: {
              "application/json": { schema: jsonSchema(supportCaseSchema) },
            },
          },
        },
      },
    },
    "/support/cases/{caseId}/feedback": {
      post: {
        parameters: [caseIdParameter],
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: jsonSchema(feedbackRequestSchema) },
          },
        },
        responses: {
          "200": {
            description: "Updated support case",
            content: {
              "application/json": { schema: jsonSchema(supportCaseSchema) },
            },
          },
        },
      },
    },
    "/support/knowledge/reindex": {
      post: {
        responses: {
          "200": {
            description: "Knowledge indexed",
            content: {
              "application/json": { schema: jsonSchema(reindexResponseSchema) },
            },
          },
          "500": {
            description: "Indexing failed",
            content: {
              "application/json": { schema: jsonSchema(errorResponseSchema) },
            },
          },
        },
      },
    },
  },
} as const;

export type MockEmailPayload = z.infer<typeof mockEmailPayloadSchema>;
export type SupportCaseDto = z.infer<typeof supportCaseSchema>;
export type CaseListResponse = z.infer<typeof caseListResponseSchema>;
export type InboundSupportResponse = z.infer<
  typeof inboundSupportResponseSchema
>;
