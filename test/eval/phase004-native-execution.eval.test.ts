import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { LanguageModelV2 } from "@ai-sdk/provider";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  budgetedLanguageModel,
  createValidationBudgetExecution,
} from "../../src/mastra/lib/eval-budget";
import { deterministicJsonModel } from "../fixtures/deterministic-language-model";

type DatasetCase = {
  id: string;
  critical: boolean;
  input: string;
  assertions: Record<string, unknown>;
};
type Dataset = { axis: string; cases: DatasetCase[] };
type ObservedCall = {
  sequence: number;
  name: string;
  input: Record<string, unknown>;
  result: unknown;
};
type Result = {
  id: string;
  axis: string;
  critical: boolean;
  score: number;
  evidence: Record<string, unknown>;
};
const results: Result[] = [];
const datasets: Dataset[] = [];
const ciEvaluationBudget = createValidationBudgetExecution("ci-eval");
const budgetedDeterministicModel = (model: LanguageModelV2) =>
  budgetedLanguageModel(model, ciEvaluationBudget);
const scorerKey: Record<string, string> = {
  groundedness: "groundedness",
  "policy-compliance": "policyCompliance",
  "routing-accuracy": "routingAccuracy",
  "tool-call-correctness": "toolCallCorrectness",
  "multi-turn-consistency": "multiTurnConsistency",
  "resolution-quality": "resolutionQuality",
};
const binding = (id: string, tenantId = "local-demo") => ({
  tenantId,
  providerKind: "local" as const,
  providerAccountId: tenantId === "local-demo" ? "local-demo" : `account-${id}`,
  externalConversationId: id,
});

function responseModel(answer: string, citation: string): LanguageModelV2 {
  let iteration = 0;
  return {
    specificationVersion: "v2",
    provider: "phase004-test",
    modelId: "observed-response-trajectory",
    supportedUrls: {},
    async doGenerate() {
      iteration += 1;
      if (iteration === 1)
        return {
          content: [
            {
              type: "tool-call" as const,
              toolCallId: "observed-search",
              toolName: "search_support_knowledge",
              input: JSON.stringify({
                queryText: "duplicate charge policy",
                topK: 1,
              }),
            },
          ],
          finishReason: "tool-calls" as const,
          usage: { inputTokens: 1, outputTokens: 1 },
          warnings: [],
        };
      if (iteration === 2)
        return {
          content: [
            {
              type: "tool-call" as const,
              toolCallId: "observed-order",
              toolName: "lookup_order",
              input: JSON.stringify({
                customerEmail: "alex@example.com",
                orderId: "ORD-1001",
              }),
            },
          ],
          finishReason: "tool-calls" as const,
          usage: { inputTokens: 1, outputTokens: 1 },
          warnings: [],
        };
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              draftResponse: answer,
              citedSources: [citation],
              recommendRefund: false,
              requiresEscalation: false,
            }),
          },
        ],
        finishReason: "stop" as const,
        usage: { inputTokens: 1, outputTokens: 1 },
        warnings: [],
      };
    },
    async doStream() {
      throw new Error("The deterministic evaluator only supports generate.");
    },
  };
}

async function createCase(input: string) {
  const { caseStore } = await import("../../src/mastra/lib/case-store");
  const id = `phase004-eval-${randomUUID()}`;
  const configured = binding(id);
  const now = new Date().toISOString();
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
  return { id, configured };
}

