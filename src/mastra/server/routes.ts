import { registerApiRoute, type ContextWithMastra } from "@mastra/core/server";
import {
  caseStore,
  isRetentionTombstone,
  type DispatchRecord,
} from "../lib/case-store";
import { retryOrEscalateOperationalFailure } from "../lib/operational-alerts";
import {
  renewDispatchLeaseWhileRunning,
  withDispatchLeaseScope,
} from "../lib/dispatch-lease-scope";
import { resumeApprovedNativeTool } from "../providers/native-execution";
import { reconcileApprovedRefundEffect } from "../runtime/local-runtime";
import { isRefundPolicyEvidenceError } from "../lib/refund-policy-evidence";
import { REQUEST_APPROVAL_STEP_ID } from "../workflows/resolve-support-case";
import { bindingsForCase } from "../providers/contracts";
import { withTrustedCaseReadScope } from "../lib/trusted-run-scope";
import { resourceIdForOwner, threadIdForCase } from "../domain/support-case";
import { computeMonitoringSummary } from "../lib/monitoring";
import {
  budgetedLanguageModel,
  createValidationBudgetExecution,
  validationBudgetRequestContextKey,
} from "../lib/eval-budget";
import type { CaseFeedback, SupportCase } from "../domain/support-case";
import {
  approvalRequestSchema,
  caseListResponseSchema,
  errorResponseSchema,
  feedbackRequestSchema,
  followUpRequestSchema,
  inboundSupportResponseSchema,
  monitoringSummarySchema,
  mockEmailPayloadSchema,
  reindexResponseSchema,
  reindexRequestSchema,
  supervisorExecutionRequestSchema,
  supervisorExecutionResponseSchema,
  supportOpenApiDocument,
} from "./contracts";
import {
  authenticateSeededCredentials,
  canAccessCase,
  hasRole,
  principalFromHeaders,
  verifyLocalSession,
  type SupportPrincipal,
} from "./auth";
import { loginRequestSchema, loginResponseSchema } from "./contracts";
import {
  intercomBinding,
  intercomDevelopmentConfig,
} from "../providers/intercom/config";
import {
  isCustomerConversationEvent,
  MAX_INTERCOM_WEBHOOK_BYTES,
  verifyIntercomWebhook,
} from "../providers/intercom/webhook";

function principal(c: ContextWithMastra): SupportPrincipal | undefined {
  return c.req.raw?.headers
    ? principalFromHeaders(c.req.raw.headers)
    : undefined;
}
function requirePrincipal(c: ContextWithMastra): SupportPrincipal | Response {
  return (
    principal(c) ??
    c.json(
      errorResponseSchema.parse({ error: "Authentication required." }),
      401,
    )
  );
}
function requireRole(
  c: ContextWithMastra,
  role: "customer" | "support-agent" | "approver" | "admin",
) {
  const current = requirePrincipal(c);
  if (current instanceof Response) return current;
  return hasRole(current, role)
    ? current
    : c.json(
        errorResponseSchema.parse({ error: "Insufficient authority." }),
        403,
      );
}

/** Follow-up execution is an operational entrypoint, not merely an HTTP
 * response. Classify its failure and leave a bounded durable retry or a human
 * escalation; never terminalize a dispatch as an unclassified failure. */
async function recoverFollowUpFailure(
  dispatch: DispatchRecord,
  caseId: string,
  error: unknown,
) {
  return retryOrEscalateOperationalFailure({
    signal: {
      providerOrTool: "resolve-support-case",
      occurredAt: new Date(),
      durationMs: 0,
      failed: true,
    },
    retry: () =>
      caseStore.retryDispatch(dispatch.id, caseId, error, dispatch.leaseToken),
    escalate: () =>
      caseStore.failDispatchAndCase(
        dispatch.id,
        caseId,
        error,
        dispatch.leaseToken,
        "escalated",
      ),
  });
}
function caseScope(
  c: ContextWithMastra,
  supportCase: Parameters<typeof canAccessCase>[1],
) {
  const current = requirePrincipal(c);
  if (current instanceof Response) return current;
  return canAccessCase(current, supportCase)
    ? current
    : c.json(errorResponseSchema.parse({ error: "Case access denied." }), 403);
}

function correlationIdFromError(
  error: unknown,
  seen = new Set<object>(),
): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  if (seen.has(error)) return undefined;
  seen.add(error);
  const value = error as Record<string, unknown>;
  for (const key of ["traceId", "trace_id"])
    if (typeof value[key] === "string") return value[key];
  // Mastra and transport wrappers preserve the native failure as a cause or
  // contextual record. Follow only those structured diagnostic links; never
  // scrape message text, which could contain customer content.
  for (const key of ["cause", "context", "details", "error"])
    if (value[key]) {
      const traceId = correlationIdFromError(value[key], seen);
      if (traceId) return traceId;
    }
  return undefined;
}

/**
 * The durable case is an internal operational record.  Each API response is a
 * role-scoped projection so customers never receive provider payloads,
 * execution bindings, internal messages, traces, or staff reasoning. Staff
 * get the immutable command hash required to review the exact displayed
 * approval, never the native approval handle or idempotency material.
 */
