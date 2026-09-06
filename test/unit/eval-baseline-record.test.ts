import { describe, expect, it } from "vitest";
import {
  REQUIRED_AXES,
  reportHash,
  validateEvalReference,
} from "../../scripts/eval-baseline-record.mjs";

const digest = (char: string) => char.repeat(64);

function measuredReference() {
  const record = {
    kind: "support-eval-initial-reference",
    initialReference: true,
    historicalComparison: null,
    runner: "deterministic-native-targets-v2",
    runnerSourceHash: digest("a"),
    scorerSourceHashes: { "src/mastra/evals/index.ts": digest("b") },
    executionMode: "deterministic-scripted-transport",
    implementationSha: "1c5da14",
    datasetHashes: Object.fromEntries(
      REQUIRED_AXES.map((axis, index) => [
        `${axis}.v1.json`,
        digest(String(index + 1)),
      ]),
    ),
    perCaseScores: REQUIRED_AXES.map((axis, index) => ({
      id: `${axis}-case`,
      axis,
      critical: index < 2,
      score: 1,
      evidence: { observed: true },
    })),
    sixAxisScores: Object.fromEntries(REQUIRED_AXES.map((axis) => [axis, 1])),
    costMicros: 0,
    evidenceHash: digest("c"),
    regression: "initial-reference-establishment-no-prior-comparison",
  };
  return { ...record, reportHash: reportHash(record) };
}

describe("immutable eval reference records", () => {
  it("accepts a complete first measured reference without invented human approval", () => {
    expect(
      validateEvalReference(measuredReference(), { initial: true }),
    ).toMatchObject({
      initialReference: true,
      historicalComparison: null,
    });
  });

  it("rejects corrupt hashes, missing axes, duplicate IDs, failed critical cases, and invalid evidence", () => {
    const corrupted = measuredReference();
    corrupted.sixAxisScores.groundedness = Number.NaN;
    expect(() => validateEvalReference(corrupted)).toThrow(
      "hash does not match",
    );

    const missingAxis = measuredReference();
    delete missingAxis.sixAxisScores.groundedness;
    missingAxis.reportHash = reportHash(missingAxis);
    expect(() => validateEvalReference(missingAxis)).toThrow("all six");

    const duplicate = measuredReference();
    duplicate.perCaseScores[1]!.id = duplicate.perCaseScores[0]!.id;
    duplicate.reportHash = reportHash(duplicate);
    expect(() => validateEvalReference(duplicate)).toThrow("duplicate");

    const failedCritical = measuredReference();
    failedCritical.perCaseScores[0]!.score = 0;
    failedCritical.reportHash = reportHash(failedCritical);
    expect(() => validateEvalReference(failedCritical)).toThrow(
      "failed critical",
    );

    const wrongRunnerHash = measuredReference();
    wrongRunnerHash.runnerSourceHash = "not-a-hash";
    wrongRunnerHash.reportHash = reportHash(wrongRunnerHash);
    expect(() => validateEvalReference(wrongRunnerHash)).toThrow(
      "runner provenance",
    );
  });
});
