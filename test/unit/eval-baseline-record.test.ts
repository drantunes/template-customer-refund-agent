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
});
