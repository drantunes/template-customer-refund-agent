import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { caseStore } from "../lib/case-store";
import {
  draftResolutionSchema,
  orderLookupSchema,
  refundHistorySchema,
  refundResultSchema,
  resourceIdForCase,
  subscriptionLookupSchema,
  threadIdForCase,
  triageResultSchema,
  type PolicyMatch,
  type SupportCase,
} from "../domain/support-case";
import { MAX_AUTO_APPROVABLE_REFUND } from "../tools/issue-refund";
import { caseStore as persistentCaseStore } from "../lib/case-store";
import { legacyAmountToMoney, refundFingerprint } from "../lib/money";
import {
  bindingsForPersistedCase,
  deliverOutbox,
} from "../runtime/local-runtime";
import {
  ensureProviderFixtures,
  providerRegistry,
  resolveConfiguredBinding,
} from "../providers/registry";

const caseIdSchema = z.object({ caseId: z.string() });

async function getCaseOrThrow(caseId: string) {
  const supportCase = await caseStore.get(caseId);
  if (!supportCase) throw new Error(`Support case not found: ${caseId}`);
  return supportCase;
}

const classifyStep = createStep({
  id: "classify",
  description: "Runs the triage agent on the customer's message.",
  inputSchema: caseIdSchema,
  outputSchema: caseIdSchema,
  execute: async ({ inputData, mastra, requestContext, tracingContext }) => {
    const supportCase = await getCaseOrThrow(inputData.caseId);
    const latestMessage = supportCase.messages[supportCase.messages.length - 1];
    if (!mastra)
      throw new Error(
        "The resolve workflow must run through a registered Mastra instance.",
      );

    // Capture the run's trace id once, up front, so the monitoring dashboard can pull
    // token usage and tool-call stats for this case straight from observability storage.
    const traceId = tracingContext?.currentSpan?.traceId;
    if (traceId) {
      await caseStore.update(supportCase.id, { traceId });
    }

    const result = await mastra.getAgent("triageAgent").generate(
      [
        {
          role: "user",
          content: `Subject: ${supportCase.subject}\n\nMessage:\n${latestMessage.body}`,
        },
      ],
      {
        structuredOutput: { schema: triageResultSchema },
        memory: {
          thread: threadIdForCase(supportCase.id),
          resource: resourceIdForCase(supportCase.id),
        },
        requestContext,
        tracingContext,
      },
    );

    const triageUsage = result.usage;
    await caseStore.update(supportCase.id, {
      triage: triageResultSchema.parse(result.object),
      status: "processing",
      agentUsage: {
        inputTokens: triageUsage.inputTokens ?? 0,
        outputTokens: triageUsage.outputTokens ?? 0,
        model: (result as { response?: { modelId?: string } }).response
          ?.modelId,
      },
    });
    return { caseId: supportCase.id };
  },
});

const retrievePolicyStep = createStep({
  id: "retrieve-policy",
  description:
    "Searches the indexed policy knowledge base for context relevant to this case.",
  inputSchema: caseIdSchema,
  outputSchema: caseIdSchema,
  execute: async ({ inputData, mastra, requestContext, tracingContext }) => {
    const supportCase = await getCaseOrThrow(inputData.caseId);
    const bindings = bindingsForPersistedCase(supportCase);
    const latestMessage = supportCase.messages[supportCase.messages.length - 1];
    const queryText =
      `${supportCase.triage?.intent ?? ""} ${supportCase.subject} ${latestMessage.body}`.trim();
    if (!mastra)
      throw new Error(
        "The resolve workflow must run through a registered Mastra instance.",
      );
    const searchTool = mastra.getTool("searchSupportKnowledgeTool");
    if (!searchTool.execute)
      throw new Error(
        "Registered search_support_knowledge tool has no execute function.",
      );

    const result = await searchTool.execute(
      {
        queryText,
        topK: 5,
        binding: resolveConfiguredBinding(bindings.knowledge),
      },
      { mastra, requestContext, tracingContext },
    );
    const sources: Array<{
      metadata?: Record<string, unknown>;
      document?: string;
      score?: number;
    }> =
      result && "sources" in result && Array.isArray(result.sources)
        ? (result.sources as Array<{
            metadata?: Record<string, unknown>;
            document?: string;
            score?: number;
          }>)
        : [];

    const policyMatches: PolicyMatch[] = (sources ?? []).map((source) => ({
      title: String(source.metadata?.title ?? "Untitled policy"),
      text: String(source.metadata?.text ?? source.document ?? ""),
      source: String(source.metadata?.source ?? "unknown"),
      score: source.score ?? 0,
    }));

    await caseStore.update(supportCase.id, { policyMatches });
    return { caseId: supportCase.id };
  },
});

