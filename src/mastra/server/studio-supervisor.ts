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

const studioWorkflowIds = new Map([
  ["ingestSupportCaseWorkflow", "ingestSupportCaseWorkflow"],
  ["ingest-support-case", "ingestSupportCaseWorkflow"],
  ["resolveSupportCaseWorkflow", "resolveSupportCaseWorkflow"],
  ["resolve-support-case", "resolveSupportCaseWorkflow"],
  ["indexSupportKnowledgeWorkflow", "indexSupportKnowledgeWorkflow"],
  ["index-support-knowledge", "indexSupportKnowledgeWorkflow"],
]);

const workflowRunStatuses = new Set([
  "running",
  "waiting",
  "suspended",
  "success",
  "failed",
  "canceled",
  "pending",
  "bailed",
  "tripwire",
  "paused",
  "skipped",
]);

function historyRoute(path: string) {
  const match = path.match(/^\/api\/workflows\/([^/]+)\/runs(?:\/([^/]+))?$/);
  if (!match) return undefined;
  const workflowId = studioWorkflowIds.get(match[1]);
  return workflowId ? { workflowId, runId: match[2] } : undefined;
}

function snapshotCaseId(snapshot: unknown): string | undefined {
  let value = snapshot;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  // Legacy ingest snapshots have no resourceId. These are stable workflow
  // outputs, not caller input, and bind directly to a durable support case.
  const result = record.result as Record<string, unknown> | undefined;
  if (typeof result?.caseId === "string") return result.caseId;
  const context = record.context as Record<string, unknown> | undefined;
  for (const step of ["normalize-inbound-message", "start-resolution"]) {
    const stepState = context?.[step] as Record<string, unknown> | undefined;
    const output = stepState?.output as Record<string, unknown> | undefined;
    if (typeof output?.caseId === "string") return output.caseId;
  }
  return undefined;
}

function snapshotStatus(snapshot: unknown): string | undefined {
  if (typeof snapshot === "string") {
    try {
      snapshot = JSON.parse(snapshot);
    } catch {
      return undefined;
    }
  }
  return snapshot && typeof snapshot === "object"
    ? ((snapshot as { status?: unknown }).status as string | undefined)
    : undefined;
}