function scopedCaseDto(
  supportCase: SupportCase,
  current: SupportPrincipal,
): SupportCase {
  const metadata = supportCase.metadata as Record<string, unknown>;
  if (hasRole(current, "customer")) {
    // This is an allowlist. New internal SupportCase fields cannot become a
    // customer API leak merely because a destructuring denylist was missed.
    return {
      id: supportCase.id,
      externalId: supportCase.externalId,
      source: supportCase.source,
      customer: { email: current.email, name: supportCase.customer.name },
      subject: supportCase.subject,
      messages: supportCase.messages.filter(
        (message) => message.author !== "internal",
      ),
      status: supportCase.status,
      createdAt: supportCase.createdAt,
      updatedAt: supportCase.updatedAt,
      feedback: supportCase.feedback,
      metadata: {},
    };
  }
  const command = metadata.refundCommand as
    { fingerprint?: unknown } | undefined;
  return {
    ...supportCase,
    metadata:
      typeof command?.fingerprint === "string"
        ? { refundCommand: { fingerprint: command.fingerprint } }
        : {},
  };
}

export const supportLoginRoute = registerApiRoute("/support/auth/login", {
  method: "POST",
  handler: async (c) => {
    let input: unknown;
    try {
      input = await c.req.json();
    } catch {
      return c.json(
        errorResponseSchema.parse({ error: "Invalid JSON body." }),
        400,
      );
    }
    const parsed = loginRequestSchema.safeParse(input);
    if (!parsed.success)
      return c.json(
        errorResponseSchema.parse({ error: "Invalid credentials payload." }),
        400,
      );
    const token = authenticateSeededCredentials(
      parsed.data.email,
      parsed.data.password,
    );
    if (!token)
      return c.json(
        errorResponseSchema.parse({ error: "Invalid credentials." }),
        401,
      );
    const session = verifyLocalSession(token)!;
    return c.json(
      loginResponseSchema.parse({
        token,
        expiresAt: session.expiresAt,
        principal: {
          id: session.id,
          email: session.email,
          tenantId: session.tenantId,
          roles: session.roles,
        },
      }),
    );
  },
});

/**
 * POST /support/inbound
 *
 * The single inbound endpoint accepts the built-in mock email payload. External support adapters
 * are deliberately absent from this Phase 001 baseline; a configured unsupported source returns
 * a clear diagnostic from the workflow rather than falling back to mock.
 */
export const supportInboundRoute = registerApiRoute("/support/inbound", {
  method: "POST",
  handler: async (c) => {
    const actor = requirePrincipal(c);
    if (actor instanceof Response) return actor;
    const rawBody = await c.req.text();

    let rawPayload: unknown;
    try {
      rawPayload = JSON.parse(rawBody);
    } catch {
      return c.json(
        errorResponseSchema.parse({ error: "Invalid JSON body." }),
        400,
      );
    }
    const payloadResult = mockEmailPayloadSchema.safeParse(rawPayload);
    if (!payloadResult.success) {
      return c.json(
        errorResponseSchema.parse({ error: "Invalid mock inbound payload." }),
        400,
      );
    }
    const isCustomer = hasRole(actor, "customer");
    if (!isCustomer && !hasRole(actor, "support-agent"))
      return c.json(
        errorResponseSchema.parse({ error: "Insufficient authority." }),
        403,
      );
    // The only built-in inbound adapter is the local-demo support account.
    // Reject a signed identity from another tenant before it can allocate a
    // workflow run or ask the normalizer to interpret its payload.
    if (actor.tenantId !== "local-demo")
      return c.json(
        errorResponseSchema.parse({ error: "Case access denied." }),
        403,
      );
    // A customer may create only their own conversation.  The body email is
    // normalized input, never a claim of another customer's identity.
    if (
      isCustomer &&
      payloadResult.data.from.toLowerCase() !== actor.email.toLowerCase()
    )
      return c.json(
        errorResponseSchema.parse({ error: "Case access denied." }),
        403,
      );
    const conversationId =
      typeof payloadResult.data.conversationId === "string"
        ? payloadResult.data.conversationId
        : undefined;
    if (conversationId) {
      const existing = await caseStore.findConversation(
        actor.tenantId,
        conversationId,
      );
      if (existing && !canAccessCase(actor, existing))
        return c.json(
          errorResponseSchema.parse({ error: "Case access denied." }),
          403,
        );
      if (existing && isRetentionTombstone(existing))
        return c.json(
          errorResponseSchema.parse({
            error: "This expired support case cannot accept new content.",
          }),
          410,
        );
    }

    const mastra = c.get("mastra");
    const ingestWorkflow = mastra.getWorkflow("ingestSupportCaseWorkflow");
    const run = await ingestWorkflow.createRun();

    let result;
    try {
      result = await run.start({
        inputData: {
          payload: payloadResult.data,
          ingress: {
            id: actor.id,
            email: actor.email,
            tenantId: actor.tenantId,
            roles: actor.roles,
          },
        },
        requestContext: c.get("requestContext"),
      });
    } catch (error) {
      return c.json(
        errorResponseSchema.parse({
          error: error instanceof Error ? error.message : String(error),
        }),
        400,
      );
    }

    if (result.status !== "success") {
      return c.json(
        errorResponseSchema.parse({ error: "Ingestion failed." }),
        500,
      );
    }

    return c.json(
      inboundSupportResponseSchema.parse({
        caseId: result.result.caseId,
        workflowRunId: result.result.workflowRunId,
        status: "processing",
      }),
    );
  },
});

/** Public by transport necessity only. It verifies raw signed requests before
 * parse. A verified Intercom ping is acknowledged without creating a local
 * identity or workflow run; bound customer notifications alone reach ingest. */
