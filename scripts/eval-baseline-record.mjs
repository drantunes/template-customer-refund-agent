import { createHash } from "node:crypto";

export const REQUIRED_AXES = [
  "groundedness",
  "policy-compliance",
  "routing-accuracy",
  "tool-call-correctness",
  "multi-turn-consistency",
  "resolution-quality",
];

const requiredReportFields = [
  "kind",
  "runner",
  "runnerSourceHash",
  "scorerSourceHashes",
  "executionMode",
  "implementationSha",
  "datasetHashes",
  "perCaseScores",
  "sixAxisScores",
  "costMicros",
  "evidenceHash",
  "regression",
];
const sha256 = /^[0-9a-f]{64}$/;

export function reportPayload(record) {
  const payload = { ...record };
  delete payload.reportHash;
  // Review metadata is not measurement evidence. Initial references must not
  // claim a human approval that never happened.
  delete payload.approval;
  return payload;
}

export function reportHash(record) {
  return createHash("sha256")
    .update(JSON.stringify(reportPayload(record)))
    .digest("hex");
}

function validScore(value) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  );
}

/** Validates measurement evidence, not a claimed human approval. */
export function validateEvalReference(reference, { initial = false } = {}) {
  if (!reference || typeof reference !== "object")
    throw new Error("eval reference is not an object");
  if (!requiredReportFields.every((field) => reference[field] !== undefined))
    throw new Error(
      "eval reference lacks measured report provenance or scores",
    );
  if (
    typeof reference.reportHash !== "string" ||
    reference.reportHash !== reportHash(reference)
  )
    throw new Error("eval reference hash does not match its report content");
  if (
    typeof reference.implementationSha !== "string" ||
    !/^[0-9a-f]{7,64}$/.test(reference.implementationSha)
  )
    throw new Error("eval reference implementation SHA is malformed");
  if (
    typeof reference.runner !== "string" ||
    !reference.runner ||
    !sha256.test(reference.runnerSourceHash)
  )
    throw new Error("eval reference runner provenance is malformed");
  if (
    !reference.scorerSourceHashes ||
    typeof reference.scorerSourceHashes !== "object" ||
    !Object.values(reference.scorerSourceHashes).every(
      (value) => typeof value === "string" && sha256.test(value),
    )
  )
    throw new Error("eval reference scorer provenance is malformed");
  if (
    !reference.datasetHashes ||
    typeof reference.datasetHashes !== "object" ||
    Object.keys(reference.datasetHashes).length !== REQUIRED_AXES.length ||
    !Object.values(reference.datasetHashes).every(
      (value) => typeof value === "string" && sha256.test(value),
    )
  )
    throw new Error("eval reference dataset identities are malformed");
  if (
    !reference.sixAxisScores ||
    typeof reference.sixAxisScores !== "object" ||
    REQUIRED_AXES.some((axis) => !validScore(reference.sixAxisScores[axis]))
  )
    throw new Error(
      "eval reference does not contain all six finite axis scores",
    );
  if (
    !Array.isArray(reference.perCaseScores) ||
    reference.perCaseScores.length === 0
  )
    throw new Error("eval reference has no execution cases");
  const ids = new Set();
  for (const item of reference.perCaseScores) {
    if (
      !item ||
      typeof item.id !== "string" ||
      !item.id ||
      ids.has(item.id) ||
      !REQUIRED_AXES.includes(item.axis) ||
      typeof item.critical !== "boolean" ||
      !validScore(item.score) ||
      !item.evidence ||
      typeof item.evidence !== "object"
    )
      throw new Error(
        "eval reference contains invalid, duplicate, or unevidenced case data",
      );
    if (item.critical && item.score !== 1)
      throw new Error(
        "eval reference contains an invalid or failed critical case",
      );
    ids.add(item.id);
  }
  if (
    !Number.isFinite(reference.costMicros) ||
    reference.costMicros < 0 ||
    !sha256.test(reference.evidenceHash)
  )
    throw new Error("eval reference usage or execution evidence is malformed");
  if (
    initial &&
    (reference.kind !== "support-eval-initial-reference" ||
      reference.initialReference !== true ||
      reference.historicalComparison !== null)
  )
    throw new Error(
      "eval reference is not an explicitly labeled initial reference",
    );
  return reference;
}

// Compatibility name only; it no longer adds a fabricated approval barrier.
export const validateApprovedBaseline = validateEvalReference;
