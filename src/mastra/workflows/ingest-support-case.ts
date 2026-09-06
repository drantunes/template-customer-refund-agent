import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { caseStore } from "../lib/case-store";
import { generateCaseId } from "../integrations/support-source";
import type { SupportCase } from "../domain/support-case";
import { defaultLocalBinding } from "../runtime/local-runtime";
import {
  providerRegistry,
  resolveConfiguredBinding,
} from "../providers/registry";
import { ownerIdForCustomer } from "../server/auth";
import { withDispatchLeaseScope } from "../lib/dispatch-lease-scope";
import { retryOrEscalateOperationalFailure } from "../lib/operational-alerts";

const ingressScopeSchema = z.object({
  id: z.string().min(1),
  email: z.email(),
  tenantId: z.string().min(1),
  roles: z.array(z.string()),
});
const ingestInputSchema = z.object({
  payload: z.unknown(),
  ingress: ingressScopeSchema,
});

const normalizeAndPersistStep = createStep({
  id: "normalize-inbound-message",
  description:
    "Normalizes a raw inbound payload into a SupportCase and persists it (idempotent on externalId).",
  inputSchema: ingestInputSchema,
  outputSchema: z.object({
    caseId: z.string(),
    isNew: z.boolean(),
    workflowRunId: z.string().optional(),
  }),
  execute: async ({ inputData, mastra }) => {
    if (!mastra)
      throw new Error(
        "Inbound acceptance must run through the registered Mastra instance.",
      );
    const ingress = resolveConfiguredBinding(defaultLocalBinding("inbound"));
    const normalized = await providerRegistry(ingress)
      .support(ingress)
      .normalizeInbound(inputData.payload);
    const support = resolveConfiguredBinding(normalized.binding);
    if (support.tenantId !== inputData.ingress.tenantId)
      throw new Error(
        "Inbound tenant does not match the authenticated principal.",
      );
    const verifiedOwner = ownerIdForCustomer(
      support.tenantId,
      normalized.customer.email,
    );
    const customerIngress = inputData.ingress.roles.includes("customer");
    if (
      !verifiedOwner ||
      (customerIngress &&
        (inputData.ingress.id !== verifiedOwner ||
          inputData.ingress.email.toLowerCase() !==
            normalized.customer.email.toLowerCase()))
    )
      throw new Error("Inbound customer does not match the verified owner.");
    // The support adapter owns the conversation reference; externalId is the
    // inbound event identity and may legitimately differ from it.
    const portBinding = support;
    const resolveRun = await mastra
      .getWorkflow("resolveSupportCaseWorkflow")
      .createRun();
    const acceptedAt = new Date().toISOString();
    const supportCase: SupportCase = {
      id: generateCaseId(),
      status: "new",
      externalId: normalized.externalId,
      source: normalized.source,
      customer: normalized.customer,
      subject: normalized.subject,
      messages: [normalized.message],
      // receivedAt records the provider occurrence only. Retention starts at
      // this server-owned acceptance boundary, never at a client timestamp.
      createdAt: acceptedAt,
      updatedAt: acceptedAt,
      metadata: {
        rawPayload: normalized.rawPayload,
        sourceOccurredAt: normalized.message.createdAt,
        // The adapter-normalized customer is mapped once at ingress to a
        // stable local owner. Later client email/query fields never alter it.
        ownerId: verifiedOwner,
        providerBinding: portBinding,
        providerBindings: {
          support: { ...portBinding },
          commerce: { ...portBinding },
          transactions: { ...portBinding },
          knowledge: { ...portBinding },
        },
      },
    };
    const accepted = await caseStore.acceptInbound(
      supportCase,
      normalized.externalId,
      resolveRun.runId,
    );
    if (accepted.appendRequired) {
      const followUp = await caseStore.appendFollowUp({
        caseId: accepted.caseId,
        eventId: normalized.externalId,
        message: normalized.message,
        runId: resolveRun.runId,
        expectedOwnerId: verifiedOwner,
      });
      return {
        caseId: accepted.caseId,
        isNew: followUp.appended,
        workflowRunId: followUp.appended ? resolveRun.runId : undefined,
      };
    }
    return {
      caseId: accepted.caseId,
      isNew: accepted.isNew,
      workflowRunId: accepted.isNew ? resolveRun.runId : undefined,
    };
  },
});