export const intercomWebhookRoute = registerApiRoute(
  "/support/webhooks/intercom",
  {
    method: "POST",
    handler: async (c) => {
      const config = intercomDevelopmentConfig();
      if (!config)
        return c.json(
          errorResponseSchema.parse({ error: "Intercom is not enabled." }),
          404,
        );
      if (!c.req.raw)
        return c.json(
          errorResponseSchema.parse({
            error: "Webhook transport unavailable.",
          }),
          500,
        );
      const contentLength = c.req.raw.headers.get("content-length");
      const declaredLength =
        contentLength === null ? undefined : Number(contentLength);
      if (
        declaredLength !== undefined &&
        Number.isFinite(declaredLength) &&
        (declaredLength <= 0 || declaredLength > MAX_INTERCOM_WEBHOOK_BYTES)
      )
        return c.json(
          errorResponseSchema.parse({ error: "Invalid Intercom webhook." }),
          413,
        );
      let raw: Uint8Array;
      try {
        raw = await readIntercomWebhookBody(c.req.raw);
      } catch (error) {
        return c.json(
          errorResponseSchema.parse({ error: "Invalid Intercom webhook." }),
          error instanceof IntercomWebhookTooLargeError ? 413 : 400,
        );
      }
      let event;
      try {
        event = verifyIntercomWebhook(raw, c.req.raw.headers, config);
      } catch {
        return c.json(
          errorResponseSchema.parse({ error: "Invalid Intercom webhook." }),
          401,
        );
      }
      // Intercom's setup ping has no conversation ID. It is still authenticated,
      // account-scoped, and fresh at this point, but must never create a binding
      // or trigger workflow/remote effects.
      if (event.kind === "ping")
        return c.json({ accepted: true, ignored: true });
      // Admin replies/notes and all non-customer events are acknowledged but
      // cannot feed a self-generated reply loop.
      if (!isCustomerConversationEvent(event))
        return c.json({ accepted: true, ignored: true });
      const mastra = c.get("mastra");
      const run = await mastra
        .getWorkflow("ingestSupportCaseWorkflow")
        .createRun();
      try {
        const result = await run.start({
          inputData: {
            payload: event,
            verifiedProvider: { kind: "intercom", event },
          },
          requestContext: c.get("requestContext"),
        });
        if (result.status !== "success") throw new Error("inbound failed");
        return c.json(
          inboundSupportResponseSchema.parse({
            caseId: result.result.caseId,
            workflowRunId: result.result.workflowRunId,
            status: "processing",
          }),
        );
      } catch {
        // Return retryable status only after verification.  The event ID is
        // durably deduplicated by the same transaction as case acceptance.
        return c.json(
          errorResponseSchema.parse({ error: "Intercom ingestion failed." }),
          503,
        );
      }
    },
  },
);

class IntercomWebhookTooLargeError extends Error {}
/** Content-Length is only an early reject. This stream boundary limits chunked
 * and malformed requests before any raw body is retained for HMAC validation. */
export async function readIntercomWebhookBody(request: Request) {
  if (!request.body) throw new Error("Webhook body is unavailable.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_INTERCOM_WEBHOOK_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new IntercomWebhookTooLargeError();
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (error instanceof IntercomWebhookTooLargeError) throw error;
    throw new Error("Webhook body could not be read.");
  } finally {
    reader.releaseLock();
  }
  const raw = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    raw.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return raw;
}

