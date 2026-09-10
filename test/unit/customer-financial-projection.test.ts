import { describe, expect, it } from "vitest";
import { customerReceiptState } from "../../src/mastra/lib/case-store-actions";

const command = {
  binding: { providerKind: "stripe" },
  orderId: "ord_1",
  amount: { minor: 500, currency: "USD" },
  idempotencyKey: "credit_1",
};

describe("customer financial receipt projection", () => {
  it("marks only a matching settled Stripe receipt as executed", () => {
    expect(
      customerReceiptState("refund-command", command, {
        status: "succeeded",
        orderId: "ord_1",
        amount: { minor: 500, currency: "USD" },
        idempotencyKey: "credit_1",
      }),
    ).toBe("executed");
  });

  it("does not present pending, unknown, failed, retained, or mismatched receipts as successful", () => {
    for (const receipt of [
      { status: "pending" },
      { status: "unknown" },
      { status: "failed" },
      { retention: "terminal-financial-effect" },
      {
        status: "succeeded",
        orderId: "ord_other",
        amount: { minor: 500, currency: "USD" },
        idempotencyKey: "credit_1",
      },
    ])
      expect(customerReceiptState("refund-command", command, receipt)).not.toBe(
        "executed",
      );
  });

  it("accepts the matching synchronous local receipt without a provider status", () => {
    expect(
      customerReceiptState(
        "refund-command",
        { ...command, binding: { providerKind: "local" } },
        {
          orderId: "ord_1",
          amount: { minor: 500, currency: "USD" },
          idempotencyKey: "credit_1",
        },
      ),
    ).toBe("executed");
  });
});
