import type { ContextWithMastra } from "@mastra/core/server";
import { resourceIdForOwner, threadIdForCase } from "../domain/support-case";
import { withTrustedCaseReadScope } from "../lib/trusted-run-scope";
import { caseStore } from "../lib/case-store";
import { bindingsForCase } from "../providers/contracts";
import { ensureStudioSupervisorDemoCase } from "../runtime/studio-seed";
import {
  canAccessCase,
  hasRole,
  isForeignCookieMutation,
  studioPrincipalFromHeaders,
} from "./auth";
import {
  supportSupervisorInstructions,
  supportSupervisorModel,
} from "../agents/support-supervisor";

const nativeSupervisorRoute =
  /^\/api\/agents\/support-supervisor\/(?:generate|stream|send-message|signals|threads\/subscribe)$/;
const scopedStudioMemoryRoute = (path: string, method: string) =>
  (method === "GET" &&
    /^\/api\/memory\/(?:status|config|threads(?:\/[^/]+(?:\/messages)?)?)$/.test(
      path,
    )) ||
  (method === "POST" && path === "/api/memory/threads");

type StudioExecutionBody = Record<string, unknown>;

function bodyIsRecord(value: unknown): value is StudioExecutionBody {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function allowedModelSetting(value: unknown) {
  return value === undefined || value === supportSupervisorModel;
}

function requestedCaseId(body: StudioExecutionBody) {
  return typeof body.caseId === "string" && body.caseId.trim()
    ? body.caseId
    : undefined;
}

function hasForbiddenExecutionOverride(body: StudioExecutionBody) {
  if (!allowedModelSetting(body.model)) return true;
  if (
    body.instructions !== undefined &&
    body.instructions !== supportSupervisorInstructions
  )
    return true;
  if (body.system !== undefined || body.context !== undefined) return true;
  if (body.requestContext && Object.keys(body.requestContext as object).length)
    return true;
  if (body.activeTools !== undefined || body.toolsets !== undefined)
    return true;
  if (
    body.clientTools !== undefined &&
    (!bodyIsRecord(body.clientTools) || Object.keys(body.clientTools).length)
  )
    return true;
  if (body.tools !== undefined) return true;
  if (body.toolChoice !== undefined && body.toolChoice !== "auto") return true;
  if (
    body.requireToolApproval !== undefined &&
    body.requireToolApproval !== false
  )
    return true;
  if (body.scorers !== undefined || body.structuredOutput !== undefined)
    return true;
  if (body.versions !== undefined || body.output !== undefined) return true;
  const idle = body.ifIdle;
  if (bodyIsRecord(idle) && idle.streamOptions !== undefined) {
    if (!bodyIsRecord(idle.streamOptions)) return true;
    if (hasForbiddenExecutionOverride(idle.streamOptions)) return true;
  }
  return false;
}

function clientThreadId(body: StudioExecutionBody) {
  const memory = body.memory;
  if (bodyIsRecord(memory)) {
    const thread = memory.thread;
    if (typeof thread === "string") return thread;
    if (bodyIsRecord(thread) && typeof thread.id === "string") return thread.id;
  }
  return typeof body.threadId === "string" ? body.threadId : undefined;
}

function clientResourceId(body: StudioExecutionBody) {
  const memory = body.memory;
  if (bodyIsRecord(memory) && typeof memory.resource === "string")
    return memory.resource;
  return typeof body.resourceId === "string" ? body.resourceId : undefined;
}

/**
 * The built-in Studio handlers parse client options, so this boundary runs
 * before them and establishes authority solely from a verified bearer token
 * and a durable case.  It deliberately leaves normal stream tuning alone but
 * refuses every client-controlled capability or instruction override.
 */
export async function studioSupervisorMiddleware(
  c: ContextWithMastra,
  next: () => Promise<void>,
) {
  if (isForeignCookieMutation(c.req.raw))
    return c.json({ error: "Cross-origin cookie mutation denied." }, 403);
  const path = new URL(c.req.url).pathname;
  const isNativeSupervisor = nativeSupervisorRoute.test(path);
  const isScopedMemory = scopedStudioMemoryRoute(path, c.req.method);
  if (!isNativeSupervisor && !isScopedMemory) return next();
  if (isNativeSupervisor && c.req.method !== "POST")
    return c.json({ error: "Method not allowed." }, 405);

  const principal = studioPrincipalFromHeaders(c.req.raw.headers);
  if (!principal) return c.json({ error: "Authentication required." }, 401);
  if (
    principal.tenantId !== "local-demo" ||
    (!hasRole(principal, "support-agent") && !hasRole(principal, "admin"))
  )
    return c.json({ error: "Insufficient authority." }, 403);

  if (isScopedMemory) {
    const agentId = new URL(c.req.url).searchParams.get("agentId");
    if (agentId && agentId !== "support-supervisor")
      return c.json(
        { error: "Memory is limited to the support supervisor." },
        403,
      );
    const supportCase = await ensureStudioSupervisorDemoCase();
    const ownerId = supportCase.metadata.ownerId;
    if (typeof ownerId !== "string" || !ownerId)
      return c.json({ error: "Case has no verified owner." }, 409);
    const binding = bindingsForCase(supportCase).support;
    const requestContext = c.get("requestContext");
    requestContext.setRaw(
      "mastra__resourceId",
      resourceIdForOwner(ownerId, binding.tenantId),
    );
    requestContext.setRaw(
      "mastra__threadId",
      threadIdForCase(supportCase.id, binding.tenantId),
    );
    return withTrustedCaseReadScope(
      { caseId: supportCase.id, ownerId, tenantId: binding.tenantId },
      next,
    );
  }

  let body: StudioExecutionBody;
  try {
    const parsed = await c.req.raw.clone().json();
    if (!bodyIsRecord(parsed)) throw new Error("body must be an object");
    body = parsed;
  } catch {
    return c.json({ error: "Invalid Studio request." }, 400);
  }
  if (hasForbiddenExecutionOverride(body))
    return c.json(
      { error: "Studio execution overrides are not allowed." },
      403,
    );

  const defaultCase = await ensureStudioSupervisorDemoCase();
  const supportCase = requestedCaseId(body)
    ? await caseStore.get(requestedCaseId(body)!)
    : defaultCase;
  if (!supportCase || !canAccessCase(principal, supportCase))
    return c.json({ error: "Case access denied." }, 403);
  const ownerId = supportCase.metadata.ownerId;
  if (typeof ownerId !== "string" || !ownerId)
    return c.json({ error: "Case has no verified owner." }, 409);
  const binding = bindingsForCase(supportCase).support;
  if (binding.tenantId !== principal.tenantId)
    return c.json({ error: "Case access denied." }, 403);

  const resourceId = resourceIdForOwner(ownerId, binding.tenantId);
  const requestedResource = clientResourceId(body);
  if (
    requestedResource !== undefined &&
    ![resourceId, "support-supervisor"].includes(requestedResource)
  )
    return c.json({ error: "Foreign memory is not allowed." }, 403);

  const requestContext = c.get("requestContext");
  requestContext.setRaw("mastra__resourceId", resourceId);
  requestContext.setRaw(
    "mastra__threadId",
    threadIdForCase(supportCase.id, binding.tenantId),
  );
  const requestedThread = clientThreadId(body);
  if (requestedThread) {
    const memory = await c
      .get("mastra")
      .getAgent("supportSupervisorAgent")
      .getMemory({ requestContext });
    const existing = memory
      ? await memory.getThreadById({ threadId: requestedThread })
      : undefined;
    if (existing?.resourceId && existing.resourceId !== resourceId)
      return c.json({ error: "Foreign memory is not allowed." }, 403);
  }
  return withTrustedCaseReadScope(
    { caseId: supportCase.id, ownerId, tenantId: binding.tenantId },
    next,
  );
}