/** Runs registered agents/tools. Calls are captured by wrapping their actual execution boundary. */
async function observedReadTrajectory(input: string) {
  const { mastra } = await import("../../src/mastra/index");
  const { publishKnowledge } =
    await import("../../src/mastra/lib/publish-knowledge");
  const { ensureProviderFixtures } =
    await import("../../src/mastra/providers/registry");
  const { withTrustedCaseReadScope } =
    await import("../../src/mastra/lib/trusted-run-scope");
  const { triageResultSchema, draftResolutionSchema } =
    await import("../../src/mastra/domain/support-case");
  const { id, configured } = await createCase(input);
  await publishKnowledge(configured, { onlyIfMissing: true });
  await ensureProviderFixtures(configured);
  const search = mastra.getTool("searchSupportKnowledgeTool");
  const lookup = mastra.getTool("lookupOrderTool");
  const calls: ObservedCall[] = [];
  const observe = (name: string, tool: typeof search) => {
    const original = tool.execute!.bind(tool);
    return vi
      .spyOn(tool, "execute")
      .mockImplementation(async (raw, context) => {
        const result = await original(raw, context);
        calls.push({
          sequence: calls.length + 1,
          name,
          input: raw as Record<string, unknown>,
          result,
        });
        return result;
      });
  };
  const searchSpy = observe("search_support_knowledge", search);
  const lookupSpy = observe("lookup_order", lookup as typeof search);
  try {
    const triage = mastra.getAgent("triageAgent");
    triage.__updateModel({
      model: deterministicJsonModel({
        intent: input.includes("charged") ? "duplicate_charge" : "other",
        urgency: "normal",
        sentiment: "neutral",
        requiresHumanReview:
          input.includes("ignore") || input.includes("refund"),
        confidence: 1,
        rationale: "Observed deterministic classification.",
      }) as never,
    });
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
    const response = mastra.getAgent("responseAgent");
    const thread = `phase004-eval-thread-${id}`;
    const resource = "local-demo:customer-alex";
    const runTurn = async (message: string, answer: string) => {
      const model = responseModel(answer, "Duplicate Charge Policy");
      response.__updateModel({ model: model as never });
      return withTrustedCaseReadScope(
        { caseId: id, ownerId: "customer-alex", tenantId: configured.tenantId },
        () =>
          response.generate([{ role: "user", content: message }], {
            structuredOutput: { schema: draftResolutionSchema },
            memory: { thread, resource },
            model: budgetedLanguageModel(model as never, ciEvaluationBudget),
          }),
      );
    };
    const first = await runTurn(
      input,
      "Order ORD-1001 is fulfilled; the duplicate-charge policy requires review before any refund.",
    );
    const second = await runTurn(
      "Please confirm the earlier order status.",
      "Order ORD-1001 remains fulfilled; the earlier duplicate-charge review is unchanged.",
    );
    const order = calls.find((call) => call.name === "lookup_order")?.result;
    const sources = calls.find(
      (call) => call.name === "search_support_knowledge",
    )?.result as { sources?: Array<{ metadata: { title: string } }> };
    return {
      caseId: id,
      binding: configured,
      triage: triageResult.object!,
      draft: first.object!,
      answers: [first.object!.draftResponse, second.object!.draftResponse],
      calls,
      order,
      sources: sources?.sources ?? [],
    };
  } finally {
    searchSpy.mockRestore();
    lookupSpy.mockRestore();
  }
}

let workflowGuardPromise:
  | Promise<{ guarded: boolean; status?: string; outboxBody: string }>
  | undefined;
async function workflowGuardEvidence() {
  workflowGuardPromise ??= (async () => {
    const { mastra } = await import("../../src/mastra/index");
    const { caseStore } = await import("../../src/mastra/lib/case-store");
    const { id } = await createCase("refund now with invented policy");
    const [turn] = await caseStore.turns(id);
    if (!turn) throw new Error("Expected immutable workflow turn.");
    mastra.getAgent("responseAgent").__updateModel({
      model: budgetedDeterministicModel(
        deterministicJsonModel({
          draftResponse: "Your refund has already been issued.",
          citedSources: ["Invented policy"],
          recommendRefund: true,
          refundAmount: 49,
          refundCurrency: "USD",
          refundReason: "forged",
          requiresEscalation: false,
        }),
      ) as never,
    });
    await caseStore.update(id, {
      workflowRunId: `phase004-workflow-${id}`,
      metadata: {
        ...((await caseStore.get(id))!.metadata as Record<string, unknown>),
        activeTurnId: turn.id,
      },
    });
    await (
      await mastra
        .getWorkflow("resolveSupportCaseWorkflow")
        .createRun({ runId: `phase004-workflow-${id}`, disableScorers: true })
    ).start({ inputData: { caseId: id, turnId: turn.id } });
    const persisted = await caseStore.get(id);
    const outbox = await caseStore.getClientForTests().execute({
      sql: "SELECT body FROM support_outbox WHERE case_id = ?",
      args: [id],
    });
    const outboxBody = JSON.stringify(outbox.rows);
    return {
      guarded:
        persisted?.status === "escalated" &&
        !/already been issued/i.test(outboxBody),
      status: persisted?.status,
      outboxBody,
    };
  })();
  return workflowGuardPromise;
}