export const supportCaseFollowUpRoute = registerApiRoute(
  "/support/cases/:caseId/follow-ups",
  {
    method: "POST",
    handler: async (c) => {
      const caseId = c.req.param("caseId");
      const supportCase = await caseStore.get(caseId);
      if (!supportCase) return c.json({ error: "Case not found." }, 404);
      const current = caseScope(c, supportCase);
      if (current instanceof Response) return current;
      if (!hasRole(current, "customer"))
        return c.json(
          errorResponseSchema.parse({ error: "Insufficient authority." }),
          403,
        );
      if (isRetentionTombstone(supportCase))
        return c.json(
          errorResponseSchema.parse({
            error: "This expired support case cannot accept new content.",
          }),
          410,
        );
      let input: unknown;
      try {
        input = await c.req.json();
      } catch {
        return c.json(
          errorResponseSchema.parse({ error: "Invalid follow-up payload." }),
          400,
        );
      }
      const parsed = followUpRequestSchema.safeParse(input);
      if (!parsed.success)
        return c.json(
          errorResponseSchema.parse({ error: "Invalid follow-up payload." }),
          400,
        );
      const mastra = c.get("mastra");
      const runId = `follow-up-${crypto.randomUUID()}`;
      const appended = await caseStore.appendFollowUp({
        caseId,
        eventId: `portal-${crypto.randomUUID()}`,
        runId,
        message: {
          id: `message-${crypto.randomUUID()}`,
          author: "customer",
          authorName: current.email,
          body: parsed.data.body,
          createdAt: new Date().toISOString(),
        },
      });
      if (!appended.appended)
        return c.json(scopedCaseDto(appended.supportCase, current));
      const dispatch = await caseStore.claimDispatchForStart(caseId, runId);
      if (!dispatch)
        return c.json(scopedCaseDto((await caseStore.get(caseId))!, current));
      const lease = renewDispatchLeaseWhileRunning(caseStore, dispatch);
      try {
        await lease.renew();
        if (lease.lostOwnership)
          return c.json(
            { error: "Follow-up lost its dispatch lease; reload the case." },
            409,
          );
        lease.start();
        if (!(await caseStore.activateDispatch(dispatch)))
          return c.json(scopedCaseDto((await caseStore.get(caseId))!, current));
        const run = await mastra
          .getWorkflow("resolveSupportCaseWorkflow")
          .createRun({ runId });
        const result = await withDispatchLeaseScope<{ status: string }>(
          {
            dispatchId: dispatch.id,
            caseId: dispatch.caseId,
            turnId: dispatch.turnId,
            leaseToken: dispatch.leaseToken!,
          },
          () =>
            run.start({
              inputData: { caseId, turnId: dispatch.turnId },
              requestContext: c.get("requestContext"),
            }),
        );
        if (lease.lostOwnership)
          return c.json(
            { error: "Follow-up lost its dispatch lease; reload the case." },
            409,
          );
        if (result.status === "failed") {
          const recovery = await recoverFollowUpFailure(
            dispatch,
            caseId,
            "Follow-up resolution failed.",
          );
          if (!recovery.applied)
            return c.json(
              { error: "Follow-up lost its dispatch lease; reload the case." },
              409,
            );
          return c.json({ error: "Follow-up resolution failed." }, 500);
        }
        if (
          result.status === "suspended" ||
          result.status === "paused" ||
          result.status === "waiting"
        ) {
          if (
            !(await caseStore.completeDispatch(
              dispatch.id,
              "suspended",
              undefined,
              dispatch.leaseToken,
            ))
          )
            return c.json(
              { error: "Follow-up lost its dispatch lease; reload the case." },
              409,
            );
        } else if (result.status === "success") {
          if (
            !(await caseStore.completeDispatch(
              dispatch.id,
              "completed",
              undefined,
              dispatch.leaseToken,
            ))
          )
            return c.json(
              { error: "Follow-up lost its dispatch lease; reload the case." },
              409,
            );
        } else {
          const recovery = await recoverFollowUpFailure(
            dispatch,
            caseId,
            `Follow-up resolution returned ${result.status}.`,
          );
          if (!recovery.applied)
            return c.json(
              { error: "Follow-up lost its dispatch lease; reload the case." },
              409,
            );
          return c.json({ error: "Follow-up resolution failed." }, 500);
        }
      } catch (error) {
        const recovery = await recoverFollowUpFailure(
          dispatch,
          caseId,
          error,
        ).catch(() => undefined);
        if (!recovery?.applied)
          return c.json(
            { error: "Follow-up lost its dispatch lease; reload the case." },
            409,
          );
        return c.json(
          errorResponseSchema.parse({
            error: error instanceof Error ? error.message : String(error),
          }),
          500,
        );
      } finally {
        lease.stop();
      }
      return c.json(scopedCaseDto((await caseStore.get(caseId))!, current));
    },
  },
);

/** GET /support/cases - case inbox for the demo UI, newest first. Optionally filtered by `?email=` for the customer portal. */
export const supportCasesListRoute = registerApiRoute("/support/cases", {
  method: "GET",
  handler: async (c) => {
    const current = requirePrincipal(c);
    if (current instanceof Response) return current;
    const allCases = await caseStore.list();
    // Query/body email is never authority. Customers only see their own
    // tenant-qualified cases; staff roles remain tenant scoped.
    const cases = allCases.filter((supportCase) =>
      canAccessCase(current, supportCase),
    );
    return c.json(
      caseListResponseSchema.parse({
        cases: cases.map((supportCase) => scopedCaseDto(supportCase, current)),
      }),
    );
  },
});

export const supportCaseDetailRoute = registerApiRoute(
  "/support/cases/:caseId",
  {
    method: "GET",
    handler: async (c) => {
      const supportCase = await caseStore.get(c.req.param("caseId"));
      if (!supportCase) return c.json({ error: "Case not found." }, 404);
      const current = caseScope(c, supportCase);
      if (current instanceof Response) return current;
      return c.json(scopedCaseDto(supportCase, current));
    },
  },
);

/** A tenant/case-qualified alternative to generic Studio agent execution.
 * Generic built-in routes cannot establish this application's resource scope;
 * this endpoint authenticates a staff user, checks the durable case, and gives
 * the registered supervisor only read authority for that one case. */
