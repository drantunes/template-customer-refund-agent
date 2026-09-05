/** Exact-microusd reservation ledger for eval and sandbox model calls.
 * Pricing is deliberately caller-supplied: unknown or non-finite usage/prices
 * fail before a request can be made instead of quietly recording a $0 cost. */
export type BudgetMode = "ci-eval" | "sandbox";
export const budgetLimitMicros: Record<BudgetMode, bigint> = {
  "ci-eval": 5_000_000n,
  sandbox: 10_000_000n,
};

export class EvalBudgetLedger {
  private reserved = 0n;
  private actual = 0n;
  private readonly reservations = new Map<string, bigint>();
  constructor(readonly mode: BudgetMode) {}

  reserve(estimatedMicros: bigint) {
    if (estimatedMicros <= 0n)
      throw new Error("Model request has unknown or invalid price estimate.");
    if (
      this.actual + this.reserved + estimatedMicros >
      budgetLimitMicros[this.mode]
    )
      throw new Error(`Evaluation budget exhausted for ${this.mode}.`);
    this.reserved += estimatedMicros;
    const id = crypto.randomUUID();
    this.reservations.set(id, estimatedMicros);
    return { id, estimatedMicros };
  }

  reconcile(
    reservation: { id: string; estimatedMicros: bigint },
    actualMicros: bigint,
  ) {
    const reservedMicros = this.reservations.get(reservation.id);
    if (
      reservedMicros === undefined ||
      reservation.estimatedMicros !== reservedMicros
    )
      throw new Error(
        "Unknown, foreign, or already reconciled budget reservation.",
      );
    if (actualMicros < 0n)
      throw new Error("Model request has unknown or invalid actual usage.");
    if (actualMicros > reservedMicros)
      throw new Error("Actual model usage exceeded the pre-call reservation.");
    this.actual += actualMicros;
    this.reserved -= reservedMicros;
    this.reservations.delete(reservation.id);
  }

  snapshot() {
    return {
      reservedMicros: this.reserved,
      actualMicros: this.actual,
      limitMicros: budgetLimitMicros[this.mode],
    };
  }
}
