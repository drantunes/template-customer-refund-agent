import { registerApiRoute, type ContextWithMastra } from "@mastra/core/server";
import { caseStore } from "../lib/case-store";
import { REQUEST_APPROVAL_STEP_ID } from "../workflows/resolve-support-case";
import { computeMonitoringSummary } from "../lib/monitoring";
import type { CaseFeedback } from "../domain/support-case";
import {
  approvalRequestSchema,
  caseListResponseSchema,
  errorResponseSchema,
  feedbackRequestSchema,
  inboundSupportResponseSchema,
  monitoringSummarySchema,
  mockEmailPayloadSchema,
  reindexResponseSchema,
  supportOpenApiDocument,
} from "./contracts";

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

    const mastra = c.get("mastra");
    const ingestWorkflow = mastra.getWorkflow("ingestSupportCaseWorkflow");
    const run = await ingestWorkflow.createRun();

    let result;
    try {
      result = await run.start({
        inputData: { payload: payloadResult.data },
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

/** GET /support/cases - case inbox for the demo UI, newest first. Optionally filtered by `?email=` for the customer portal. */
export const supportCasesListRoute = registerApiRoute("/support/cases", {
  method: "GET",
  handler: async (c) => {
    const email = c.req.query("email");
    const allCases = await caseStore.list();
    const cases = email
      ? allCases.filter(
          (supportCase) =>
            supportCase.customer.email.toLowerCase() === email.toLowerCase(),
        )
      : allCases;
    return c.json(caseListResponseSchema.parse({ cases }));
  },
});

export const supportCaseDetailRoute = registerApiRoute(
  "/support/cases/:caseId",
  {
    method: "GET",
    handler: async (c) => {
      const supportCase = await caseStore.get(c.req.param("caseId"));
      if (!supportCase) return c.json({ error: "Case not found." }, 404);
      return c.json(supportCase);
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

  let body: { approverId?: string; note?: string } = {};
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
  const dispatch = await caseStore.claimDispatchForResume(
    caseId,
    supportCase.workflowRunId,
  );
  if (!dispatch)
    return c.json(
      {
        error:
          "This approval is already being resumed or is no longer resumable.",
      },
      409,
    );
  const run = await resolveWorkflow.createRun({
    runId: supportCase.workflowRunId,
  });

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
  try {
    await caseStore.update(caseId, { status: "processing" });
    const result = await run.resume({
      step: REQUEST_APPROVAL_STEP_ID,
      resumeData: {
        approved,
        approverId: body.approverId ?? "demo-support-lead",
        note: body.note,
      },
      requestContext: c.get("requestContext"),
    });
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

    return c.json(await caseStore.get(caseId));
  } catch (error: any) {
    if (error?.id === "WORKFLOW_RESUME_ALREADY_CLAIMED") {
      return c.json({ error: "This approval was already submitted." }, 409);
    }
    if (!leaseLost) {
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

      return c.json(updated);
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
  supportInboundRoute,
  supportCasesListRoute,
  supportCaseDetailRoute,
  supportCaseApproveRoute,
  supportCaseRejectRoute,
  supportCaseFeedbackRoute,
  supportMonitoringSummaryRoute,
  supportKnowledgeReindexRoute,
  supportOpenApiRoute,
];
