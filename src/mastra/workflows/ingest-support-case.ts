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

const normalizeAndPersistStep = createStep({
  id: "normalize-inbound-message",
  description:
    "Normalizes a raw inbound payload into a SupportCase and persists it (idempotent on externalId).",
  inputSchema: z.object({ payload: z.unknown() }),
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
    // The support adapter owns the conversation reference; externalId is the
    // inbound event identity and may legitimately differ from it.
    const portBinding = support;
    const resolveRun = await mastra
      .getWorkflow("resolveSupportCaseWorkflow")
      .createRun();
    const supportCase: SupportCase = {
      id: generateCaseId(),
      status: "new",
      externalId: normalized.externalId,
      source: normalized.source,
      customer: normalized.customer,
      subject: normalized.subject,
      messages: [normalized.message],
      createdAt: normalized.message.createdAt,
      updatedAt: normalized.message.createdAt,
      metadata: {
        rawPayload: normalized.rawPayload,
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
      `event_${normalized.source}_${normalized.externalId}`,
      resolveRun.runId,
    );
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
    const dispatch = await caseStore.claimDispatchForStart(inputData.caseId);
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
    await caseStore.update(inputData.caseId, {
      workflowRunId: inputData.workflowRunId,
    });
    await caseStore.markDispatchStarted(inputData.caseId, dispatch.leaseToken);

    const heartbeat = setInterval(
      () =>
        void caseStore.renewDispatchLease(dispatch.id, dispatch.leaseToken!),
      10_000,
    );
    heartbeat.unref();
    void run
      .start({
        inputData: { caseId: inputData.caseId },
        requestContext,
        tracingContext,
      })
      .then(async (result) => {
        if (result.status === "failed") {
          mastra!.getLogger()?.error("resolve-support-case run failed", {
            caseId: inputData.caseId,
            error: "Workflow start failed.",
          });
          await caseStore.update(inputData.caseId, {
            status: "failed",
            escalationReason: "Workflow start failed.",
          });
        }
        await caseStore.completeDispatch(
          dispatch.id,
          result.status === "suspended"
            ? "suspended"
            : result.status === "success"
              ? "completed"
              : "failed",
          result.status === "failed" ? "Workflow start failed." : undefined,
          dispatch.leaseToken,
        );
      })
      .catch(async (error) => {
        mastra!.getLogger()?.error("resolve-support-case run failed", {
          error,
          caseId: inputData.caseId,
        });
        await caseStore.update(inputData.caseId, {
          status: "failed",
          escalationReason:
            error instanceof Error ? error.message : String(error),
        });
        await caseStore.completeDispatch(
          dispatch.id,
          "failed",
          error,
          dispatch.leaseToken,
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
  inputSchema: z.object({ payload: z.unknown() }),
  outputSchema: z.object({
    caseId: z.string(),
    workflowRunId: z.string().optional(),
  }),
})
  .then(normalizeAndPersistStep)
  .then(startResolutionStep)
  .commit();
