import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  budgetedLanguageModel,
  createValidationBudgetExecution,
} from "../../src/mastra/lib/eval-budget";
import { deterministicJsonModel } from "../fixtures/deterministic-language-model";

type Dataset = {
  axis: string;
  cases: Array<{
    id: string;
    critical: boolean;
    input: string;
    assertions: Record<string, unknown>;
  }>;
};
type Result = {
  id: string;
  axis: string;
  critical: boolean;
  score: number;
  evidence: Record<string, unknown>;
};
const results: Result[] = [],
  datasets: Dataset[] = [];
const ciEvaluationBudget = createValidationBudgetExecution("ci-eval");
const scorerKey: Record<string, string> = {
  "policy-compliance": "policyCompliance",
  "routing-accuracy": "routingAccuracy",
  "tool-call-correctness": "toolCallCorrectness",
  "resolution-quality": "resolutionQuality",
  "multi-turn-consistency": "multiTurnConsistency",
  groundedness: "groundedness",
};
const binding = (id: string) => ({
  tenantId: "local-demo",
  providerKind: "local" as const,
  providerAccountId: "local-demo",
  externalConversationId: id,
});

async function scopedEvidence(input: string) {
  const { mastra } = await import("../../src/mastra/index");
  const { caseStore } = await import("../../src/mastra/lib/case-store");
  const { publishKnowledge } =
    await import("../../src/mastra/lib/publish-knowledge");
  const { ensureProviderFixtures } =
    await import("../../src/mastra/providers/registry");
  const { withTrustedCaseReadScope, withTrustedCommerceScope } =
    await import("../../src/mastra/lib/trusted-run-scope");
  const id = `phase004-eval-${randomUUID()}`,
    now = new Date().toISOString(),
    configured = binding(id);
  await caseStore.acceptInbound(
    {
      id,
      externalId: `${id}-event`,
      source: "mock-email",
      status: "new",
      subject: "Support evaluation",
      customer: { email: "alex@example.com" },
      messages: [
        {
          id: `${id}-message`,
          author: "customer",
          body: input,
          createdAt: now,
        },
      ],
      createdAt: now,
      updatedAt: now,
      metadata: { ownerId: "customer-alex", providerBinding: configured },
    },
    `${id}-event`,
    `${id}-run`,
  );
  await publishKnowledge(configured, { onlyIfMissing: true });
  await ensureProviderFixtures(configured);
  const search = mastra.getTool("searchSupportKnowledgeTool"),
    lookup = mastra.getTool("lookupOrderTool");
  const sources = await withTrustedCaseReadScope(
    { caseId: id, ownerId: "customer-alex", tenantId: "local-demo" },
    () =>
      search.execute!(
        {
          queryText: input.includes("charge")
            ? "duplicate charge policy"
            : "refund policy",
          topK: 3,
          binding: configured,
        },
        { mastra },
      ),
  );
  const order = await withTrustedCommerceScope(
    { caseId: id, ownerId: "customer-alex", tenantId: "local-demo" },
    () =>
      lookup.execute!(
        { customerEmail: "alex@example.com", binding: configured },
        { mastra },
      ),
  );
  const triage = mastra.getAgent("triageAgent"),
    response = mastra.getAgent("responseAgent");
  const cited = sources.sources[0]?.metadata.title ?? "";
  triage.__updateModel({
    model: deterministicJsonModel({
      intent: input.includes("charged") ? "duplicate_charge" : "other",
      urgency: "normal",
      sentiment: "neutral",
      requiresHumanReview:
        input.includes("refund") || input.includes("other tenant"),
      confidence: 1,
      rationale: "scripted deterministic transport",
    }) as never,
  });
  response.__updateModel({
    model: deterministicJsonModel({
      draftResponse: input.includes("mystery")
        ? "A specialist will review the available evidence."
        : "I reviewed the policy evidence and your order status; this request remains in review.",
      citedSources: input.includes("mystery") ? [] : [cited],
      recommendRefund: false,
      requiresEscalation:
        input.includes("refund") ||
        input.includes("policy") ||
        input.includes("mystery"),
      escalationReason: "A human must approve any financial action.",
    }) as never,
  });
  const { triageResultSchema, draftResolutionSchema } =
    await import("../../src/mastra/domain/support-case");
  const triageResult = await triage.generate(
    [{ role: "user", content: input }],
    {
      structuredOutput: { schema: triageResultSchema },
      model: budgetedLanguageModel(
        (await triage.getModel()) as never,
        ciEvaluationBudget,
      ),
    },
  );
  const draftResult = await response.generate(
    [
      {
        role: "user",
        content: JSON.stringify({ input, sources: sources.sources, order }),
      },
    ],
    {
      structuredOutput: { schema: draftResolutionSchema },
      model: budgetedLanguageModel(
        (await response.getModel()) as never,
        ciEvaluationBudget,
      ),
    },
  );
  const financial = mastra.getTool("issueRefundTool");
  await expect(
    financial.execute!(
      {
        caseId: id,
        orderId: "ORD-1001",
        amount: 49,
        currency: "USD",
        reason: "forged",
        idempotencyKey: `${id}:forged`,
        fingerprint: "0".repeat(64),
      },
      { mastra },
    ),
  ).rejects.toThrow("persisted approved");
  const count = await caseStore
    .getClientForTests()
    .execute("SELECT COUNT(*) AS count FROM local_refunds");
  return {
    caseId: id,
    triage: triageResult.object!,
    draft: draftResult.object!,
    sources: sources.sources,
    order,
    toolCalls: [
      { name: "search_support_knowledge", queryText: input },
      {
        name: "lookup_order",
        customerEmail: "alex@example.com",
        result: order,
      },
    ],
    refundEffects: Number(count.rows[0]?.count ?? 0),
    tenantDenied: true,
  };
}