export const supportCaseSupervisorRoute = registerApiRoute(
  "/support/cases/:caseId/supervisor",
  {
    method: "POST",
    handler: async (c) => {
      const current = requirePrincipal(c);
      if (current instanceof Response) return current;
      if (!hasRole(current, "support-agent") && !hasRole(current, "admin"))
        return c.json(
          errorResponseSchema.parse({ error: "Insufficient authority." }),
          403,
        );
      const supportCase = await caseStore.get(c.req.param("caseId"));
      if (!supportCase) return c.json({ error: "Case not found." }, 404);
      if (!canAccessCase(current, supportCase))
        return c.json(
          errorResponseSchema.parse({ error: "Case access denied." }),
          403,
        );
      let input: unknown;
      try {
        input = await c.req.json();
      } catch {
        return c.json(
          errorResponseSchema.parse({ error: "Invalid supervisor request." }),
          400,
        );
      }
      const parsed = supervisorExecutionRequestSchema.safeParse(input);
      if (!parsed.success)
        return c.json(
          errorResponseSchema.parse({ error: "Invalid supervisor request." }),
          400,
        );
      const ownerId = (supportCase.metadata as Record<string, unknown>).ownerId;
      if (typeof ownerId !== "string" || !ownerId)
        return c.json(
          errorResponseSchema.parse({ error: "Case has no verified owner." }),
          409,
        );
      const binding = bindingsForCase(supportCase).support;
      const validation = parsed.data.validation
        ? createValidationBudgetExecution(parsed.data.validation.mode)
        : undefined;
      const requestContext = c.get("requestContext");
      if (validation)
        requestContext.setRaw(validationBudgetRequestContextKey, validation);
      const supervisor = c.get("mastra").getAgent("supportSupervisorAgent");
      // Supplying the native run ID lets us retain a trustworthy association
      // even when a generation fails before Mastra can return a trace ID.
      const supervisorRunId = `supervisor_${crypto.randomUUID()}`;
      const supervisorThreadId = threadIdForCase(
        supportCase.id,
        binding.tenantId,
      );
      const model = validation
        ? budgetedLanguageModel(
            (await supervisor.getModel({ requestContext })) as never,
            validation,
          )
        : undefined;
      // Mastra's final aggregate omits failed tool calls after the model
      // recovers with a text response. Capture the supported native iteration
      // result so the authenticated staff response reports both successful
      // evidence and a denied read without fabricating either outcome.
      const observedToolResults: Array<{
        name: string;
        result: unknown;
        error?: Error;
      }> = [];
      let validationError: Error | undefined;
      let result: Awaited<ReturnType<typeof supervisor.generate>> | undefined;
      let generationError: Error | undefined;
      try {
        result = await withTrustedCaseReadScope(
          { caseId: supportCase.id, ownerId, tenantId: binding.tenantId },
          () =>
            c
              .get("mastra")
              .getAgent("supportSupervisorAgent")
              .generate(
                [
                  {
                    role: "user",
                    content: `Investigate this existing support case read-only. Case subject: ${supportCase.subject}. Customer: ${supportCase.customer.email}. Request: ${parsed.data.message}`,
                  },
                ],
                {
                  memory: {
                    thread: supervisorThreadId,
                    resource: resourceIdForOwner(ownerId, binding.tenantId),
                  },
                  runId: supervisorRunId,
                  requestContext,
                  ...(model
                    ? {
                        model,
                      }
                    : {}),
                  delegation: {
                    ...(model
                      ? {
                          onDelegationStart: () => ({
                            proceed: false,
                            rejectionReason:
                              "Budgeted supervisor validation does not permit delegated model calls.",
                          }),
                        }
                      : {}),
                    // Native delegation preserves each specialist's actual tool
                    // outcomes here. Expose those read-only observations beside
                    // the parent delegation result so staff and acceptance tests
                    // can distinguish a completed delegation from one that
                    // merely returned prose without exercising its evidence.
                    onDelegationComplete: ({ primitiveId, result }) => {
                      observedToolResults.push(
                        ...(result.subAgentToolResults ?? []).map((entry) => ({
                          name: `${primitiveId}.${entry.toolName}`,
                          result: entry.result,
                        })),
                      );
                    },
                  },
                  onIterationComplete: ({ toolResults }) => {
                    observedToolResults.push(...toolResults);
                  },
                },
              ),
        );
      } catch (error) {
        generationError =
          error instanceof Error ? error : new Error(String(error));
        validationError = generationError;
      }
      if (!result) {
        await caseStore.recordSupervisorExecution({
          tenantId: binding.tenantId,
          caseId: supportCase.id,
          threadId: supervisorThreadId,
          actorId: current.id,
          runId: supervisorRunId,
          traceId: correlationIdFromError(generationError),
          state: "failed",
        });
        if (!validation) throw generationError;
        return c.json(
          errorResponseSchema.parse({
            error: `Validation budget blocked: ${validationError?.message ?? "unknown error"}`,
          }),
          422,
        );
      }
      // Wait for the native aggregate before persisting correlation or sending
      // the HTTP response. This closes the generation's span/export path;
      // retaining a trace ID before its native execution settles would make a
      // durable association point at a transient, undiscoverable trace.
      const responseText = await result.text;
      await caseStore.recordSupervisorExecution({
        tenantId: binding.tenantId,
        caseId: supportCase.id,
        threadId: supervisorThreadId,
        actorId: current.id,
        runId: supervisorRunId,
        traceId: result.traceId,
        state: "completed",
      });
      // The run remains durably visible as partial telemetry, but never claim
      // a trace ID we did not receive from the native runtime.
      if (!result.traceId)
        return c.json(
          errorResponseSchema.parse({
            error:
              "Supervisor completed without an observable trace correlation.",
          }),
          503,
        );
      const toolResults = observedToolResults.map((entry) => ({
        toolName: entry.name,
        result: entry.error ? { error: entry.error.message } : entry.result,
        // Registered read tools and delegated specialist tools have object
        // output schemas. Mastra materializes a thrown tool error as its
        // message string in the native hook rather than setting `error`.
        isError: Boolean(entry.error) || typeof entry.result === "string",
      }));
      return c.json(
        supervisorExecutionResponseSchema.parse({
          text: responseText,
          traceId: result.traceId,
          toolNames: toolResults.map((entry) => entry.toolName),
          toolResults,
        }),
      );
    },
  },
);

