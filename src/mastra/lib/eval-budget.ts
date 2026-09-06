/** Exact-microusd reservation ledger for eval and sandbox model calls.
 * Pricing is deliberately caller-supplied: unknown or non-finite usage/prices
 * fail before a request can be made instead of quietly recording a $0 cost. */
export type BudgetMode = "ci-eval" | "sandbox";
export const budgetLimitMicros: Record<BudgetMode, bigint> = {
  "ci-eval": 5_000_000n,
  sandbox: 10_000_000n,
};

export interface BudgetReservation {
  id: string;
  estimatedMicros: bigint;
  /** Opaque ledger identity rejects a reservation from another ledger even if
   * an ID is maliciously copied. It is never exported as telemetry. */
  issuer: string;
}

export class EvalBudgetLedger {
  private reserved = 0n;
  private actual = 0n;
  private readonly reservations = new Map<string, bigint>();
  private readonly issuer = crypto.randomUUID();
  constructor(readonly mode: BudgetMode) {}

  reserve(estimatedMicros: bigint): BudgetReservation {
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
    return { id, estimatedMicros, issuer: this.issuer };
  }

  reconcile(reservation: BudgetReservation, actualMicros: bigint) {
    const reservedMicros = this.reservations.get(reservation.id);
    if (
      reservedMicros === undefined ||
      reservation.estimatedMicros !== reservedMicros ||
      reservation.issuer !== this.issuer
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

const sharedLedgers = new Map<BudgetMode, EvalBudgetLedger>();

/** One process-wide cumulative ledger per DEC-016 execution mode. Callers
 * reserve before optional billable work and reconcile only once real usage is
 * known. No model/provider call is made by this utility. */
export function sharedBudgetLedger(mode: BudgetMode) {
  let ledger = sharedLedgers.get(mode);
  if (!ledger) {
    ledger = new EvalBudgetLedger(mode);
    sharedLedgers.set(mode, ledger);
  }
  return ledger;
}

export async function withReservedModelBudget<T>(input: {
  mode: BudgetMode;
  estimatedMicrosUsd: bigint;
  execute: () => Promise<{ value: T; actualMicrosUsd: bigint }>;
}): Promise<T> {
  const ledger = sharedBudgetLedger(input.mode);
  const reservation = ledger.reserve(input.estimatedMicrosUsd);
  const result = await input.execute();
  ledger.reconcile(reservation, result.actualMicrosUsd);
  return result.value;
}