async function studioHistoryResponse(
  c: ContextWithMastra,
  principal: NonNullable<ReturnType<typeof studioPrincipalFromHeaders>>,
  route: { workflowId: string; runId?: string },
) {
  const allCases = await caseStore.list();
  const allowedCases = allCases.filter((supportCase) =>
    canAccessCase(principal, supportCase),
  );
  const allowedCaseIds = new Set(
    allowedCases.map((supportCase) => supportCase.id),
  );
  const allowedResourceIds = new Set(
    allowedCases.flatMap((supportCase) => {
      const ownerId = supportCase.metadata.ownerId;
      const tenantId = supportCase.metadata.providerBinding?.tenantId;
      return typeof ownerId === "string" && tenantId === principal.tenantId
        ? [resourceIdForOwner(ownerId, tenantId)]
        : [];
    }),
  );
  const client = caseStore.getClient();
  const dispatches = await client.execute({
    // The tenant column is authoritative. Local-demo cases may legitimately
    // use a non-local provider account, so account ids are never a history
    // authorization filter.
    sql: "SELECT d.run_id FROM support_dispatch d JOIN support_cases c ON c.id = d.case_id WHERE c.tenant_id = ?",
    args: [principal.tenantId],
  });
  const allowedResolveRunIds = new Set(
    dispatches.rows.map((row) => String(row.run_id)),
  );
  const workflow = c.get("mastra").getWorkflow(route.workflowId);
  const allows = (run: {
    runId: string;
    resourceId?: string;
    snapshot?: unknown;
  }) => {
    if (run.resourceId && allowedResourceIds.has(run.resourceId)) return true;
    if (
      route.workflowId === "resolveSupportCaseWorkflow" &&
      allowedResolveRunIds.has(run.runId)
    )
      return true;
    return (
      route.workflowId === "ingestSupportCaseWorkflow" &&
      !!snapshotCaseId(run.snapshot ?? (run as unknown)) &&
      allowedCaseIds.has(snapshotCaseId(run.snapshot ?? (run as unknown))!)
    );
  };
  const rawRuns = await workflow.listWorkflowRuns({ perPage: false });
  if (route.runId) {
    // Processed detail intentionally omits the raw snapshot envelope. Check
    // its durable list record first so legacy NULL-resource ingest runs retain
    // their case association without making arbitrary history visible.
    const stored = rawRuns.runs.find((run) => run.runId === route.runId);
    const run = await workflow.getWorkflowRunById(route.runId);
    if (!run || !stored || !allows(stored))
      return c.json({ error: "Workflow run not found." }, 404);
    return c.json(run);
  }
  const query = new URL(c.req.url).searchParams;
  const paginationValue = (name: string) => {
    const value = query.get(name);
    if (value === null) return undefined;
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
  };
  const perPageInput = paginationValue("perPage");
  const pageInput = paginationValue("page");
  const limit = paginationValue("limit");
  const offset = paginationValue("offset");
  if (
    perPageInput === null ||
    pageInput === null ||
    limit === null ||
    offset === null
  )
    return c.json({ error: "Invalid pagination." }, 400);
  let perPage = perPageInput;
  let page = pageInput;
  // Match Mastra's combined pagination handler: page/perPage take precedence;
  // legacy offset is converted only when page was omitted and a page size exists.
  if (perPage === undefined && limit !== undefined) perPage = limit;
  if (
    page === undefined &&
    offset !== undefined &&
    perPage !== undefined &&
    perPage > 0
  )
    page = Math.floor(offset / perPage);
  if (perPage !== undefined && perPage <= 0)
    return c.json({ error: "Invalid pagination." }, 400);
  const status = query.get("status") ?? undefined;
  if (status && !workflowRunStatuses.has(status))
    return c.json({ error: "Invalid workflow status." }, 400);
  const parseDate = (value: string | null) =>
    value === null ? undefined : new Date(value);
  const fromDate = parseDate(query.get("fromDate"));
  const toDate = parseDate(query.get("toDate"));
  if (
    (fromDate && Number.isNaN(fromDate.getTime())) ||
    (toDate && Number.isNaN(toDate.getTime()))
  )
    return c.json({ error: "Invalid date filter." }, 400);
  const permitted = rawRuns.runs
    .filter((run) => !status || snapshotStatus(run.snapshot) === status)
    .filter((run) => !fromDate || run.createdAt >= fromDate)
    .filter((run) => !toDate || run.createdAt <= toDate)
    .filter(allows)
    .sort(
      (left, right) => right.createdAt.getTime() - left.createdAt.getTime(),
    );
  const start =
    page === undefined || perPage === undefined ? 0 : page * perPage;
  return c.json({
    runs:
      page === undefined || perPage === undefined
        ? permitted
        : permitted.slice(start, start + perPage),
    total: permitted.length,
  });
}

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
  const requestedHistory = historyRoute(path);
  const isNativeSupervisor = nativeSupervisorRoute.test(path);
  const isScopedMemory = scopedStudioMemoryRoute(path, c.req.method);
  if (!isNativeSupervisor && !isScopedMemory && !requestedHistory)
    return next();
  if (requestedHistory && c.req.method !== "GET")
    return c.json({ error: "Method not allowed." }, 405);
  if (isNativeSupervisor && c.req.method !== "POST")
    return c.json({ error: "Method not allowed." }, 405);

  const principal = studioPrincipalFromHeaders(c.req.raw.headers);
  if (!principal) return c.json({ error: "Authentication required." }, 401);
  if (
    principal.tenantId !== "local-demo" ||
    (!hasRole(principal, "support-agent") && !hasRole(principal, "admin"))
  )
    return c.json({ error: "Insufficient authority." }, 403);

  if (requestedHistory)
    return studioHistoryResponse(c, principal, requestedHistory);

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