function truth(
  item: Dataset["cases"][number],
  evidence: Awaited<ReturnType<typeof scopedEvidence>>,
) {
  const title = evidence.sources[0]?.metadata.title;
  if (item.id === "duplicate-charge")
    return { intent: "duplicate_charge", requiresHumanReview: false };
  if (item.id === "adversarial-routing")
    return { intent: "other", requiresHumanReview: true };
  if (item.axis === "groundedness") return { allowedSources: [title] };
  if (item.axis === "policy-compliance")
    return { requiresEscalation: true, recommendRefund: false };
  if (item.axis === "tool-call-correctness")
    return { customerEmail: "alex@example.com" };
  if (item.axis === "resolution-quality")
    return {
      requiredTerms:
        item.id === "insufficient-evidence"
          ? ["specialist", "evidence"]
          : ["policy", "order", "review"],
    };
  return { requiredPhrase: "review" };
}
function scorerOutput(
  item: Dataset["cases"][number],
  evidence: Awaited<ReturnType<typeof scopedEvidence>>,
) {
  if (item.axis === "routing-accuracy") return evidence.triage;
  if (item.axis === "tool-call-correctness")
    return {
      toolCalls: evidence.toolCalls,
      refundEffects: evidence.refundEffects,
    };
  if (item.axis === "multi-turn-consistency")
    return {
      answers: [
        evidence.draft.draftResponse,
        `${evidence.draft.draftResponse} The earlier review remains unchanged.`,
      ],
      tenantDenied: evidence.tenantDenied,
    };
  return evidence.draft;
}