let financialPromise: Promise<Record<string, unknown>> | undefined;
async function observedFinancialEvidence() {
  financialPromise ??= (async () => {
    const { mastra } = await import("../../src/mastra/index");
    const { caseStore } = await import("../../src/mastra/lib/case-store");
    const { localRuntime, recoverApprovedNativeDecisions } =
      await import("../../src/mastra/runtime/local-runtime");
    const { id, configured } = await createCase(
      "Please refund the duplicate charge.",
    );
    await localRuntime.seed(configured);
    mastra.getAgent("triageAgent").__updateModel({
      model: budgetedDeterministicModel(
        deterministicJsonModel({
          intent: "refund_request",
          urgency: "normal",
          sentiment: "neutral",
          requiresHumanReview: false,
          confidence: 1,
          rationale: "Observed refund request.",
        }),
      ) as never,
    });
    mastra.getAgent("responseAgent").__updateModel({
      model: budgetedDeterministicModel(
        deterministicJsonModel({
          draftResponse: "The duplicate charge can be reviewed for a refund.",
          citedSources: ["duplicate-charge-policy"],
          recommendRefund: true,
          refundAmount: 49,
          refundCurrency: "USD",
          refundReason: "duplicate charge",
          requiresEscalation: false,
        }),
      ) as never,
    });
    let command: Record<string, unknown> = {};
    const approvedRefundModel = async () => {
      const current = await caseStore.get(id);
      const activeTurnId = (current?.metadata as Record<string, unknown>)
        .activeTurnId;
      const action = await caseStore.getClientForTests().execute({
        sql: "SELECT action.data FROM support_actions AS action JOIN support_turns AS turn ON turn.case_id = action.case_id AND turn.command_fingerprint = action.fingerprint WHERE action.case_id = ? AND action.kind = 'refund-command' AND turn.id = ? LIMIT 1",
        args: [id, activeTurnId],
      });
      command = JSON.parse(String(action.rows[0]?.data ?? "{}")) as Record<
        string,
        unknown
      >;
      const toolInput = {
        caseId: command.approvalCaseId,
        orderId: command.orderId,
        amount: 49,
        currency: "USD",
        reason: command.reason,
        idempotencyKey: command.idempotencyKey,
        fingerprint: command.fingerprint,
      };
      return budgetedDeterministicModel({
        specificationVersion: "v2",
        provider: "phase004-test",
        modelId: "approved-native-refund",
        supportedUrls: {},
        async doGenerate(options) {
          if (options.tools?.some((tool) => tool.type === "function"))
            return {
              content: [
                {
                  type: "tool-call" as const,
                  toolCallId: "phase004-approved-refund",
                  toolName: "issue_refund",
                  input: JSON.stringify(toolInput),
                },
              ],
              finishReason: "tool-calls" as const,
              usage: { inputTokens: 1, outputTokens: 1 },
              warnings: [],
            };
          return {
            content: [{ type: "text" as const, text: "completed" }],
            finishReason: "stop" as const,
            usage: { inputTokens: 1, outputTokens: 1 },
            warnings: [],
          };
        },
        async doStream() {
          throw new Error(
            "The deterministic evaluator only supports generate.",
          );
        },
      } as LanguageModelV2);
    };
    mastra.getAgent("refundExecutionAgent").__updateModel({
      model: approvedRefundModel,
    });
    const workflowRunId = `${id}-run`;
    const dispatch = await caseStore.claimDispatchForStart(id, workflowRunId);
    if (!dispatch) throw new Error("Expected financial workflow dispatch.");
    await caseStore.markDispatchStarted(dispatch.id, dispatch.leaseToken);
    await caseStore.update(id, {
      workflowRunId,
      metadata: {
        ...((await caseStore.get(id))!.metadata as Record<string, unknown>),
        activeTurnId: dispatch.turnId,
      },
    });
    const started = await (
      await mastra
        .getWorkflow("resolveSupportCaseWorkflow")
        .createRun({ runId: workflowRunId, disableScorers: true })
    ).start({ inputData: { caseId: id, turnId: dispatch.turnId } });
    await caseStore.completeDispatch(
      dispatch.id,
      started.status === "suspended" ? "suspended" : "completed",
      undefined,
      dispatch.leaseToken,
    );
    const waiting = await caseStore.get(id);
    const native = (waiting?.metadata as Record<string, unknown>)
      .nativeApproval as {
      runId: string;
      toolCallId: string;
      fingerprint: string;
      turnId: string;
    };
    if (!native)
      throw new Error(
        `Financial workflow did not suspend: ${JSON.stringify({ status: waiting?.status, draft: waiting?.draft, started })}`,
      );
    command = (await caseStore.getAction(
      id,
      "refund-command",
      native.fingerprint,
    )) as Record<string, unknown>;
    const input = {
      caseId: id,
      orderId: command.orderId,
      amount: 49,
      currency: "USD",
      reason: command.reason,
      idempotencyKey: command.idempotencyKey,
      fingerprint: command.fingerprint,
    };
    let unapprovedError = "";
    try {
      await mastra.getTool("issueRefundTool").execute!(input, { mastra });
    } catch (error) {
      unapprovedError = String(error);
    }
    let tamperedError = "";
    try {
      await localRuntime.issueRefund({
        ...(command as never),
        fingerprint: "tampered",
      });
    } catch (error) {
      tamperedError = String(error);
    }
    await caseStore.recordApprovalDecision({
      caseId: id,
      turnId: native.turnId,
      commandFingerprint: native.fingerprint,
      principalId: "approver-demo",
      approved: true,
      nativeRunId: native.runId,
      nativeToolCallId: native.toolCallId,
    });
    const recoveries = await Promise.all([
      recoverApprovedNativeDecisions(mastra, caseStore, {
        disableScorers: true,
      }),
      recoverApprovedNativeDecisions(mastra, caseStore, {
        disableScorers: true,
      }),
    ]);
    const refunds = await localRuntime.refunds(configured, "ORD-1001");
    return {
      unapprovedDenied:
        /persisted approved|current durable workflow dispatch/i.test(
          unapprovedError,
        ),
      unapprovedError,
      tamperedDenied: /fingerprint was tampered/i.test(tamperedError),
      tamperedError,
      approvedReplayCount: refunds.length,
      concurrentRecoveries: recoveries.length,
      recoveryResults: recoveries,
    };
  })();
  return financialPromise;
}

