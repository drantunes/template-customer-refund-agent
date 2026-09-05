import { createHash } from "node:crypto";
import type { Money, RefundCommand } from "../providers/contracts";

export function money(currency: string, minor: number): Money {
  if (!/^[A-Z]{3}$/.test(currency))
    throw new Error("Currency must be an ISO 4217 uppercase code.");
  if (!Number.isSafeInteger(minor) || minor < 0)
    throw new Error(
      "Money must be a non-negative safe integer minor-unit value.",
    );
  return { currency, minor };
}

/** Compatibility conversion is allowed only at the existing agent/UI edge. */
export function legacyAmountToMoney(amount: number, currency: string): Money {
  if (!Number.isFinite(amount) || amount <= 0)
    throw new Error("Refund amount must be positive.");
  const minor = Math.round(amount * 100);
  if (Math.abs(amount * 100 - minor) > 1e-8)
    throw new Error(
      "Refund amount has more precision than the currency supports.",
    );
  return money(currency, minor);
}

export function moneyToLegacyAmount(value: Money): number {
  return value.minor / 100;
}

export function refundFingerprint(
  command: Omit<RefundCommand, "fingerprint">,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        approvalCaseId: command.approvalCaseId,
        tenantId: command.binding.tenantId,
        account: command.binding.providerAccountId,
        orderId: command.orderId,
        currency: command.amount.currency,
        minor: command.amount.minor,
        reason: command.reason,
        idempotencyKey: command.idempotencyKey,
      }),
    )
    .digest("hex");
}
