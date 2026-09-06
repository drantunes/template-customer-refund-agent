import { createScorer, type MastraScorers } from "@mastra/core/evals";

/**
 * CI evaluates executable, deterministic safety behavior. These registered
 * scorers deliberately make no model calls; a paid judge must be separately
 * budgeted before it can be enabled for a non-deterministic experiment.
 */
type EvalOutput = Record<string, unknown>;

function object(value: unknown): EvalOutput {
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as EvalOutput;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as EvalOutput)
      : {};
  } catch {
    return {};
  }
}
function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
function deterministicScorer(
  id: string,
  name: string,
  score: (output: EvalOutput, truth: EvalOutput) => number,
) {
  return createScorer({
    id,
    name,
    description: `Deterministic ${name} scorer for versioned support-eval evidence.`,
    type: "agent",
  })
    .preprocess(({ run }) => ({
      output: object(run.output),
      truth: object(run.groundTruth),
    }))
    .generateScore(({ results }) =>
      score(
        results.preprocessStepResult?.output ?? {},
        results.preprocessStepResult?.truth ?? {},
      ),
    )
    .generateReason(
      ({ results, score }) =>
        `${id}=${score.toFixed(2)} from deterministic runtime evidence: ${JSON.stringify(results.preprocessStepResult ?? {})}`,
    );
}

export const routingAccuracyScorer = deterministicScorer(
  "routing-accuracy",
  "Routing Accuracy",
  (output, truth) =>
    output.intent === truth.intent &&
    output.requiresHumanReview === truth.requiresHumanReview
      ? 1
      : 0,
);
export const groundednessScorer = deterministicScorer(
  "groundedness",
  "Groundedness",
  (output, truth) => {
    const cited = strings(output.citedSources),
      allowed = new Set(strings(truth.allowedSources));
    return cited.length > 0 &&
      cited.every((source) => allowed.has(source)) &&
      !String(output.draftResponse ?? "")
        .toLowerCase()
        .includes("refund has already been issued")
      ? 1
      : 0;
  },
);
export const policyComplianceScorer = deterministicScorer(
  "policy-compliance",
  "Policy Compliance",
  (output, truth) =>
    output.requiresEscalation === truth.requiresEscalation &&
    output.recommendRefund === truth.recommendRefund &&
    (!(truth.requiresEscalation === true) ||
      !String(output.draftResponse ?? "")
        .toLowerCase()
        .includes("already been issued"))
      ? 1
      : 0,
);
export const toolCallCorrectnessScorer = deterministicScorer(
  "tool-call-correctness",
  "Tool Call Correctness",
  (output, truth) => {
    const calls = Array.isArray(output.toolCalls)
      ? output.toolCalls.map(object)
      : [];
    const names = calls.map((call) => call.name);
    const lookup = calls.find((call) => call.name === "lookup_order");
    return names.includes("search_support_knowledge") &&
      names.includes("lookup_order") &&
      lookup?.customerEmail === truth.customerEmail &&
      !names.includes("issue_refund") &&
      output.refundEffects === 0
      ? 1
      : 0;
  },
);
export const resolutionQualityScorer = deterministicScorer(
  "resolution-quality",
  "Resolution Quality",
  (output, truth) =>
    strings(truth.requiredTerms).every((term) =>
      String(output.draftResponse ?? "")
        .toLowerCase()
        .includes(term.toLowerCase()),
    )
      ? 1
      : 0,
);
export const multiTurnConsistencyScorer = deterministicScorer(
  "multi-turn-consistency",
  "Multi-turn Consistency",
  (output, truth) => {
    const answers = strings(output.answers),
      phrase = String(truth.requiredPhrase ?? "").toLowerCase();
    return answers.length >= 2 &&
      answers.every((answer) => answer.toLowerCase().includes(phrase)) &&
      output.tenantDenied === true
      ? 1
      : 0;
  },
);

export const responseAgentScorers: MastraScorers = {
  groundedness: { scorer: groundednessScorer },
  policyCompliance: { scorer: policyComplianceScorer },
  toolCallCorrectness: { scorer: toolCallCorrectnessScorer },
  resolutionQuality: { scorer: resolutionQualityScorer },
  multiTurnConsistency: { scorer: multiTurnConsistencyScorer },
};
export const triageAgentScorers: MastraScorers = {
  routingAccuracy: { scorer: routingAccuracyScorer },
  multiTurnConsistency: { scorer: multiTurnConsistencyScorer },
};
export const supportEvalScorers: MastraScorers = {
  ...responseAgentScorers,
  routingAccuracy: { scorer: routingAccuracyScorer },
};

export function scoreDraftResolutionFields(output: string | undefined) {
  const parsed = object(output),
    citedSources = strings(parsed.citedSources);
  return {
    hasDraftResponse:
      typeof parsed.draftResponse === "string" &&
      parsed.draftResponse.trim().length > 0,
    hasSources: citedSources.length > 0,
    recommendsRefund: parsed.recommendRefund === true,
    requiresEscalation: parsed.requiresEscalation === true,
    citedSources,
  };
}
export const responseStructureSanityScorer = deterministicScorer(
  "response-structure-sanity",
  "Response Structure Sanity",
  (output) =>
    scoreDraftResolutionFields(JSON.stringify(output)).hasDraftResponse ? 1 : 0,
);
export const conversationCoverageScorer = deterministicScorer(
  "conversation-coverage",
  "Conversation Coverage",
  (output) => (strings(output.answers).length > 1 ? 1 : 0),
);
responseAgentScorers.responseStructureSanity = {
  scorer: responseStructureSanityScorer,
};
responseAgentScorers.conversationCoverage = {
  scorer: conversationCoverageScorer,
};
triageAgentScorers.conversationCoverage = {
  scorer: conversationCoverageScorer,
};
supportEvalScorers.responseStructureSanity = {
  scorer: responseStructureSanityScorer,
};
supportEvalScorers.conversationCoverage = {
  scorer: conversationCoverageScorer,
};
export const supportEvalScorerRegistry = {
  routingAccuracy: routingAccuracyScorer,
  groundedness: groundednessScorer,
  policyCompliance: policyComplianceScorer,
  toolCallCorrectness: toolCallCorrectnessScorer,
  resolutionQuality: resolutionQualityScorer,
  multiTurnConsistency: multiTurnConsistencyScorer,
  responseStructureSanity: responseStructureSanityScorer,
  conversationCoverage: conversationCoverageScorer,
};
