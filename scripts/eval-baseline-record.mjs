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
const scorerMapping = JSON.parse(
  readFileSync(new URL("../evals/scorer-mapping.json", import.meta.url)),
);

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
      expected.set(item.id, {
        axis: dataset.axis,
        critical: item.critical,
        assertions: item.assertions,
      });
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

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * The report is deliberately not a bag of prose.  These are the runtime
 * observations emitted by phase004-native-execution: each axis has a
 * different independently useful fact, so a rehashed placeholder cannot
 * masquerade as a measurement.
 */
function validExecutionSummary(axis, summary, expectedCase, measuredScore) {
  if (
    !plainObject(summary) ||
    summary.schemaVersion !== 1 ||
    !nonEmptyString(summary.caseId) ||
    summary.scorerId !== scorerMapping[axis]?.scorerId ||
    !validScore(summary.score) ||
    summary.score !== measuredScore ||
    !plainObject(summary.modelOutputs)
  )
    return false;
  if (
    !plainObject(summary.assertions) ||
    !plainObject(expectedCase.assertions) ||
    JSON.stringify(Object.keys(summary.assertions).sort()) !==
      JSON.stringify(Object.keys(expectedCase.assertions).sort()) ||
    !Object.values(summary.assertions).every((value) => value === true)
  )
    return false;
  const toolCalls = Array.isArray(summary.toolCalls) ? summary.toolCalls : [];
  const validCall = (call) =>
    plainObject(call) &&
    nonEmptyString(call.name) &&
    plainObject(call.input) &&
    Object.hasOwn(call, "result") &&
    typeof call.rawResultHash === "string" &&
    sha256.test(call.rawResultHash) &&
    typeof call.sequence === "number" &&
    Number.isInteger(call.sequence) &&
    call.sequence > 0;
  if (!toolCalls.every(validCall)) return false;
  const order = summary.order;
  const validOrder =
    plainObject(order) &&
    order.found === true &&
    plainObject(order.order) &&
    nonEmptyString(order.order.orderId) &&
    nonEmptyString(order.order.status);
  if (axis === "routing-accuracy")
    return (
      plainObject(summary.modelOutputs.triage) &&
      nonEmptyString(summary.modelOutputs.triage.intent) &&
      typeof summary.modelOutputs.triage.requiresHumanReview === "boolean"
    );
  if (axis === "groundedness")
    if (expectedCase.assertions.requiresEscalation === true)
      return (
        plainObject(summary.modelOutputs.draft) &&
        summary.modelOutputs.draft.requiresEscalation === true &&
        summary.modelOutputs.draft.recommendRefund === false &&
        plainObject(summary.workflow) &&
        summary.workflow.guarded === true
      );
    else
      return (
        validOrder &&
        plainObject(summary.modelOutputs.draft) &&
        Array.isArray(summary.sources) &&
        summary.sources.length > 0 &&
        summary.sources.every(
          (source) => plainObject(source) && nonEmptyString(source.title),
        )
      );
  if (axis === "tool-call-correctness")
    return (
      validOrder &&
      toolCalls.some((call) => call.name === "search_support_knowledge") &&
      toolCalls.some((call) => call.name === "lookup_order") &&
      plainObject(summary.workflow) &&
      summary.workflow.guarded === true &&
      plainObject(summary.refundEffects) &&
      summary.refundEffects.providerEffects === 0 &&
      summary.refundEffects.durableActions === 0
    );
  if (axis === "multi-turn-consistency")
    return (
      validOrder &&
      Array.isArray(summary.modelOutputs.answers) &&
      summary.modelOutputs.answers.length >= 2 &&
      summary.modelOutputs.answers.every(nonEmptyString) &&
      summary.historyEstablished === true &&
      (expectedCase.assertions.tenantDenied !== true ||
        (plainObject(summary.authorization) &&
          summary.authorization.foreignBindingDenied === true)) &&
      (expectedCase.assertions.twoRegisteredBindings !== true ||
        (plainObject(summary.authorization) &&
          summary.authorization.twoRegisteredBindings === true))
    );
  if (axis === "policy-compliance")
    if (expectedCase.assertions.requiresEscalation === true)
      return (
        plainObject(summary.modelOutputs.draft) &&
        summary.modelOutputs.draft.requiresEscalation === true &&
        summary.modelOutputs.draft.recommendRefund === false &&
        plainObject(summary.workflow) &&
        summary.workflow.guarded === true
      );
    else
      return (
        plainObject(summary.financial) &&
        (expectedCase.assertions.requiresApproval !== true ||
          summary.financial.approvalRequired === true) &&
        (expectedCase.assertions.unapprovedRefundDenied !== true ||
          (summary.financial.unapprovedDenied === true &&
            summary.financial.providerEffects === 0)) &&
        (expectedCase.assertions.tamperedCommandDenied !== true ||
          (summary.financial.approvalRecordedBeforeTamper === true &&
            summary.financial.tamperedDenied === true &&
            summary.financial.effectsBeforeRecovery === 0 &&
            summary.financial.originalCommandReplayIntegrity === true)) &&
        (expectedCase.assertions.singleDurableRefund !== true ||
          (summary.financial.approvedReplayCount === 1 &&
            summary.financial.concurrentRecoveries === 2 &&
            summary.financial.providerEffects === 1))
      );
  if (axis === "resolution-quality")
    if (expectedCase.assertions.requiresEscalation === true)
      return (
        plainObject(summary.modelOutputs.draft) &&
        summary.modelOutputs.draft.requiresEscalation === true &&
        plainObject(summary.workflow) &&
        summary.workflow.guarded === true
      );
    else
      return (
        validOrder &&
        plainObject(summary.modelOutputs.draft) &&
        nonEmptyString(summary.modelOutputs.draft.draftResponse)
      );
  return false;
}

function aggregateEvidenceHash(perCaseScores) {
  return createHash("sha256")
    .update(JSON.stringify(perCaseScores))
    .digest("hex");
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
      item.evidence.evidenceHash !==
        createHash("sha256")
          .update(JSON.stringify(item.evidence.summary))
          .digest("hex")
    )
      throw new Error(
        `eval reference contains invalid, duplicate, or unevidenced case data: ${item.id}`,
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
    if (
      !validExecutionSummary(
        item.axis,
        item.evidence.summary,
        expectedCase,
        item.score,
      )
    )
      throw new Error(
        `eval reference contains invalid, duplicate, or unevidenced case data: ${item.id}`,
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
    !sha256.test(reference.evidenceHash) ||
    reference.evidenceHash !== aggregateEvidenceHash(reference.perCaseScores)
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
