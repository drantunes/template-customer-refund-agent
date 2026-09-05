import type {
  InboundSupportResponse,
  MockEmailPayload,
  SupportCaseDto,
} from "../../../src/mastra/server/contracts";

/** These DTOs are inferred from the API's Zod boundary, not manually duplicated. */
export type { InboundSupportResponse, MockEmailPayload };
export type SupportCase = SupportCaseDto;
export type CaseStatus = SupportCase["status"];
export type CaseMessage = SupportCase["messages"][number];
export type TriageResult = NonNullable<SupportCase["triage"]>;
export type PolicyMatch = NonNullable<SupportCase["policyMatches"]>[number];
export type OrderLookup = NonNullable<SupportCase["orderLookup"]>;
export type SubscriptionLookup = NonNullable<SupportCase["subscriptionLookup"]>;
export type RefundHistory = NonNullable<SupportCase["refundHistory"]>;
export type DraftResolution = NonNullable<SupportCase["draft"]>;
export type ApprovalDecision = NonNullable<SupportCase["approval"]>;
export type RefundResult = NonNullable<SupportCase["refundResult"]>;
export type CaseFeedback = NonNullable<SupportCase["feedback"]>;

// Mirrors src/mastra/lib/monitoring.ts on the API side.

export interface CaseFunnelMetrics {
  totalCases: number;
  new: number;
  processing: number;
  waitingApproval: number;
  resolved: number;
  escalated: number;
  failed: number;
  containmentRate: number | null;
  escalationRate: number | null;
  avgResolutionMinutes: number | null;
}

export interface RefundApprovalMetrics {
  recommended: number;
  approved: number;
  rejected: number;
  autoEscalated: number;
  approvalRate: number | null;
  totalApprovedAmount: number;
  currency: string;
}

export interface FeedbackMetrics {
  totalResponses: number;
  up: number;
  down: number;
  satisfactionRate: number | null;
  recent: Array<{
    caseId: string;
    subject: string;
    rating: "up" | "down";
    comment?: string;
    submittedAt: string;
  }>;
}

export interface MonitoringSummary {
  generatedAt: string;
  casesConsidered: number;
  funnel: CaseFunnelMetrics;
  refunds: RefundApprovalMetrics;
  feedback: FeedbackMetrics;
}
