import { createHash } from "node:crypto";

const requiredReportFields = [
  "kind",
  "runner",
  "executionMode",
  "implementationSha",
  "datasetHashes",
  "perCaseScores",
  "sixAxisScores",
  "costMicros",
  "evidenceHash",
  "regression",
];

export function reportPayload(record) {
  const payload = { ...record };
  delete payload.reportHash;
  delete payload.approval;
  return payload;
}

export function reportHash(record) {
  return createHash("sha256")
    .update(JSON.stringify(reportPayload(record)))
    .digest("hex");
}

export function validateApprovedBaseline(baseline) {
  if (!baseline || typeof baseline !== "object")
    throw new Error("baseline record is not an object");
  if (!requiredReportFields.every((field) => baseline[field] !== undefined))
    throw new Error("baseline lacks measured report provenance or scores");
  if (
    typeof baseline.reportHash !== "string" ||
    baseline.reportHash !== reportHash(baseline)
  )
    throw new Error("baseline report hash does not match its report content");
  if (
    typeof baseline.implementationSha !== "string" ||
    !/^[0-9a-f]{7,64}$/.test(baseline.implementationSha)
  )
    throw new Error("baseline implementation SHA is malformed");
  if (
    !baseline.approval ||
    typeof baseline.approval !== "object" ||
    typeof baseline.approval.approvedBy !== "string" ||
    !baseline.approval.approvedBy.trim() ||
    typeof baseline.approval.approvedAt !== "string" ||
    !Number.isFinite(Date.parse(baseline.approval.approvedAt)) ||
    baseline.approval.reportHash !== baseline.reportHash
  )
    throw new Error(
      "baseline approval is absent, malformed, or not content-bound",
    );
  if (
    !baseline.datasetHashes ||
    typeof baseline.datasetHashes !== "object" ||
    !baseline.sixAxisScores ||
    typeof baseline.sixAxisScores !== "object" ||
    !Array.isArray(baseline.perCaseScores)
  )
    throw new Error("baseline identities or score evidence are malformed");
  if (
    baseline.perCaseScores.some(
      (item) =>
        !item ||
        typeof item.id !== "string" ||
        typeof item.critical !== "boolean" ||
        !Number.isFinite(item.score) ||
        item.score < 0 ||
        item.score > 1 ||
        (item.critical && item.score !== 1),
    )
  )
    throw new Error("baseline contains an invalid or failed critical case");
  return baseline;
}
