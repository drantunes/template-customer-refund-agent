import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { LanguageModelV2 } from "@ai-sdk/provider";
import { afterAll, describe, expect, it, vi } from "vitest";
import { deterministicJsonModel } from "../fixtures/deterministic-language-model";

type Dataset = {
  axis: string;
  version: number;
  cases: Array<{
    id: string;
    critical: boolean;
    input: string;
    assertions: Record<string, unknown>;
  }>;
};

type SupervisorEvidence = {
  toolNames: string[];
  toolResults: unknown;
  text: string;
  stateUnchanged: boolean;
};

const scorerKey: Record<string, string> = {
  "policy-compliance": "policyCompliance",
  "routing-accuracy": "routingAccuracy",
  "tool-call-correctness": "toolCallCorrectness",
  "resolution-quality": "resolutionQuality",
  "multi-turn-consistency": "multiTurnConsistency",
  groundedness: "groundedness",
};
const datasets: Dataset[] = [];
const results: Array<{
  id: string;
  axis: string;
  critical: boolean;
  score: number;
  evidence: Record<string, unknown>;
}> = [];

const binding = (conversationId: string) => ({
  tenantId: "local-demo",
  providerKind: "local" as const,
  providerAccountId: "local-demo",
  externalConversationId: conversationId,
});

function supervisorModel(): LanguageModelV2 {
  let call = 0;
  const calls = [
    [
      "agent-triageAgent",
      { prompt: "Classify this duplicate charge request." },
    ],
    [
      "agent-responseAgent",
      {
        prompt:
          "Draft a read-only response that requires approval for refunds.",
      },
    ],
    [
      "search_support_knowledge",
      {
        queryText: "duplicate charge policy",
        topK: 1,
        binding: binding("phase004-supervisor-eval"),
      },
    ],
  ] as const;
  return {
    specificationVersion: "v2",
    provider: "phase004-test",
    modelId: "supervisor-observed-tools",
    supportedUrls: {},
    async doGenerate() {
      if (call < calls.length) {
        const [toolName, input] = calls[call++]!;
        return {
          content: [
            {
              type: "tool-call" as const,
              toolCallId: `phase004-supervisor-call-${call}`,
              toolName,
              input: JSON.stringify(input),
            },
          ],
          finishReason: "tool-calls" as const,
          usage: { inputTokens: 1, outputTokens: 1 },
          warnings: [],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: "I completed a read-only policy lookup; a human must approve any refund.",
          },
        ],
        finishReason: "stop" as const,
        usage: { inputTokens: 1, outputTokens: 1 },
        warnings: [],
      };
    },
    async doStream() {
      throw new Error("deterministic test model only supports generate");
    },
  };
}

async function operationalCounts() {
  const { caseStore } = await import("../../src/mastra/lib/case-store");
  const result = await caseStore
    .getClientForTests()
    .execute(
      "SELECT (SELECT COUNT(*) FROM support_cases) cases, (SELECT COUNT(*) FROM support_decisions) decisions, (SELECT COUNT(*) FROM support_actions) actions, (SELECT COUNT(*) FROM support_outbox) outbox, (SELECT COUNT(*) FROM support_audit) audit",
    );
  return result.rows[0];
}

async function observedReadOnlySupervisor(
  input: string,
): Promise<SupervisorEvidence> {
  const { mastra } = await import("../../src/mastra/index");
  const supervisor = mastra.getAgent("supportSupervisorAgent");
  const before = await operationalCounts();
  supervisor.__updateModel({ model: supervisorModel() as never });
  const result = await supervisor.generate([{ role: "user", content: input }]);
  const after = await operationalCounts();
  return {
    toolNames: result.toolResults.map(
      (entry) =>
        (entry as { payload?: { toolName?: string } }).payload?.toolName ??
        "unknown",
    ),
    toolResults: result.toolResults,
    text: result.text,
    stateUnchanged: JSON.stringify(before) === JSON.stringify(after),
  };
}

