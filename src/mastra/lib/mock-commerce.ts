/**
 * Deterministic order/subscription/refund fixtures standing in for a real
 * commerce backend (Shopify, Stripe Billing, an internal orders service...).
 *
 * Keyed by customer email so the resolution workflow can look a customer up
 * from the inbound message alone, the same way it would call a real API.
 */

export interface MockOrder {
  orderId: string;
  customerEmail: string;
  product: string;
  amount: number;
  currency: string;
  status: "fulfilled" | "shipped" | "processing" | "cancelled" | "refunded";
  chargeCount: number;
  placedAt: string;
}

export interface MockSubscription {
  subscriptionId: string;
  customerEmail: string;
  plan: string;
  amount: number;
  currency: string;
  status: "active" | "cancelled" | "past_due";
  renewsAt: string;
}

export interface MockRefund {
  refundId: string;
  orderId: string;
  amount: number;
  currency: string;
  reason: string;
  issuedAt: string;
}

export const MOCK_ORDERS: MockOrder[] = [
  {
    orderId: "ORD-1001",
    customerEmail: "alex@example.com",
    product: "Pro Plan - Monthly",
    amount: 49,
    currency: "USD",
    status: "fulfilled",
    chargeCount: 2, // duplicate charge on record
    placedAt: "2026-08-01T14:00:00.000Z",
  },
  {
    orderId: "ORD-1002",
    customerEmail: "jordan@example.com",
    product: "Wireless Headphones",
    amount: 129.99,
    currency: "USD",
    status: "shipped",
    chargeCount: 1,
    placedAt: "2026-08-10T09:30:00.000Z",
  },
  {
    orderId: "ORD-1003",
    customerEmail: "sam@example.com",
    product: "Standing Desk",
    amount: 349,
    currency: "USD",
    status: "fulfilled",
    chargeCount: 1,
    placedAt: "2026-07-20T11:15:00.000Z",
  },
  {
    orderId: "ORD-1004",
    customerEmail: "riley@example.com",
    product: "Team Plan - Annual",
    amount: 588,
    currency: "USD",
    status: "fulfilled",
    chargeCount: 1,
    placedAt: "2026-05-02T08:00:00.000Z",
  },
];

export const MOCK_SUBSCRIPTIONS: MockSubscription[] = [
  {
    subscriptionId: "SUB-1001",
    customerEmail: "alex@example.com",
    plan: "Pro Plan - Monthly",
    amount: 49,
    currency: "USD",
    status: "active",
    renewsAt: "2026-09-01T00:00:00.000Z",
  },
  {
    subscriptionId: "SUB-1004",
    customerEmail: "riley@example.com",
    plan: "Team Plan - Annual",
    amount: 588,
    currency: "USD",
    status: "active",
    renewsAt: "2027-05-02T00:00:00.000Z",
  },
];

export const MOCK_REFUNDS: MockRefund[] = [
  {
    refundId: "REF-9001",
    orderId: "ORD-1004",
    amount: 49,
    currency: "USD",
    reason: "Goodwill credit for onboarding delay",
    issuedAt: "2026-06-01T10:00:00.000Z",
  },
];

export function findOrderByEmail(email: string): MockOrder | undefined {
  return MOCK_ORDERS.find(
    (o) => o.customerEmail.toLowerCase() === email.toLowerCase(),
  );
}

export function findOrderById(orderId: string): MockOrder | undefined {
  return MOCK_ORDERS.find((o) => o.orderId === orderId);
}

export function findSubscriptionByEmail(
  email: string,
): MockSubscription | undefined {
  return MOCK_SUBSCRIPTIONS.find(
    (s) => s.customerEmail.toLowerCase() === email.toLowerCase(),
  );
}

export function findRefundsByOrderId(orderId: string): MockRefund[] {
  return MOCK_REFUNDS.filter((r) => r.orderId === orderId);
}

export function recordRefund(refund: MockRefund): void {
  MOCK_REFUNDS.push(refund);
  const order = findOrderById(refund.orderId);
  if (order) {
    order.status = "refunded";
  }
}