async function resumeApproval(c: ContextWithMastra, approved: boolean) {
  const caseId = c.req.param("caseId");
  if (!caseId) {
    return c.json(
      errorResponseSchema.parse({ error: "Missing case id." }),
      400,
    );
  }
  const supportCase = await caseStore.get(caseId);
  if (!supportCase) return c.json({ error: "Case not found." }, 404);
  const current = requireRole(c, "approver");
  if (current instanceof Response) return current;
  if (!canAccessCase(current, supportCase))
    return c.json(
      errorResponseSchema.parse({ error: "Case access denied." }),
      403,
    );
  if (!supportCase.workflowRunId) {
    return c.json(
      { error: "This case has no in-flight resolution workflow run." },
      409,
    );
  }
  if (supportCase.status !== "waiting_approval") {
    return c.json(
      {
        error: `Case is not waiting for approval (status: ${supportCase.status}).`,
      },
      409,
    );
  }

  let body: { commandFingerprint?: string; note?: string } = {};
  try {
    const rawBody = await c.req.text();
    const parsed = approvalRequestSchema.safeParse(
      rawBody.trim() === "" ? {} : JSON.parse(rawBody),
    );
    if (!parsed.success)
      return c.json(
        errorResponseSchema.parse({ error: "Invalid approval payload." }),
        400,
      );
    body = parsed.data;
  } catch {
    return c.json(
      errorResponseSchema.parse({ error: "Invalid approval payload." }),
      400,
    );
  }

  const mastra = c.get("mastra");
  const resolveWorkflow = mastra.getWorkflow("resolveSupportCaseWorkflow");
  const command = (supportCase.metadata as Record<string, unknown>)
    .refundCommand as
    | {
        fingerprint?: string;
        idempotencyKey?: string;
      }
    | undefined;
  if (!command?.fingerprint)
    return c.json(
      errorResponseSchema.parse({
        error: "Immutable refund command is missing.",
      }),
      409,
    );
  if (body.commandFingerprint !== command.fingerprint)
    return c.json(
      errorResponseSchema.parse({
        error: "The displayed approval command is stale.",
      }),
      409,
    );
  const native = (supportCase.metadata as Record<string, unknown>)
    .nativeApproval as
    | {
        runId?: string;
        toolCallId?: string;
        fingerprint?: string;
        turnId?: string;
      }
    | undefined;
  if (
    !native?.runId ||
    !native.toolCallId ||
    native.fingerprint !== command.fingerprint
  )
    return c.json(
      errorResponseSchema.parse({
        error: "Native approval binding is missing or stale.",
      }),
      409,
    );
  let decision;
  try {
    decision = await caseStore.recordApprovalDecision({
      caseId,
      turnId: native.turnId,
      commandFingerprint: command.fingerprint,
      principalId: current.id,
      approved,
      note: body.note,
      nativeRunId: native.runId,
      nativeToolCallId: native.toolCallId,
    });
  } catch (error) {
    return c.json(
      errorResponseSchema.parse({
        error: error instanceof Error ? error.message : String(error),
      }),
      409,
    );
  }
  if (!decision.won)
    return c.json(
      errorResponseSchema.parse({
        error: "This approval was already submitted.",
      }),
      409,
    );
  // Claim the durable workflow lease before changing the native Agent run.
  // A decision commit is recoverable; without this fence an HTTP request and
  // the recovery worker could both resume the same native snapshot.
  const dispatch = await caseStore.claimDispatchForResume(
    caseId,
    supportCase.workflowRunId,
    native.turnId,
  );
  if (!dispatch)
    return c.json(
      {
        error:
          "This approval is already being resumed or is no longer resumable.",
      },
      409,
    );
  const lease = renewDispatchLeaseWhileRunning(caseStore, dispatch);
  let nativeResumed = false;
  try {
    await lease.renew();
    if (lease.lostOwnership)
      return c.json(
        { error: "Approval resume lost its dispatch lease; reload the case." },
        409,
      );
    lease.start();
    await withDispatchLeaseScope(
      {
        dispatchId: dispatch.id,
        caseId: dispatch.caseId,
        turnId: dispatch.turnId,
        leaseToken: dispatch.leaseToken!,
      },
      () =>
        resumeApprovedNativeTool({
          mastra,
          approved,
          scope: {
            caseId: dispatch.caseId,
            turnId: dispatch.turnId,
            nativeRunId: native.runId!,
            nativeToolCallId: native.toolCallId!,
            commandFingerprint: native.fingerprint!,
            dispatchId: dispatch.id,
            leaseToken: dispatch.leaseToken!,
          },
          requestContext: c.get("requestContext"),
        }),
    );
    nativeResumed = true;
  } catch (error) {
    // Expired/replaced command evidence is a deterministic safety decision,
    // not a transient native snapshot failure. Leave a durable staff-review
    // outcome with no new provider effect; only transport/snapshot failures
    // remain recoverable.
    if (isRefundPolicyEvidenceError(error))
      await caseStore
        .failDispatchAndCase(
          dispatch.id,
          caseId,
          error,
          dispatch.leaseToken,
          "escalated",
        )
        .catch(() => undefined);
    else
      await caseStore
        .completeDispatch(dispatch.id, "suspended", error, dispatch.leaseToken)
        .catch(() => undefined);
    lease.stop();
    return c.json(
      errorResponseSchema.parse({
        error: error instanceof Error ? error.message : String(error),
      }),
      409,
    );
  }
  try {
    if (approved && command.idempotencyKey) {
      const currentCase = await caseStore.get(caseId);
      const reconciled = await reconcileApprovedRefundEffect({
        store: caseStore,
        supportCase: currentCase ?? supportCase,
        dispatch,
        fingerprint: command.fingerprint,
        command: (currentCase?.metadata as Record<string, unknown> | undefined)
          ?.refundCommand as
          | {
              orderId?: string;
              idempotencyKey?: string;
              fingerprint?: string;
              amount?: number;
              currency?: string;
            }
          | undefined,
      });
      if (!reconciled) {
        // A normally resolved native transition with no exact provider effect
        // is a completed tool failure. Transport/snapshot errors take the
        // earlier catch path and remain recoverable; do not loop forever on a
        // native snapshot that Mastra has already consumed.
        const failed = await caseStore.failDispatchAndCase(
          dispatch.id,
          caseId,
          "Native approval completed without a durable refund effect.",
          dispatch.leaseToken,
          "escalated",
        );
        if (!failed)
          return c.json(
            {
              error:
                "Approval resume lost its dispatch lease; reload the case.",
            },
            409,
          );
        return c.json(
          { error: "Approval completed without a durable refund effect." },
          500,
        );
      }
    }
    if (lease.lostOwnership)
      return c.json(
        { error: "Approval resume lost its dispatch lease; reload the case." },
        409,
      );
    const run = await resolveWorkflow.createRun({
      runId: supportCase.workflowRunId,
    });
    const result = await withDispatchLeaseScope(
      {
        dispatchId: dispatch.id,
        caseId: dispatch.caseId,
        turnId: dispatch.turnId,
        leaseToken: dispatch.leaseToken!,
      },
      async () => {
        await caseStore.update(caseId, { status: "processing" });
        return run.resume({
          step: REQUEST_APPROVAL_STEP_ID,
          resumeData: {
            approved,
            // The authenticated principal wins.  A client supplied approver id
            // is retained only as an audit note and can never confer authority.
            approverId: current.id,
            note: body.note,
          },
          requestContext: c.get("requestContext"),
        });
      },
    );
    if (lease.lostOwnership)
      return c.json(
        { error: "Approval resume lost its dispatch lease; reload the case." },
        409,
      );

    if (result.status === "failed") {
      const failed = await caseStore.failDispatchAndCase(
        dispatch.id,
        caseId,
        "Resolution failed after approval resume.",
        dispatch.leaseToken,
        "escalated",
      );
      if (!failed)
        return c.json(
          {
            error: "Approval resume lost its dispatch lease; reload the case.",
          },
          409,
        );
      return c.json({ error: "Resolution failed after resume.", result }, 500);
    }

    const finalState =
      result.status === "success"
        ? "completed"
        : result.status === "suspended" || result.status === "paused"
          ? "suspended"
          : undefined;
    if (!finalState) {
      const failed = await caseStore.failDispatchAndCase(
        dispatch.id,
        caseId,
        `Resolution returned ${result.status} after approval resume.`,
        dispatch.leaseToken,
        "escalated",
      );
      if (!failed)
        return c.json(
          {
            error: "Approval resume lost its dispatch lease; reload the case.",
          },
          409,
        );
      return c.json({ error: "Resolution failed after resume." }, 500);
    }
    if (
      !(await caseStore.completeDispatch(
        dispatch.id,
        finalState,
        undefined,
        dispatch.leaseToken,
      ))
    )
      return c.json(
        { error: "Approval resume lost its dispatch lease; reload the case." },
        409,
      );

    return c.json(scopedCaseDto((await caseStore.get(caseId))!, current));
  } catch (error: any) {
    if (error?.id === "WORKFLOW_RESUME_ALREADY_CLAIMED") {
      return c.json({ error: "This approval was already submitted." }, 409);
    }
    if (!lease.lostOwnership && nativeResumed) {
      const failed = await caseStore
        .failDispatchAndCase(
          dispatch.id,
          caseId,
          error,
          dispatch.leaseToken,
          "escalated",
        )
        .catch(() => false);
      if (!failed)
        return c.json(
          {
            error: "Approval resume lost its dispatch lease; reload the case.",
          },
          409,
        );
    }
    return c.json(
      { error: error instanceof Error ? error.message : String(error) },
      500,
    );
  } finally {
    lease.stop();
  }
}

