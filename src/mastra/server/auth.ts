import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { MastraAuthProvider } from "@mastra/core/server";

/** The local mode intentionally has only synthetic identities.  Passwords are
 * accepted only by the login route; every subsequent request uses a signed,
 * expiring server-verifiable session token. */
export type SupportRole = "customer" | "support-agent" | "approver" | "admin";
export interface SupportPrincipal {
  id: string;
  email: string;
  tenantId: string;
  roles: SupportRole[];
  expiresAt: string;
}

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const signingKey = () => {
  const value = process.env.LOCAL_AUTH_SIGNING_KEY;
  if (!value || value.length < 32)
    throw new Error(
      "LOCAL_AUTH_SIGNING_KEY must contain at least 32 characters.",
    );
  return value;
};
const seeded = [
  {
    id: "customer-alex",
    email: "alex@example.com",
    password: "local-customer-alex",
    tenantId: "local-demo",
    roles: ["customer"] as SupportRole[],
  },
  {
    id: "customer-jordan",
    email: "jordan@example.com",
    password: "local-customer-jordan",
    tenantId: "local-demo",
    roles: ["customer"] as SupportRole[],
  },
  {
    id: "support-agent-demo",
    email: "agent@local.test",
    password: "local-support-agent",
    tenantId: "local-demo",
    roles: ["support-agent"] as SupportRole[],
  },
  {
    id: "approver-demo",
    email: "approver@local.test",
    password: "local-approver",
    tenantId: "local-demo",
    roles: ["approver"] as SupportRole[],
  },
  {
    id: "admin-demo",
    email: "admin@local.test",
    password: "local-admin",
    tenantId: "local-demo",
    roles: ["admin"] as SupportRole[],
  },
  {
    id: "other-tenant-agent",
    email: "agent@other.test",
    password: "local-other-agent",
    tenantId: "other-tenant",
    roles: ["support-agent"] as SupportRole[],
  },
] as const;

