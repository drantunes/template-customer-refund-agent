import type {
  InboundSupportResponse,
  MockEmailPayload,
  MonitoringSummary,
  SupportCase,
} from "./types";

export type SupportSession = {
  token: string;
  expiresAt: string;
  principal: {
    id: string;
    email: string;
    tenantId: string;
    roles: Array<"customer" | "support-agent" | "approver" | "admin">;
  };
};

const SESSION_STORAGE_KEY = "support-demo:session";

export function currentSession(): SupportSession | undefined {
  try {
    const value = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!value) return undefined;
    const session = JSON.parse(value) as SupportSession;
    if (!session.token || Date.parse(session.expiresAt) <= Date.now()) {
      localStorage.removeItem(SESSION_STORAGE_KEY);
      return undefined;
    }
    return session;
  } catch {
    return undefined;
  }
}

export function clearSession() {
  localStorage.removeItem(SESSION_STORAGE_KEY);
}

export async function login(email: string, password: string) {
  const session = await request<SupportSession>("/support/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  return session;
}

// In dev, Vite proxies `/support/*` to the Mastra API server (see vite.config.ts).
// In production, point VITE_API_BASE_URL at wherever the Mastra app is deployed.
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "";

async function request<T>(
  path: string,
  init?: RequestInit,
  session = currentSession(),
): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(session ? { authorization: `Bearer ${session.token}` } : {}),
      ...init?.headers,
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      body?.error ?? `Request failed: ${res.status} ${res.statusText}`,
    );
  }
  return body as T;
}

export function listCases(
  session?: SupportSession,
): Promise<{ cases: SupportCase[] }> {
  return request<{ cases?: SupportCase[] }>(
    "/support/cases",
    undefined,
    session,
  ).then((response) => {
    if (!Array.isArray(response.cases)) {
      throw new Error("Support API returned an invalid case-list response.");
    }
    return { cases: response.cases };
  });
}

export function getCase(caseId: string): Promise<SupportCase> {
  return request(`/support/cases/${caseId}`);
}

export function submitCase(
  payload: MockEmailPayload,
  session?: SupportSession,
): Promise<InboundSupportResponse> {
  return request(
    "/support/inbound",
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
    session,
  );
}

export function approveCase(
  caseId: string,
  commandFingerprint: string,
  note?: string,
  session?: SupportSession,
): Promise<SupportCase> {
  return request(
    `/support/cases/${caseId}/approve`,
    {
      method: "POST",
      body: JSON.stringify({ commandFingerprint, note }),
    },
    session,
  );
}

export function rejectCase(
  caseId: string,
  commandFingerprint: string,
  note?: string,
  session?: SupportSession,
): Promise<SupportCase> {
  return request(
    `/support/cases/${caseId}/reject`,
    {
      method: "POST",
      body: JSON.stringify({ commandFingerprint, note }),
    },
    session,
  );
}

export function submitFollowUp(
  caseId: string,
  body: string,
  session?: SupportSession,
): Promise<SupportCase> {
  return request(
    `/support/cases/${caseId}/follow-ups`,
    {
      method: "POST",
      body: JSON.stringify({ body }),
    },
    session,
  );
}

export function reindexKnowledge(
  session?: SupportSession,
): Promise<{ indexed: number }> {
  return request("/support/knowledge/reindex", { method: "POST" }, session);
}

export function submitCaseFeedback(
  caseId: string,
  rating: "up" | "down",
  responseMessageId: string,
  comment?: string,
  session?: SupportSession,
): Promise<SupportCase> {
  return request(
    `/support/cases/${caseId}/feedback`,
    {
      method: "POST",
      body: JSON.stringify({ rating, responseMessageId, comment }),
    },
    session,
  );
}

export function getMonitoringSummary(
  session?: SupportSession,
): Promise<MonitoringSummary> {
  return request("/support/monitoring/summary", undefined, session);
}

/** A case is still moving through the pipeline and worth polling for updates. */
export function isCaseActive(status: SupportCase["status"]): boolean {
  return (
    status === "new" || status === "processing" || status === "waiting_approval"
  );
}
