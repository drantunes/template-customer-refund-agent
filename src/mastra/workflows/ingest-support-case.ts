import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { caseStore } from "../lib/case-store";
import { generateCaseId } from "../integrations/support-source";
import { getActiveSupportAdapter } from "../integrations/active-adapter";
import type { SupportCase } from "../domain/support-case";

const normalizeAndPersistStep = createStep({
  id: "normalize-inbound-message",
  description:
    "Normalizes a raw inbound payload into a SupportCase and persists it (idempotent on externalId).",
  inputSchema: z.object({ payload: z.unknown() }),
  outputSchema: z.object({ caseId: z.string(), isNew: z.boolean() }),
  execute: async ({ inputData }) => {
    const normalized = await getActiveSupportAdapter().normalizeInbound(
      inputData.payload,
    );

    const existing = await caseStore.findByExternalId(
      normalized.source,
      normalized.externalId,
    );
    if (existing) {
      return { caseId: existing.id, isNew: false };
    }

    const supportCase: SupportCase = {
      id: generateCaseId(),
      status: "new",
      ...normalized,
    };
    await caseStore.create(supportCase);
    return { caseId: supportCase.id, isNew: true };
  },
});

const startResolutionStep = createStep({
  id: "start-resolution",
  description:
    "Kicks off the resolve-support-case workflow without blocking the inbound webhook response.",
  inputSchema: z.object({ caseId: z.string(), isNew: z.boolean() }),
  outputSchema: z.object({
    caseId: z.string(),
    workflowRunId: z.string().optional(),
  }),
  execute: async ({ inputData, mastra }) => {
    if (!inputData.isNew) {
      return { caseId: inputData.caseId };
    }

    const resolveWorkflow = mastra!.getWorkflow("resolveSupportCaseWorkflow");
    const run = await resolveWorkflow.createRun();
    await caseStore.update(inputData.caseId, { workflowRunId: run.runId });

    void run
      .start({ inputData: { caseId: inputData.caseId } })
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
      });

    return { caseId: inputData.caseId, workflowRunId: run.runId };
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
