import { createStep } from "@mastra/core/workflows";
import { z } from "zod";
import { type SupportCase } from "../domain/support-case";
import { persistedRefundCommandSchema } from "../domain/refund-command";
import { STANDARD_REFUND_REVIEW_LIMIT } from "../domain/refund-review-limit";
import { caseStore } from "../lib/case-store";
import { legacyAmountToMoney, refundFingerprint } from "../lib/money";
import { traceOperationalPort } from "../lib/operational-spans";
import {
  ensureProviderFixtures,
  providerRegistry,
  resolveConfiguredBinding,
} from "../providers/registry";
import { bindingsForPersistedCase } from "../runtime/local-runtime";
import { refundExecutionInputSchema } from "../tools/issue-refund";
import {
  getActiveCaseOrThrow,
  resolveSupportCaseInputSchema,
} from "./resolve-support-case-context";

/** Serialize only the authoritative identities already selected by the
 * grounded draft. This durable action is later read by the provider write
 * transaction; it intentionally does not consult a newer case draft. */
function parsedDraftEvidence(supportCase: SupportCase, citations: string[]) {
  return citations.map((citation) => {
    const match = (supportCase.policyMatches ?? []).find(
      (entry) => entry.title === citation || entry.source === citation,
    );
    if (
      !match?.source ||
      !match.title ||
      !match.documentHash ||
      !match.generationId ||
      !match.version ||
      !match.effectiveAt ||
      !match.indexedAt ||
      !match.providerKind ||
      !match.providerAccountId
    )
      throw new Error(
        "Refund approval requires complete authoritative policy evidence.",
      );
    return {
      title: match.title,
      source: match.source,
      documentHash: match.documentHash,
      generationId: match.generationId,
      version: match.version,
      effectiveAt: match.effectiveAt,
      indexedAt: match.indexedAt,
      expiresAt: match.expiresAt,
      providerKind: match.providerKind,
      providerAccountId: match.providerAccountId,
    };
  });
}

const approvalOutputSchema = z.object({
  caseId: z.string(),
  turnId: z.string(),
  approved: z.boolean(),
  approverId: z.string().optional(),
  note: z.string().optional(),
});

/** A running snapshot can be restarted after the API accepted a decision but
 * before Mastra persisted the downstream step. The restarted checkpoint has
 * no resumeData, so recover only an already durable decision. Approval is
 * tied to the immutable action row, never just mutable case metadata. */
async function recoveredApprovalDecision(
  supportCase: SupportCase,
  turnId: string,
) {
  const decision = supportCase.approval;
  if (!decision) return undefined;
  if (!decision.approverId)
    throw new Error("The persisted approval decision is missing its approver.");
  if (decision.approved) {
    const stored = persistedRefundCommandSchema.safeParse(
      (supportCase.metadata as Record<string, unknown>).refundCommand,
    );
    if (!stored.success)
      throw new Error("The persisted refund command is missing.");
    const command = stored.data;
    const binding = resolveConfiguredBinding(
      bindingsForPersistedCase(supportCase).transactions,
    );
    const immutable = {
      binding,
      approvalCaseId: supportCase.id,
      orderId: command.orderId,
      amount: legacyAmountToMoney(command.amount, command.currency),
      reason: command.reason,
      idempotencyKey: command.idempotencyKey,
    };
    const fingerprint = refundFingerprint(immutable);
    if (
      command.approvalCaseId !== supportCase.id ||
      command.fingerprint !== fingerprint
    )
      throw new Error("The persisted refund command fingerprint is invalid.");
    const action = await caseStore.getAction(
      supportCase.id,
      "refund-command",
      fingerprint,
    );
    if (
      !action ||
      JSON.stringify(action) !== JSON.stringify({ ...immutable, fingerprint })
    )
      throw new Error(
        "The persisted approved refund command does not match its immutable action.",
      );
  }
  return {
    caseId: supportCase.id,
    turnId,
    approved: decision.approved,
    approverId: decision.approverId,
    note: decision.note,
  };
}

