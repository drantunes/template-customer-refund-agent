import { z } from "zod";

export const caseSourceSchema = z.enum(["mock-email", "chat"]);
export type CaseSource = z.infer<typeof caseSourceSchema>;

export const caseStatusSchema = z.enum([
  "new",
  "processing",
  "waiting_approval",
  "resolved",
  "escalated",
  "failed",
]);
export type CaseStatus = z.infer<typeof caseStatusSchema>;

export const messageAuthorSchema = z.enum(["customer", "agent", "internal"]);

export const caseMessageSchema = z.object({
  id: z.string(),
  author: messageAuthorSchema,
  authorName: z.string().optional(),
  body: z.string(),
  createdAt: z.string(),
});
export type CaseMessage = z.infer<typeof caseMessageSchema>;

export const customerRefSchema = z.object({
  email: z.email(),
  name: z.string().optional(),
});

export const triageResultSchema = z.object({
  intent: z.enum([
    "refund_request",
    "duplicate_charge",
    "order_status",
    "cancellation",
    "damaged_item",
    "account_issue",
    "other",
  ]),
  urgency: z.enum(["low", "normal", "high", "critical"]),
  sentiment: z.enum(["positive", "neutral", "negative", "angry"]),
  requiresHumanReview: z.boolean(),
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
});
export type TriageResult = z.infer<typeof triageResultSchema>;

export const policyMatchSchema = z.object({
  title: z.string(),
  text: z.string(),
  source: z.string(),
  score: z.number(),
});
export type PolicyMatch = z.infer<typeof policyMatchSchema>;

export const orderLookupSchema = z.object({
  found: z.boolean(),
  order: z
    .object({
      orderId: z.string(),
      customerEmail: z.email(),
      product: z.string(),
      amount: z.number(),
      currency: z.string(),
      status: z.enum([
        "fulfilled",
        "shipped",
        "processing",
        "cancelled",
        "refunded",
      ]),
      chargeCount: z.number(),
      placedAt: z.string(),
    })
    .optional(),
});
export type OrderLookup = z.infer<typeof orderLookupSchema>;

export const subscriptionLookupSchema = z.object({
  found: z.boolean(),
  subscription: z
    .object({
      subscriptionId: z.string(),
      customerEmail: z.email(),
      plan: z.string(),
      amount: z.number(),
      currency: z.string(),
      status: z.enum(["active", "cancelled", "past_due"]),
      renewsAt: z.string(),
    })
    .optional(),
});
export type SubscriptionLookup = z.infer<typeof subscriptionLookupSchema>;

export const refundHistorySchema = z.object({
  refunds: z.array(
    z.object({
      refundId: z.string(),
      orderId: z.string(),
      amount: z.number(),
      currency: z.string(),
      reason: z.string(),
      issuedAt: z.string(),
    }),
  ),
});
export type RefundHistory = z.infer<typeof refundHistorySchema>;

export const draftResolutionSchema = z.object({
  draftResponse: z.string().describe("The grounded, customer-facing reply."),
  citedSources: z
    .array(z.string())
    .describe("Titles/sources of policy documents actually used."),
  recommendRefund: z.boolean(),
  refundAmount: z.number().optional(),
  refundCurrency: z.string().optional(),
  refundReason: z.string().optional(),
  requiresEscalation: z.boolean(),
  escalationReason: z.string().optional(),
});
export type DraftResolution = z.infer<typeof draftResolutionSchema>;

export const approvalDecisionSchema = z.object({
  approved: z.boolean(),
  approverId: z.string(),
  note: z.string().optional(),
});
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;

export const caseFeedbackSchema = z.object({
  rating: z.enum(["up", "down"]),
  comment: z.string().optional(),
  submittedAt: z.string(),
});
export type CaseFeedback = z.infer<typeof caseFeedbackSchema>;

export const refundResultSchema = z.object({
  refundId: z.string(),
  orderId: z.string(),
  amount: z.number(),
  currency: z.string(),
  status: z.enum(["executed", "skipped"]),
  idempotencyKey: z.string(),
  executedAt: z.string(),
});
export type RefundResult = z.infer<typeof refundResultSchema>;

export const supportCaseSchema = z.object({
  id: z.string(),
  externalId: z.string(),
  source: caseSourceSchema,
  customer: customerRefSchema,
  subject: z.string(),
  messages: z.array(caseMessageSchema),
  status: caseStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  triage: triageResultSchema.optional(),
  policyMatches: z.array(policyMatchSchema).optional(),
  orderLookup: orderLookupSchema.optional(),
  subscriptionLookup: subscriptionLookupSchema.optional(),
  refundHistory: refundHistorySchema.optional(),
  draft: draftResolutionSchema.optional(),
  approval: approvalDecisionSchema.optional(),
  refundResult: refundResultSchema.optional(),
  finalResponse: z.string().optional(),
  escalationReason: z.string().optional(),
  workflowRunId: z.string().optional(),
  /** Root trace id for the resolve-support-case workflow run, used to pull token/tool observability data for monitoring. */
  traceId: z.string().optional(),
  agentUsage: z
    .object({
      inputTokens: z.number(),
      outputTokens: z.number(),
      model: z.string().optional(),
    })
    .optional(),
  feedback: caseFeedbackSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type SupportCase = z.infer<typeof supportCaseSchema>;

export function threadIdForCase(caseId: string, tenantId: string): string {
  return `tenant_${tenantId}_conversation_${caseId}`;
}
/** Memory is scoped to the authenticated owner, never to a model-provided
 * case identifier. Conversations remain separate threads under this resource. */
export function resourceIdForOwner(ownerId: string, tenantId: string): string {
  return `tenant_${tenantId}_owner_${ownerId}`;
}
