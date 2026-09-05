import type { Mastra } from "@mastra/core/mastra";
import { caseStore } from "./case-store";
import type { SupportCase } from "../domain/support-case";
import { bindingsForCase } from "../providers/contracts";

function minutesBetween(startIso: string, endIso: string): number {
  return (new Date(endIso).getTime() - new Date(startIso).getTime()) / 60_000;
}

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

export function computeCaseFunnelMetrics(
  cases: SupportCase[],
): CaseFunnelMetrics {
  const byStatus = {
    new: 0,
    processing: 0,
    waiting_approval: 0,
    resolved: 0,
    escalated: 0,
    failed: 0,
  };
  for (const supportCase of cases) byStatus[supportCase.status] += 1;

  const decided = byStatus.resolved + byStatus.escalated;
  const resolutionMinutes = cases
    .filter((c) => c.status === "resolved" || c.status === "escalated")
    .map((c) => minutesBetween(c.createdAt, c.updatedAt))
    .filter((n) => Number.isFinite(n) && n >= 0);

  return {
    totalCases: cases.length,
    new: byStatus.new,
    processing: byStatus.processing,
    waitingApproval: byStatus.waiting_approval,
    resolved: byStatus.resolved,
    escalated: byStatus.escalated,
    failed: byStatus.failed,
    containmentRate: decided > 0 ? byStatus.resolved / decided : null,
    escalationRate: decided > 0 ? byStatus.escalated / decided : null,
    avgResolutionMinutes:
      resolutionMinutes.length > 0
        ? resolutionMinutes.reduce((sum, n) => sum + n, 0) /
          resolutionMinutes.length
        : null,
  };
}

export function computeRefundApprovalMetrics(
  cases: SupportCase[],
): RefundApprovalMetrics {
  const recommendedCases = cases.filter((c) => c.draft?.recommendRefund);
  const approved = recommendedCases.filter(
    (c) => c.approval?.approved === true,
  ).length;
  const rejected = recommendedCases.filter(
    (c) => c.approval?.approved === false,
  ).length;
  const autoEscalated = recommendedCases.filter(
    (c) => !c.approval && c.status === "escalated",
  ).length;
  const decided = approved + rejected;
  const executedRefunds = cases.filter(
    (c) => c.refundResult?.status === "executed",
  );

  return {
    recommended: recommendedCases.length,
    approved,
    rejected,
    autoEscalated,
    approvalRate: decided > 0 ? approved / decided : null,
    totalApprovedAmount: executedRefunds.reduce(
      (sum, c) => sum + (c.refundResult?.amount ?? 0),
      0,
    ),
    currency: executedRefunds[0]?.refundResult?.currency ?? "USD",
  };
}

export function computeFeedbackMetrics(cases: SupportCase[]): FeedbackMetrics {
  const withFeedback = cases.filter(
    (
      c,
    ): c is SupportCase & { feedback: NonNullable<SupportCase["feedback"]> } =>
      !!c.feedback,
  );
  const up = withFeedback.filter((c) => c.feedback.rating === "up").length;
  const down = withFeedback.filter((c) => c.feedback.rating === "down").length;

  return {
    totalResponses: withFeedback.length,
    up,
    down,
    satisfactionRate: withFeedback.length > 0 ? up / withFeedback.length : null,
    recent: [...withFeedback]
      .sort((a, b) =>
        a.feedback.submittedAt < b.feedback.submittedAt ? 1 : -1,
      )
      .slice(0, 10)
      .map((c) => ({
        caseId: c.id,
        subject: c.subject,
        rating: c.feedback.rating,
        // The dashboard never re-exports free-form feedback. The durable case
        // keeps it under its retention policy; monitoring only needs its
        // rating and correlation references.
        submittedAt: c.feedback.submittedAt,
      })),
  };
}

export async function computeMonitoringSummary(
  _mastra: Mastra,
  tenantId: string,
): Promise<MonitoringSummary> {
  const cases = (await caseStore.list()).filter(
    (supportCase) => bindingsForCase(supportCase).support.tenantId === tenantId,
  );
  return {
    generatedAt: new Date().toISOString(),
    casesConsidered: cases.length,
    funnel: computeCaseFunnelMetrics(cases),
    refunds: computeRefundApprovalMetrics(cases),
    feedback: computeFeedbackMetrics(cases),
  };
}
