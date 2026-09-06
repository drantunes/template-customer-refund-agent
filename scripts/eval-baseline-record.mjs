import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";

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
const floors = {
  groundedness: 0.9,
  "policy-compliance": 0.9,
  "routing-accuracy": 0.9,
  "tool-call-correctness": 0.9,
  "multi-turn-consistency": 0.9,
  "resolution-quality": 0.85,
};

function expectedDatasetCases() {
  const directory = new URL("../evals/datasets/", import.meta.url);
  const expected = new Map();
  const hashes = {};
  for (const file of readdirSync(directory)
    .filter((entry) => entry.endsWith(".json"))
    .sort()) {
    const raw = readFileSync(new URL(file, directory));
    const dataset = JSON.parse(raw);
    hashes[file] = createHash("sha256").update(raw).digest("hex");
    for (const item of dataset.cases ?? []) {
      if (expected.has(item.id))
        throw new Error("eval datasets contain duplicate case identifiers");
      expected.set(item.id, { axis: dataset.axis, critical: item.critical });
    }
  }
  return { expected, hashes };
}

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
  const { expected, hashes } = expectedDatasetCases();
  if (JSON.stringify(reference.datasetHashes) !== JSON.stringify(hashes))
    throw new Error(
      "eval reference dataset hashes do not match the versioned datasets",
    );
  const ids = new Set();
  const totals = Object.fromEntries(
    REQUIRED_AXES.map((axis) => [axis, { sum: 0, count: 0 }]),
  );
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
      typeof item.evidence !== "object" ||
      !sha256.test(item.evidence.evidenceHash) ||
      !item.evidence.summary ||
      typeof item.evidence.summary !== "object" ||
      Object.keys(item.evidence.summary).length === 0 ||
      item.evidence.evidenceHash !==
        createHash("sha256")
          .update(JSON.stringify(item.evidence.summary))
          .digest("hex")
    )
      throw new Error(
        "eval reference contains invalid, duplicate, or unevidenced case data",
      );
    const expectedCase = expected.get(item.id);
    if (
      !expectedCase ||
      expectedCase.axis !== item.axis ||
      expectedCase.critical !== item.critical
    )
      throw new Error(
        "eval reference case identity, axis, or critical coverage is inconsistent with the dataset",
      );
    if (item.critical && item.score !== 1)
      throw new Error(
        "eval reference contains an invalid or failed critical case",
      );
    ids.add(item.id);
    totals[item.axis].sum += item.score;
    totals[item.axis].count += 1;
  }
  if (
    ids.size !== expected.size ||
    [...expected.keys()].some((id) => !ids.has(id))
  )
    throw new Error(
      "eval reference does not cover every versioned dataset case exactly once",
    );
  for (const axis of REQUIRED_AXES) {
    const actual = totals[axis].count
      ? totals[axis].sum / totals[axis].count
      : Number.NaN;
    if (Math.abs(actual - reference.sixAxisScores[axis]) > Number.EPSILON)
      throw new Error(
        "eval reference axis aggregates do not match per-case measurements",
      );
    if (actual < floors[axis])
      throw new Error(`eval reference failed ${axis} threshold`);
  }
  if (
    !Number.isFinite(reference.costMicros) ||
    reference.costMicros < 0 ||
    !sha256.test(reference.evidenceHash)
  )
    throw new Error("eval reference usage or execution evidence is malformed");
  if (
    reference.executionMode ===
      "deterministic-scripted-transport-no-paid-routes" &&
    (reference.costMicros !== 0 ||
      reference.pricing !== "not-applicable-deterministic-transport")
  )
    throw new Error("deterministic eval reference must record zero paid usage");
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