async function foreignBindingEvidence(
  trajectory: Awaited<ReturnType<typeof observedReadTrajectory>>,
) {
  const { mastra } = await import("../../src/mastra/index");
  const { publishKnowledge } =
    await import("../../src/mastra/lib/publish-knowledge");
  const { ensureProviderFixtures } =
    await import("../../src/mastra/providers/registry");
  const { registerProviderRegistry } =
    await import("../../src/mastra/providers/registry");
  const { localRuntime } =
    await import("../../src/mastra/runtime/local-runtime");
  const { withTrustedCaseReadScope } =
    await import("../../src/mastra/lib/trusted-run-scope");
  const foreign = binding(`foreign-${randomUUID()}`, "other-tenant");
  registerProviderRegistry(localRuntime, [foreign]);
  await ensureProviderFixtures(foreign);
  await publishKnowledge(foreign, { onlyIfMissing: true });
  let error = "";
  try {
    await withTrustedCaseReadScope(
      {
        caseId: trajectory.caseId,
        ownerId: "customer-alex",
        tenantId: "local-demo",
      },
      () =>
        mastra.getTool("searchSupportKnowledgeTool").execute!(
          { queryText: "duplicate charge policy", topK: 1, binding: foreign },
          { mastra },
        ),
    );
  } catch (value) {
    error = String(value);
  }
  return {
    foreignBindingDenied:
      /does not match the durable case|does not match the trusted case/i.test(
        error,
      ),
    error,
    twoRegisteredBindings: true,
  };
}