function encoded(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
function signature(payload: string) {
  return createHmac("sha256", signingKey()).update(payload).digest("base64url");
}
function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function issueLocalSession(
  identity: Pick<SupportPrincipal, "id">,
  expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString(),
) {
  // Claims are never capability-bearing: tenant and roles are looked up from
  // the local identity registry on every request.
  const payload = encoded({ id: identity.id, expiresAt, nonce: randomUUID() });
  return `${payload}.${signature(payload)}`;
}
export function verifyLocalSession(
  token: string,
): SupportPrincipal | undefined {
  const [payload, provided] = token.split(".");
  if (!payload || !provided || !safeEqual(signature(payload), provided))
    return undefined;
  try {
    const parsed = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as { id?: string; expiresAt?: string };
    const expires = Date.parse(parsed.expiresAt ?? "");
    if (!parsed.id || !Number.isFinite(expires) || expires <= Date.now())
      return undefined;
    const identity = seeded.find((entry) => entry.id === parsed.id);
    if (!identity) return undefined;
    return {
      id: identity.id,
      email: identity.email,
      tenantId: identity.tenantId,
      roles: [...identity.roles],
      expiresAt: new Date(expires).toISOString(),
    };
  } catch {
    return undefined;
  }
}
export function authenticateSeededCredentials(email: string, password: string) {
  const identity = seeded.find(
    (entry) =>
      entry.email.toLowerCase() === email.toLowerCase() &&
      entry.password === password,
  );
  return identity ? issueLocalSession({ id: identity.id }) : undefined;
}
export function ownerIdForCustomer(tenantId: string, email: string) {
  return seeded.find(
    (entry) =>
      entry.tenantId === tenantId &&
      entry.roles.includes("customer") &&
      entry.email.toLowerCase() === email.toLowerCase(),
  )?.id;
}
export function activePrincipalHasRole(
  id: string,
  tenantId: string,
  role: SupportRole,
) {
  return seeded.some(
    (entry) =>
      entry.id === id &&
      entry.tenantId === tenantId &&
      entry.roles.includes(role),
  );
}
export function principalFromHeaders(
  headers: Headers,
): SupportPrincipal | undefined {
  const value = headers.get("authorization");
  if (!value?.startsWith("Bearer ")) return undefined;
  return verifyLocalSession(value.slice("Bearer ".length));
}
export function canAccessCase(
  principal: SupportPrincipal,
  supportCase: {
    customer: { email: string };
    metadata: Record<string, unknown>;
  },
) {
  const binding = supportCase.metadata.providerBinding as
    { tenantId?: string } | undefined;
  if (binding?.tenantId !== principal.tenantId) return false;
  if (
    principal.roles.some(
      (role) =>
        role === "admin" || role === "support-agent" || role === "approver",
    )
  )
    return true;
  return supportCase.metadata.ownerId === principal.id;
}
export function hasRole(principal: SupportPrincipal, role: SupportRole) {
  return principal.roles.includes(role);
}

export class LocalSupportAuthProvider extends MastraAuthProvider<SupportPrincipal> {
  constructor() {
    super({
      name: "local-support-auth",
      protected: ["/*"],
      public: ["/health", "/support/auth/login"],
    });
  }
  async authenticateToken(token: string) {
    return verifyLocalSession(token) ?? null;
  }
  async signIn(email: string, password: string, _request: Request) {
    const token = authenticateSeededCredentials(email, password);
    const user = token ? verifyLocalSession(token) : undefined;
    if (!token || !user) throw new Error("Invalid local credentials.");
    return { user, token };
  }
  async getCurrentUser(request: Request) {
    return principalFromHeaders(request.headers) ?? null;
  }
  isSignUpEnabled() {
    return false;
  }
  async authorizeUser(user: SupportPrincipal, request: unknown) {
    const expires = Date.parse(user.expiresAt);
    if (!Number.isFinite(expires) || expires <= Date.now()) return false;
    const rawRequest =
      typeof request === "object" && request !== null && "raw" in request
        ? request.raw
        : request;
    const requestUrl =
      typeof rawRequest === "object" &&
      rawRequest !== null &&
      "url" in rawRequest
        ? String(rawRequest.url)
        : "/";
    const path = new URL(requestUrl, "http://local").pathname;
    // Custom support routes enforce their own tenant/owner checks. Studio has
    // one explicit local, staff-only metadata scope. Every data-bearing or
    // executable built-in route remains denied because it has no tenant-safe
    // generic scoping contract in this phase.
    if (path.startsWith("/support/")) return true;
    const method =
      typeof rawRequest === "object" &&
      rawRequest !== null &&
      "method" in rawRequest
        ? String(rawRequest.method).toUpperCase()
        : "GET";
    const studioRegistryIds = {
      agents: new Set([
        "triage-agent",
        "response-agent",
        "support-supervisor",
        "refund-execution-agent",
      ]),
      tools: new Set([
        "search_support_knowledge",
        "lookup_order",
        "lookup_subscription",
        "lookup_customer_refund_history",
        "issue_refund",
      ]),
      workflows: new Set([
        "ingest-support-case",
        "resolve-support-case",
        "index-support-knowledge",
      ]),
    };
    const metadataRoute = path.match(
      /^(?:\/api)?\/(agents|tools|workflows)(?:\/([^/]+))?$/,
    );
    const isRegistryMetadata =
      metadataRoute !== null &&
      (metadataRoute[2] === undefined ||
        studioRegistryIds[
          metadataRoute[1] as keyof typeof studioRegistryIds
        ].has(metadataRoute[2]));
    if (
      method === "GET" &&
      user.tenantId === "local-demo" &&
      user.roles.some((role) => role === "support-agent" || role === "admin") &&
      isRegistryMetadata
    )
      return true;
    return false;
  }
  mapUserToResourceId(user: SupportPrincipal) {
    return `tenant:${user.tenantId}:owner:${user.id}`;
  }
}
