import type {
  InboundSupportResponse,
  MockEmailPayload,
  MonitoringSummary,
  SupportCase,
} from "./types";

// In dev, Vite proxies `/support/*` to the Mastra API server (see vite.config.ts).
// In production, point VITE_API_BASE_URL at wherever the Mastra app is deployed.
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      body?.error ?? `Request failed: ${res.status} ${res.statusText}`,
    );
  }
  return body as T;
}

export function listCases(email?: string): Promise<{ cases: SupportCase[] }> {
  const query = email ? `?email=${encodeURIComponent(email)}` : "";
  return request<{ cases?: SupportCase[] }>(`/support/cases${query}`).then(
    (response) => {
      if (!Array.isArray(response.cases)) {
        throw new Error("Support API returned an invalid case-list response.");
      }
      return { cases: response.cases };
    },
  );
}

export function getCase(caseId: string): Promise<SupportCase> {
  return request(`/support/cases/${caseId}`);
}

export function submitCase(
  payload: MockEmailPayload,
): Promise<InboundSupportResponse> {
  return request("/support/inbound", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function approveCase(
  caseId: string,
  approverId: string,
  note?: string,
): Promise<SupportCase> {
  return request(`/support/cases/${caseId}/approve`, {
    method: "POST",
    body: JSON.stringify({ approverId, note }),
  });
}

export function rejectCase(
  caseId: string,
  approverId: string,
  note?: string,
): Promise<SupportCase> {
  return request(`/support/cases/${caseId}/reject`, {
    method: "POST",
    body: JSON.stringify({ approverId, note }),
  });
}

export function reindexKnowledge(): Promise<{ indexed: number }> {
  return request("/support/knowledge/reindex", { method: "POST" });
}

export function submitCaseFeedback(
  caseId: string,
  rating: "up" | "down",
  comment?: string,
): Promise<SupportCase> {
  return request(`/support/cases/${caseId}/feedback`, {
    method: "POST",
    body: JSON.stringify({ rating, comment }),
  });
}

export function getMonitoringSummary(): Promise<MonitoringSummary> {
  return request("/support/monitoring/summary");
}

/** A case is still moving through the pipeline and worth polling for updates. */
export function isCaseActive(status: SupportCase["status"]): boolean {
  return (
    status === "new" || status === "processing" || status === "waiting_approval"
  );
}