export const requestApprovalStep = createStep({
  id: "request-approval",
  description:
    "Suspends the workflow for human approval when the drafted resolution recommends a refund.",
  inputSchema: resolveSupportCaseInputSchema,
  resumeSchema: z.object({
    approved: z.boolean(),
    approverId: z.string(),
    note: z.string().optional(),
  }),
  suspendSchema: z.object({
    caseId: z.string(),
    refundAmount: z.number(),
    refundCurrency: z.string(),
    refundReason: z.string(),
    orderId: z.string(),
    draftResponse: z.string(),
  }),
  outputSchema: approvalOutputSchema,
  execute: async ({
    inputData,
    resumeData,
    suspend,
    mastra,
    requestContext,
    tracingContext,
  }) => {
    const { supportCase } = await getActiveCaseOrThrow(
      inputData.caseId,
      inputData.turnId,
    );
    const bindings = bindingsForPersistedCase(supportCase);
    const draft = supportCase.draft;

    if (!draft?.recommendRefund) {
      return {
        caseId: supportCase.id,
        turnId: inputData.turnId,
        approved: false,
      };
    }

    // Do not create an executable native command for a recommendation which
    // local policy already requires a human escalation to handle. The same
    // rule is repeated by LocalRuntime in its provider write transaction.
    if (
      draft.requiresEscalation ||
      (draft.refundAmount ?? 0) > STANDARD_REFUND_REVIEW_LIMIT
    ) {
      if (!draft.requiresEscalation)
        await caseStore.update(supportCase.id, {
          draft: {
            ...draft,
            requiresEscalation: true,
            escalationReason: `Refund amount ${draft.refundAmount} exceeds the ${STANDARD_REFUND_REVIEW_LIMIT} standard review limit and needs manual handling.`,
          },
        });
      return {
        caseId: supportCase.id,
        turnId: inputData.turnId,
        approved: false,
      };
    }

    if (!resumeData) {
      const recovered = await recoveredApprovalDecision(
        supportCase,
        inputData.turnId,
      );
      if (recovered) return recovered;
      const amount = draft.refundAmount ?? 0;
      const currency = draft.refundCurrency ?? "USD";
      const turnId = inputData.turnId;
      const command = {
        approvalCaseId: supportCase.id,
        orderId:
          supportCase.orderLookup?.order?.orderId ??
          supportCase.subscriptionLookup?.subscription?.refundOrderId ??
          "",
        amount,
        currency,
        reason: draft.refundReason ?? "Approved support refund",
        // A conversation may legitimately issue a later, distinct command.
        // The effect key is therefore stable for this immutable turn only.
        idempotencyKey: `${supportCase.id}:${turnId}`,
        fingerprint: "",
      };
      if (!command.orderId)
        throw new Error(
          "A refund recommendation requires an unambiguous order id.",
        );
      const money = legacyAmountToMoney(amount, currency);
      const binding = resolveConfiguredBinding(bindings.transactions);
      const immutableCommand = {
        binding,
        approvalCaseId: supportCase.id,
        orderId: command.orderId,
        amount: money,
        reason: command.reason,
        idempotencyKey: command.idempotencyKey,
      };
      command.fingerprint = refundFingerprint(immutableCommand);
      await ensureProviderFixtures(binding);
      const approvedCommand = {
        ...immutableCommand,
        fingerprint: command.fingerprint,
      };
      // Tool.execute does not create a Mastra span when this trusted workflow
      // invokes a deterministic provider port directly. Quote is a real
      // financial-provider boundary even though it has no effect, so include
      // it in the workflow's tenant/turn trace before native suspension.
      await traceOperationalPort({
        mastra,
        tracingContext,
        kind: "provider",
        operation: "transactions.quote_refund",
        run: () =>
          providerRegistry(binding)
            .transactions(binding)
            .quoteRefund(approvedCommand),
      });
      await caseStore.saveAction(
        supportCase.id,
        "refund-command",
        command.fingerprint,
        approvedCommand,
      );
      // Bind the exact evidence selected for this immutable command and turn.
      // Later case projections/drafts are mutable operational state and must
      // never decide whether a suspended approval may create an effect.
      await caseStore.saveAction(
        supportCase.id,
        "refund-policy-evidence",
        command.fingerprint,
        {
          turnId,
          binding: {
            tenantId: bindings.knowledge.tenantId,
            providerKind: bindings.knowledge.providerKind,
            providerAccountId: bindings.knowledge.providerAccountId,
          },
          citations: parsedDraftEvidence(supportCase, draft.citedSources),
        },
      );
      await caseStore.bindTurnCommand(
        supportCase.id,
        turnId,
        command.fingerprint,
      );
      if (!mastra)
        throw new Error(
          "Native refund approval requires the registered Mastra instance.",
        );
      const executionAgent = mastra.getAgent("refundExecutionAgent");
      // This is a real Agent lifecycle. requireApproval is set on issue_refund;
      // generate must therefore persist a native snapshot before the workflow
      // presents its one shared decision.
      const native = await executionAgent.generate(
        `Call issue_refund once with exactly this immutable command JSON: ${JSON.stringify(
          {
            caseId: supportCase.id,
            orderId: command.orderId,
            amount: command.amount,
            currency: command.currency,
            reason: command.reason,
            idempotencyKey: command.idempotencyKey,
            fingerprint: command.fingerprint,
          },
        )}`,
        { requestContext, tracingContext },
      );
      const suspended = native as {
        finishReason?: string;
        runId?: string;
        suspendPayload?: {
          toolCallId?: string;
          toolName?: string;
          args?: unknown;
        };
      };
      const expectedNativeArgs = {
        caseId: supportCase.id,
        orderId: command.orderId,
        amount: command.amount,
        currency: command.currency,
        reason: command.reason,
        idempotencyKey: command.idempotencyKey,
        fingerprint: command.fingerprint,
      };
      const nativeArgs = refundExecutionInputSchema.safeParse(
        suspended.suspendPayload?.args,
      );
      if (
        suspended.finishReason !== "suspended" ||
        !suspended.runId ||
        suspended.suspendPayload?.toolName !== "issue_refund" ||
        !suspended.suspendPayload.toolCallId ||
        !nativeArgs.success ||
        nativeArgs.data.caseId !== expectedNativeArgs.caseId ||
        nativeArgs.data.orderId !== expectedNativeArgs.orderId ||
        nativeArgs.data.amount !== expectedNativeArgs.amount ||
        nativeArgs.data.currency !== expectedNativeArgs.currency ||
        nativeArgs.data.reason !== expectedNativeArgs.reason ||
        nativeArgs.data.idempotencyKey !== expectedNativeArgs.idempotencyKey ||
        nativeArgs.data.fingerprint !== expectedNativeArgs.fingerprint
      )
        throw new Error(
          "Native refund agent did not suspend on the immutable tool call.",
        );
      await caseStore.update(supportCase.id, {
        status: "waiting_approval",
        metadata: {
          ...supportCase.metadata,
          refundCommand: command,
          nativeApproval: {
            runId: suspended.runId,
            toolCallId: suspended.suspendPayload.toolCallId,
            fingerprint: command.fingerprint,
            turnId,
          },
        },
      });
      return await suspend({
        caseId: supportCase.id,
        refundAmount: draft.refundAmount ?? 0,
        refundCurrency: draft.refundCurrency ?? "USD",
        refundReason: draft.refundReason ?? "",
        orderId:
          supportCase.orderLookup?.order?.orderId ??
          supportCase.subscriptionLookup?.subscription?.refundOrderId ??
          "",
        draftResponse: draft.draftResponse,
      });
    }

    if (!(supportCase.metadata as Record<string, unknown>).refundCommand)
      throw new Error("The persisted refund command is missing.");
    // HTTP records the authenticated decision atomically before it resumes the
    // workflow. This step must only consume that record, never manufacture a
    // second decision from resume data (which is network-controlled input).
    const persisted = supportCase.approval;
    if (!persisted)
      throw new Error(
        "Legacy approval has no authenticated Phase 003 decision and cannot execute.",
      );
    if (
      persisted.approved !== resumeData.approved ||
      persisted.approverId !== resumeData.approverId
    )
      throw new Error(
        "The workflow resume does not match the durable approval decision.",
      );

    return {
      caseId: supportCase.id,
      turnId: inputData.turnId,
      approved: persisted.approved,
      approverId: persisted.approverId,
      note: persisted.note,
    };
  },
});

export const REQUEST_APPROVAL_STEP_ID = requestApprovalStep.id;
