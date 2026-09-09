import { describe, expect, it } from "vitest";
import { caseForFollowUp } from "./portal";
import type { SupportCase } from "@/lib/types";

describe("portal follow-up selection", () => {
  it("uses the explicitly selected case instead of the list order", () => {
    const older = { id: "case-older", subject: "Older case" } as SupportCase;
    const newer = { id: "case-newer", subject: "Newer case" } as SupportCase;

    expect(caseForFollowUp([newer, older], older.id)).toBe(older);
    expect(caseForFollowUp([newer, older], "missing")).toBeUndefined();
  });
});