const startResolutionStep = createStep({
  id: "start-resolution",
  description:
    "Kicks off the resolve-support-case workflow without blocking the inbound webhook response.",
  inputSchema: z.object({
    caseId: z.string(),
    isNew: z.boolean(),
    workflowRunId: z.string().optional(),
  }),
  outputSchema: z.object({
    caseId: z.string(),
    workflowRunId: z.string().optional(),
  }),
  execute: async ({ inputData, mastra, requestContext, tracingContext }) => {
    if (!inputData.isNew) {
      return { caseId: inputData.caseId };
    }

    const resolveWorkflow = mastra!.getWorkflow("resolveSupportCaseWorkflow");
    if (!inputData.workflowRunId)
      throw new Error(
        "Accepted inbound case is missing its durable workflow run id.",
      );
    const dispatch = await caseStore.claimDispatchForStart(
      inputData.caseId,
      inputData.workflowRunId,
    );
    if (!dispatch) {
      // Recovery owns the lease, or this is the idempotent duplicate path.
      return {
        caseId: inputData.caseId,
        workflowRunId: inputData.workflowRunId,
      };
    }
    const run = await resolveWorkflow.createRun({
      runId: inputData.workflowRunId,
    });
    if (!(await caseStore.activateDispatch(dispatch)))
      return {
        caseId: inputData.caseId,
        workflowRunId: inputData.workflowRunId,
      };

    const heartbeat = setInterval(
      () =>
        void caseStore
          .renewDispatchLease(dispatch.id, dispatch.leaseToken!)
          .catch(() => undefined),
      10_000,
    );
    heartbeat.unref();
    void withDispatchLeaseScope(
      {
        dispatchId: dispatch.id,
        caseId: dispatch.caseId,
        turnId: dispatch.turnId,
        leaseToken: dispatch.leaseToken!,
      },
      () =>
        run.start({
          inputData: { caseId: inputData.caseId, turnId: dispatch.turnId },
          requestContext,
          tracingContext,
        }),
    )
      .then(async (result) => {
        if (result.status === "failed") {
          mastra!.getLogger()?.error("resolve-support-case run failed", {
            caseId: inputData.caseId,
            error: "Workflow start failed.",
          });
          await retryOrEscalateOperationalFailure({
            signal: {
              providerOrTool: "resolve-support-case",
              occurredAt: new Date(),
              durationMs: 0,
              failed: true,
            },
            retry: () =>
              caseStore.retryDispatch(
                dispatch.id,
                inputData.caseId,
                "Workflow start failed.",
                dispatch.leaseToken,
              ),
            escalate: () =>
              caseStore.failDispatchAndCase(
                dispatch.id,
                inputData.caseId,
                "Workflow start failed.",
                dispatch.leaseToken,
                "escalated",
              ),
          }).catch((error) =>
            mastra!.getLogger()?.error("Failed to persist workflow recovery.", {
              caseId: inputData.caseId,
              error,
            }),
          );
          return;
        }
        await caseStore.completeDispatch(
          dispatch.id,
          result.status === "suspended" || result.status === "paused"
            ? "suspended"
            : "completed",
          undefined,
          dispatch.leaseToken,
        );
      })
      .catch(async (error) => {
        mastra!.getLogger()?.error("resolve-support-case run failed", {
          error,
          caseId: inputData.caseId,
        });
        await retryOrEscalateOperationalFailure({
          signal: {
            providerOrTool: "resolve-support-case",
            occurredAt: new Date(),
            durationMs: 0,
            failed: true,
          },
          retry: () =>
            caseStore.retryDispatch(
              dispatch.id,
              inputData.caseId,
              error,
              dispatch.leaseToken,
            ),
          escalate: () =>
            caseStore.failDispatchAndCase(
              dispatch.id,
              inputData.caseId,
              error,
              dispatch.leaseToken,
              "escalated",
            ),
        }).catch((recoveryError) =>
          mastra!.getLogger()?.error("Failed to persist workflow recovery.", {
            caseId: inputData.caseId,
            error: recoveryError,
          }),
        );
      })
      .finally(() => clearInterval(heartbeat));

    return { caseId: inputData.caseId, workflowRunId: inputData.workflowRunId };
  },
});

export const ingestSupportCaseWorkflow = createWorkflow({
  id: "ingest-support-case",
  description:
    "Normalizes an inbound support message, persists it idempotently, and starts resolution.",
  inputSchema: ingestInputSchema,
  outputSchema: z.object({
    caseId: z.string(),
    workflowRunId: z.string().optional(),
  }),
})
  .then(normalizeAndPersistStep)
  .then(startResolutionStep)
  .commit();