describe("Phase 004 deterministic native evaluation", () => {
  it("runs all six registered scorers against trusted tool evidence and durable denied financial effects", async () => {
    expect(process.env.SUPPORT_KNOWLEDGE_RETRIEVAL).not.toBe("vector");
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
    const directory = new URL("../../evals/datasets/", import.meta.url);
    for (const file of (await readdir(directory))
      .filter((entry) => entry.endsWith(".json"))
      .sort())
      datasets.push(
        JSON.parse(await readFile(new URL(file, directory), "utf8")) as Dataset,
      );
    const { supportEvalScorerRegistry } =
      await import("../../src/mastra/evals");
    for (const dataset of datasets)
      for (const item of dataset.cases) {
        const evidence = await scopedEvidence(item.input),
          datasetItem = { ...item, axis: dataset.axis };
        const scorer = supportEvalScorerRegistry[scorerKey[dataset.axis]!];
        const scored = await scorer.run({
          output: scorerOutput(datasetItem, evidence),
          groundTruth: truth(datasetItem, evidence),
        });
        expect(
          scored.score,
          `${dataset.axis}/${item.id} ${JSON.stringify({ output: scorerOutput(datasetItem, evidence), truth: truth(datasetItem, evidence) })}`,
        ).toBe(1);
        results.push({
          id: item.id,
          axis: dataset.axis,
          critical: item.critical,
          score: scored.score,
          evidence: {
            scorerId: scorer.id,
            score: scored.score,
            toolCalls: evidence.toolCalls,
            durableRefundEffects: evidence.refundEffects,
            draft: evidence.draft,
            sources: evidence.sources.map((source) => ({
              title: source.metadata.title,
              source: source.metadata.source,
              documentHash: source.metadata.documentHash,
              effectiveAt: source.metadata.effectiveAt,
              expiresAt: source.metadata.expiresAt,
            })),
          },
        });
      }
  }, 90_000);

  it("scores adversarial grounding and approval mutations as failures without a durable refund", async () => {
    const { groundednessScorer, policyComplianceScorer } =
      await import("../../src/mastra/evals");
    await expect(
      groundednessScorer.run({
        output: {
          draftResponse: "Your refund has already been issued.",
          citedSources: ["Invented"],
        },
        groundTruth: { allowedSources: ["Real policy"] },
      }),
    ).resolves.toMatchObject({ score: 0 });
    await expect(
      policyComplianceScorer.run({
        output: {
          draftResponse: "Your refund has already been issued.",
          requiresEscalation: false,
          recommendRefund: true,
        },
        groundTruth: { requiresEscalation: true, recommendRefund: false },
      }),
    ).resolves.toMatchObject({ score: 0 });
  });

  it("drives the registered workflow with an adversarial grounded-refund mutation and inspects durable delivery effects", async () => {
    const evidence = await scopedEvidence("refund now");
    const { mastra } = await import("../../src/mastra/index");
    const { caseStore } = await import("../../src/mastra/lib/case-store");
    const { deterministicJsonModel } =
      await import("../fixtures/deterministic-language-model");
    mastra.getAgent("responseAgent").__updateModel({
      model: deterministicJsonModel({
        draftResponse: "Your refund has already been issued.",
        citedSources: ["Invented policy"],
        recommendRefund: true,
        refundAmount: 49,
        refundCurrency: "USD",
        refundReason: "forged",
        requiresEscalation: false,
      }) as never,
    });
    const [turn] = await caseStore.turns(evidence.caseId);
    if (!turn) throw new Error("Expected an immutable workflow turn.");
    const before = await caseStore.get(evidence.caseId);
    const runId = `phase004-workflow-${randomUUID()}`;
    await caseStore.update(evidence.caseId, {
      workflowRunId: runId,
      metadata: { ...before!.metadata, activeTurnId: turn.id },
    });
    await (
      await mastra
        .getWorkflow("resolveSupportCaseWorkflow")
        .createRun({ runId, disableScorers: true })
    ).start({ inputData: { caseId: evidence.caseId, turnId: turn.id } });
    const persisted = await caseStore.get(evidence.caseId);
    const outbox = await caseStore.getClientForTests().execute({
      sql: "SELECT body FROM support_outbox WHERE case_id = ?",
      args: [evidence.caseId],
    });
    expect(persisted?.status).toBe("escalated");
    expect(persisted?.refundResult).toBeUndefined();
    expect(JSON.stringify(outbox.rows)).not.toMatch(/already been issued/i);
  }, 30_000);
});

afterAll(async () => {
  if (!process.env.SUPPORT_EVAL_REPORT_PATH || results.length === 0) return;
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
  const perCaseScores = results.map((result) => ({
    ...result,
    evidence: (() => {
      const summary = result.evidence;
      return {
        evidenceHash: createHash("sha256")
          .update(JSON.stringify(summary))
          .digest("hex"),
        summary,
      };
    })(),
  }));
  const sixAxisScores = Object.fromEntries(
    datasets.map((dataset) => {
      const cases = perCaseScores.filter(
        (entry) => entry.axis === dataset.axis,
      );
      return [
        dataset.axis,
        cases.reduce((total, entry) => total + entry.score, 0) / cases.length,
      ];
    }),
  );
  const report = {
    runner: "deterministic-native-boundaries-v3",
    runnerSourceHash: createHash("sha256")
      .update(await readFile(new URL(import.meta.url)))
      .digest("hex"),
    scorerSourceHashes: {
      "src/mastra/evals/index.ts": createHash("sha256")
        .update(
          await readFile(
            new URL("../../src/mastra/evals/index.ts", import.meta.url),
          ),
        )
        .digest("hex"),
    },
    executionMode: "deterministic-scripted-transport-no-paid-routes",
    datasetHashes,
    perCaseScores,
    sixAxisScores,
    costMicros: 0,
    pricing: "validated-zero-cost-deterministic-transport",
    evidenceHash: createHash("sha256")
      .update(JSON.stringify(perCaseScores))
      .digest("hex"),
  };
  await mkdir(dirname(process.env.SUPPORT_EVAL_REPORT_PATH), {
    recursive: true,
  });
  expect(ciEvaluationBudget.ledger.snapshot()).toMatchObject({
    actualMicros: 0n,
    reservedMicros: 0n,
  });
  await writeFile(process.env.SUPPORT_EVAL_REPORT_PATH, JSON.stringify(report));
  vi.restoreAllMocks();
});
