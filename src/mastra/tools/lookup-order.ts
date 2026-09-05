import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  findOrderByEmail,
  findOrderById,
  findRefundsByOrderId,
  findSubscriptionByEmail,
} from "../lib/mock-commerce";

/**
 * Read-only commerce lookups. These stand in for calls to a real order
 * management system (Shopify, internal orders API, Stripe). Swap the bodies
 * for real API calls when wiring this template to a live backend - the
 * schemas the resolution workflow depends on stay the same.
 */

export const lookupOrderTool = createTool({
  id: "lookup_order",
  description:
    "Look up a customer's most recent order by email address, or a specific order by id.",
  inputSchema: z.object({
    customerEmail: z.email().optional(),
    orderId: z.string().optional(),
  }),
  outputSchema: z.object({
    found: z.boolean(),
    order: z
      .object({
        orderId: z.string(),
        customerEmail: z.email(),
        product: z.string(),
        amount: z.number(),
        currency: z.string(),
        status: z.enum([
          "fulfilled",
          "shipped",
          "processing",
          "cancelled",
          "refunded",
        ]),
        chargeCount: z.number(),
        placedAt: z.string(),
      })
      .optional(),
  }),
  execute: async ({ customerEmail, orderId }) => {
    const order = orderId
      ? findOrderById(orderId)
      : customerEmail
        ? findOrderByEmail(customerEmail)
        : undefined;
    return order ? { found: true, order } : { found: false };
  },
});

export const lookupSubscriptionTool = createTool({
  id: "lookup_subscription",
  description: "Look up a customer's subscription by email address.",
  inputSchema: z.object({
    customerEmail: z.email(),
  }),
  outputSchema: z.object({
    found: z.boolean(),
    subscription: z
      .object({
        subscriptionId: z.string(),
        customerEmail: z.email(),
        plan: z.string(),
        amount: z.number(),
        currency: z.string(),
        status: z.enum(["active", "cancelled", "past_due"]),
        renewsAt: z.string(),
      })
      .optional(),
  }),
  execute: async ({ customerEmail }) => {
    const subscription = findSubscriptionByEmail(customerEmail);
    return subscription ? { found: true, subscription } : { found: false };
  },
});

export const lookupCustomerRefundHistoryTool = createTool({
  id: "lookup_customer_refund_history",
  description:
    "List prior refunds issued for a given order id, so the agent avoids double-refunding.",
  inputSchema: z.object({
    orderId: z.string(),
  }),
  outputSchema: z.object({
    refunds: z.array(
      z.object({
        refundId: z.string(),
        orderId: z.string(),
        amount: z.number(),
        currency: z.string(),
        reason: z.string(),
        issuedAt: z.string(),
      }),
    ),
  }),
  execute: async ({ orderId }) => {
    return { refunds: findRefundsByOrderId(orderId) };
  },
});
