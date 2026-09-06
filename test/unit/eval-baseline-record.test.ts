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
});
