import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { LanguageModelV2 } from "@ai-sdk/provider";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  budgetedLanguageModel,
  createValidationBudgetExecution,
} from "../../src/mastra/lib/eval-budget";
import {
  evaluateDatasetAssertions as evaluateAssertionSemantics,
  scorerInputFromObservation,
  truthForDatasetCase,
} from "../../src/mastra/evals/deterministic-semantics.js";
import { deterministicJsonModel } from "../fixtures/deterministic-language-model";

type DatasetCase = {
  id: string;
  critical: boolean;
  input: string;
  assertions: Record<string, unknown>;
};
type Dataset = { axis: string; cases: DatasetCase[] };
type AssertionObservation = {
  triage?: Record<string, unknown>;
  draft?: Record<string, unknown>;
  calls?: ObservedCall[];
  workflow?: Record<string, unknown>;
  authorization?: Record<string, unknown>;
  financial?: Record<string, unknown>;
  historyEstablished?: boolean;
  refundEffects?: Record<string, unknown>;
  order?: unknown;
  turns?: Array<{ turn: number; answer: string }>;
};
type ObservedCall = {
  sequence: number;
  turn: number;
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
const scorerMapping = JSON.parse(
  await readFile(
    new URL("../../evals/scorer-mapping.json", import.meta.url),
    "utf8",
  ),
) as Record<string, { registryKey: string; scorerId: string }>;
const binding = (id: string, tenantId = "local-demo") => ({
  tenantId,
  providerKind: "local" as const,
  providerAccountId: `phase004-account-${id}`,
  externalConversationId: id,
});

const expectedKnowledgeEvidence = {
  title: "Duplicate Charge Policy",
  source: "duplicate-charge-policy",
  documentHash:
    "b127b8f27f290d3adc016d41c5a9910d0b820a38a9a7ddcb90f7618ae4528e95",
};

function completeObservedCalls() {
  const search = (sequence: number, turn: number) => ({
    sequence,
    turn,
    name: "search_support_knowledge",
    input: { queryText: "duplicate charge policy", topK: 1 },
    result: { sources: [expectedKnowledgeEvidence] },
  });
  const lookup = (sequence: number, turn: number) => ({
    sequence,
    turn,
    name: "lookup_order",
    input: { customerEmail: "alex@example.com", orderId: "ORD-1001" },
    result: {
      found: true,
      order: {
        orderId: "ORD-1001",
        customerEmail: "alex@example.com",
        status: "fulfilled",
      },
    },
  });
  return [search(1, 1), lookup(2, 1), search(3, 2), lookup(4, 2)];
}

function completeObservedTurns() {
  return [
    { turn: 1, answer: "Order ORD-1001 is fulfilled." },
    { turn: 2, answer: "Order ORD-1001 remains fulfilled." },
  ];
}

function responseModel(options: {
  firstAnswer: string;
  citation: string;
  requiresEscalation?: boolean;
  recommendRefund?: boolean;
  followUpContradiction?: boolean;
}): LanguageModelV2 {
  let iteration = 0;
  return {
    specificationVersion: "v2",
    provider: "phase004-test",
    modelId: "observed-response-trajectory",
    supportedUrls: {},
    async doGenerate(request) {
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
      const receivedPrompt = JSON.stringify(request.prompt);
      const historyEstablished = receivedPrompt.includes(options.firstAnswer);
      const answer = historyEstablished
        ? options.followUpContradiction
          ? "Order ORD-1001 was cancelled."
          : "Order ORD-1001 remains fulfilled; the earlier duplicate-charge review is unchanged."
        : options.firstAnswer;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              draftResponse: answer,
              citedSources: [options.citation],
              recommendRefund: options.recommendRefund ?? false,
              requiresEscalation: options.requiresEscalation ?? false,
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
async function observedReadTrajectory(
  input: string,
  options: { includeMemory?: boolean; followUpContradiction?: boolean } = {},
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
  const { triageResultSchema, draftResolutionSchema } =
    await import("../../src/mastra/domain/support-case");
  const { id, configured } = await createCase(input);
  registerProviderRegistry(localRuntime, [configured]);
  await publishKnowledge(configured, { onlyIfMissing: true });
  await ensureProviderFixtures(configured);
  const search = mastra.getTool("searchSupportKnowledgeTool");
  const lookup = mastra.getTool("lookupOrderTool");
  const calls: ObservedCall[] = [];
  let observedTurn = 0;
  const observe = (name: string, tool: typeof search) => {
    const original = tool.execute!.bind(tool);
    return vi
      .spyOn(tool, "execute")
      .mockImplementation(async (raw, context) => {
        const result = await original(raw, context);
        calls.push({
          sequence: calls.length + 1,
          turn: observedTurn,
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
    const firstAnswer =
      "Order ORD-1001 is fulfilled; the duplicate-charge policy requires review before any refund.";
    const runTurn = async (
      message: string,
      includeMemory: boolean,
      turn: number,
    ) => {
      observedTurn = turn;
      const model = responseModel({
        firstAnswer,
        citation: "Duplicate Charge Policy",
        followUpContradiction: options.followUpContradiction,
      });
      response.__updateModel({ model: model as never });
      return withTrustedCaseReadScope(
        { caseId: id, ownerId: "customer-alex", tenantId: configured.tenantId },
        () =>
          response.generate([{ role: "user", content: message }], {
            structuredOutput: { schema: draftResolutionSchema },
            memory: includeMemory ? { thread, resource } : undefined,
            model: budgetedLanguageModel(model as never, ciEvaluationBudget),
          }),
      );
    };
    const first = await runTurn(input, true, 1);
    const second = await runTurn(
      "Please confirm the earlier order status.",
      options.includeMemory ?? true,
      2,
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
      turns: [
        { turn: 1, answer: first.object!.draftResponse },
        { turn: 2, answer: second.object!.draftResponse },
      ],
      historyEstablished:
        second.object!.draftResponse.includes("remains fulfilled"),
      calls,
      order,
      sources: sources?.sources ?? [],
    };
  } finally {
    searchSpy.mockRestore();
    lookupSpy.mockRestore();
  }
}

async function workflowGuardEvidence(evidenceKind: "invalid" | "expired") {
  return (async () => {
    const { mastra } = await import("../../src/mastra/index");
    const { caseStore } = await import("../../src/mastra/lib/case-store");
    const { publishKnowledge } =
      await import("../../src/mastra/lib/publish-knowledge");
    const { registerProviderRegistry } =
      await import("../../src/mastra/providers/registry");
    const { localRuntime } =
      await import("../../src/mastra/runtime/local-runtime");
    const { id, configured } = await createCase(
      `refund ${evidenceKind} evidence policy`,
    );
    registerProviderRegistry(localRuntime, [configured]);
    await publishKnowledge(configured, { onlyIfMissing: true });
    if (evidenceKind === "expired")
      await caseStore.getClientForTests().execute({
        sql: "UPDATE support_knowledge_documents SET expires_at = ? WHERE provider_kind = ? AND provider_account_id = ?",
        args: [
          "2000-01-01T00:00:00.000Z",
          configured.providerKind,
          configured.providerAccountId,
        ],
      });
    const [turn] = await caseStore.turns(id);
    if (!turn) throw new Error("Expected immutable workflow turn.");
    mastra.getAgent("responseAgent").__updateModel({
      model: budgetedDeterministicModel(
        deterministicJsonModel({
          draftResponse: "Your refund has already been issued.",
          citedSources: evidenceKind === "invalid" ? ["Invented policy"] : [],
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
      draft: persisted?.draft,
      order: persisted?.orderLookup,
      evidenceKind,
      policyMatchCount: persisted?.policyMatches?.length ?? 0,
    };
  })();
}

async function observedFinancialEvidence(
  scenario:
    | "approval-required"
    | "unapproved-financial-denied"
    | "tampered-approved-command-denied"
    | "approved-replay-concurrency",
) {
  return (async () => {
    const { mastra } = await import("../../src/mastra/index");
    const { caseStore } = await import("../../src/mastra/lib/case-store");
    const { localRuntime, recoverApprovedNativeDecisions } =
      await import("../../src/mastra/runtime/local-runtime");
    const { registerProviderRegistry } =
      await import("../../src/mastra/providers/registry");
    const { id, configured } = await createCase(
      "Please refund the duplicate charge.",
    );
    registerProviderRegistry(localRuntime, [configured]);
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
      if (!current)
        throw new Error("Financial workflow case was not persisted.");
      const activeTurnId = (current.metadata as Record<string, unknown>)
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
    if (!waiting)
      throw new Error("Financial workflow case disappeared before approval.");
    const native = (waiting.metadata as Record<string, unknown>)
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
    if (
      !native.runId ||
      !native.toolCallId ||
      !native.fingerprint ||
      !native.turnId
    )
      throw new Error(
        `Financial workflow native approval binding is incomplete: ${JSON.stringify(native)}`,
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
    const approvalRequired =
      Boolean(native.runId) &&
      Boolean(native.toolCallId) &&
      Boolean(native.fingerprint) &&
      Boolean(native.turnId);
    let approvalRecordedBeforeTamper = false;
    let tamperedError = "";
    let effectsBeforeRecovery = 0;
    let recoveries: number[] = [];
    if (scenario !== "unapproved-financial-denied") {
      await caseStore.recordApprovalDecision({
        caseId: id,
        turnId: native.turnId,
        commandFingerprint: native.fingerprint,
        principalId: "approver-demo",
        approved: true,
        nativeRunId: native.runId,
        nativeToolCallId: native.toolCallId,
      });
      approvalRecordedBeforeTamper = true;
      if (scenario === "tampered-approved-command-denied") {
        try {
          await localRuntime.issueRefund({
            ...(command as never),
            fingerprint: "tampered",
          });
        } catch (error) {
          tamperedError = String(error);
        }
        effectsBeforeRecovery = (
          await localRuntime.refunds(configured, "ORD-1001")
        ).length;
      }
      if (scenario !== "approval-required")
        recoveries = await Promise.all([
          recoverApprovedNativeDecisions(mastra, caseStore, {
            disableScorers: true,
          }),
          recoverApprovedNativeDecisions(mastra, caseStore, {
            disableScorers: true,
          }),
        ]);
    }
    const refunds = await localRuntime.refunds(configured, "ORD-1001");
    const durableActions = await caseStore.getClientForTests().execute({
      sql: "SELECT COUNT(*) AS count FROM support_actions WHERE case_id = ? AND kind IN ('refund-failure', 'refund-uncertain', 'refund-command')",
      args: [id],
    });
    return {
      scenario,
      approvalRequired,
      unapprovedDenied:
        /persisted approved|current durable workflow dispatch/i.test(
          unapprovedError,
        ),
      unapprovedError,
      approvalRecordedBeforeTamper,
      tamperedDenied: /fingerprint was tampered/i.test(tamperedError),
      tamperedError,
      effectsBeforeRecovery,
      approvedReplayCount: refunds.length,
      providerEffects: refunds.length,
      durableActions: Number(durableActions.rows[0]?.count ?? 0),
      originalCommandReplayIntegrity:
        refunds.length === 1 &&
        refunds[0]?.reason === command.reason &&
        refunds[0]?.orderId === command.orderId,
      concurrentRecoveries: recoveries.length,
      recoveryResults: recoveries,
    };
  })();
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

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Every dataset assertion is executable; an undeclared assertion is a test failure. */
function evaluateDatasetAssertions(
  assertions: Record<string, unknown>,
  observed: AssertionObservation,
) {
  const evaluated = evaluateAssertionSemantics(
    assertions,
    observed as Record<string, unknown>,
  );
  for (const [name, actual] of Object.entries(evaluated))
    expect(actual, `dataset assertion ${name}`).toBe(true);
  return evaluated;
}

async function caseRefundEffects(
  caseId: string,
  configured: ReturnType<typeof binding>,
) {
  const { caseStore } = await import("../../src/mastra/lib/case-store");
  const { localRuntime } =
    await import("../../src/mastra/runtime/local-runtime");
  const actions = await caseStore.getClientForTests().execute({
    sql: "SELECT COUNT(*) AS count FROM support_actions WHERE case_id = ? AND kind IN ('refund-command', 'refund-failure', 'refund-uncertain')",
    args: [caseId],
  });
  return {
    providerEffects: (await localRuntime.refunds(configured, "ORD-1001"))
      .length,
    durableActions: Number(actions.rows[0]?.count ?? 0),
  };
}

function truth(
  axis: string,
  item: DatasetCase,
  _evidence: AssertionObservation,
) {
  return truthForDatasetCase(axis, item.assertions);
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
    for (const dataset of datasets)
      for (const item of dataset.cases) {
        const read = await observedReadTrajectory(item.input);
        const observed: AssertionObservation = {
          triage: read.triage,
          draft: read.draft,
          calls: read.calls,
          order: read.order,
          historyEstablished: read.historyEstablished,
          refundEffects: await caseRefundEffects(read.caseId, read.binding),
        };
        if (
          item.id === "unsupported-policy" ||
          item.id === "workflow-guard-mutation" ||
          item.id === "evidence-required" ||
          item.id === "insufficient-evidence"
        ) {
          const evidenceKind =
            item.id === "unsupported-policy" ||
            item.id === "workflow-guard-mutation"
              ? "invalid"
              : item.id === "evidence-required"
                ? "expired"
                : "expired";
          const workflow = await workflowGuardEvidence(evidenceKind);
          observed.workflow = workflow;
          observed.draft = asRecord(workflow.draft);
          observed.order = workflow.order;
        }
        if (item.id === "cross-tenant-denied")
          observed.authorization = await foreignBindingEvidence(read);
        if (dataset.axis === "policy-compliance" && !observed.workflow)
          observed.financial = await observedFinancialEvidence(
            item.id as Parameters<typeof observedFinancialEvidence>[0],
          );
        const assertionResults = evaluateDatasetAssertions(
          item.assertions,
          observed,
        );
        const output = scorerInputFromObservation(dataset.axis, {
          ...observed,
          answers: read.answers,
          turns: read.turns,
        });
        const scorer =
          supportEvalScorerRegistry[
            scorerMapping[dataset.axis]?.registryKey ?? ""
          ];
        if (!scorer)
          throw new Error(
            `Dataset axis has no declared registered scorer: ${dataset.axis}`,
          );
        expect(scorer.id).toBe(scorerMapping[dataset.axis]?.scorerId);
        const scored = await scorer.run({
          output,
          groundTruth: truth(dataset.axis, item, observed),
        });
        expect(scored.score, `${dataset.axis}/${item.id}`).toBe(1);
        // Preserve the native boundary's exact inputs and a hash of its raw
        // result. The semantic result remains visible without duplicating each
        // full policy document in every per-case immutable reference record.
        const toolCalls =
          dataset.axis === "tool-call-correctness" ||
          dataset.axis === "multi-turn-consistency"
            ? (observed.calls ?? []).map((call) => ({
                sequence: call.sequence,
                turn: call.turn,
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
            ? { modelOutputs: { triage: observed.triage } }
            : dataset.axis === "groundedness"
              ? {
                  modelOutputs: { draft: observed.draft },
                  order: observed.order,
                  sources: read.sources.map((source) => ({
                    title: source.metadata.title,
                  })),
                  workflow: observed.workflow,
                }
              : dataset.axis === "tool-call-correctness"
                ? {
                    order: observed.order,
                    refundEffects: observed.refundEffects,
                  }
                : dataset.axis === "multi-turn-consistency"
                  ? {
                      modelOutputs: {
                        answers: read.answers,
                        turns: read.turns,
                      },
                      order: observed.order,
                      toolCalls,
                      historyEstablished: observed.historyEstablished,
                      authorization: observed.authorization,
                    }
                  : dataset.axis === "policy-compliance"
                    ? {
                        modelOutputs: { draft: observed.draft },
                        financial: observed.financial,
                        workflow: observed.workflow,
                      }
                    : {
                        modelOutputs: { draft: observed.draft },
                        order: observed.order,
                        workflow: observed.workflow,
                      };
        results.push({
          id: item.id,
          axis: dataset.axis,
          critical: item.critical,
          score: scored.score,
          evidence: {
            schemaVersion: 1,
            caseId: read.caseId,
            scorerId: scorer.id,
            score: scored.score,
            assertions: assertionResults,
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
    const toolTruth = truthForDatasetCase("tool-call-correctness", {});
    const multiTurnTruth = truthForDatasetCase("multi-turn-consistency", {
      sameThread: true,
    });
    const scoreTool = (calls: ReturnType<typeof completeObservedCalls>) =>
      supportEvalScorerRegistry.toolCallCorrectness.run({
        output: {
          toolCalls: calls,
          refundEffects: { providerEffects: 0, durableActions: 0 },
        },
        groundTruth: toolTruth,
      });
    const scoreTurns = (turns: ReturnType<typeof completeObservedTurns>) =>
      supportEvalScorerRegistry.multiTurnConsistency.run({
        output: {
          turns,
          toolCalls: completeObservedCalls(),
          historyEstablished: true,
        },
        groundTruth: multiTurnTruth,
      });
    await expect(scoreTool(completeObservedCalls())).resolves.toMatchObject({
      score: 1,
    });
    await expect(scoreTurns(completeObservedTurns())).resolves.toMatchObject({
      score: 1,
    });
    const rejectedToolMutations = [
      (calls: ReturnType<typeof completeObservedCalls>) => {
        calls[2].input.queryText = "foreign policy";
      },
      (calls: ReturnType<typeof completeObservedCalls>) => {
        (
          calls[2].result as { sources: Array<{ documentHash: string }> }
        ).sources[0].documentHash = "0".repeat(64);
      },
      (calls: ReturnType<typeof completeObservedCalls>) => {
        calls[3].input.customerEmail = "mallory@example.com";
      },
      (calls: ReturnType<typeof completeObservedCalls>) => {
        calls[3].input.orderId = "ORD-9999";
      },
      (calls: ReturnType<typeof completeObservedCalls>) => {
        (
          calls[3].result as { order: { customerEmail: string } }
        ).order.customerEmail = "mallory@example.com";
      },
      (calls: ReturnType<typeof completeObservedCalls>) => {
        (calls[3].result as { order: { status: string } }).order.status =
          "cancelled";
      },
      (calls: ReturnType<typeof completeObservedCalls>) => {
        calls[2].result = { sources: [{}] } as never;
      },
      (calls: ReturnType<typeof completeObservedCalls>) => {
        delete (calls[3] as { result?: unknown }).result;
      },
      (calls: ReturnType<typeof completeObservedCalls>) => {
        calls.pop();
      },
      (calls: ReturnType<typeof completeObservedCalls>) => {
        calls.push(structuredClone(calls[0]));
      },
      (calls: ReturnType<typeof completeObservedCalls>) => {
        calls[2] = structuredClone(calls[0]);
      },
    ];
    for (const mutate of rejectedToolMutations) {
      const calls = completeObservedCalls();
      mutate(calls);
      await expect(scoreTool(calls)).resolves.toMatchObject({ score: 0 });
    }
    for (const contradiction of [
      "Order ORD-1001 is fulfilled, but it was cancelled.",
      "Order ORD-1001 is fulfilled, but it is unfulfilled.",
      "Order ORD-1001 is fulfilled, but it is not fulfilled.",
      "Order ORD-1001 is fulfilled, but it is no longer fulfilled.",
      "Order ORD-1001 is fulfilled, but not fulfilled.",
    ]) {
      const turns = completeObservedTurns();
      turns[1].answer = contradiction;
      await expect(scoreTurns(turns)).resolves.toMatchObject({ score: 0 });
    }
    for (const mutate of [
      (turns: ReturnType<typeof completeObservedTurns>) => {
        turns.pop();
      },
      (turns: ReturnType<typeof completeObservedTurns>) => {
        turns[1].turn = 1;
      },
      (turns: ReturnType<typeof completeObservedTurns>) => {
        turns.push(structuredClone(turns[0]));
      },
    ]) {
      const turns = completeObservedTurns();
      mutate(turns);
      await expect(scoreTurns(turns)).resolves.toMatchObject({ score: 0 });
    }
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
        groundTruth: { singleDurableRefund: true },
      }),
    ).resolves.toMatchObject({ score: 0 });
    const inconsistentTurns = completeObservedTurns();
    inconsistentTurns[1].answer =
      "Order ORD-1001 is fulfilled, but it was cancelled.";
    await expect(
      supportEvalScorerRegistry.multiTurnConsistency.run({
        output: {
          turns: inconsistentTurns,
          toolCalls: completeObservedCalls(),
          authorization: {
            foreignBindingDenied: true,
            twoRegisteredBindings: true,
          },
        },
        groundTruth: { orderId: "ORD-1001", orderStatus: "fulfilled" },
      }),
    ).resolves.toMatchObject({ score: 0 });
  });

  it("fails multi-turn scoring when native received history is absent or contradicted", async () => {
    const { supportEvalScorerRegistry } =
      await import("../../src/mastra/evals");
    const absent = await observedReadTrajectory("same conversation follow-up", {
      includeMemory: false,
    });
    const contradictory = await observedReadTrajectory(
      "same conversation follow-up",
      {
        followUpContradiction: true,
      },
    );
    const truth = {
      orderId: "ORD-1001",
      orderStatus: "fulfilled",
      historyEstablished: true,
    };
    await expect(
      supportEvalScorerRegistry.multiTurnConsistency.run({
        output: {
          turns: absent.turns,
          toolCalls: absent.calls,
          historyEstablished: absent.historyEstablished,
          authorization: {
            foreignBindingDenied: true,
            twoRegisteredBindings: true,
          },
        },
        groundTruth: truth,
      }),
    ).resolves.toMatchObject({ score: 0 });
    await expect(
      supportEvalScorerRegistry.multiTurnConsistency.run({
        output: {
          turns: contradictory.turns,
          toolCalls: contradictory.calls,
          historyEstablished: contradictory.historyEstablished,
          authorization: {
            foreignBindingDenied: true,
            twoRegisteredBindings: true,
          },
        },
        groundTruth: truth,
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
      "src/mastra/evals/deterministic-semantics.js": createHash("sha256")
        .update(
          await readFile(
            new URL(
              "../../src/mastra/evals/deterministic-semantics.js",
              import.meta.url,
            ),
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
