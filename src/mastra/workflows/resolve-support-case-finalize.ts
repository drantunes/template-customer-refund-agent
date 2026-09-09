import { createStep } from "@mastra/core/workflows";
import { z } from "zod";
import { type SupportCase } from "../domain/support-case";
import {
  renderGroundedSupportResponse,
  safeEscalationResponse,
} from "../domain/customer-response";
import { persistedRefundCommandSchema } from "../domain/refund-command";
import { STANDARD_REFUND_REVIEW_LIMIT } from "../domain/refund-review-limit";
import { triageEscalationReason } from "../domain/resolution-decision";
import { caseStore } from "../lib/case-store";
import { legacyAmountToMoney, refundFingerprint } from "../lib/money";
import {
  resolveConfiguredBinding,
  providerRegistry,
} from "../providers/registry";
import {
  bindingsForPersistedCase,
  deliverOutbox,
} from "../runtime/local-runtime";
import { getActiveCaseOrThrow } from "./resolve-support-case-context";

const immutableRefundCommandSchema = z.object({
  binding: z.object({
    tenantId: z.string(),
    providerKind: z.enum(["local", "stripe"]),
    providerAccountId: z.string(),
    externalConversationId: z.string(),
  }),
  approvalCaseId: z.string(),
  orderId: z.string(),
  amount: z.object({
    currency: z.string(),
    minor: z.number().int().positive(),
  }),
  reason: z.string(),
  idempotencyKey: z.string(),
  fingerprint: z.string(),
});

const durableRefundEffectSchema = z.object({
  refundId: z.string(),
  orderId: z.string(),
  amount: z.object({
    currency: z.string(),
    minor: z.number().int().positive(),
  }),
  idempotencyKey: z.string(),
  executedAt: z.string().refine((value) => Number.isFinite(Date.parse(value))),
  replayed: z.boolean().optional(),
});

/** A completed refund message is permitted only when every customer-visible
 * detail is bound back to the same durable effect, immutable command, account,
 * and inbound turn. This intentionally does not inspect model text. */
async function completedRefundResponse(
  supportCase: SupportCase,
  turnId: string,
) {
  const metadata = supportCase.metadata as Record<string, unknown>;
  const command = persistedRefundCommandSchema.safeParse(
    metadata.refundCommand,
  );
  const result = supportCase.refundResult;
  const turn = await caseStore.turn(supportCase.id, turnId);
  if (
    !command.success ||
    !result ||
    !turn ||
    !["executed", "skipped"].includes(result.status)
  )
    return undefined;

  const binding = resolveConfiguredBinding(
    bindingsForPersistedCase(supportCase).transactions,
  );
  let expectedAmount;
  try {
    expectedAmount = legacyAmountToMoney(
      command.data.amount,
      command.data.currency,
    );
  } catch {
    return undefined;
  }
  const expectedFingerprint = refundFingerprint({
    binding,
    approvalCaseId: supportCase.id,
    orderId: command.data.orderId,
    amount: expectedAmount,
    reason: command.data.reason,
    idempotencyKey: command.data.idempotencyKey,
  });
  const immutable = immutableRefundCommandSchema.safeParse(
    await caseStore.getAction(
      supportCase.id,
      "refund-command",
      command.data.fingerprint,
    ),
  );
  const idempotency = await caseStore.idempotency(command.data.idempotencyKey);
  const effect = durableRefundEffectSchema.safeParse(idempotency?.effect);
  const decision = await caseStore.approvalDecision(supportCase.id, turnId);
  const projected = metadata.refundEffects as
    Record<string, unknown> | undefined;
  const projectedResult = projected?.[command.data.fingerprint];

  if (
    command.data.approvalCaseId !== supportCase.id ||
    command.data.fingerprint !== expectedFingerprint ||
    turn.commandFingerprint !== command.data.fingerprint ||
    metadata.activeTurnId !== turnId ||
    !supportCase.approval?.approved ||
    !decision?.approved ||
    decision.turnId !== turnId ||
    decision.commandFingerprint !== command.data.fingerprint ||
    !immutable.success ||
    immutable.data.binding.tenantId !== binding.tenantId ||
    immutable.data.binding.providerKind !== binding.providerKind ||
    immutable.data.binding.providerAccountId !== binding.providerAccountId ||
    immutable.data.approvalCaseId !== supportCase.id ||
    immutable.data.orderId !== command.data.orderId ||
    immutable.data.amount.currency !== expectedAmount.currency ||
    immutable.data.amount.minor !== expectedAmount.minor ||
    immutable.data.reason !== command.data.reason ||
    immutable.data.idempotencyKey !== command.data.idempotencyKey ||
    immutable.data.fingerprint !== command.data.fingerprint ||
    idempotency?.fingerprint !== command.data.fingerprint ||
    !effect.success ||
    effect.data.orderId !== command.data.orderId ||
    effect.data.amount.currency !== expectedAmount.currency ||
    effect.data.amount.minor !== expectedAmount.minor ||
    effect.data.idempotencyKey !== command.data.idempotencyKey ||
    result.refundId !== effect.data.refundId ||
    result.orderId !== effect.data.orderId ||
    result.amount !== command.data.amount ||
    result.currency !== effect.data.amount.currency ||
    result.idempotencyKey !== effect.data.idempotencyKey ||
    result.executedAt !== effect.data.executedAt ||
    JSON.stringify(projectedResult) !== JSON.stringify(result)
  )
    return undefined;

  return `Your refund of ${result.amount} ${result.currency} has been issued.`;
}

const approvalOutputSchema = z.object({
  caseId: z.string(),
  turnId: z.string(),
  approved: z.boolean(),
  approverId: z.string().optional(),
  note: z.string().optional(),
});