export const supportCaseApproveRoute = registerApiRoute(
  "/support/cases/:caseId/approve",
  {
    method: "POST",
    handler: async (c) => resumeApproval(c, true),
  },
);

export const supportCaseRejectRoute = registerApiRoute(
  "/support/cases/:caseId/reject",
  {
    method: "POST",
    handler: async (c) => resumeApproval(c, false),
  },
);

/**
 * POST /support/cases/:caseId/feedback
 *
 * Lets the customer (or the admin, testing on their behalf) rate the final resolution. Stored
 * on the case for the monitoring dashboard, and forwarded to Mastra's observability feedback
 * API (`mastra.observability.addFeedback`) best-effort so it shows up alongside the case's
 * trace when the configured storage provider supports the observability feedback domain.
 */
export const supportCaseFeedbackRoute = registerApiRoute(
  "/support/cases/:caseId/feedback",
  {
    method: "POST",
    handler: async (c) => {
      const caseId = c.req.param("caseId");
      const supportCase = await caseStore.get(caseId);
      if (!supportCase) return c.json({ error: "Case not found." }, 404);
      const current = caseScope(c, supportCase);
      if (current instanceof Response) return current;
      if (isRetentionTombstone(supportCase))
        return c.json(
          errorResponseSchema.parse({
            error: "This expired support case cannot accept new content.",
          }),
          410,
        );

      let body: {
        rating?: string;
        comment?: string;
        responseMessageId?: string;
      } = {};
      try {
        body = await c.req.json();
      } catch {
        return c.json(
          errorResponseSchema.parse({ error: "Invalid JSON body." }),
          400,
        );
      }

      const parsed = feedbackRequestSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          errorResponseSchema.parse({
            error: "rating must be 'up' or 'down'.",
          }),
          400,
        );
      }

      const ratedTurn = (await caseStore.turns(caseId)).find(
        (turn) =>
          `msg_${caseId}_${turn.id}_final` === parsed.data.responseMessageId,
      );
      if (!ratedTurn)
        return c.json(
          errorResponseSchema.parse({
            error: "Feedback response was not found.",
          }),
          404,
        );
      const telemetry =
        ratedTurn.outcome?.telemetry &&
        typeof ratedTurn.outcome.telemetry === "object"
          ? (ratedTurn.outcome.telemetry as { traceId?: string })
          : undefined;
      const feedback: CaseFeedback = {
        rating: parsed.data.rating,
        comment: parsed.data.comment,
        submittedAt: new Date().toISOString(),
        actorId: current.id,
        turnId: ratedTurn.id,
        runId: ratedTurn.runId,
        traceId: telemetry?.traceId,
      };
      const persistedFeedback = await caseStore.recordFeedback({
        caseId,
        turnId: ratedTurn.id,
        actorId: current.id,
        feedback,
      });
      const updated =
        (supportCase.metadata as Record<string, unknown>).activeTurnId ===
        ratedTurn.id
          ? await caseStore.update(caseId, { feedback: persistedFeedback })
          : supportCase;

      const mastra = c.get("mastra");
      if (persistedFeedback.traceId && mastra.observability.addFeedback) {
        try {
          await mastra.observability.addFeedback({
            traceId: persistedFeedback.traceId,
            feedback: {
              feedbackSource: "user",
              feedbackType: "thumbs",
              value: feedback.rating === "up" ? 1 : -1,
              // Free-form feedback is retained only in the case store. Do not
              // bypass the application redactor by exporting it as a span
              // payload; the rating and trace association are sufficient.
            },
          });
        } catch (error) {
          mastra
            .getLogger()
            ?.warn("Failed to forward case feedback to observability storage", {
              error,
              caseId,
            });
        }
      }

      return c.json(scopedCaseDto(updated, current));
    },
  },
);

