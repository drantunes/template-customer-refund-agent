import { registerApiRoute, type ContextWithMastra } from "@mastra/core/server";
import { caseStore } from "../lib/case-store";
import { withDispatchLeaseScope } from "../lib/dispatch-lease-scope";
import { resumeApprovedNativeTool } from "../providers/native-execution";
import { REQUEST_APPROVAL_STEP_ID } from "../workflows/resolve-support-case";
import { computeMonitoringSummary } from "../lib/monitoring";
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
      try {
        if (!(await caseStore.activateDispatch(dispatch)))
          return c.json(scopedCaseDto((await caseStore.get(caseId))!, current));
        const run = await mastra
          .getWorkflow("resolveSupportCaseWorkflow")
          .createRun({ runId });
        const result = await withDispatchLeaseScope(
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
        await caseStore.completeDispatch(
          dispatch.id,
          result.status === "suspended" ? "suspended" : "completed",
          undefined,
          dispatch.leaseToken,
        );
      } catch (error) {
        await caseStore
          .failDispatchAndCase(dispatch.id, caseId, error, dispatch.leaseToken)
          .catch(() => undefined);
        return c.json(
          errorResponseSchema.parse({
            error: error instanceof Error ? error.message : String(error),
          }),
          500,
        );
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
    .refundCommand as { fingerprint?: string } | undefined;
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
  let leaseLost = false;
  const renewLease = async () => {
    try {
      if (
        !(await caseStore.renewDispatchLease(dispatch.id, dispatch.leaseToken!))
      )
        leaseLost = true;
    } catch {
      // A renewal failure means the caller can no longer safely project the
      // resume result onto the case.  Do not turn it into a detached rejection.
      leaseLost = true;
    }
  };
  const heartbeat = setInterval(() => void renewLease(), 10_000);
  heartbeat.unref();
  let nativeResumed = false;
  try {
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
    // The decision remains durable. Requeue its fenced dispatch for native
    // recovery instead of recording a second decision or a failed effect.
    await caseStore
      .completeDispatch(dispatch.id, "suspended", error, dispatch.leaseToken)
      .catch(() => undefined);
    clearInterval(heartbeat);
    return c.json(
      errorResponseSchema.parse({
        error: error instanceof Error ? error.message : String(error),
      }),
      409,
    );
  }
  try {
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
    if (leaseLost)
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

    await caseStore.completeDispatch(
      dispatch.id,
      result.status === "suspended" ? "suspended" : "completed",
      undefined,
      dispatch.leaseToken,
    );

    return c.json(scopedCaseDto((await caseStore.get(caseId))!, current));
  } catch (error: any) {
    if (error?.id === "WORKFLOW_RESUME_ALREADY_CLAIMED") {
      return c.json({ error: "This approval was already submitted." }, 409);
    }
    if (!leaseLost && nativeResumed) {
      const failed = await caseStore
        .failDispatchAndCase(dispatch.id, caseId, error, dispatch.leaseToken)
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
    clearInterval(heartbeat);
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

      let body: { rating?: string; comment?: string } = {};
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

      const feedback: CaseFeedback = {
        rating: parsed.data.rating,
        comment: parsed.data.comment,
        submittedAt: new Date().toISOString(),
      };
      const updated = await caseStore.update(caseId, { feedback });

      const mastra = c.get("mastra");
      if (supportCase.traceId && mastra.observability.addFeedback) {
        try {
          await mastra.observability.addFeedback({
            traceId: supportCase.traceId,
            feedback: {
              feedbackSource: "user",
              feedbackType: "thumbs",
              value: feedback.rating === "up" ? 1 : -1,
              comment: feedback.comment,
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
      const summary = await computeMonitoringSummary(mastra);
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
      const mastra = c.get("mastra");
      const workflow = mastra.getWorkflow("indexSupportKnowledgeWorkflow");
      const run = await workflow.createRun();
      const result = await run.start({
        inputData: {},
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
  supportCasesListRoute,
  supportCaseDetailRoute,
  supportCaseApproveRoute,
  supportCaseRejectRoute,
  supportCaseFollowUpRoute,
  supportCaseFeedbackRoute,
  supportMonitoringSummaryRoute,
  supportKnowledgeReindexRoute,
  supportOpenApiRoute,
];
