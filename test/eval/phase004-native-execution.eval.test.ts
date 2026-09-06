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
};
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
    const firstAnswer =
      "Order ORD-1001 is fulfilled; the duplicate-charge policy requires review before any refund.";
    const runTurn = async (message: string, includeMemory: boolean) => {
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
    const first = await runTurn(input, true);
    const second = await runTurn(
      "Please confirm the earlier order status.",
      options.includeMemory ?? true,
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
  const draft = asRecord(observed.draft);
  const financial = asRecord(observed.financial);
  const authorization = asRecord(observed.authorization);
  const workflow = asRecord(observed.workflow);
  const triage = asRecord(observed.triage);
  const calls = observed.calls ?? [];
  const refundEffects = asRecord(observed.refundEffects);
  const evaluated: Record<string, boolean> = {};
  for (const [name, expected] of Object.entries(assertions)) {
    let actual: boolean;
    switch (name) {
      case "requiresCitation":
        actual =
          expected === true &&
          Array.isArray(draft.citedSources) &&
          draft.citedSources.length > 0;
        break;
      case "requiresEscalation":
        actual =
          expected === true &&
          draft.requiresEscalation === true &&
          draft.recommendRefund === false &&
          workflow.guarded === true;
        break;
      case "unsupportedFinancialDraftEscalates":
        actual =
          expected === true &&
          workflow.guarded === true &&
          workflow.status === "escalated";
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
          String(draft.draftResponse ?? "").includes("ORD-1001") &&
          String(draft.draftResponse ?? "")
            .toLowerCase()
            .includes("fulfilled");
        break;
      default:
        throw new Error(`Unhandled declared dataset assertion: ${name}`);
    }
    evaluated[name] = actual;
    if (!actual)
      throw new Error(
        `Dataset assertion ${name} failed with ${JSON.stringify({ expected, draft, financial, authorization, workflow, refundEffects })}`,
      );
    expect(actual, `dataset assertion ${name}`).toBe(true);
  }
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
  evidence: AssertionObservation,
) {
  const order = asRecord(evidence.order).order as
    { orderId?: string; status?: string } | undefined;
  const base = { orderId: order?.orderId, orderStatus: order?.status };
  if (axis === "routing-accuracy")
    return {
      ...base,
      ...item.assertions,
      intent: item.assertions.intent ?? "other",
      requiresHumanReview: item.assertions.requiresHumanReview ?? false,
    };
  if (axis === "groundedness")
    return {
      ...base,
      ...item.assertions,
      allowedSources: ["Duplicate Charge Policy"],
    };
  if (axis === "tool-call-correctness")
    return {
      ...base,
      ...item.assertions,
      expectedCallOrder: [
        "search_support_knowledge",
        "lookup_order",
        "search_support_knowledge",
        "lookup_order",
      ],
      queryText: "duplicate charge policy",
      customerEmail: "alex@example.com",
    };
  if (axis === "policy-compliance") return { ...base, ...item.assertions };
  if (axis === "multi-turn-consistency")
    return { ...base, ...item.assertions, historyEstablished: true };
  return { ...base, ...item.assertions };
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
        const output =
          dataset.axis === "routing-accuracy"
            ? observed.triage
            : dataset.axis === "groundedness"
              ? {
                  ...observed.draft,
                  order: observed.order,
                  workflow: observed.workflow,
                }
              : dataset.axis === "tool-call-correctness"
                ? {
                    toolCalls: observed.calls,
                    refundEffects: observed.refundEffects,
                  }
                : dataset.axis === "multi-turn-consistency"
                  ? {
                      answers: read.answers,
                      historyEstablished: observed.historyEstablished,
                      authorization: observed.authorization,
                    }
                  : dataset.axis === "policy-compliance"
                    ? { ...observed.draft, financial: observed.financial }
                    : { ...observed.draft, order: observed.order };
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
          dataset.axis === "tool-call-correctness"
            ? (observed.calls ?? []).map((call) => ({
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
                      modelOutputs: { answers: read.answers },
                      order: observed.order,
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
          answers: absent.answers,
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
          answers: contradictory.answers,
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