function truth(
  axis: string,
  item: DatasetCase,
  evidence: Awaited<ReturnType<typeof observedReadTrajectory>>,
) {
  const order = (
    evidence.order as { order?: { orderId?: string; status?: string } }
  )?.order;
  const base = { orderId: order?.orderId, orderStatus: order?.status };
  if (axis === "routing-accuracy")
    return {
      ...base,
      intent: item.id === "duplicate-charge" ? "duplicate_charge" : "other",
      requiresHumanReview: item.id === "adversarial-routing",
    };
  if (axis === "groundedness")
    return {
      ...base,
      allowedSources: evidence.sources.map((source) => source.metadata.title),
    };
  if (axis === "tool-call-correctness")
    return {
      ...base,
      expectedCallOrder: [
        "search_support_knowledge",
        "lookup_order",
        "search_support_knowledge",
        "lookup_order",
      ],
      queryText: "duplicate charge policy",
      customerEmail: "alex@example.com",
    };
  if (axis === "policy-compliance")
    return { ...base, requiresEscalation: false, recommendRefund: false };
  return base;
}
function scorerOutput(
  axis: string,
  evidence: Awaited<ReturnType<typeof observedReadTrajectory>>,
  authorization: Record<string, unknown>,
  financial: Record<string, unknown>,
  workflow: Record<string, unknown>,
) {
  if (axis === "routing-accuracy") return evidence.triage;
  if (axis === "groundedness")
    return { ...evidence.draft, order: evidence.order };
  if (axis === "tool-call-correctness")
    return { toolCalls: evidence.calls, refundEffects: 0, workflow };
  if (axis === "multi-turn-consistency")
    return { answers: evidence.answers, authorization };
  if (axis === "policy-compliance") return { ...evidence.draft, financial };
  return { ...evidence.draft, order: evidence.order };
}