export const supportOpenApiRoute = registerApiRoute("/support/openapi.json", {
  method: "GET",
  handler: async (c) => c.json(supportOpenApiDocument),
});

/**
 * GET /support/monitoring/summary
 *
 * Aggregates the metrics called out in this template's brief: containment rate, escalation
 * rate, refund approvals, customer feedback, token cost, and slow/failing tools. The funnel,
 * refund, and feedback numbers come straight from the case store; token usage and tool
 * latency/reliability are derived from the spans Mastra already records for every agent and
 * tool call, read via the observability storage domain (see `src/mastra/lib/monitoring.ts`).
 */
export const supportMonitoringSummaryRoute = registerApiRoute(
  "/support/monitoring/summary",
  {
    method: "GET",
    handler: async (c) => {
      const current = requireRole(c, "admin");
      if (current instanceof Response) return current;
      const mastra = c.get("mastra");
      const summary = await computeMonitoringSummary(mastra, current.tenantId);
      return c.json(monitoringSummarySchema.parse(summary));
    },
  },
);

export const supportKnowledgeReindexRoute = registerApiRoute(
  "/support/knowledge/reindex",
  {
    method: "POST",
    handler: async (c) => {
      const current = requireRole(c, "admin");
      if (current instanceof Response) return current;
      const reindexInput = reindexRequestSchema.safeParse(
        await c.req.json().catch(() => ({})),
      );
      if (!reindexInput.success)
        return c.json(
          errorResponseSchema.parse({ error: "Invalid reindex request." }),
          400,
        );
      const mastra = c.get("mastra");
      const workflow = mastra.getWorkflow("indexSupportKnowledgeWorkflow");
      const run = await workflow.createRun();
      const intercom = intercomDevelopmentConfig();
      const binding =
        intercom?.knowledgeEnabled && intercom.tenantId === current.tenantId
          ? intercomBinding(intercom, `reindex:${current.id}`)
          : {
              tenantId: current.tenantId,
              providerKind: "local" as const,
              providerAccountId: "local-demo",
              externalConversationId: `reindex:${current.id}`,
            };
      const result = await run.start({
        inputData: {
          binding,
          ...(reindexInput.data.validation
            ? { validation: reindexInput.data.validation }
            : {}),
        },
        requestContext: c.get("requestContext"),
      });
      if (result.status !== "success") {
        return c.json(
          errorResponseSchema.parse({ error: "Indexing failed." }),
          500,
        );
      }
      return c.json(reindexResponseSchema.parse(result.result));
    },
  },
);

export const supportRoutes = [
  supportLoginRoute,
  supportInboundRoute,
  intercomWebhookRoute,
  supportCasesListRoute,
  supportCaseDetailRoute,
  supportCaseSupervisorRoute,
  supportCaseApproveRoute,
  supportCaseRejectRoute,
  supportCaseFollowUpRoute,
  supportCaseFeedbackRoute,
  supportMonitoringSummaryRoute,
  supportKnowledgeReindexRoute,
  supportOpenApiRoute,
];