const inspectOrderStep = createStep({
  id: "inspect-order",
  description:
    "Looks up the customer's order, subscription, and prior refunds.",
  inputSchema: caseIdSchema,
  outputSchema: caseIdSchema,
  execute: async ({ inputData, mastra, requestContext, tracingContext }) => {
    const supportCase = await getCaseOrThrow(inputData.caseId);
    const bindings = bindingsForPersistedCase(supportCase);
    if (!mastra)
      throw new Error(
        "The resolve workflow must run through a registered Mastra instance.",
      );
    const orderTool = mastra.getTool("lookupOrderTool");
    const subscriptionTool = mastra.getTool("lookupSubscriptionTool");
    const refundHistoryTool = mastra.getTool("lookupCustomerRefundHistoryTool");
    if (
      !orderTool.execute ||
      !subscriptionTool.execute ||
      !refundHistoryTool.execute
    ) {
      throw new Error(
        "A registered commerce lookup tool has no execute function.",
      );
    }

    const orderLookup = orderLookupSchema.parse(
      await orderTool.execute(
        {
          customerEmail: supportCase.customer.email,
          binding: resolveConfiguredBinding(bindings.commerce),
        },
        { mastra, requestContext, tracingContext },
      ),
    );

    const subscriptionLookup = subscriptionLookupSchema.parse(
      await subscriptionTool.execute(
        {
          customerEmail: supportCase.customer.email,
          binding: resolveConfiguredBinding(bindings.commerce),
        },
        { mastra, requestContext, tracingContext },
      ),
    );

    const refundHistory = orderLookup.found
      ? refundHistorySchema.parse(
          await refundHistoryTool.execute(
            {
              orderId: orderLookup.order?.orderId ?? "",
              binding: resolveConfiguredBinding(bindings.commerce),
            },
            { mastra, requestContext, tracingContext },
          ),
        )
      : { refunds: [] };

    await caseStore.update(supportCase.id, {
      orderLookup,
      subscriptionLookup,
      refundHistory,
    });
    return { caseId: supportCase.id };
  },
});

const draftResponseStep = createStep({
  id: "draft-response",
  description:
    "Runs the response agent to draft a grounded reply and refund recommendation.",
  inputSchema: caseIdSchema,
  outputSchema: caseIdSchema,
  execute: async ({ inputData, mastra, requestContext, tracingContext }) => {
    const supportCase = await getCaseOrThrow(inputData.caseId);
    const latestMessage = supportCase.messages[supportCase.messages.length - 1];
    if (!mastra)
      throw new Error(
        "The resolve workflow must run through a registered Mastra instance.",
      );

    const context = {
      subject: supportCase.subject,
      customerMessage: latestMessage.body,
      customerEmail: supportCase.customer.email,
      triage: supportCase.triage,
      policyMatches: supportCase.policyMatches,
      orderLookup: supportCase.orderLookup,
      subscriptionLookup: supportCase.subscriptionLookup,
      refundHistory: supportCase.refundHistory,
    };

    const result = await mastra.getAgent("responseAgent").generate(
      [
        {
          role: "user",
          content: `Draft a resolution for this support case. Here is everything retrieved so far as JSON - use only this data, plus your tools if you need to double check something:\n\n${JSON.stringify(context, null, 2)}`,
        },
      ],
      {
        structuredOutput: { schema: draftResolutionSchema },
        memory: {
          thread: threadIdForCase(supportCase.id),
          resource: resourceIdForCase(supportCase.id),
        },
        requestContext,
        tracingContext,
      },
    );

    const responseUsage = result.usage;
    const existingUsage = supportCase.agentUsage;
    await caseStore.update(supportCase.id, {
      draft: draftResolutionSchema.parse(result.object),
      agentUsage: {
        inputTokens:
          (existingUsage?.inputTokens ?? 0) + (responseUsage.inputTokens ?? 0),
        outputTokens:
          (existingUsage?.outputTokens ?? 0) +
          (responseUsage.outputTokens ?? 0),
        model:
          (result as { response?: { modelId?: string } }).response?.modelId ??
          existingUsage?.model,
      },
    });
    return { caseId: supportCase.id };
  },
});

const approvalInputSchema = caseIdSchema;
const approvalOutputSchema = z.object({
  caseId: z.string(),
  approved: z.boolean(),
  approverId: z.string().optional(),
  note: z.string().optional(),
});

const persistedRefundCommandSchema = z.object({
  approvalCaseId: z.string().min(1),
  orderId: z.string().min(1),
  amount: z.number().positive(),
  currency: z.string().min(1),
  reason: z.string().min(1),
  idempotencyKey: z.string().min(1),
  fingerprint: z.string().min(1),
});

