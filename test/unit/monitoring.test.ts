import { afterEach, describe, expect, it, vi } from "vitest";
import {
  computeFeedbackMetrics,
  computeRefundApprovalMetrics,
} from "../../src/mastra/lib/monitoring";
import { caseStore } from "../../src/mastra/lib/case-store";
import type { SupportCase } from "../../src/mastra/domain/support-case";

function fixture(id: string): SupportCase {
  return {
    id,
    externalId: id,
    source: "mock-email",
    customer: { email: `${id}@example.test` },
    subject: `Case ${id}`,
    messages: [],
    status: "resolved",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
    metadata: {},
  };
}

afterEach(() => vi.restoreAllMocks());

describe("monitoring aggregates", () => {
  it("uses immutable turn outcomes and separate exact currency totals", async () => {
    const supportCase = fixture("case-1");
    vi.spyOn(caseStore, "turns").mockResolvedValue([
      {
        id: "turn-usd",
        eventId: "event-usd",
        sequence: 1,
        state: "resolved",
        outcome: {
          draft: { recommendRefund: true },
          refundResult: {
            amount: 20.01,
            currency: "USD",
            status: "executed",
            idempotencyKey: "usd-effect",
          },
        },
      },
      {
        id: "turn-eur",
        eventId: "event-eur",
        sequence: 2,
        state: "failed",
        outcome: {
          draft: { recommendRefund: true },
          refundResult: {
            amount: 10.5,
            currency: "EUR",
            status: "executed",
            idempotencyKey: "eur-effect",
          },
        },
      },
    ]);
    vi.spyOn(caseStore, "monitoringDecisions").mockResolvedValue([
      { caseId: supportCase.id, turnId: "turn-usd", approved: true },
      { caseId: supportCase.id, turnId: "turn-eur", approved: false },
    ]);

    await expect(computeRefundApprovalMetrics([supportCase])).resolves.toEqual({
      recommended: 2,
      approved: 1,
      rejected: 1,
      executed: 2,
      failed: 1,
      autoEscalated: 0,
      approvalRate: 0.5,
      executedTotals: [
        { currency: "EUR", minor: 1050 },
        { currency: "USD", minor: 2001 },
      ],
    });
  });

  it("returns feedback correlation without exporting a free-form comment", () => {
    const supportCase = fixture("case-feedback");
    supportCase.feedback = {
      rating: "up",
      comment: "private feedback that must not reach monitoring",
      submittedAt: "2026-01-01T00:01:00.000Z",
      actorId: "customer-1",
      turnId: "turn-1",
      runId: "run-1",
      traceId: "trace-1",
    };
    expect(computeFeedbackMetrics([supportCase])).toMatchObject({
      totalResponses: 1,
      satisfactionRate: 1,
      recent: [{ turnId: "turn-1", runId: "run-1", traceId: "trace-1" }],
    });
    expect(JSON.stringify(computeFeedbackMetrics([supportCase]))).not.toContain(
      "private feedback",
    );
  });
});
