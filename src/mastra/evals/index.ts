import { createScorer, type MastraScorers } from "@mastra/core/evals";
import { scoreAxis } from "./deterministic-semantics.js";

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
function deterministicScorer(
  id: string,
  name: string,
  score?: (output: EvalOutput, truth: EvalOutput) => number,
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
      score
        ? score(
            results.preprocessStepResult?.output ?? {},
            results.preprocessStepResult?.truth ?? {},
          )
        : scoreAxis(
            id,
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
);
export const groundednessScorer = deterministicScorer(
  "groundedness",
  "Groundedness",
);
export const policyComplianceScorer = deterministicScorer(
  "policy-compliance",
  "Policy Compliance",
);
export const toolCallCorrectnessScorer = deterministicScorer(
  "tool-call-correctness",
  "Tool Call Correctness",
);
export const resolutionQualityScorer = deterministicScorer(
  "resolution-quality",
  "Resolution Quality",
);
export const multiTurnConsistencyScorer = deterministicScorer(
  "multi-turn-consistency",
  "Multi-turn Consistency",
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
    citedSources = Array.isArray(parsed.citedSources)
      ? parsed.citedSources.filter(
          (source): source is string => typeof source === "string",
        )
      : [];
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
  (output) =>
    (Array.isArray(output.answers) ? output.answers : []).filter(
      (answer) => typeof answer === "string",
    ).length > 1
      ? 1
      : 0,
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
