/**
 * The deterministic Phase 004 evidence contract.  This module deliberately
 * owns both the dataset assertion meanings and registered scorer formulas so
 * an immutable report can be replayed without trusting its claimed flags.
 */
const EXPECTED_ORDER_ID = "ORD-1001";
const EXPECTED_ORDER_STATUS = "fulfilled";
const EXPECTED_CUSTOMER_EMAIL = "alex@example.com";
const EXPECTED_QUERY = "duplicate charge policy";
const EXPECTED_CALL_ORDER = [
  "search_support_knowledge",
  "lookup_order",
  "search_support_knowledge",
  "lookup_order",
];

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

function strings(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string")
    : [];
}

function records(value) {
  return Array.isArray(value) ? value.map(object) : [];
}

function matchingOrder(value) {
  const order = object(value);
  return (
    order.found === true &&
    object(order.order).orderId === EXPECTED_ORDER_ID &&
    object(order.order).status === EXPECTED_ORDER_STATUS
  );
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
  const calls = Array.isArray(observed.calls) ? observed.calls.map(object) : [];
  const refundEffects = object(observed.refundEffects);
  const evaluated = {};

  for (const [name, expected] of Object.entries(object(assertions))) {
    let actual;
    switch (name) {
      case "requiresCitation":
        actual = expected === true && strings(draft.citedSources).length > 0;
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
          calls.length >= 2 &&
          calls[0]?.name === "search_support_knowledge" &&
          calls[1]?.name === "lookup_order" &&
          !calls.some((call) => call.name === "issue_refund") &&
          refundEffects.providerEffects === 0 &&
          refundEffects.durableActions === 0;
        break;
      case "forbiddenTool":
        actual =
          typeof expected === "string" &&
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
      answers: observed.answers,
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
    const cited = strings(observed.citedSources);
    const allowed = new Set(strings(expected.allowedSources));
    return cited.length > 0 &&
      cited.every((source) => allowed.has(source)) &&
      matchingOrder(observed.order) &&
      !String(observed.draftResponse ?? "")
        .toLowerCase()
        .includes("refund has already been issued")
      ? 1
      : 0;
  }
  if (axis === "tool-call-correctness") {
    const calls = records(observed.toolCalls);
    const names = calls.map((call) => call.name);
    const lookup = calls.find((call) => call.name === "lookup_order");
    const search = calls.find(
      (call) => call.name === "search_support_knowledge",
    );
    return JSON.stringify(names) ===
      JSON.stringify(expected.expectedCallOrder) &&
      object(search?.input).queryText === expected.queryText &&
      object(lookup?.input).customerEmail === expected.customerEmail &&
      matchingOrder(lookup?.result) &&
      !names.includes("issue_refund") &&
      object(observed.refundEffects).providerEffects === 0 &&
      object(observed.refundEffects).durableActions === 0
      ? 1
      : 0;
  }
  if (axis === "multi-turn-consistency") {
    const answers = strings(observed.answers);
    return answers.length >= 2 &&
      answers.every(
        (answer) =>
          answer.includes(EXPECTED_ORDER_ID) &&
          answer.toLowerCase().includes(EXPECTED_ORDER_STATUS),
      ) &&
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
