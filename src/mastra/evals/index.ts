import { createScorer, type MastraScorers } from "@mastra/core/evals";
import type { Tool } from "@mastra/core/tools";
import {
  createMultiTurnJudgeScorer,
  createPromptAlignmentScorerLLM,
  createToolCallAccuracyScorerLLM,
} from "@mastra/evals/scorers/prebuilt";
import {
  extractAgentResponseMessages,
  extractToolCalls,
  getAssistantMessageFromRunOutput,
  getCombinedSystemPrompt,
  getUserMessageFromRunInput,
} from "@mastra/evals/scorers/utils";
import { z } from "zod";
import {
  lookupCustomerRefundHistoryTool,
  lookupOrderTool,
  lookupSubscriptionTool,
} from "../tools/lookup-order";
import { searchSupportKnowledgeTool } from "../tools/search-support-knowledge";

const EVAL_MODEL = "openai/gpt-5-mini";

const responseAgentAvailableTools = [
  searchSupportKnowledgeTool,
  lookupOrderTool,
  lookupSubscriptionTool,
  lookupCustomerRefundHistoryTool,
] as unknown as Tool[];

function normalizeWhitespace(value: string | undefined): string {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

function extractJsonBlock(value: string): string | null {
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");

  if (start === -1 || end === -1 || end < start) {
    return null;
  }

  return value.slice(start, end + 1);
}

function parseJsonObject(
  value: string | undefined,
): Record<string, unknown> | null {
  if (!value) {
    return null;
  }

  const jsonBlock = extractJsonBlock(value);
  if (!jsonBlock) {
    return null;
  }

  try {
    const parsed = JSON.parse(jsonBlock);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function stringifyContext(context: Record<string, unknown> | null): string {
  return context
    ? JSON.stringify(context, null, 2)
    : "No structured case context was found in the input.";
}

export const routingAccuracyScorer = createScorer({
  id: "routing-accuracy",
  name: "Routing Accuracy",
  description:
    "Evaluates whether triage routing labels match the support message and any provided ground truth.",
  type: "agent",
  judge: {
    model: EVAL_MODEL,
    instructions:
      "You evaluate support-triage classifications. Grade whether the predicted intent, urgency, sentiment, and human-review decision are justified by the customer message. Be strict about unsupported labels.",
  },
})
  .preprocess(({ run }) => {
    const userMessage = getUserMessageFromRunInput(run.input);
    const rawOutput = getAssistantMessageFromRunOutput(run.output);
    const prediction = parseJsonObject(rawOutput);
    const groundTruth = isRecord(run.groundTruth) ? run.groundTruth : null;

    return {
      userMessage,
      rawOutput,
      prediction,
      groundTruth,
    };
  })
  .analyze({
    description: "Determine whether the triage output is accurate.",
    outputSchema: z.object({
      intentCorrect: z.boolean(),
      urgencyCorrect: z.boolean(),
      sentimentCorrect: z.boolean(),
      humanReviewCorrect: z.boolean(),
      rationaleGrounded: z.boolean(),
      reasoning: z.string(),
      overallScore: z.number().min(0).max(1),
    }),
    createPrompt: ({ results }) => {
      const { userMessage, prediction, groundTruth, rawOutput } =
        results.preprocessStepResult ?? {};

      return `Customer message:\n${userMessage ?? "Missing customer message"}\n\nPredicted triage JSON:\n${prediction ? JSON.stringify(prediction, null, 2) : (rawOutput ?? "Unparseable output")}\n\nGround truth (if present):\n${groundTruth ? JSON.stringify(groundTruth, null, 2) : "None provided"}\n\nReturn booleans for each field, a concise explanation, and an overallScore from 0 to 1.`;
    },
  })
  .generateScore(({ results }) => results.analyzeStepResult?.overallScore ?? 0)
  .generateReason(
    ({ results }) =>
      results.analyzeStepResult?.reasoning ?? "No routing analysis available.",
  );

export const groundednessScorer = createScorer({
  id: "groundedness",
  name: "Groundedness",
  description:
    "Checks whether the drafted support resolution is grounded in the retrieved policy and account context.",
  type: "agent",
  judge: {
    model: EVAL_MODEL,
    instructions:
      "You evaluate grounded customer-support resolutions. A grounded answer only makes claims that are supported by the provided policy, order, subscription, and refund-history context.",
  },
})
  .preprocess(({ run }) => {
    const userMessage = getUserMessageFromRunInput(run.input);
    const responseText = getAssistantMessageFromRunOutput(run.output);
    const responseObject = parseJsonObject(responseText);
    const context = parseJsonObject(userMessage);

    return {
      responseText,
      responseObject,
      context,
    };
  })
  .analyze({
    description:
      "Judge how well the response stays grounded in the supplied case context.",
    outputSchema: z.object({
      supportedClaims: z.number().int().nonnegative(),
      unsupportedClaims: z.number().int().nonnegative(),
      missingSupport: z.array(z.string()),
      reasoning: z.string(),
      overallScore: z.number().min(0).max(1),
    }),
    createPrompt: ({ results }) => {
      const { context, responseObject, responseText } =
        results.preprocessStepResult ?? {};

      return `Case context JSON:\n${stringifyContext(context ?? null)}\n\nDraft resolution output:\n${responseObject ? JSON.stringify(responseObject, null, 2) : (responseText ?? "Missing output")}\n\nScore how grounded the draft is in the context. Penalize invented refund eligibility, invented order facts, invented timelines, and uncited policy claims.`;
    },
  })
  .generateScore(({ results }) => results.analyzeStepResult?.overallScore ?? 0)
  .generateReason(
    ({ results }) =>
      results.analyzeStepResult?.reasoning ??
      "No groundedness analysis available.",
  );

export const policyComplianceScorer = createScorer({
  id: "policy-compliance",
  name: "Policy Compliance",
  description:
    "Checks whether the draft follows refund and escalation policy rules from the retrieved support context.",
  type: "agent",
  judge: {
    model: EVAL_MODEL,
    instructions:
      "You evaluate policy compliance for a support refund agent. Focus on whether the response respects the supplied policies and the agent rules around citations, escalation, and refund recommendations.",
  },
})
  .preprocess(({ run }) => {
    const userMessage = getUserMessageFromRunInput(run.input);
    const responseText = getAssistantMessageFromRunOutput(run.output);
    const responseObject = parseJsonObject(responseText);
    const context = parseJsonObject(userMessage);

    return {
      responseText,
      responseObject,
      context,
      systemPrompt: getCombinedSystemPrompt(run.input),
    };
  })
  .analyze({
    description:
      "Judge whether the response complies with policy and response rules.",
    outputSchema: z.object({
      respectsPolicy: z.boolean(),
      citesSourcesWhenMakingPolicyClaims: z.boolean(),
      avoidsUnsupportedRefundPromises: z.boolean(),
      handlesEscalationCorrectly: z.boolean(),
      reasoning: z.string(),
      overallScore: z.number().min(0).max(1),
    }),
    createPrompt: ({ results }) => {
      const { context, responseObject, responseText, systemPrompt } =
        results.preprocessStepResult ?? {};

      return `Agent instructions:\n${systemPrompt ?? "Missing system prompt"}\n\nCase context JSON:\n${stringifyContext(context ?? null)}\n\nDraft resolution output:\n${responseObject ? JSON.stringify(responseObject, null, 2) : (responseText ?? "Missing output")}\n\nJudge policy compliance. Check whether citedSources match used policy claims, whether refund recommendations are supported by policy and account state, and whether escalation is used when the situation requires it.`;
    },
  })
  .generateScore(({ results }) => results.analyzeStepResult?.overallScore ?? 0)
  .generateReason(
    ({ results }) =>
      results.analyzeStepResult?.reasoning ??
      "No policy-compliance analysis available.",
  );

export const toolCallCorrectnessScorer = createToolCallAccuracyScorerLLM({
  model: EVAL_MODEL,
  availableTools: responseAgentAvailableTools,
});

export const resolutionQualityScorer = createPromptAlignmentScorerLLM({
  model: EVAL_MODEL,
  options: {
    evaluationMode: "user",
    includeConversationHistory: { maxMessages: 6 },
  },
});

export const multiTurnConsistencyScorer = createMultiTurnJudgeScorer({
  model: EVAL_MODEL,
  criterion:
    "Across the conversation, the support agent stays consistent about the customer issue, recommended next steps, refund posture, and escalation status. It does not contradict earlier claims about eligibility, actions taken, or required approvals.",
});

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
  routingAccuracy: { scorer: routingAccuracyScorer },
  groundedness: { scorer: groundednessScorer },
  policyCompliance: { scorer: policyComplianceScorer },
  toolCallCorrectness: { scorer: toolCallCorrectnessScorer },
  resolutionQuality: { scorer: resolutionQualityScorer },
  multiTurnConsistency: { scorer: multiTurnConsistencyScorer },
};

export function scoreDraftResolutionFields(output: string | undefined): {
  hasDraftResponse: boolean;
  hasSources: boolean;
  recommendsRefund: boolean;
  requiresEscalation: boolean;
  citedSources: string[];
} {
  const parsed = parseJsonObject(output);
  const citedSources = asStringArray(parsed?.citedSources);

  return {
    hasDraftResponse:
      typeof parsed?.draftResponse === "string" &&
      normalizeWhitespace(parsed.draftResponse).length > 0,
    hasSources: citedSources.length > 0,
    recommendsRefund: parsed?.recommendRefund === true,
    requiresEscalation: parsed?.requiresEscalation === true,
    citedSources,
  };
}

export const responseStructureSanityScorer = createScorer({
  id: "response-structure-sanity",
  name: "Response Structure Sanity",
  description:
    "Performs a lightweight deterministic sanity check over the draft resolution structure.",
  type: "agent",
})
  .preprocess(({ run }) =>
    scoreDraftResolutionFields(getAssistantMessageFromRunOutput(run.output)),
  )
  .generateScore(({ results }) => {
    const structure = results.preprocessStepResult;
    if (!structure) {
      return 0;
    }

    let score = 0;
    if (structure.hasDraftResponse) score += 0.4;
    if (structure.hasSources) score += 0.2;
    if (!structure.recommendsRefund || structure.hasSources) score += 0.2;
    if (!structure.requiresEscalation || structure.hasDraftResponse)
      score += 0.2;
    return score;
  })
  .generateReason(({ results, score }) => {
    const structure = results.preprocessStepResult;

    if (!structure) {
      return "The response could not be parsed as the expected structured draft output.";
    }

    return `Score ${score.toFixed(2)}. draftResponse=${structure.hasDraftResponse}, citedSources=${structure.citedSources.length}, recommendRefund=${structure.recommendsRefund}, requiresEscalation=${structure.requiresEscalation}.`;
  });

responseAgentScorers.responseStructureSanity = {
  scorer: responseStructureSanityScorer,
};
supportEvalScorers.responseStructureSanity = {
  scorer: responseStructureSanityScorer,
};

export const conversationCoverageScorer = createScorer({
  id: "conversation-coverage",
  name: "Conversation Coverage",
  description:
    "Checks whether the agent keeps responding across a multi-turn conversation.",
  type: "agent",
})
  .preprocess(({ run }) => {
    const assistantTurns = extractAgentResponseMessages(run.output);
    const toolUsage = extractToolCalls(run.output);

    return {
      assistantTurns,
      toolCount: toolUsage.tools.length,
    };
  })
  .generateScore(({ results }) => {
    const turnCount = results.preprocessStepResult?.assistantTurns.length ?? 0;
    return turnCount > 1 ? 1 : 0;
  })
  .generateReason(({ results }) => {
    const turnCount = results.preprocessStepResult?.assistantTurns.length ?? 0;
    const toolCount = results.preprocessStepResult?.toolCount ?? 0;
    return `Observed ${turnCount} assistant turn(s) and ${toolCount} tool call(s) in the conversation output.`;
  });

triageAgentScorers.conversationCoverage = {
  scorer: conversationCoverageScorer,
};
responseAgentScorers.conversationCoverage = {
  scorer: conversationCoverageScorer,
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
