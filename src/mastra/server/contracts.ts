import { z } from "zod";
import { caseFeedbackSchema, supportCaseSchema } from "../domain/support-case";

export const mockEmailPayloadSchema = z
  .object({
    externalId: z.string().min(1),
    from: z.email(),
    fromName: z.string().min(1).optional(),
    subject: z.string().optional(),
    body: z.string().min(1),
    conversationId: z.string().min(1).max(200).optional(),
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
  commandFingerprint: z.string().min(1),
  note: z.string().max(2_000).optional(),
});
export const followUpRequestSchema = z.object({
  body: z.string().min(1).max(10_000),
});

export const loginRequestSchema = z.object({
  email: z.email(),
  password: z.string().min(1).max(256),
});
export const loginResponseSchema = z.object({
  token: z.string(),
  expiresAt: z.string(),
  principal: z.object({
    id: z.string(),
    email: z.email(),
    tenantId: z.string(),
    roles: z.array(z.enum(["customer", "support-agent", "approver", "admin"])),
  }),
});
export const feedbackRequestSchema = caseFeedbackSchema
  .pick({
    rating: true,
    comment: true,
  })
  .extend({ responseMessageId: z.string().min(1) });
export const errorResponseSchema = z.object({ error: z.string() });
export const reindexResponseSchema = z.object({
  indexed: z.number().int().nonnegative(),
});
export const validationRequestSchema = z.object({
  // This is intentionally an explicit alternate execution mode. Ordinary
  // application requests do not inherit validation accounting.
  mode: z.literal("sandbox"),
});
export const supervisorExecutionRequestSchema = z.object({
  message: z.string().min(1).max(10_000),
  validation: validationRequestSchema.optional(),
});
export const reindexRequestSchema = z.object({
  validation: validationRequestSchema.optional(),
});
export const supervisorExecutionResponseSchema = z.object({
  text: z.string(),
  traceId: z.string().optional(),
  toolNames: z.array(z.string()),
  // Staff can inspect the read-only evidence their authorized supervisor run
  // actually observed. This deliberately exposes no command or approval data.
  toolResults: z.array(
    z.object({
      toolName: z.string(),
      result: z.unknown().optional(),
      isError: z.boolean(),
    }),
  ),
});
export const monitoringSummarySchema = z.object({
  generatedAt: z.iso.datetime(),
  casesConsidered: z.number().int().nonnegative(),
  funnel: z.object({
    totalCases: z.number().int().nonnegative(),
    new: z.number().int().nonnegative(),
    processing: z.number().int().nonnegative(),
    waitingApproval: z.number().int().nonnegative(),
    resolved: z.number().int().nonnegative(),
    escalated: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    containmentRate: z.number().nullable(),
    escalationRate: z.number().nullable(),
    avgResolutionMinutes: z.number().nullable(),
  }),
  refunds: z.object({
    recommended: z.number().int().nonnegative(),
    approved: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
    autoEscalated: z.number().int().nonnegative(),
    approvalRate: z.number().nullable(),
    executed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    executedTotals: z.array(
      z.object({ currency: z.string(), minor: z.number().int().nonnegative() }),
    ),
  }),
  feedback: z.object({
    totalResponses: z.number().int().nonnegative(),
    up: z.number().int().nonnegative(),
    down: z.number().int().nonnegative(),
    satisfactionRate: z.number().nullable(),
    recent: z.array(
      z.object({
        caseId: z.string(),
        subject: z.string(),
        rating: z.enum(["up", "down"]),
        submittedAt: z.iso.datetime(),
        turnId: z.string().optional(),
        runId: z.string().optional(),
        traceId: z.string().optional(),
      }),
    ),
  }),
  telemetry: z.object({
    observedTraces: z.number().int().nonnegative(),
    observedSpans: z.number().int().nonnegative(),
    providerOrToolErrorRate: z.number().nullable(),
    providerOrToolP95Ms: z.number().nullable(),
    modelUsage: z.array(
      z.object({
        model: z.string(),
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
        estimatedCostMicrosUsd: z.number().nullable(),
      }),
    ),
    workflowStages: z.array(
      z.object({
        operation: z.string(),
        calls: z.number().int().nonnegative(),
        errorRate: z.number().nullable(),
        p95Ms: z.number().nullable(),
      }),
    ),
    providerCalls: z.array(
      z.object({
        operation: z.string(),
        calls: z.number().int().nonnegative(),
        errorRate: z.number().nullable(),
        p95Ms: z.number().nullable(),
      }),
    ),
    toolCalls: z.array(
      z.object({
        operation: z.string(),
        calls: z.number().int().nonnegative(),
        errorRate: z.number().nullable(),
        p95Ms: z.number().nullable(),
      }),
    ),
    unavailable: z.array(z.string()),
    alerts: z.array(z.string()),
  }),
  failures: z.object({
    rejectedDecisions: z.number().int().nonnegative(),
    workflow: z.number().int().nonnegative(),
    financial: z.number().int().nonnegative(),
    delivery: z.number().int().nonnegative(),
  }),
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
    "/support/auth/login": {
      post: {
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: jsonSchema(loginRequestSchema) },
          },
        },
        responses: {
          "200": {
            description: "Authenticated local session",
            content: {
              "application/json": { schema: jsonSchema(loginResponseSchema) },
            },
          },
          "401": {
            description: "Invalid credentials",
            content: {
              "application/json": { schema: jsonSchema(errorResponseSchema) },
            },
          },
        },
      },
    },
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
    "/support/webhooks/intercom": {
      post: {
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object" } } },
        },
        responses: {
          "200": {
            description: "Verified provider event accepted or ignored",
            content: { "application/json": { schema: { type: "object" } } },
          },
          "401": {
            description: "Invalid webhook signature or payload",
            content: {
              "application/json": { schema: jsonSchema(errorResponseSchema) },
            },
          },
          "503": {
            description: "Verified event could not be persisted",
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
    "/support/cases/{caseId}/supervisor": {
      post: {
        parameters: [caseIdParameter],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: jsonSchema(supervisorExecutionRequestSchema),
            },
          },
        },
        responses: {
          "200": {
            description: "Authenticated read-only supervisor response",
            content: {
              "application/json": {
                schema: jsonSchema(supervisorExecutionResponseSchema),
              },
            },
          },
          "400": {
            description: "Invalid supervisor request",
            content: {
              "application/json": { schema: jsonSchema(errorResponseSchema) },
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
    "/support/cases/{caseId}/follow-ups": {
      post: {
        parameters: [caseIdParameter],
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: jsonSchema(followUpRequestSchema) },
          },
        },
        responses: {
          "200": {
            description: "Appended authorized customer follow-up",
            content: {
              "application/json": { schema: jsonSchema(supportCaseSchema) },
            },
          },
        },
      },
    },
    "/support/knowledge/reindex": {
      post: {
        requestBody: {
          required: false,
          content: {
            "application/json": { schema: jsonSchema(reindexRequestSchema) },
          },
        },
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
    "/support/monitoring/summary": {
      get: {
        responses: {
          "200": {
            description: "Support monitoring summary",
            content: {
              "application/json": {
                schema: jsonSchema(monitoringSummarySchema),
              },
            },
          },
        },
      },
    },
    "/support/openapi.json": {
      get: {
        responses: {
          "200": {
            description: "OpenAPI document",
            content: {
              "application/json": { schema: jsonSchema(z.unknown()) },
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
export type MonitoringSummaryResponse = z.infer<typeof monitoringSummarySchema>;
