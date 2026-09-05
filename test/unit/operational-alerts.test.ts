import { describe, expect, it } from "vitest";
import {
  alertReasons,
  classifyFailure,
} from "../../src/mastra/lib/operational-alerts";

describe("operational alert policy", () => {
  it("alerts for any refund failure, >2% errors, and p95 over five seconds", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const signals = Array.from({ length: 100 }, (_, index) => ({
      providerOrTool: "lookup",
      occurredAt: now,
      durationMs: index >= 94 ? 5_001 : 10,
      failed: index === 0,
    }));
    expect(alertReasons(signals, now)).toContain("p95-latency");
    expect(classifyFailure({ ...signals[0]!, refundFailure: true })).toBe(
      "escalate",
    );
    expect(classifyFailure(signals[0]!)).toBe("retry");
    expect(
      alertReasons(
        [
          ...signals,
          {
            providerOrTool: "refund",
            occurredAt: now,
            durationMs: 1,
            failed: true,
            refundFailure: true,
          },
        ],
        now,
      ),
    ).toContain("refund-failure");
  });
});
