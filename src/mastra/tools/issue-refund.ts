import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { caseStore } from "../lib/case-store";
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

/**
 * A Phase-002 local decision bridge: callers must reference the immutable
 * command persisted at suspension. Native approval/RBAC belongs to Phase 003.
 */
export const issueRefundTool = createTool({
  id: "issue_refund",
  description: "Execute the already-approved persisted local refund command.",
  inputSchema: z.object({
    caseId: z.string(),
    orderId: z.string(),
    amount: z.number().positive(),
    currency: z.string().default("USD"),
    reason: z.string(),
    idempotencyKey: z.string(),
    fingerprint: z.string(),
  }),
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
  execute: async (input) => {
    const supportCase = await caseStore.get(input.caseId);
    if (!supportCase?.approval?.approved)
      throw new Error(
        "A persisted approved local decision is required before issuing a refund.",
      );
    const stored = commandSchema.safeParse(
      (supportCase.metadata as Record<string, unknown>).refundCommand,
    );
    if (!stored.success)
      throw new Error("The persisted refund command is missing.");
    const command = stored.data;
    const bindings = bindingsForPersistedCase(supportCase);
    if (
      JSON.stringify(command) !==
      JSON.stringify({
        approvalCaseId: input.caseId,
        orderId: input.orderId,
        amount: input.amount,
        currency: input.currency,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
        fingerprint: input.fingerprint,
      })
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
    const effect = await providerRegistry(binding)
      .transactions(binding)
      .issueRefund({
        binding,
        approvalCaseId: input.caseId,
        orderId: command.orderId,
        amount,
        reason: command.reason,
        idempotencyKey: command.idempotencyKey,
        fingerprint: command.fingerprint,
      });
    return {
      refundId: effect.refundId,
      orderId: effect.orderId,
      amount: moneyToLegacyAmount(effect.amount),
      currency: effect.amount.currency,
      status: effect.replayed ? ("skipped" as const) : ("executed" as const),
      idempotencyKey: effect.idempotencyKey,
      executedAt: effect.executedAt,
    };
  },
});
