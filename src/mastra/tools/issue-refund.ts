import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { findOrderById, recordRefund } from "../lib/mock-commerce";

export const MAX_AUTO_APPROVABLE_REFUND = 1000;

const issuedIdempotencyKeys = new Map<
  string,
  { refundId: string; executedAt: string }
>();

export const issueRefundTool = createTool({
  id: "issue_refund",
  description:
    "Execute a refund against an order. Requires human approval. Idempotent on idempotencyKey - safe to call more than once for the same case.",
  inputSchema: z.object({
    orderId: z.string(),
    amount: z.number().positive(),
    currency: z.string().default("USD"),
    reason: z.string(),
    idempotencyKey: z
      .string()
      .describe(
        "Stable key (e.g. the case id) so retries never double-refund.",
      ),
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
  execute: async ({ orderId, amount, currency, reason, idempotencyKey }) => {
    const existing = issuedIdempotencyKeys.get(idempotencyKey);
    if (existing) {
      return {
        refundId: existing.refundId,
        orderId,
        amount,
        currency,
        status: "skipped" as const,
        idempotencyKey,
        executedAt: existing.executedAt,
      };
    }

    const order = findOrderById(orderId);
    if (!order) {
      throw new Error(`Cannot issue refund: order ${orderId} not found.`);
    }
    if (amount > order.amount) {
      throw new Error(
        `Refund amount ${amount} ${currency} exceeds the original charge of ${order.amount} ${order.currency} for order ${orderId}.`,
      );
    }

    const refundId = `REF-${Math.floor(1000 + Math.random() * 9000)}`;
    const executedAt = new Date().toISOString();

    // Mock execution: in production this calls the payment processor
    // (Stripe Refunds API, PayPal, etc.) and the commerce backend.
    recordRefund({
      refundId,
      orderId,
      amount,
      currency,
      reason,
      issuedAt: executedAt,
    });
    issuedIdempotencyKeys.set(idempotencyKey, { refundId, executedAt });

    return {
      refundId,
      orderId,
      amount,
      currency,
      status: "executed" as const,
      idempotencyKey,
      executedAt,
    };
  },
});
