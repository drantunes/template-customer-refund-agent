import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { moneyToLegacyAmount } from "../lib/money";
import { caseStore } from "../lib/case-store";
import { requireTrustedCommerceScope } from "../lib/trusted-run-scope";
import {
  ensureProviderFixtures,
  providerRegistry,
  resolveConfiguredBinding,
} from "../providers/registry";

const bindingSchema = z
  .object({
    tenantId: z.string(),
    providerKind: z.literal("local"),
    providerAccountId: z.string(),
    externalConversationId: z.string(),
  })
  .optional();
const fallbackBinding = {
  tenantId: "local-demo",
  providerKind: "local" as const,
  providerAccountId: "local-demo",
  externalConversationId: "tool",
};
const orderSchema = z.object({
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
});

async function verifiedCommerceBinding(
  binding: z.infer<typeof bindingSchema>,
  customerEmail?: string,
) {
  const scope = requireTrustedCommerceScope();
  const supportCase = await caseStore.get(scope.caseId);
  if (!supportCase)
    throw new Error(
      "Trusted commerce scope references a missing support case.",
    );
  const metadata = supportCase.metadata as Record<string, unknown>;
  const persistedBindings = metadata.providerBindings as
    { commerce?: typeof fallbackBinding } | undefined;
  const persisted = resolveConfiguredBinding(
    persistedBindings?.commerce ?? fallbackBinding,
  );
  if (
    binding &&
    (binding.tenantId !== persisted.tenantId ||
      binding.providerKind !== persisted.providerKind ||
      binding.providerAccountId !== persisted.providerAccountId ||
      binding.externalConversationId !== persisted.externalConversationId)
  )
    throw new Error("Commerce lookup binding does not match the durable case.");
  const configured = persisted;
  if (
    metadata.ownerId !== scope.ownerId ||
    configured.tenantId !== scope.tenantId ||
    (customerEmail &&
      customerEmail.toLowerCase() !== supportCase.customer.email.toLowerCase())
  )
    throw new Error(
      "Commerce lookup scope does not match the verified case owner.",
    );
  return { configured, customerEmail: supportCase.customer.email };
}

export const lookupOrderTool = createTool({
  id: "lookup_order",
  description:
    "Look up a scoped local commerce order by customer email or explicit id.",
  inputSchema: z.object({
    customerEmail: z.email().optional(),
    orderId: z.string().optional(),
    binding: bindingSchema,
  }),
  outputSchema: z.object({ found: z.boolean(), order: orderSchema.optional() }),
  execute: async ({ customerEmail, orderId, binding }) => {
    const scoped = await verifiedCommerceBinding(binding, customerEmail);
    const configured = scoped.configured;
    await ensureProviderFixtures(configured);
    const order = await providerRegistry(configured)
      .commerce(configured)
      .findOrder(configured, scoped.customerEmail, orderId);
    return order
      ? {
          found: true,
          order: {
            ...order,
            amount: moneyToLegacyAmount(order.amount),
            currency: order.amount.currency,
          },
        }
      : { found: false };
  },
});

export const lookupSubscriptionTool = createTool({
  id: "lookup_subscription",
  description: "Look up a scoped local subscription by email.",
  inputSchema: z.object({ customerEmail: z.email(), binding: bindingSchema }),
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
  execute: async ({ customerEmail, binding }) => {
    const scoped = await verifiedCommerceBinding(binding, customerEmail);
    const configured = scoped.configured;
    await ensureProviderFixtures(configured);
    const subscription = await providerRegistry(configured)
      .commerce(configured)
      .findSubscription(configured, scoped.customerEmail);
    return subscription
      ? {
          found: true,
          subscription: {
            ...subscription,
            amount: moneyToLegacyAmount(subscription.amount),
            currency: subscription.amount.currency,
          },
        }
      : { found: false };
  },
});

export const lookupCustomerRefundHistoryTool = createTool({
  id: "lookup_customer_refund_history",
  description: "List durable local refund effects for an order.",
  inputSchema: z.object({ orderId: z.string(), binding: bindingSchema }),
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
  execute: async ({ orderId, binding }) => {
    const scoped = await verifiedCommerceBinding(binding);
    const configured = scoped.configured;
    await ensureProviderFixtures(configured);
    const order = await providerRegistry(configured)
      .commerce(configured)
      .findOrder(configured, scoped.customerEmail, orderId);
    if (!order)
      throw new Error(
        "Refund history order is outside the verified case owner scope.",
      );
    const refunds = await providerRegistry(configured)
      .commerce(configured)
      .refunds(configured, orderId);
    return {
      refunds: refunds.map((refund) => ({
        ...refund,
        amount: moneyToLegacyAmount(refund.amount),
        currency: refund.amount.currency,
      })),
    };
  },
});