/** A running snapshot can be restarted after the API accepted a decision but
 * before Mastra persisted the downstream step.  The restarted checkpoint has
 * no resumeData, so recover only an already durable decision.  Approval is
 * tied to the immutable action row, never just mutable case metadata. */
async function recoveredApprovalDecision(supportCase: SupportCase) {
  const decision = supportCase.approval;
  if (!decision) return undefined;
  if (!decision.approverId)
    throw new Error("The persisted approval decision is missing its approver.");
  if (decision.approved) {
    const stored = persistedRefundCommandSchema.safeParse(
      (supportCase.metadata as Record<string, unknown>).refundCommand,
    );
    if (!stored.success)
      throw new Error("The persisted refund command is missing.");
    const command = stored.data;
    const binding = resolveConfiguredBinding(
      bindingsForPersistedCase(supportCase).transactions,
    );
    const immutable = {
      binding,
      approvalCaseId: supportCase.id,
      orderId: command.orderId,
      amount: legacyAmountToMoney(command.amount, command.currency),
      reason: command.reason,
      idempotencyKey: command.idempotencyKey,
    };
    const fingerprint = refundFingerprint(immutable);
    if (
      command.approvalCaseId !== supportCase.id ||
      command.fingerprint !== fingerprint
    )
      throw new Error("The persisted refund command fingerprint is invalid.");
    const action = await persistentCaseStore.getAction(
      supportCase.id,
      "refund-command",
      fingerprint,
    );
    if (
      !action ||
      JSON.stringify(action) !== JSON.stringify({ ...immutable, fingerprint })
    )
      throw new Error(
        "The persisted approved refund command does not match its immutable action.",
      );
  }
  return {
    caseId: supportCase.id,
    approved: decision.approved,
    approverId: decision.approverId,
    note: decision.note,
  };
}

const requestApprovalStep = createStep({
  id: "request-approval",
  description:
    "Suspends the workflow for human approval when the drafted resolution recommends a refund.",
  inputSchema: approvalInputSchema,
  resumeSchema: z.object({
    approved: z.boolean(),
    approverId: z.string(),
    note: z.string().optional(),
  }),
  suspendSchema: z.object({
    caseId: z.string(),
    refundAmount: z.number(),
    refundCurrency: z.string(),
    refundReason: z.string(),
    orderId: z.string(),
    draftResponse: z.string(),
  }),
  outputSchema: approvalOutputSchema,
  execute: async ({ inputData, resumeData, suspend }) => {
    const supportCase = await getCaseOrThrow(inputData.caseId);
    const bindings = bindingsForPersistedCase(supportCase);
    const draft = supportCase.draft;

    if (!draft?.recommendRefund) {
      return { caseId: supportCase.id, approved: false };
    }

    if (!resumeData) {
      const recovered = await recoveredApprovalDecision(supportCase);
      if (recovered) return recovered;
      const amount = draft.refundAmount ?? 0;
      const currency = draft.refundCurrency ?? "USD";
      const command = {
        approvalCaseId: supportCase.id,
        orderId: supportCase.orderLookup?.order?.orderId ?? "",
        amount,
        currency,
        reason: draft.refundReason ?? "Approved support refund",
        idempotencyKey: supportCase.id,
        fingerprint: "",
      };
      if (!command.orderId)
        throw new Error(
          "A refund recommendation requires an unambiguous order id.",
        );
      const money = legacyAmountToMoney(amount, currency);
      const binding = resolveConfiguredBinding(bindings.transactions);
      const immutableCommand = {
        binding,
        approvalCaseId: supportCase.id,
        orderId: command.orderId,
        amount: money,
        reason: command.reason,
        idempotencyKey: command.idempotencyKey,
      };
      command.fingerprint = refundFingerprint(immutableCommand);
      await ensureProviderFixtures(binding);
      const approvedCommand = {
        ...immutableCommand,
        fingerprint: command.fingerprint,
      };
      await providerRegistry(binding)
        .transactions(binding)
        .quoteRefund(approvedCommand);
      await persistentCaseStore.saveAction(
        supportCase.id,
        "refund-command",
        command.fingerprint,
        approvedCommand,
      );
      await caseStore.update(supportCase.id, {
        status: "waiting_approval",
        metadata: { ...supportCase.metadata, refundCommand: command },
      });
      return await suspend({
        caseId: supportCase.id,
        refundAmount: draft.refundAmount ?? 0,
        refundCurrency: draft.refundCurrency ?? "USD",
        refundReason: draft.refundReason ?? "",
        orderId: supportCase.orderLookup?.order?.orderId ?? "",
        draftResponse: draft.draftResponse,
      });
    }

    if (!(supportCase.metadata as Record<string, unknown>).refundCommand)
      throw new Error("The persisted refund command is missing.");
    await caseStore.update(supportCase.id, {
      approval: {
        approved: resumeData.approved,
        approverId: resumeData.approverId,
        note: resumeData.note,
      },
    });

    return {
      caseId: supportCase.id,
      approved: resumeData.approved,
      approverId: resumeData.approverId,
      note: resumeData.note,
    };
  },
});