export const resolveCaseStep = createStep({
  id: "resolve-case",
  description:
    "Finalizes a durably executed refund or marks the case resolved/escalated.",
  inputSchema: approvalOutputSchema,
  outputSchema: z.object({
    caseId: z.string(),
    turnId: z.string(),
    status: z.enum(["resolved", "escalated"]),
  }),
  execute: async ({ inputData, mastra }) => {
    const { supportCase } = await getActiveCaseOrThrow(
      inputData.caseId,
      inputData.turnId,
    );
    const draft = supportCase.draft!;
    const triageReason = triageEscalationReason(supportCase.triage);
    let finalResponse =
      draft.requiresEscalation || triageReason
        ? safeEscalationResponse
        : renderGroundedSupportResponse(
            supportCase,
            draft.selectedPolicyExcerpts,
          );
    let status: "resolved" | "escalated" = draft.requiresEscalation
      ? "escalated"
      : "resolved";
    let escalationReason = triageReason ?? draft.escalationReason;
    if (triageReason) status = "escalated";
    const mustEscalate = Boolean(triageReason || draft.requiresEscalation);

    const cancellation = (supportCase.metadata as Record<string, unknown>)
      .cancellationEffect as
      { status?: string; cancelsAt?: string } | undefined;
    if (
      !mustEscalate &&
      supportCase.triage?.intent === "cancellation" &&
      cancellation?.status === "scheduled" &&
      cancellation.cancelsAt
    ) {
      status = "resolved";
      finalResponse = `Your subscription is scheduled to cancel at the end of the current billing period on ${cancellation.cancelsAt}.`;
    } else if (
      !mustEscalate &&
      supportCase.triage?.intent === "cancellation" &&
      !cancellation
    ) {
      status = "escalated";
      finalResponse = safeEscalationResponse;
      escalationReason ??=
        "Subscription cancellation was not durably scheduled.";
    }

    if (draft.recommendRefund && !mustEscalate) {
      if (!inputData.approved) {
        status = "escalated";
        escalationReason = `Refund declined by ${inputData.approverId ?? "reviewer"}${inputData.note ? `: ${inputData.note}` : "."}`;
        finalResponse =
          "Thanks for your patience - a specialist is going to take a closer look at your case and follow up shortly.";
      } else {
        const orderId =
          supportCase.orderLookup?.order?.orderId ??
          supportCase.subscriptionLookup?.subscription?.refundOrderId;
        if (!orderId) {
          status = "escalated";
          escalationReason =
            "Refund was approved but no order id was on file - needs manual handling.";
        } else if ((draft.refundAmount ?? 0) > STANDARD_REFUND_REVIEW_LIMIT) {
          status = "escalated";
          escalationReason = `Refund amount ${draft.refundAmount} exceeds the ${STANDARD_REFUND_REVIEW_LIMIT} standard review limit and needs a senior approver.`;
        } else {
          if (!mastra)
            throw new Error(
              "The resolve workflow must run through a registered Mastra instance.",
            );
          // Phase 003 executes through the native Agent approval lifecycle.
          // The tool writes its durable result before this workflow resumes;
          // never call a requireApproval tool directly from a workflow step.
          const completed = await completedRefundResponse(
            supportCase,
            inputData.turnId,
          );
          if (completed) {
            status = "resolved";
            finalResponse = completed;
          } else if (supportCase.refundResult?.status === "failed") {
            status = "escalated";
            escalationReason =
              "Stripe reported that the approved refund failed and requires staff review.";
            finalResponse =
              "The refund requires additional review. A support specialist will follow up shortly.";
          } else
            throw new Error(
              "Native approval resumed without a matching durable refund effect; recovery must reconcile the immutable command.",
            );
        }
      }
    }

    // A financial terminalization may be committed by an authoritative Stripe
    // webhook between the approved tool receipt and this native continuation.
    // Both paths must use the immutable refund-command/turn identity, so the
    // transaction's INSERT OR IGNORE converges on one customer notification.
    const terminalOutboxKind =
      draft.recommendRefund && supportCase.refundResult?.status === "skipped"
        ? "refund-final"
        : "final";
    const message = {
      // Deterministic identities make an active-step replay converge on the
      // already finalized message/outbox pair.
      id: `msg_${supportCase.id}_${inputData.turnId}_final`,
      author: "agent" as const,
      authorName: "Support Agent",
      body: finalResponse,
      createdAt: new Date().toISOString(),
    };
    const supportBinding = resolveConfiguredBinding(
      bindingsForPersistedCase(supportCase).support,
    );
    const providerPlan = providerRegistry(supportBinding)
      .support(supportBinding)
      .planFinalizationOutbox?.({
        status,
        subject: supportCase.subject,
        escalationReason,
      });
    await caseStore.finalizeCaseAndEnqueue({
      caseId: supportCase.id,
      turnId: inputData.turnId,
      status,
      finalResponse,
      escalationReason,
      message,
      outbox: {
        id: `outbox_${supportCase.id}_${inputData.turnId}_${terminalOutboxKind}`,
        caseId: supportCase.id,
        binding: supportBinding,
        body: finalResponse,
        status,
      },
      additionalOutbox: providerPlan?.map((operation) => ({
        id: `outbox_${supportCase.id}_${inputData.turnId}_${operation.operation}`,
        caseId: supportCase.id,
        binding: supportBinding,
        body: operation.body,
        status: operation.status,
        operation: operation.operation,
      })),
    });
    await deliverOutbox(undefined, 10, caseStore, { mastra }).catch((error) =>
      mastra
        ?.getLogger()
        ?.warn("Local outbox delivery failed; recovery will retry it.", {
          error,
          caseId: supportCase.id,
        }),
    );

    return { caseId: supportCase.id, turnId: inputData.turnId, status };
  },
});
