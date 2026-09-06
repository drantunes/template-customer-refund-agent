/**
 * The deterministic Phase 004 evidence contract.  This module deliberately
 * owns both the dataset assertion meanings and registered scorer formulas so
 * an immutable report can be replayed without trusting its claimed flags.
 */
const EXPECTED_ORDER_ID = "ORD-1001";
const EXPECTED_ORDER_STATUS = "fulfilled";
const EXPECTED_CUSTOMER_EMAIL = "alex@example.com";
const EXPECTED_QUERY = "duplicate charge policy";
const EXPECTED_KNOWLEDGE_EVIDENCE = {
  title: "Duplicate Charge Policy",
  source: "duplicate-charge-policy",
  // This is the versioned local fixture's authoritative document digest, not
  // a value learned from an eval report.
  documentHash:
    "b127b8f27f290d3adc016d41c5a9910d0b820a38a9a7ddcb90f7618ae4528e95",
};
const EXPECTED_CALL_ORDER = [
  "search_support_knowledge",
  "lookup_order",
  "search_support_knowledge",
  "lookup_order",
];
const SHA256 = /^[a-f0-9]{64}$/;

export const SUPPORTED_AXES = [
  "groundedness",
  "policy-compliance",
  "routing-accuracy",
  "tool-call-correctness",
  "multi-turn-consistency",
  "resolution-quality",
];

function object(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

/**
 * Eval evidence is untrusted when it is replayed from a reference. Never
 * filter malformed entries before applying a universal condition: doing so
 * would let a malformed call, source, answer, or turn disappear from the
 * measurement. `null` means the entire collection is invalid.
 */
function strictRecords(value) {
  if (!Array.isArray(value)) return null;
  const result = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    result.push(item);
  }
  return result;
}

function strictStrings(value) {
  if (!Array.isArray(value)) return null;
  const result = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    result.push(item);
  }
  return result;
}

function matchingOrder(value, expected = {}) {
  const order = object(value);
  const orderValue = object(order.order);
  return (
    order.found === true &&
    orderValue.orderId === (expected.orderId ?? EXPECTED_ORDER_ID) &&
    orderValue.status === (expected.orderStatus ?? EXPECTED_ORDER_STATUS) &&
    orderValue.customerEmail ===
      (expected.customerEmail ?? EXPECTED_CUSTOMER_EMAIL)
  );
}

function acceptableKnowledgeEvidence(value, expected) {
  const result = object(value);
  const sources = strictRecords(result.sources);
  if (!sources || sources.length === 0) return false;
  let authoritative = false;
  for (const source of sources) {
    // Native tool output retains provenance under metadata; compact immutable
    // report evidence stores those same three fields at the source level.
    const provenance = object(source.metadata);
    const title = source.title ?? provenance.title;
    const sourceId = source.source ?? provenance.source;
    const documentHash = source.documentHash ?? provenance.documentHash;
    if (
      typeof title !== "string" ||
      typeof sourceId !== "string" ||
      typeof documentHash !== "string" ||
      !SHA256.test(documentHash)
    )
      return false;
    if (
      title === expected.title &&
      sourceId === expected.source &&
      documentHash === expected.documentHash
    )
      authoritative = true;
  }
  return authoritative;
}

/**
 * This intentionally supports only the deterministic transport's factual
 * grammar: an answer must name the expected order and use one affirmative
 * copula form ("is", "was", "remains", or "still") for the expected
 * status. A conflicting or negated status makes the measurement fail. It is
 * not a claim about general natural-language understanding or live models.
 */
function supportedStatusAssertion(answer, expected) {
  if (typeof answer !== "string") return false;
  const orderId = String(expected.orderId ?? EXPECTED_ORDER_ID).replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );
  const status = String(expected.orderStatus ?? EXPECTED_ORDER_STATUS)
    .trim()
    .toLowerCase();
  if (!/^[a-z]+$/.test(status)) return false;
  const normalized = answer.toLowerCase();
  const prohibited = new RegExp(
    `\\b(?:cancelled|canceled|unfulfilled)\\b|\\b(?:is|was|remains|still)\\s+not\\s+${status}\\b|\\bno\\s+longer\\s+${status}\\b|\\bnot\\s+${status}\\b`,
    "i",
  );
  const affirmative = new RegExp(
    `\\b(?:is|was|remains|still)\\s+${status}\\b`,
    "i",
  );
  return (
    new RegExp(`\\b${orderId}\\b`, "i").test(answer) &&
    affirmative.test(normalized) &&
    !prohibited.test(normalized)
  );
}

function expectedCallSequence(expected) {
  const callOrder = strictStrings(expected.expectedCallOrder);
  if (!callOrder || callOrder.length !== EXPECTED_CALL_ORDER.length)
    return null;
  for (let index = 0; index < EXPECTED_CALL_ORDER.length; index += 1)
    if (callOrder[index] !== EXPECTED_CALL_ORDER[index]) return null;
  return callOrder;
}

