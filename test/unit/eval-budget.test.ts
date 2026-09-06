import { describe, expect, it } from "vitest";
import {
  EvalBudgetLedger,
  withReservedModelBudget,
} from "../../src/mastra/lib/eval-budget";

describe("eval budget ledger", () => {
  it("reserves before a call, reconciles actual usage, and fails closed at the exact limit", () => {
    const budget = new EvalBudgetLedger("ci-eval");
    const reservation = budget.reserve(5_000_000n);
    expect(() => budget.reserve(1n)).toThrow("budget exhausted");
    budget.reconcile(reservation, 5_000_000n);
    expect(budget.snapshot()).toMatchObject({
      actualMicros: 5_000_000n,
      reservedMicros: 0n,
    });
    expect(() => budget.reserve(1n)).toThrow("budget exhausted");
    expect(() => budget.reconcile(reservation, 1n)).toThrow("Unknown, foreign");
    expect(() => budget.reserve(0n)).toThrow("unknown or invalid");
    const other = new EvalBudgetLedger("ci-eval").reserve(1n);
    expect(() => budget.reconcile(other, -1n)).toThrow("Unknown, foreign");
  });

  it("rejects a copied foreign reservation and reserves before optional billable work", async () => {
    const first = new EvalBudgetLedger("sandbox");
    const reservation = first.reserve(1n);
    const foreign = new EvalBudgetLedger("sandbox");
    expect(() => foreign.reconcile(reservation, 1n)).toThrow(
      "Unknown, foreign",
    );
    let invoked = false;
    await expect(
      withReservedModelBudget({
        mode: "sandbox",
        estimatedMicrosUsd: 10_000_001n,
        execute: async () => {
          invoked = true;
          return { value: "should-not-run", actualMicrosUsd: 1n };
        },
      }),
    ).rejects.toThrow("budget exhausted");
    expect(invoked).toBe(false);
  });
});
