import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { caseStore } from "../lib/case-store";
import { activeDispatchLeaseScope } from "../lib/dispatch-lease-scope";
import {
  legacyAmountToMoney,
  moneyToLegacyAmount,
  refundFingerprint,
} from "../lib/money";
import { bindingsForPersistedCase } from "../runtime/local-runtime";
import {
  ensureProviderFixtures,
  providerRegistry,
  resolveConfiguredBinding,
} from "../providers/registry";
import { withNativeRefundExecutionAuthorization } from "../providers/native-execution";
import { activePrincipalHasRole } from "../server/auth";

export const MAX_AUTO_APPROVABLE_REFUND = 1000;
const commandSchema = z.object({
  approvalCaseId: z.string(),
  orderId: z.string(),
  amount: z.number().positive(),
  currency: z.string(),
  reason: z.string(),
  idempotencyKey: z.string(),
  fingerprint: z.string(),
});
export const refundExecutionInputSchema = z.object({
  caseId: z.string(),
  orderId: z.string(),
  amount: z.number().positive(),
  currency: z.string().default("USD"),
  reason: z.string(),
  idempotencyKey: z.string(),
  fingerprint: z.string(),
});

/**
 * The Phase-003 financial boundary: the native approved tool context, durable
 * decision, immutable command, and current approver role must all agree.
 */
export const issueRefundTool = createTool({
  id: "issue_refund",
  description: "Execute the already-approved persisted local refund command.",
  inputSchema: refundExecutionInputSchema,
  outputSchema: z.object({
    refundId: z.string(),
    orderId: z.string(),
    amount: z.number(),
    currency: z.string(),
    status: z.enum(["executed", "skipped"]),
    idempotencyKey: z.string(),
    executedAt: z.string(),
  }),
  requireApproval: true,
  execute: async (input, context) => {
    const supportCase = await caseStore.get(input.caseId);
    if (!supportCase?.approval?.approved)
      throw new Error(
        "A persisted approved local decision is required before issuing a refund.",
      );
    const lease = activeDispatchLeaseScope();
    if (
      !lease ||
      lease.caseId !== input.caseId ||
      !(await caseStore.hasDispatchLease(lease))
    )
      throw new Error(
        "Refund execution requires the current durable workflow dispatch lease.",
      );
    const decision = await caseStore.approvalDecision(
      input.caseId,
      (
        (supportCase.metadata as Record<string, unknown>).nativeApproval as
          | {
              turnId?: string;
            }
          | undefined
      )?.turnId,
    );
    const native = (supportCase.metadata as Record<string, unknown>)
      .nativeApproval as
      | {
          runId?: string;
          toolCallId?: string;
          fingerprint?: string;
          turnId?: string;
        }
      | undefined;
    const decisionBinding = bindingsForPersistedCase(supportCase).transactions;
    if (
      !decision?.approved ||
      decision.commandFingerprint !== input.fingerprint ||
      decision.nativeRunId !== native?.runId ||
      decision.nativeToolCallId !== native?.toolCallId ||
      native?.fingerprint !== input.fingerprint ||
      !activePrincipalHasRole(
        decision.principalId,
        decisionBinding.tenantId,
        "approver",
      )
    )
      throw new Error(
        "Refund execution requires a current authorized decision bound to the native tool call.",
      );
    const stored = commandSchema.safeParse(
      (supportCase.metadata as Record<string, unknown>).refundCommand,
    );
    if (!stored.success)
      throw new Error("The persisted refund command is missing.");
    const command = stored.data;
    const bindings = bindingsForPersistedCase(supportCase);
    if (
      command.approvalCaseId !== input.caseId ||
      command.orderId !== input.orderId ||
      command.amount !== input.amount ||
      command.currency !== input.currency ||
      command.reason !== input.reason ||
      command.idempotencyKey !== input.idempotencyKey ||
      command.fingerprint !== input.fingerprint
    )
      throw new Error(
        "Refund execution must exactly match the persisted command.",
      );
    const amount = legacyAmountToMoney(command.amount, command.currency);
    const expected = refundFingerprint({
      binding: bindings.transactions,
      approvalCaseId: input.caseId,
      orderId: command.orderId,
      amount,
      reason: command.reason,
      idempotencyKey: command.idempotencyKey,
    });
    if (expected !== command.fingerprint)
      throw new Error("The persisted refund command fingerprint is invalid.");
    const binding = resolveConfiguredBinding(bindings.transactions);
    await ensureProviderFixtures(binding);
    const effect = await withNativeRefundExecutionAuthorization(
      context,
      native,
      command.fingerprint,
      (authorization) =>
        providerRegistry(binding).transactions(binding).issueRefund(
          {
            binding,
            approvalCaseId: input.caseId,
            orderId: command.orderId,
            amount,
            reason: command.reason,
            idempotencyKey: command.idempotencyKey,
            fingerprint: command.fingerprint,
          },
          authorization,
        ),
    );
    const result = {
      refundId: effect.refundId,
      orderId: effect.orderId,
      amount: moneyToLegacyAmount(effect.amount),
      currency: effect.amount.currency,
      status: effect.replayed ? ("skipped" as const) : ("executed" as const),
      idempotencyKey: effect.idempotencyKey,
      executedAt: effect.executedAt,
    };
    await caseStore.update(input.caseId, {
      refundResult: result,
      metadata: {
        ...supportCase.metadata,
        refundEffects: {
          ...((supportCase.metadata as Record<string, unknown>)
            .refundEffects as Record<string, unknown> | undefined),
          [input.fingerprint]: result,
        },
      },
    });
    return result;
  },
});