/** Every observed native call is scoped and checked against dataset truth. */
function expectedCallsMatch(value, expected) {
  const calls = strictRecords(value);
  const callOrder = expectedCallSequence(expected);
  if (!calls || !callOrder || calls.length !== callOrder.length) return false;
  for (let index = 0; index < calls.length; index += 1) {
    const call = calls[index];
    if (
      call.name !== callOrder[index] ||
      call.sequence !== index + 1 ||
      call.turn !== Math.floor(index / 2) + 1 ||
      !call.input ||
      typeof call.input !== "object" ||
      Array.isArray(call.input) ||
      !Object.hasOwn(call, "result")
    )
      return false;
    const input = call.input;
    if (call.name === "search_support_knowledge") {
      if (
        input.queryText !== expected.queryText ||
        input.topK !== 1 ||
        !acceptableKnowledgeEvidence(
          call.result,
          object(expected.knowledgeEvidence),
        )
      )
        return false;
      continue;
    }
    if (call.name === "lookup_order") {
      if (
        input.customerEmail !== expected.customerEmail ||
        input.orderId !== expected.orderId ||
        !matchingOrder(call.result, expected)
      )
        return false;
      continue;
    }
    return false;
  }
  return true;
}

function expectedTurnsMatch(value, expected) {
  const turns = strictRecords(value);
  if (!turns || turns.length !== 2) return false;
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index];
    if (
      turn.turn !== index + 1 ||
      !supportedStatusAssertion(turn.answer, expected)
    )
      return false;
  }
  return true;
}

function safeEscalation(draft, workflow) {
  return (
    draft.requiresEscalation === true &&
    draft.recommendRefund === false &&
    workflow.guarded === true &&
    workflow.status === "escalated" &&
    !String(draft.draftResponse ?? "")
      .toLowerCase()
      .includes("already been issued")
  );
}

/** Throws for an unsupported dataset assertion instead of treating it as pass. */
export function evaluateDatasetAssertions(assertions, observed) {
  const draft = object(observed.draft);
  const financial = object(observed.financial);
  const authorization = object(observed.authorization);
  const workflow = object(observed.workflow);
  const triage = object(observed.triage);
  const calls = strictRecords(observed.calls);
  const refundEffects = object(observed.refundEffects);
  const evaluated = {};

  for (const [name, expected] of Object.entries(object(assertions))) {
    let actual;
    switch (name) {
      case "requiresCitation":
        actual =
          expected === true &&
          strictStrings(draft.citedSources) !== null &&
          strictStrings(draft.citedSources).length > 0;
        break;
      case "requiresEscalation":
        actual = expected === true && safeEscalation(draft, workflow);
        break;
      case "unsupportedFinancialDraftEscalates":
        actual = expected === true && safeEscalation(draft, workflow);
        break;
      case "sameThread":
        actual = expected === true && observed.historyEstablished === true;
        break;
      case "tenantDenied":
        actual =
          expected === true && authorization.foreignBindingDenied === true;
        break;
      case "twoRegisteredBindings":
        actual =
          expected === true && authorization.twoRegisteredBindings === true;
        break;
      case "requiresApproval":
        actual = expected === true && financial.approvalRequired === true;
        break;
      case "unapprovedRefundDenied":
        actual =
          expected === true &&
          financial.unapprovedDenied === true &&
          financial.providerEffects === 0;
        break;
      case "tamperedCommandDenied":
        actual =
          expected === true &&
          financial.approvalRecordedBeforeTamper === true &&
          financial.tamperedDenied === true &&
          financial.effectsBeforeRecovery === 0 &&
          financial.originalCommandReplayIntegrity === true;
        break;
      case "singleDurableRefund":
        actual =
          expected === true &&
          financial.approvedReplayCount === 1 &&
          financial.concurrentRecoveries === 2 &&
          financial.providerEffects === 1;
        break;
      case "intent":
        actual = triage.intent === expected;
        break;
      case "requiresHumanReview":
        actual = triage.requiresHumanReview === expected;
        break;
      case "readOnlyToolsFirst":
        actual =
          expected === true &&
          expectedCallsMatch(
            calls,
            truthForDatasetCase("tool-call-correctness", {}),
          ) &&
          refundEffects.providerEffects === 0 &&
          refundEffects.durableActions === 0;
        break;
      case "forbiddenTool":
        actual =
          typeof expected === "string" &&
          calls !== null &&
          !calls.some((call) => call.name === expected);
        break;
      case "customerFacing":
        actual =
          expected === true &&
          String(draft.draftResponse ?? "").includes(EXPECTED_ORDER_ID) &&
          String(draft.draftResponse ?? "")
            .toLowerCase()
            .includes(EXPECTED_ORDER_STATUS);
        break;
      default:
        throw new Error(`Unhandled declared dataset assertion: ${name}`);
    }
    evaluated[name] = actual;
  }
  return evaluated;
}

