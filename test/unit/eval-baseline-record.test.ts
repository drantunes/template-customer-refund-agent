import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  reportHash,
  validateEvalReference,
} from "../../scripts/eval-baseline-record.mjs";

function measuredReference() {
  return JSON.parse(
    readFileSync(
      new URL("../../evals/initial-reference.json", import.meta.url),
      "utf8",
    ),
  );
}
function rehash(record: Record<string, unknown>) {
  record.reportHash = reportHash(record);
  return record;
}
function rehashEvidence(record: {
  perCaseScores: Array<{
    evidence: { summary: unknown; evidenceHash: string };
  }>;
  evidenceHash: string;
}) {
  for (const item of record.perCaseScores)
    item.evidence.evidenceHash = createHash("sha256")
      .update(JSON.stringify(item.evidence.summary))
      .digest("hex");
  record.evidenceHash = createHash("sha256")
    .update(JSON.stringify(record.perCaseScores))
    .digest("hex");
  return record;
}

describe("immutable eval reference records", () => {
  it("accepts the measured first reference without inventing a human approval", () => {
    expect(
      validateEvalReference(measuredReference(), { initial: true }),
    ).toMatchObject({ initialReference: true, historicalComparison: null });
  });

  it("rejects removed coverage, altered critical classifications, empty evidence, and fabricated aggregates", () => {
    const missing = measuredReference();
    missing.perCaseScores.pop();
    expect(() => validateEvalReference(rehash(missing))).toThrow("cover every");

    const critical = measuredReference();
    critical.perCaseScores.find(
      (item: { critical: boolean }) => item.critical,
    ).critical = false;
    expect(() => validateEvalReference(rehash(critical))).toThrow(
      "critical coverage",
    );

    const evidence = measuredReference();
    evidence.perCaseScores[0].evidence.summary = {};
    evidence.perCaseScores[0].evidence.evidenceHash = "0".repeat(64);
    expect(() => validateEvalReference(rehash(evidence))).toThrow(
      "invalid, duplicate, or unevidenced",
    );

    const aggregate = measuredReference();
    aggregate.sixAxisScores.groundedness = 0;
    expect(() => validateEvalReference(rehash(aggregate))).toThrow(
      "aggregates",
    );
  });

  it("rejects rehashed placeholder execution summaries and recomputed aggregate hashes", () => {
    const placeholder = measuredReference();
    for (const item of placeholder.perCaseScores) {
      item.evidence.summary = { placeholder: true };
      item.evidence.evidenceHash = "0".repeat(64);
    }
    placeholder.evidenceHash = "0".repeat(64);
    expect(() => validateEvalReference(rehash(placeholder))).toThrow(
      "invalid, duplicate, or unevidenced",
    );

    const aggregate = measuredReference();
    aggregate.evidenceHash = "0".repeat(64);
    expect(() => validateEvalReference(rehash(aggregate))).toThrow(
      "usage or execution evidence",
    );
  });

  it("rejects rehashed contradictory measurements, scorer identities, and assertion results", () => {
    const contradictory = measuredReference();
    contradictory.perCaseScores[0].evidence.summary.score = 0;
    expect(() =>
      validateEvalReference(rehash(rehashEvidence(contradictory))),
    ).toThrow("invalid, duplicate, or unevidenced");

    const wrongScorer = measuredReference();
    wrongScorer.perCaseScores[0].evidence.summary.scorerId = "wrong-scorer";
    expect(() =>
      validateEvalReference(rehash(rehashEvidence(wrongScorer))),
    ).toThrow("invalid, duplicate, or unevidenced");

    const failedAssertion = measuredReference();
    failedAssertion.perCaseScores[0].evidence.summary.assertions = {
      requiresCitation: false,
    };
    expect(() =>
      validateEvalReference(rehash(rehashEvidence(failedAssertion))),
    ).toThrow("invalid, duplicate, or unevidenced");
  });

  it("replays every declared assertion and scorer formula from rehashed observations", () => {
    const mutate = (
      id: string,
      apply: (summary: Record<string, unknown>) => void,
    ) => {
      const record = measuredReference();
      const item = record.perCaseScores.find(
        (caseScore: { id: string }) => caseScore.id === id,
      );
      if (!item) throw new Error(`Missing fixed dataset case ${id}`);
      apply(item.evidence.summary);
      expect(() =>
        validateEvalReference(rehash(rehashEvidence(record))),
      ).toThrow("invalid, duplicate, or unevidenced");
    };

    mutate("adversarial-routing", (summary) => {
      (
        summary.modelOutputs as { triage: { requiresHumanReview: boolean } }
      ).triage.requiresHumanReview = false;
    });
    mutate("workflow-guard-mutation", (summary) => {
      const workflow = summary.workflow as {
        guarded: boolean;
        status: string;
      };
      workflow.guarded = false;
      workflow.status = "resolved";
      (
        summary.modelOutputs as { draft: { recommendRefund: boolean } }
      ).draft.recommendRefund = true;
    });
    for (const contradiction of [
      "Order ORD-1001 is fulfilled, but it was cancelled.",
      "Order ORD-1001 is fulfilled, but it is unfulfilled.",
      "Order ORD-1001 is fulfilled, but it is not fulfilled.",
      "Order ORD-1001 is fulfilled, but it is no longer fulfilled.",
      "Order ORD-1001 is fulfilled, but not fulfilled.",
    ])
      mutate("follow-up-stays-scoped", (summary) => {
        (
          summary.modelOutputs as { turns: Array<{ answer: string }> }
        ).turns[1].answer = contradiction;
      });
    mutate("follow-up-stays-scoped", (summary) => {
      (
        summary.modelOutputs as { turns: Array<{ turn: number }> }
      ).turns[1].turn = 1;
    });
    mutate("follow-up-stays-scoped", (summary) => {
      const turns = (
        summary.modelOutputs as {
          turns: Array<{ turn: number; answer: string }>;
        }
      ).turns;
      turns.push(structuredClone(turns[0]));
    });
    mutate("no-financial-tool", (summary) => {
      (summary.toolCalls as Array<Record<string, unknown>>).push({
        sequence: 5,
        turn: 3,
        name: "issue_refund",
        input: {},
        result: {},
        rawResultHash: "0".repeat(64),
      });
    });
    const toolCalls = (summary: Record<string, unknown>) =>
      summary.toolCalls as Array<{
        input: Record<string, unknown>;
        result: Record<string, unknown>;
      }>;
    mutate("lookup-before-refund", (summary) => {
      toolCalls(summary)[2].input.queryText = "foreign policy";
    });
    mutate("lookup-before-refund", (summary) => {
      const sources = toolCalls(summary)[2].result.sources as Array<
        Record<string, unknown>
      >;
      sources[0].documentHash = "0".repeat(64);
    });
    mutate("lookup-before-refund", (summary) => {
      toolCalls(summary)[3].input.customerEmail = "mallory@example.com";
    });
    mutate("lookup-before-refund", (summary) => {
      toolCalls(summary)[3].input.orderId = "ORD-9999";
    });
    mutate("lookup-before-refund", (summary) => {
      const order = toolCalls(summary)[3].result.order as Record<
        string,
        unknown
      >;
      order.customerEmail = "mallory@example.com";
    });
    mutate("lookup-before-refund", (summary) => {
      const order = toolCalls(summary)[3].result.order as Record<
        string,
        unknown
      >;
      order.status = "cancelled";
    });
    mutate("lookup-before-refund", (summary) => {
      toolCalls(summary).pop();
    });
    mutate("lookup-before-refund", (summary) => {
      const calls = toolCalls(summary);
      calls.push(structuredClone(calls[0]));
    });
    mutate("lookup-before-refund", (summary) => {
      const calls = toolCalls(summary);
      calls[2] = structuredClone(calls[0]);
    });
    mutate("workflow-guard-mutation", (summary) => {
      (summary.workflow as { guarded: boolean }).guarded = false;
    });
  });
});