const resolveCaseStep = createStep({
  id: "resolve-case",
  description:
    "Executes an approved refund, or marks the case resolved/escalated.",
  inputSchema: approvalOutputSchema,
  outputSchema: z.object({
    caseId: z.string(),
    status: z.enum(["resolved", "escalated"]),
  }),
  execute: async ({ inputData, mastra, requestContext, tracingContext }) => {
    const supportCase = await getCaseOrThrow(inputData.caseId);
    const draft = supportCase.draft!;
    let finalResponse = draft.draftResponse;
    let status: "resolved" | "escalated" = draft.requiresEscalation
      ? "escalated"
      : "resolved";
    let escalationReason = draft.escalationReason;

    if (draft.recommendRefund) {
      if (!inputData.approved) {
        status = "escalated";
        escalationReason = `Refund declined by ${inputData.approverId ?? "reviewer"}${inputData.note ? `: ${inputData.note}` : "."}`;
        finalResponse = `Thanks for your patience - a specialist is going to take a closer look at your case and follow up shortly.`;
      } else {
        const orderId = supportCase.orderLookup?.order?.orderId;
        if (!orderId) {
          status = "escalated";
          escalationReason =
            "Refund was approved but no order id was on file - needs manual handling.";
        } else if ((draft.refundAmount ?? 0) > MAX_AUTO_APPROVABLE_REFUND) {
          status = "escalated";
          escalationReason = `Refund amount ${draft.refundAmount} exceeds the ${MAX_AUTO_APPROVABLE_REFUND} auto-approvable limit and needs a senior approver.`;
        } else {
          if (!mastra)
            throw new Error(
              "The resolve workflow must run through a registered Mastra instance.",
            );
          const refundTool = mastra.getTool("issueRefundTool");
          if (!refundTool.execute)
            throw new Error(
              "Registered issue_refund tool has no execute function.",
            );
          const refundResult = refundResultSchema.parse(
            await refundTool.execute(
              {
                caseId: supportCase.id,
                orderId,
                amount: draft.refundAmount ?? 0,
                currency: draft.refundCurrency ?? "USD",
                reason: draft.refundReason ?? "Approved support refund",
                idempotencyKey: supportCase.id,
                fingerprint: String(
                  (supportCase.metadata as Record<string, unknown>)
                    .refundCommand &&
                    (
                      (supportCase.metadata as Record<string, unknown>)
                        .refundCommand as { fingerprint?: string }
                    ).fingerprint,
                ),
              },
              { mastra, requestContext, tracingContext },
            ),
          );
          await caseStore.update(supportCase.id, { refundResult });
          status = "resolved";
        }
      }
    }

    const message = {
      // Deterministic identities make an active-step replay converge on the
      // already finalized message/outbox pair.
      id: `msg_${supportCase.id}_final`,
      author: "agent" as const,
      authorName: "Support Agent",
      body: finalResponse,
      createdAt: new Date().toISOString(),
    };
    await persistentCaseStore.finalizeCaseAndEnqueue({
      caseId: supportCase.id,
      status,
      finalResponse,
      escalationReason,
      message,
      outbox: {
        id: `outbox_${supportCase.id}_final`,
        caseId: supportCase.id,
        binding: resolveConfiguredBinding(
          bindingsForPersistedCase(supportCase).support,
        ),
        body: finalResponse,
        status,
      },
    });
    await deliverOutbox().catch((error) =>
      mastra
        ?.getLogger()
        ?.warn("Local outbox delivery failed; recovery will retry it.", {
          error,
          caseId: supportCase.id,
        }),
    );

    return { caseId: supportCase.id, status };
  },
});

export const resolveSupportCaseWorkflow = createWorkflow({
  id: "resolve-support-case",
  description:
    "The core resolution pipeline: classify -> retrieve policy -> inspect order -> draft response -> human refund approval -> execute or escalate.",
  inputSchema: caseIdSchema,
  outputSchema: z.object({
    caseId: z.string(),
    status: z.enum(["resolved", "escalated"]),
  }),
})
  .then(classifyStep)
  .then(retrievePolicyStep)
  .then(inspectOrderStep)
  .then(draftResponseStep)
  .then(requestApprovalStep)
  .then(resolveCaseStep)
  .commit();

export const REQUEST_APPROVAL_STEP_ID = requestApprovalStep.id;
