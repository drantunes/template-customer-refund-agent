import { describe, expect, it } from "vitest";
import { StripeClient } from "../../src/mastra/providers/stripe/client";
import {
  STRIPE_API_VERSION,
  type StripeSandboxConfig,
} from "../../src/mastra/providers/stripe/config";

const config: StripeSandboxConfig = {
  enabled: true,
  tenantId: "local-demo",
  accountId: "acct_test_123",
  restrictedApiKey: "rk_test_synthetic",
  webhookSecret: "whsec_synthetic",
  apiBaseUrl: "http://stripe.test",
};
const binding = {
  tenantId: "local-demo",
  providerKind: "stripe" as const,
  providerAccountId: "acct_test_123",
  externalConversationId: "case_1",
};

describe("Stripe fetch mapping", () => {
  it("maps a verified Customer, Checkout Session, line items and PaymentIntent with exact minor units", async () => {
    const calls: Request[] = [];
    const client = new StripeClient(config, async (request) => {
      calls.push(request);
      const path = new URL(request.url).pathname;
      // Current Stripe Account objects identify the account but do not expose
      // a `livemode` field.  The adapter must not reject this documented
      // sandbox account shape before it can map downstream resources.
      if (path === "/v1/account")
        return Response.json({ id: config.accountId });
      if (path === "/v1/customers")
        return Response.json({
          data: [{ id: "cus_1", email: "alex@example.com", livemode: false }],
          has_more: false,
        });
      if (path === "/v1/checkout/sessions")
        return Response.json({
          data: [
            {
              id: "cs_1",
              customer: "cus_1",
              customer_details: { email: "alex@example.com" },
              payment_intent: "pi_1",
              status: "complete",
              payment_status: "paid",
              livemode: false,
              created: 1,
            },
          ],
          has_more: false,
        });
      if (path === "/v1/payment_intents/pi_1")
        return Response.json({
          id: "pi_1",
          livemode: false,
          currency: "usd",
          amount_received: 4999,
          status: "succeeded",
        });
      if (path === "/v1/checkout/sessions/cs_1/line_items")
        return Response.json({
          data: [
            {
              description: "Synthetic plan",
              price: { product: "prod_synthetic" },
            },
          ],
          has_more: false,
        });
      throw new Error(`unexpected ${path}`);
    });
    await expect(
      client.findOrder(binding, "alex@example.com"),
    ).resolves.toMatchObject({
      orderId: "cs_1",
      customerEmail: "alex@example.com",
      amount: { currency: "USD", minor: 4999 },
      providerStatus: "succeeded",
      providerRefs: expect.arrayContaining([
        expect.objectContaining({ type: "checkout_session", livemode: false }),
        expect.objectContaining({ type: "payment_intent", id: "pi_1" }),
      ]),
    });
    expect(
      calls.every(
        (request) =>
          request.headers.get("stripe-version") === STRIPE_API_VERSION,
      ),
    ).toBe(true);
    expect(
      calls.every((request) => request.headers.has("stripe-account") === false),
    ).toBe(true);
  });

  it("rejects a live resource returned by fake HTTP", async () => {
    const client = new StripeClient(config, async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/v1/account")
        return Response.json({ id: config.accountId, livemode: false });
      if (path === "/v1/customers")
        return Response.json({
          data: [{ id: "cus_1", email: "alex@example.com", livemode: true }],
          has_more: false,
        });
      return Response.json({ data: [], has_more: false });
    });
    await expect(
      client.findOrder(binding, "alex@example.com"),
    ).resolves.toBeUndefined();
  });

  it("maps subscription Invoice Payments and enforces exact history, quote, create and retrieval contracts", async () => {
    const requests: Request[] = [];
    const client = new StripeClient(config, async (request) => {
      requests.push(request);
      const url = new URL(request.url);
      const path = url.pathname;
      if (path === "/v1/account")
        return Response.json({ id: config.accountId, livemode: false });
      if (path === "/v1/customers")
        return Response.json({
          data: [{ id: "cus_1", email: "alex@example.com", livemode: false }],
          has_more: false,
        });
      if (path === "/v1/subscriptions")
        return Response.json({
          data: [
            {
              id: "sub_1",
              customer: "cus_1",
              latest_invoice: "in_1",
              livemode: false,
              status: "active",
              items: {
                data: [
                  {
                    current_period_end: 2,
                    price: {
                      id: "price_1",
                      nickname: "Synthetic recurring",
                      currency: "usd",
                      unit_amount: 1299,
                    },
                  },
                ],
              },
            },
          ],
          has_more: false,
        });
      if (path === "/v1/invoices/in_1")
        return Response.json({
          id: "in_1",
          customer: "cus_1",
          livemode: false,
          status: "paid",
          paid: true,
        });
      if (path === "/v1/invoice_payments")
        return Response.json({
          data: [
            {
              id: "inpay_1",
              invoice: "in_1",
              livemode: false,
              status: "paid",
              payment: { type: "payment_intent", payment_intent: "pi_1" },
            },
          ],
          has_more: false,
        });
      if (path === "/v1/checkout/sessions")
        return Response.json({
          data: [
            {
              id: "cs_1",
              customer: "cus_1",
              customer_details: { email: "alex@example.com" },
              payment_intent: "pi_1",
              status: "complete",
              payment_status: "paid",
              livemode: false,
              created: 1,
            },
          ],
          has_more: false,
        });
      if (path === "/v1/payment_intents/pi_1")
        return Response.json({
          id: "pi_1",
          livemode: false,
          currency: "usd",
          amount_received: 4999,
          status: "succeeded",
        });
      if (path === "/v1/checkout/sessions/cs_1/line_items")
        return Response.json({
          data: [
            { description: "Synthetic purchase", price: { product: "prod_1" } },
          ],
          has_more: false,
        });
      if (path === "/v1/refunds" && request.method === "GET")
        return Response.json({
          data: [
            {
              id: "re_old",
              currency: "usd",
              amount: 999,
              reason: "requested_by_customer",
              created: 3,
              status: "succeeded",
            },
          ],
          has_more: false,
        });
      if (path === "/v1/refunds" && request.method === "POST")
        return Response.json({
          id: "re_new",
          currency: "usd",
          amount: 2000,
          created: 4,
          status: "pending",
          metadata: {
            support_case_id: "case_1",
            command_fingerprint: "fingerprint_1",
          },
        });
      if (path === "/v1/refunds/re_new")
        return Response.json({
          id: "re_new",
          currency: "usd",
          amount: 2000,
          created: 4,
          status: "succeeded",
          metadata: {
            support_case_id: "case_1",
            command_fingerprint: "fingerprint_1",
          },
        });
      throw new Error(`unexpected ${request.method} ${path}`);
    });
    await expect(
      client.findSubscription(binding, "alex@example.com"),
    ).resolves.toMatchObject({
      subscriptionId: "sub_1",
      providerRefs: expect.arrayContaining([
        expect.objectContaining({ type: "invoice", id: "in_1" }),
        expect.objectContaining({ type: "invoice_payment", id: "inpay_1" }),
        expect.objectContaining({ type: "payment_intent", id: "pi_1" }),
      ]),
      amount: { currency: "USD", minor: 1299 },
      renewsAt: "1970-01-01T00:00:02.000Z",
    });
    const command = {
      binding,
      approvalCaseId: "case_1",
      orderId: "cs_1",
      amount: { currency: "USD", minor: 2000 },
      reason: "duplicate charge",
      idempotencyKey: "stable-key-1",
      fingerprint: "fingerprint_1",
    };
    await expect(
      client.refunds(binding, "cs_1", "alex@example.com"),
    ).resolves.toMatchObject([
      { refundId: "re_old", amount: { currency: "USD", minor: 999 } },
    ]);
    await expect(
      client.quoteRefund(command, "alex@example.com"),
    ).resolves.toMatchObject({
      approvedAmount: command.amount,
      remainingAmount: { currency: "USD", minor: 4000 },
    });
    await expect(
      client.createRefund(command, "alex@example.com"),
    ).resolves.toMatchObject({
      refundId: "re_new",
      status: "pending",
      idempotencyKey: "stable-key-1",
    });
    await expect(
      client.retrieveRefund(binding, "re_new", "cs_1", "stable-key-1", {
        caseId: "case_1",
        fingerprint: "fingerprint_1",
        amountMinor: 2000,
        currency: "USD",
      }),
    ).resolves.toMatchObject({
      refundId: "re_new",
      status: "succeeded",
      replayed: true,
    });
    const create = requests.find(
      (request) =>
        new URL(request.url).pathname === "/v1/refunds" &&
        request.method === "POST",
    );
    expect(create?.headers.get("idempotency-key")).toBe("stable-key-1");
    expect(await create?.text()).toContain("amount=2000");
  });

  it("refuses over-refunds before a Stripe POST", async () => {
    let posts = 0;
    const client = new StripeClient(config, async (request) => {
      const path = new URL(request.url).pathname;
      if (request.method === "POST") posts += 1;
      if (path === "/v1/account")
        return Response.json({ id: config.accountId, livemode: false });
      if (path === "/v1/customers")
        return Response.json({
          data: [{ id: "cus_1", email: "alex@example.com", livemode: false }],
          has_more: false,
        });
      if (path === "/v1/checkout/sessions")
        return Response.json({
          data: [
            {
              id: "cs_1",
              customer: "cus_1",
              customer_details: { email: "alex@example.com" },
              payment_intent: "pi_1",
              status: "complete",
              payment_status: "paid",
              livemode: false,
              created: 1,
            },
          ],
          has_more: false,
        });
      if (path === "/v1/payment_intents/pi_1")
        return Response.json({
          id: "pi_1",
          livemode: false,
          currency: "usd",
          amount_received: 1000,
          status: "succeeded",
        });
      if (path === "/v1/checkout/sessions/cs_1/line_items")
        return Response.json({ data: [], has_more: false });
      if (path === "/v1/refunds")
        return Response.json({
          data: [
            {
              id: "re_old",
              livemode: false,
              currency: "usd",
              amount: 900,
              reason: "requested_by_customer",
              created: 1,
              status: "succeeded",
            },
          ],
          has_more: false,
        });
      throw new Error(`unexpected ${path}`);
    });
    await expect(
      client.quoteRefund(
        {
          binding,
          approvalCaseId: "case_1",
          orderId: "cs_1",
          amount: { currency: "USD", minor: 101 },
          reason: "duplicate",
          idempotencyKey: "key",
          fingerprint: "fp",
        },
        "alex@example.com",
      ),
    ).rejects.toThrow("remaining balance");
    expect(posts).toBe(0);
  });

  it("rejects incomplete Checkout and unpaid InvoicePayment targets before a refund can be quoted", async () => {
    const client = new StripeClient(config, async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/v1/account")
        return Response.json({ id: config.accountId });
      if (path === "/v1/customers")
        return Response.json({
          data: [{ id: "cus_1", email: "alex@example.com", livemode: false }],
          has_more: false,
        });
      if (path === "/v1/checkout/sessions")
        return Response.json({
          data: [
            {
              id: "cs_unpaid",
              customer: "cus_1",
              customer_details: { email: "alex@example.com" },
              payment_intent: "pi_1",
              status: "open",
              payment_status: "unpaid",
              livemode: false,
            },
          ],
          has_more: false,
        });
      throw new Error(`unexpected ${path}`);
    });
    await expect(client.findOrder(binding, "alex@example.com")).rejects.toThrow(
      "complete and paid",
    );
  });

  it.each([
    {
      name: "an InvoicePayment belonging to a different Invoice",
      payment: {
        id: "inpay_wrong_invoice",
        invoice: "in_other",
        status: "paid",
        payment: { type: "payment_intent", payment_intent: "pi_1" },
        livemode: false,
      },
    },
    {
      name: "an unpaid InvoicePayment for the selected Invoice",
      payment: {
        id: "inpay_unpaid",
        invoice: "in_1",
        status: "open",
        paid: false,
        payment: { type: "payment_intent", payment_intent: "pi_1" },
        livemode: false,
      },
    },
  ])(
    "rejects $name before choosing a refund PaymentIntent",
    async ({ payment }) => {
      let posts = 0;
      const client = new StripeClient(config, async (request) => {
        const path = new URL(request.url).pathname;
        if (request.method === "POST") posts += 1;
        if (path === "/v1/account")
          return Response.json({ id: config.accountId, livemode: false });
        if (path === "/v1/customers")
          return Response.json({
            data: [{ id: "cus_1", email: "alex@example.com", livemode: false }],
            has_more: false,
          });
        if (path === "/v1/subscriptions")
          return Response.json({
            data: [
              {
                id: "sub_1",
                customer: "cus_1",
                latest_invoice: "in_1",
                status: "active",
                livemode: false,
                items: {
                  data: [
                    {
                      current_period_end: 2,
                      price: {
                        id: "price_1",
                        currency: "usd",
                        unit_amount: 1000,
                      },
                    },
                  ],
                },
              },
            ],
            has_more: false,
          });
        if (path === "/v1/invoices/in_1")
          return Response.json({
            id: "in_1",
            customer: "cus_1",
            status: "paid",
            paid: true,
            livemode: false,
          });
        if (path === "/v1/invoice_payments")
          return Response.json({ data: [payment], has_more: false });
        throw new Error(`unexpected ${request.method} ${path}`);
      });
      await expect(
        client.findSubscription(binding, "alex@example.com"),
      ).rejects.toThrow("exactly one PaymentIntent");
      expect(posts).toBe(0);
    },
  );

  it("keeps an undocumented provider state recoverable instead of claiming a failed or issued refund", async () => {
    const client = new StripeClient(config, async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/v1/account")
        return Response.json({ id: config.accountId });
      if (path === "/v1/refunds/re_unknown")
        return Response.json({
          id: "re_unknown",
          livemode: false,
          currency: "usd",
          amount: 1000,
          created: 1,
          status: "requires_action",
          metadata: { support_case_id: "case_1", command_fingerprint: "fp" },
        });
      throw new Error(`unexpected ${path}`);
    });
    await expect(
      client.retrieveRefund(binding, "re_unknown", "cs_1", "key", {
        caseId: "case_1",
        fingerprint: "fp",
        amountMinor: 1000,
        currency: "USD",
      }),
    ).resolves.toMatchObject({
      status: "unknown",
      providerStatus: "requires_action",
    });
  });

  it.each([true, "false", null])(
    "rejects an explicit non-test Refund livemode value of %j",
    async (livemode) => {
      const client = new StripeClient(config, async (request) => {
        const path = new URL(request.url).pathname;
        if (path === "/v1/account")
          return Response.json({ id: config.accountId });
        if (path === "/v1/refunds/re_live")
          return Response.json({
            id: "re_live",
            livemode,
            currency: "usd",
            amount: 1000,
            created: 1,
            status: "succeeded",
            metadata: { support_case_id: "case_1", command_fingerprint: "fp" },
          });
        throw new Error(`unexpected ${path}`);
      });
      await expect(
        client.retrieveRefund(binding, "re_live", "cs_1", "key", {
          caseId: "case_1",
          fingerprint: "fp",
          amountMinor: 1000,
          currency: "USD",
        }),
      ).rejects.toThrow();
    },
  );

  it("runs the last refund fence after account verification and before its first POST", async () => {
    const calls: string[] = [];
    const client = new StripeClient(config, async (request) => {
      const path = new URL(request.url).pathname;
      calls.push(`${request.method}:${path}`);
      if (path === "/v1/account")
        return Response.json({ id: config.accountId, livemode: false });
      if (path === "/v1/refunds") throw new Error("stale worker posted");
      throw new Error(`unexpected ${request.method} ${path}`);
    });
    await expect(
      client.createRefundForRequest(
        {
          binding,
          approvalCaseId: "case_1",
          orderId: "order_1",
          amount: { currency: "USD", minor: 2000 },
          reason: "requested_by_customer",
          idempotencyKey: "refund:case_1",
          fingerprint: "refund-fingerprint",
        },
        { paymentIntentId: "pi_1", providerRefs: [] },
        async () => {
          expect(calls).toEqual(["GET:/v1/account"]);
          throw new Error("stale dispatch lease");
        },
      ),
    ).rejects.toThrow("stale dispatch lease");
    expect(calls).toEqual(["GET:/v1/account"]);
  });

  it("runs the cancellation fence directly before its first POST", async () => {
    const calls: string[] = [];
    const client = new StripeClient(config, async (request) => {
      calls.push(`${request.method}:${new URL(request.url).pathname}`);
      throw new Error("stale worker posted");
    });
    await expect(
      client.createSubscriptionCancellation(
        {
          caseId: "case_1",
          turnId: "turn_1",
          ownerId: "customer-alex",
          binding,
          subscriptionId: "sub_1",
          cancellationMode: "period_end",
          sourceMessageId: "message_1",
          sourceMessageHash: "message-hash",
          idempotencyKey: "cancel:case_1",
          fingerprint: "cancel-fingerprint",
        },
        async () => {
          expect(calls).toEqual([]);
          throw new Error("stale dispatch lease");
        },
      ),
    ).rejects.toThrow("stale dispatch lease");
    expect(calls).toEqual([]);
  });
});