describe("Phase 004 deterministic native evaluation", () => {
  it("records six registered scorer measurements from native tools, two turns, workflow guards, and financial recovery", async () => {
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
    const financial = await observedFinancialEvidence();
    const workflow = await workflowGuardEvidence();
    expect(financial).toMatchObject({
      unapprovedDenied: true,
      tamperedDenied: true,
      approvedReplayCount: 1,
      concurrentRecoveries: 2,
    });
    expect(workflow.guarded).toBe(true);
    for (const dataset of datasets)
      for (const item of dataset.cases) {
        const evidence = await observedReadTrajectory(item.input);
        const authorization = await foreignBindingEvidence(evidence);
        expect(authorization.foreignBindingDenied).toBe(true);
        const output = scorerOutput(
          dataset.axis,
          evidence,
          authorization,
          financial,
          workflow,
        );
        const scorer = supportEvalScorerRegistry[scorerKey[dataset.axis]!];
        const scored = await scorer.run({
          output,
          groundTruth: truth(dataset.axis, item, evidence),
        });
        expect(scored.score, `${dataset.axis}/${item.id}`).toBe(1);
        // Preserve the native boundary's exact inputs and a hash of its raw
        // result. The semantic result remains visible without duplicating each
        // full policy document in every per-case immutable reference record.
        const toolCalls =
          dataset.axis === "tool-call-correctness"
            ? evidence.calls.map((call) => ({
                sequence: call.sequence,
                name: call.name,
                input: call.input,
                result:
                  call.name === "lookup_order"
                    ? call.result
                    : {
                        sources: (
                          call.result as {
                            sources?: Array<{
                              metadata: {
                                title: string;
                                source: string;
                                documentHash: string;
                              };
                            }>;
                          }
                        ).sources?.map((source) => ({
                          title: source.metadata.title,
                          source: source.metadata.source,
                          documentHash: source.metadata.documentHash,
                        })),
                      },
                rawResultHash: createHash("sha256")
                  .update(JSON.stringify(call.result))
                  .digest("hex"),
              }))
            : [];
        const axisEvidence =
          dataset.axis === "routing-accuracy"
            ? { modelOutputs: { triage: evidence.triage } }
            : dataset.axis === "groundedness"
              ? {
                  modelOutputs: { draft: evidence.draft },
                  order: evidence.order,
                  sources: evidence.sources.map((source) => ({
                    title: source.metadata.title,
                  })),
                }
              : dataset.axis === "tool-call-correctness"
                ? { order: evidence.order, workflow }
                : dataset.axis === "multi-turn-consistency"
                  ? {
                      modelOutputs: { answers: evidence.answers },
                      order: evidence.order,
                      authorization,
                    }
                  : dataset.axis === "policy-compliance"
                    ? { financial }
                    : {
                        modelOutputs: { draft: evidence.draft },
                        order: evidence.order,
                      };
        results.push({
          id: item.id,
          axis: dataset.axis,
          critical: item.critical,
          score: scored.score,
          evidence: {
            schemaVersion: 1,
            caseId: evidence.caseId,
            scorerId: scorer.id,
            score: scored.score,
            modelOutputs: {},
            toolCalls,
            ...axisEvidence,
          },
        });
      }
  }, 180_000);

  it("makes registered scorers reject mutated observed arguments, results, and answers", async () => {
    const { supportEvalScorerRegistry } =
      await import("../../src/mastra/evals");
    await expect(
      supportEvalScorerRegistry.toolCallCorrectness.run({
        output: {
          toolCalls: [
            {
              name: "lookup_order",
              input: { customerEmail: "mallory@example.com" },
              result: {
                found: true,
                order: { orderId: "ORD-1001", status: "fulfilled" },
              },
            },
          ],
          refundEffects: 0,
          workflow: { guarded: true },
        },
        groundTruth: {
          expectedCallOrder: ["search_support_knowledge", "lookup_order"],
          queryText: "duplicate charge policy",
          customerEmail: "alex@example.com",
          orderId: "ORD-1001",
          orderStatus: "fulfilled",
        },
      }),
    ).resolves.toMatchObject({ score: 0 });
    await expect(
      supportEvalScorerRegistry.policyCompliance.run({
        output: {
          requiresEscalation: false,
          recommendRefund: false,
          financial: {
            unapprovedDenied: true,
            tamperedDenied: true,
            approvedReplayCount: 2,
          },
        },
        groundTruth: { requiresEscalation: false, recommendRefund: false },
      }),
    ).resolves.toMatchObject({ score: 0 });
    await expect(
      supportEvalScorerRegistry.multiTurnConsistency.run({
        output: {
          answers: [
            "Order ORD-1001 is fulfilled",
            "Order ORD-1001 was cancelled",
          ],
          authorization: {
            foreignBindingDenied: true,
            twoRegisteredBindings: true,
          },
        },
        groundTruth: { orderId: "ORD-1001", orderStatus: "fulfilled" },
      }),
    ).resolves.toMatchObject({ score: 0 });
  });
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
    evidence: {
      evidenceHash: createHash("sha256")
        .update(JSON.stringify(result.evidence))
        .digest("hex"),
      summary: result.evidence,
    },
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
    runner: "deterministic-native-observed-runtime-v4",
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
    pricing: "not-applicable-deterministic-transport",
    evidenceHash: createHash("sha256")
      .update(JSON.stringify(perCaseScores))
      .digest("hex"),
  };
  expect(ciEvaluationBudget.ledger.snapshot()).toMatchObject({
    actualMicros: 0n,
    reservedMicros: 0n,
  });
  await mkdir(dirname(process.env.SUPPORT_EVAL_REPORT_PATH), {
    recursive: true,
  });
  await writeFile(process.env.SUPPORT_EVAL_REPORT_PATH, JSON.stringify(report));
  vi.restoreAllMocks();
});