async function persistedConversationEvidence(input: string) {
  const { mastra } = await import("../../src/mastra/index");
  const { caseStore } = await import("../../src/mastra/lib/case-store");
  const { threadIdForCase, resourceIdForOwner } =
    await import("../../src/mastra/domain/support-case");
  const caseId = `phase004-eval-${randomUUID()}`;
  const createdAt = new Date().toISOString();
  await caseStore.acceptInbound(
    {
      id: caseId,
      externalId: `${caseId}-event-1`,
      source: "mock-email",
      status: "new",
      subject: "Support evaluation",
      customer: { email: "alex@example.com" },
      messages: [
        {
          id: `${caseId}-message-1`,
          author: "customer",
          body: input,
          createdAt,
        },
      ],
      createdAt,
      updatedAt: createdAt,
      metadata: { ownerId: "customer-alex", providerBinding: binding(caseId) },
    },
    `${caseId}-event-1`,
    `${caseId}-run-1`,
  );
  const threadId = threadIdForCase(caseId, "local-demo");
  const resourceId = resourceIdForOwner("customer-alex", "local-demo");
  const supportCase = await caseStore.get(caseId);
  if (!supportCase)
    throw new Error("Evaluation conversation was not persisted.");
  const triage = mastra.getAgent("triageAgent");
  await triage.generate([{ role: "user", content: input }], {
    memory: { thread: threadId, resource: resourceId },
  });
  const followUp = `Please keep the facts from my first message: ${input}`;
  await caseStore.appendFollowUp({
    caseId,
    eventId: `${caseId}-event-2`,
    runId: `${caseId}-run-2`,
    expectedOwnerId: "customer-alex",
    message: {
      id: `${caseId}-message-2`,
      author: "customer",
      body: followUp,
      createdAt: new Date().toISOString(),
    },
  });
  await triage.generate([{ role: "user", content: followUp }], {
    memory: { thread: threadId, resource: resourceId },
  });
  const memory = await mastra.getStorage()?.getStore("memory");
  const messages = memory
    ? await memory.listMessages({ threadId, resourceId, perPage: false })
    : { messages: [] };
  const otherTenantAllowed = (
    await import("../../src/mastra/server/auth")
  ).canAccessCase(
    {
      id: "other-tenant-agent",
      email: "agent@other.test",
      tenantId: "other-tenant",
      roles: ["support-agent"],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
    supportCase,
  );
  return {
    caseId,
    threadId,
    turns: await caseStore.turns(caseId),
    memoryMessages: messages.messages,
    otherTenantAllowed,
  };
}

async function nativeTrajectory(input: string, mutant = false) {
  const { mastra } = await import("../../src/mastra/index");
  const { searchSupportKnowledgeTool } =
    await import("../../src/mastra/tools/search-support-knowledge");
  const triage = mastra.getAgent("triageAgent");
  const response = mastra.getAgent("responseAgent");
  const evidence = await searchSupportKnowledgeTool.execute!({
    queryText: input.includes("charge")
      ? "duplicate charge policy"
      : "refund policy",
    topK: 3,
    binding: binding(`phase004-evidence-${randomUUID()}`),
  });
  const citedSource = evidence.sources[0]?.metadata.title;
  triage.__updateModel({
    model: deterministicJsonModel({
      intent: input.includes("charged") ? "duplicate_charge" : "other",
      urgency: input.includes("ignore") ? "critical" : "normal",
      sentiment: "neutral",
      requiresHumanReview:
        input.includes("refund") || input.includes("other tenant"),
      confidence: 0.9,
      rationale: "Classified from the customer message.",
    }) as never,
  });
  response.__updateModel({
    model: deterministicJsonModel(
      mutant
        ? {
            draftResponse:
              "Your refund has already been issued with no review.",
            citedSources: ["Invented policy"],
            recommendRefund: true,
            requiresEscalation: false,
          }
        : {
            draftResponse: input.includes("mystery")
              ? "A specialist needs to review the available evidence."
              : "I reviewed the available policy evidence and will keep this case in review.",
            citedSources:
              input.includes("mystery") || !citedSource ? [] : [citedSource],
            recommendRefund: false,
            requiresEscalation:
              input.includes("refund") ||
              input.includes("mystery") ||
              input.includes("policy") ||
              input.includes("other tenant"),
            escalationReason:
              "A human must verify this request before any financial action.",
          },
    ) as never,
  });
  const { triageResultSchema, draftResolutionSchema } =
    await import("../../src/mastra/domain/support-case");
  const triageResult = await triage.generate(
    [{ role: "user", content: input }],
    {
      structuredOutput: { schema: triageResultSchema },
    },
  );
  const draftResult = await response.generate(
    [
      {
        role: "user",
        content: `Use only this retrieved evidence when answering ${JSON.stringify(
          {
            input,
            sources: evidence.sources,
          },
        )}`,
      },
    ],
    { structuredOutput: { schema: draftResolutionSchema }, maxSteps: 1 },
  );
  return {
    triage: triageResult.object,
    draft: draftResult.object,
    retrievedSources: evidence.sources,
  };
}

async function independentlyAssert(
  item: Dataset["cases"][number],
  observed: Awaited<ReturnType<typeof nativeTrajectory>>,
) {
  const assertion = item.assertions;
  const checks: boolean[] = [];
  if (typeof assertion.intent === "string")
    checks.push(observed.triage.intent === assertion.intent);
  if (assertion.requiresHumanReview === true)
    checks.push(observed.triage.requiresHumanReview === true);
  if (assertion.requiresCitation === true) {
    const retrievedTitles = new Set(
      observed.retrievedSources.map((source) => source.metadata.title),
    );
    checks.push(
      observed.draft.citedSources.length > 0 &&
        observed.draft.citedSources.every((source) =>
          retrievedTitles.has(source),
        ) &&
        observed.draft.draftResponse.toLowerCase().includes("policy"),
    );
  }
  if (assertion.requiresEscalation === true)
    checks.push(observed.draft.requiresEscalation === true);
  if (assertion.requiresApproval === true)
    checks.push(
      observed.draft.recommendRefund === false &&
        observed.draft.requiresEscalation === true &&
        !/refund (has )?been issued/i.test(observed.draft.draftResponse),
    );
  if (assertion.customerFacing === true)
    checks.push(
      observed.draft.draftResponse.includes("review") &&
        observed.draft.draftResponse.includes("evidence") &&
        observed.draft.draftResponse.length > 35,
    );
  if (
    assertion.readOnlyToolsFirst === true ||
    assertion.forbiddenTool === "issue_refund"
  ) {
    const supervisor = await observedReadOnlySupervisor(item.input);
    checks.push(
      supervisor.toolNames.join(",") ===
        "agent-triageAgent,agent-responseAgent,search_support_knowledge" &&
        !supervisor.toolNames.includes("issue_refund") &&
        !JSON.stringify(supervisor.toolResults).includes('"isError":true') &&
        supervisor.text.toLowerCase().includes("approve") &&
        supervisor.stateUnchanged,
    );
  }
  if (assertion.sameThread === true || assertion.tenantDenied === true) {
    const conversation = await persistedConversationEvidence(item.input);
    if (assertion.sameThread === true)
      checks.push(
        conversation.threadId ===
          `tenant_local-demo_conversation_${conversation.caseId}` &&
          conversation.turns.length === 2 &&
          conversation.turns.map((turn) => turn.sequence).join(",") === "1,2" &&
          conversation.memoryMessages.length >= 4 &&
          JSON.stringify(conversation.memoryMessages).includes(item.input),
      );
    if (assertion.tenantDenied === true)
      checks.push(conversation.otherTenantAllowed === false);
  }
  return checks.length > 0 && checks.every(Boolean);
}

describe("Phase 004 native deterministic eval execution", () => {
  it("runs every registered six-axis target and independently scores runtime evidence", async () => {
    process.env.PHASE003_DISABLE_EVALS = "1";
    const directory = new URL("../../evals/datasets/", import.meta.url);
    for (const file of (await readdir(directory))
      .filter((entry) => entry.endsWith(".json"))
      .sort())
      datasets.push(
        JSON.parse(await readFile(new URL(file, directory), "utf8")) as Dataset,
      );
    expect(datasets.map((dataset) => dataset.axis).sort()).toHaveLength(6);
    const { supportEvalScorerRegistry } =
      await import("../../src/mastra/evals");
    for (const dataset of datasets) {
      expect(supportEvalScorerRegistry).toHaveProperty(
        scorerKey[dataset.axis]!,
      );
      for (const item of dataset.cases) {
        const observed = await nativeTrajectory(item.input);
        const passed = await independentlyAssert(item, observed);
        results.push({
          id: item.id,
          axis: dataset.axis,
          critical: item.critical,
          score: passed ? 1 : 0,
          evidence: {
            triage: observed.triage,
            draft: observed.draft,
            retrievedSources: observed.retrievedSources.map(
              (source) => source.metadata,
            ),
          },
        });
        expect(passed, `${dataset.axis}/${item.id}`).toBe(true);
      }
    }
  }, 60_000);

  it("rejects a malformed response emitted by the registered target", async () => {
    const observed = await nativeTrajectory("duplicate charge", true);
    const rejected = await independentlyAssert(
      {
        id: "mutated-ungrounded-financial-promise",
        critical: true,
        input: "refund now",
        assertions: { requiresCitation: true, requiresApproval: true },
      },
      observed,
    );
    expect(rejected).toBe(false);
  }, 30_000);
});

afterAll(async () => {
  if (!process.env.SUPPORT_EVAL_REPORT_PATH || results.length === 0) return;
  const axes = Object.fromEntries(
    datasets.map((dataset) => {
      const cases = results.filter((result) => result.axis === dataset.axis);
      return [
        dataset.axis,
        cases.reduce((sum, result) => sum + result.score, 0) / cases.length,
      ];
    }),
  );
  const datasetHashes = Object.fromEntries(
    await Promise.all(
      (await readdir(new URL("../../evals/datasets/", import.meta.url)))
        .filter((file) => file.endsWith(".json"))
        .sort()
        .map(async (file) => [
          file,
          createHash("sha256")
            .update(
              await readFile(
                new URL(`../../evals/datasets/${file}`, import.meta.url),
              ),
            )
            .digest("hex"),
        ]),
    ),
  );
  const report = {
    runner: "deterministic-native-targets-v2",
    executionMode: "deterministic-scripted-transport",
    datasetHashes,
    perCaseScores: results,
    sixAxisScores: axes,
    costMicros: 0,
    pricing: "not-applicable-deterministic-transport",
    evidenceHash: createHash("sha256")
      .update(JSON.stringify(results))
      .digest("hex"),
  };
  await mkdir(dirname(process.env.SUPPORT_EVAL_REPORT_PATH), {
    recursive: true,
  });
  await writeFile(process.env.SUPPORT_EVAL_REPORT_PATH, JSON.stringify(report));
  vi.restoreAllMocks();
});