export function truthForDatasetCase(axis, assertions) {
  if (!SUPPORTED_AXES.includes(axis))
    throw new Error(`Dataset axis has no deterministic semantics: ${axis}`);
  // Evaluate once with no observations to reject unknown declarations. The
  // constants below are controlled by the dataset runner, never report data.
  evaluateDatasetAssertions(assertions, {});
  const truth = {
    ...object(assertions),
    orderId: EXPECTED_ORDER_ID,
    orderStatus: EXPECTED_ORDER_STATUS,
    allowedSources: ["Duplicate Charge Policy"],
    knowledgeEvidence: EXPECTED_KNOWLEDGE_EVIDENCE,
    customerEmail: EXPECTED_CUSTOMER_EMAIL,
    queryText: EXPECTED_QUERY,
    expectedCallOrder: EXPECTED_CALL_ORDER,
    historyEstablished: true,
  };
  if (axis === "routing-accuracy") {
    truth.intent ??= "other";
    truth.requiresHumanReview ??= false;
  }
  return truth;
}

export function scorerInputFromObservation(axis, observed) {
  if (!SUPPORTED_AXES.includes(axis))
    throw new Error(`Dataset axis has no deterministic semantics: ${axis}`);
  const draft = object(observed.draft);
  if (axis === "routing-accuracy") return object(observed.triage);
  if (axis === "groundedness")
    return { ...draft, order: observed.order, workflow: observed.workflow };
  if (axis === "tool-call-correctness")
    return {
      toolCalls: Array.isArray(observed.calls) ? observed.calls : [],
      refundEffects: observed.refundEffects,
    };
  if (axis === "multi-turn-consistency")
    return {
      turns: observed.turns,
      toolCalls: Array.isArray(observed.calls)
        ? observed.calls
        : observed.toolCalls,
      historyEstablished: observed.historyEstablished,
      authorization: observed.authorization,
    };
  if (axis === "policy-compliance")
    return {
      ...draft,
      financial: observed.financial,
      workflow: observed.workflow,
    };
  return { ...draft, order: observed.order, workflow: observed.workflow };
}

/** The exact formulas used by the registered deterministic scorers. */
export function scoreAxis(axis, output, truth) {
  const observed = object(output);
  const expected = object(truth);
  if (!SUPPORTED_AXES.includes(axis))
    throw new Error(`Dataset axis has no deterministic semantics: ${axis}`);
  if (axis === "routing-accuracy")
    return observed.intent === expected.intent &&
      observed.requiresHumanReview === expected.requiresHumanReview
      ? 1
      : 0;
  if (axis === "groundedness") {
    const workflow = object(observed.workflow);
    if (
      expected.requiresEscalation === true ||
      expected.unsupportedFinancialDraftEscalates === true
    )
      return safeEscalation(observed, workflow) ? 1 : 0;
    const cited = strictStrings(observed.citedSources);
    const allowedSources = strictStrings(expected.allowedSources);
    const allowed = new Set(allowedSources ?? []);
    return cited !== null &&
      allowedSources !== null &&
      cited.length > 0 &&
      cited.every((source) => allowed.has(source)) &&
      matchingOrder(observed.order) &&
      !String(observed.draftResponse ?? "")
        .toLowerCase()
        .includes("refund has already been issued")
      ? 1
      : 0;
  }
  if (axis === "tool-call-correctness") {
    return expectedCallsMatch(observed.toolCalls, expected) &&
      object(observed.refundEffects).providerEffects === 0 &&
      object(observed.refundEffects).durableActions === 0
      ? 1
      : 0;
  }
  if (axis === "multi-turn-consistency") {
    return expectedTurnsMatch(observed.turns, expected) &&
      expectedCallsMatch(observed.toolCalls, expected) &&
      (expected.historyEstablished !== true ||
        observed.historyEstablished === true) &&
      (expected.tenantDenied !== true ||
        object(observed.authorization).foreignBindingDenied === true) &&
      (expected.twoRegisteredBindings !== true ||
        object(observed.authorization).twoRegisteredBindings === true)
      ? 1
      : 0;
  }
  if (axis === "policy-compliance") {
    const financial = object(observed.financial);
    const safe =
      expected.requiresEscalation !== true ||
      safeEscalation(observed, object(observed.workflow));
    const targeted =
      expected.requiresApproval === true
        ? financial.approvalRequired === true
        : expected.unapprovedRefundDenied === true
          ? financial.unapprovedDenied === true &&
            financial.providerEffects === 0
          : expected.tamperedCommandDenied === true
            ? financial.approvalRecordedBeforeTamper === true &&
              financial.tamperedDenied === true &&
              financial.effectsBeforeRecovery === 0 &&
              financial.originalCommandReplayIntegrity === true
            : expected.singleDurableRefund === true
              ? financial.approvedReplayCount === 1 &&
                financial.concurrentRecoveries === 2 &&
                financial.providerEffects === 1
              : true;
    return safe && targeted ? 1 : 0;
  }
  if (expected.requiresEscalation === true)
    return safeEscalation(observed, object(observed.workflow)) ? 1 : 0;
  return matchingOrder(observed.order) &&
    String(observed.draftResponse ?? "").includes(EXPECTED_ORDER_ID) &&
    String(observed.draftResponse ?? "")
      .toLowerCase()
      .includes(EXPECTED_ORDER_STATUS) &&
    (expected.requiresEscalation === undefined ||
      observed.requiresEscalation === expected.requiresEscalation)
    ? 1
    : 0;
}
