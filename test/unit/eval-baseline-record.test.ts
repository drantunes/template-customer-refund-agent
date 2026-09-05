import { describe, expect, it } from "vitest";
import {
  reportHash,
  validateApprovedBaseline,
} from "../../scripts/eval-baseline-record.mjs";

function approvedRecord() {
  const record = {
    kind: "support-eval-candidate",
    runner: "deterministic-native-targets-v2",
    executionMode: "deterministic-scripted-transport",
    implementationSha: "1c5da14",
    datasetHashes: { "groundedness.v1.json": "a".repeat(64) },
    perCaseScores: [{ id: "critical-case", critical: true, score: 1 }],
    sixAxisScores: { groundedness: 1 },
    costMicros: 0,
    evidenceHash: "b".repeat(64),
    regression: "pending-human-baseline-approval",
  };
  const reportHashValue = reportHash(record);
  return {
    ...record,
    reportHash: reportHashValue,
    approval: {
      approvedBy: "human-reviewer",
      approvedAt: "2026-09-05T20:00:00.000Z",
      reportHash: reportHashValue,
    },
  };
}

describe("approved eval baseline records", () => {
  it("accepts a human approval bound to the measured report", () => {
    expect(validateApprovedBaseline(approvedRecord())).toMatchObject({
      implementationSha: "1c5da14",
    });
  });

  it("rejects corruption and an approval bound to another report", () => {
    const corrupted = approvedRecord();
    corrupted.sixAxisScores.groundedness = 0;
    expect(() => validateApprovedBaseline(corrupted)).toThrow(
      "report hash does not match",
    );

    const unbound = approvedRecord();
    unbound.approval.reportHash = "c".repeat(64);
    expect(() => validateApprovedBaseline(unbound)).toThrow("content-bound");

    const failedCritical = approvedRecord();
    failedCritical.perCaseScores[0]!.score = 0;
    failedCritical.reportHash = reportHash(failedCritical);
    failedCritical.approval.reportHash = failedCritical.reportHash;
    expect(() => validateApprovedBaseline(failedCritical)).toThrow(
      "failed critical",
    );
  });
});
