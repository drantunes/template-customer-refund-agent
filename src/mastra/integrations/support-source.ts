import type { CaseSource, SupportCase } from "../domain/support-case";

export interface SupportSourceAdapter {
  source: CaseSource;

  normalizeInbound(payload: unknown): Promise<
    Omit<SupportCase, "id" | "status" | "metadata"> & {
      metadata: Record<string, unknown>;
    }
  >;

  sendReply(caseId: string, body: string): Promise<void>;
  addInternalNote(caseId: string, body: string): Promise<void>;
  updateStatus(caseId: string, status: string): Promise<void>;
}

export function generateCaseId(): string {
  return `case_${crypto.randomUUID().slice(0, 8)}`;
}
