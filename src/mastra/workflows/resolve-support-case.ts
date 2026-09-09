import { createStep, createWorkflow } from "@mastra/core/workflows";
import { createHash } from "node:crypto";
import { z } from "zod";
import { caseStore } from "../lib/case-store";
import { withTrustedCommerceScope } from "../lib/trusted-run-scope";
import {
  draftResolutionSchema,
  orderLookupSchema,
  refundHistorySchema,
  resourceIdForOwner,
  subscriptionLookupSchema,
  threadIdForCase,
  triageResultSchema,
  type PolicyMatch,
  type SupportCase,
} from "../domain/support-case";
import { refundExecutionInputSchema } from "../tools/issue-refund";
import { STANDARD_REFUND_REVIEW_LIMIT } from "../domain/refund-review-limit";
import { persistedRefundCommandSchema } from "../domain/refund-command";
import {
  escalationReasonForDraft,
  triageEscalationReason,
} from "../domain/resolution-decision";
import {
  renderGroundedSupportResponse,
  safeEscalationResponse,
} from "../domain/customer-response";
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
import { knowledgePublicationStore } from "../lib/knowledge-publications";
import { withTrustedCaseReadScope } from "../lib/trusted-run-scope";
import { publishKnowledge } from "../lib/publish-knowledge";
import { traceOperationalPort } from "../lib/operational-spans";
import { withTrustedCancellationScope } from "../providers/cancellation-execution";
import { cancellationFingerprint } from "../tools/schedule-subscription-cancellation";

const caseIdSchema = z.object({ caseId: z.string(), turnId: z.string() });

/** Serialize only the authoritative identities already selected by the
 * grounded draft. This durable action is later read by the provider write
 * transaction; it intentionally does not consult a newer case draft. */
function parsedDraftEvidence(supportCase: SupportCase, citations: string[]) {
  return citations.map((citation) => {
    const match = (supportCase.policyMatches ?? []).find(
      (entry) => entry.title === citation || entry.source === citation,
    );
    if (
      !match?.source ||
      !match.title ||
      !match.documentHash ||
      !match.generationId ||
      !match.version ||
      !match.effectiveAt ||
      !match.indexedAt ||
      !match.providerKind ||
      !match.providerAccountId
    )
      throw new Error(
        "Refund approval requires complete authoritative policy evidence.",
      );
    return {
      title: match.title,
      source: match.source,
      documentHash: match.documentHash,
      generationId: match.generationId,
      version: match.version,
      effectiveAt: match.effectiveAt,
      indexedAt: match.indexedAt,
      expiresAt: match.expiresAt,
      providerKind: match.providerKind,
      providerAccountId: match.providerAccountId,
    };
  });
}

const immutableRefundCommandSchema = z.object({
  binding: z.object({
    tenantId: z.string(),
    providerKind: z.enum(["local", "stripe"]),
    providerAccountId: z.string(),
    externalConversationId: z.string(),
  }),
  approvalCaseId: z.string(),
  orderId: z.string(),
  amount: z.object({
    currency: z.string(),
    minor: z.number().int().positive(),
  }),
  reason: z.string(),
  idempotencyKey: z.string(),
  fingerprint: z.string(),
});

const durableRefundEffectSchema = z.object({
  refundId: z.string(),
  orderId: z.string(),
  amount: z.object({
    currency: z.string(),
    minor: z.number().int().positive(),
  }),
  idempotencyKey: z.string(),
  executedAt: z.string().refine((value) => Number.isFinite(Date.parse(value))),
  replayed: z.boolean().optional(),
});

/** A completed refund message is permitted only when every customer-visible
 * detail is bound back to the same durable effect, immutable command, account,
 * and inbound turn. This intentionally does not inspect model text. */
async function completedRefundResponse(
  supportCase: SupportCase,
  turnId: string,
) {
  const metadata = supportCase.metadata as Record<string, unknown>;
  const command = persistedRefundCommandSchema.safeParse(
    metadata.refundCommand,
  );
  const result = supportCase.refundResult;
  const turn = await persistentCaseStore.turn(supportCase.id, turnId);
  if (
    !command.success ||
    !result ||
    !turn ||
    !["executed", "skipped"].includes(result.status)
  )
    return undefined;

  const binding = resolveConfiguredBinding(
    bindingsForPersistedCase(supportCase).transactions,
  );
  let expectedAmount;
  try {
    expectedAmount = legacyAmountToMoney(
      command.data.amount,
      command.data.currency,
    );
  } catch {
    return undefined;
  }
  const expectedFingerprint = refundFingerprint({
    binding,
    approvalCaseId: supportCase.id,
    orderId: command.data.orderId,
    amount: expectedAmount,
    reason: command.data.reason,
    idempotencyKey: command.data.idempotencyKey,
  });
  const immutable = immutableRefundCommandSchema.safeParse(
    await persistentCaseStore.getAction(
      supportCase.id,
      "refund-command",
      command.data.fingerprint,
    ),
  );
  const idempotency = await persistentCaseStore.idempotency(
    command.data.idempotencyKey,
  );
  const effect = durableRefundEffectSchema.safeParse(idempotency?.effect);
  const decision = await persistentCaseStore.approvalDecision(
    supportCase.id,
    turnId,
  );
  const projected = metadata.refundEffects as
    Record<string, unknown> | undefined;
  const projectedResult = projected?.[command.data.fingerprint];

  if (
    command.data.approvalCaseId !== supportCase.id ||
    command.data.fingerprint !== expectedFingerprint ||
    turn.commandFingerprint !== command.data.fingerprint ||
    metadata.activeTurnId !== turnId ||
    !supportCase.approval?.approved ||
    !decision?.approved ||
    decision.turnId !== turnId ||
    decision.commandFingerprint !== command.data.fingerprint ||
    !immutable.success ||
    immutable.data.binding.tenantId !== binding.tenantId ||
    immutable.data.binding.providerKind !== binding.providerKind ||
    immutable.data.binding.providerAccountId !== binding.providerAccountId ||
    immutable.data.approvalCaseId !== supportCase.id ||
    immutable.data.orderId !== command.data.orderId ||
    immutable.data.amount.currency !== expectedAmount.currency ||
    immutable.data.amount.minor !== expectedAmount.minor ||
    immutable.data.reason !== command.data.reason ||
    immutable.data.idempotencyKey !== command.data.idempotencyKey ||
    immutable.data.fingerprint !== command.data.fingerprint ||
    idempotency?.fingerprint !== command.data.fingerprint ||
    !effect.success ||
    effect.data.orderId !== command.data.orderId ||
    effect.data.amount.currency !== expectedAmount.currency ||
    effect.data.amount.minor !== expectedAmount.minor ||
    effect.data.idempotencyKey !== command.data.idempotencyKey ||
    result.refundId !== effect.data.refundId ||
    result.orderId !== effect.data.orderId ||
    result.amount !== command.data.amount ||
    result.currency !== effect.data.amount.currency ||
    result.idempotencyKey !== effect.data.idempotencyKey ||
    result.executedAt !== effect.data.executedAt ||
    JSON.stringify(projectedResult) !== JSON.stringify(result)
  )
    return undefined;

  return `Your refund of ${result.amount} ${result.currency} has been issued.`;
}

async function getCaseOrThrow(caseId: string, turnId: string) {
  const supportCase = await caseStore.get(caseId);
  if (!supportCase) throw new Error(`Support case not found: ${caseId}`);
  if ((supportCase.metadata as Record<string, unknown>).activeTurnId !== turnId)
    throw new Error(
      "Workflow turn is no longer the active durable projection.",
    );
  const turn = await caseStore.turn(caseId, turnId);
  if (!turn?.message)
    throw new Error("Workflow turn is missing its immutable customer message.");
  const ownerId = (supportCase.metadata as Record<string, unknown>).ownerId;
  if (typeof ownerId !== "string" || !ownerId)
    throw new Error("Workflow case has no verified owner binding.");
  return { supportCase, turn, ownerId };
}

const classifyStep = createStep({
  id: "classify",
  description: "Runs the triage agent on the customer's message.",
  inputSchema: caseIdSchema,
  outputSchema: caseIdSchema,
  execute: async ({ inputData, mastra, requestContext, tracingContext }) => {
    const { supportCase, turn, ownerId } = await getCaseOrThrow(
      inputData.caseId,
      inputData.turnId,
    );
    const latestMessage = turn.message!;
    if (!mastra)
      throw new Error(
        "The resolve workflow must run through a registered Mastra instance.",
      );

    // Capture the run's trace id once, up front, so the monitoring dashboard can pull
    // token usage and tool-call stats for this case straight from observability storage.
    const traceId = tracingContext?.currentSpan?.traceId;
    if (traceId) {
      await caseStore.update(supportCase.id, { traceId });
      await caseStore.recordTurnTelemetry(supportCase.id, inputData.turnId, {
        traceId,
        workflowRunId: supportCase.workflowRunId,
      });
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
          thread: threadIdForCase(
            supportCase.id,
            bindingsForPersistedCase(supportCase).support.tenantId,
          ),
          resource: resourceIdForOwner(
            ownerId,
            bindingsForPersistedCase(supportCase).support.tenantId,
          ),
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
    return { caseId: supportCase.id, turnId: inputData.turnId };
  },
});

const retrievePolicyStep = createStep({
  id: "retrieve-policy",
  description:
    "Searches the indexed policy knowledge base for context relevant to this case.",
  inputSchema: caseIdSchema,
  outputSchema: caseIdSchema,
  execute: async ({ inputData, mastra, requestContext, tracingContext }) => {
    const { supportCase, turn } = await getCaseOrThrow(
      inputData.caseId,
      inputData.turnId,
    );
    const bindings = bindingsForPersistedCase(supportCase);
    const latestMessage = turn.message!;
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
    // The operational workflow is a trusted publication boundary. It may
    // establish the initial local generation; the read tool below never can.
    await publishKnowledge(bindings.knowledge, {
      onlyIfMissing: true,
      mastra,
      tracingContext,
    });

    const result = await withTrustedCaseReadScope(
      {
        caseId: supportCase.id,
        ownerId: (supportCase.metadata as Record<string, unknown>)
          .ownerId as string,
        tenantId: bindings.knowledge.tenantId,
      },
      () =>
        traceOperationalPort({
          mastra,
          tracingContext,
          kind: "tool",
          operation: "tool.search_support_knowledge",
          run: () =>
            searchTool.execute!(
              {
                queryText,
                topK: 5,
                binding: resolveConfiguredBinding(bindings.knowledge),
              },
              { mastra, requestContext, tracingContext },
            ),
        }),
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
      version:
        typeof source.metadata?.version === "string"
          ? source.metadata.version
          : undefined,
      documentHash:
        typeof source.metadata?.documentHash === "string"
          ? source.metadata.documentHash
          : undefined,
      generationId:
        typeof source.metadata?.generationId === "string"
          ? source.metadata.generationId
          : undefined,
      effectiveAt:
        typeof source.metadata?.effectiveAt === "string"
          ? source.metadata.effectiveAt
          : undefined,
      indexedAt:
        typeof source.metadata?.indexedAt === "string"
          ? source.metadata.indexedAt
          : undefined,
      expiresAt:
        typeof source.metadata?.expiresAt === "string"
          ? source.metadata.expiresAt
          : undefined,
      providerKind:
        typeof source.metadata?.providerKind === "string"
          ? source.metadata.providerKind
          : undefined,
      providerAccountId:
        typeof source.metadata?.providerAccountId === "string"
          ? source.metadata.providerAccountId
          : undefined,
    }));

    await caseStore.update(supportCase.id, { policyMatches });
    return { caseId: supportCase.id, turnId: inputData.turnId };
  },
});

const inspectOrderStep = createStep({
  id: "inspect-order",
  description:
    "Looks up the customer's order, subscription, and prior refunds.",
  inputSchema: caseIdSchema,
  outputSchema: caseIdSchema,
  execute: async ({ inputData, mastra, requestContext, tracingContext }) => {
    const { supportCase, ownerId } = await getCaseOrThrow(
      inputData.caseId,
      inputData.turnId,
    );
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
    // Fixture setup is an operational workflow concern. Read tools stay pure
    // so a supervisor investigation cannot seed commerce state.
    await ensureProviderFixtures(resolveConfiguredBinding(bindings.commerce));
    const executeOrder = orderTool.execute;
    const executeSubscription = subscriptionTool.execute;
    const executeRefundHistory = refundHistoryTool.execute;

    return withTrustedCommerceScope(
      {
        caseId: supportCase.id,
        ownerId,
        tenantId: bindings.commerce.tenantId,
      },
      async () => {
        const orderLookup = orderLookupSchema.parse(
          await traceOperationalPort({
            mastra,
            tracingContext,
            kind: "tool",
            operation: "tool.lookup_order",
            run: () =>
              executeOrder(
                {
                  customerEmail: supportCase.customer.email,
                  binding: resolveConfiguredBinding(bindings.commerce),
                },
                { mastra, requestContext, tracingContext },
              ),
          }),
        );

        const subscriptionLookup = subscriptionLookupSchema.parse(
          await traceOperationalPort({
            mastra,
            tracingContext,
            kind: "tool",
            operation: "tool.lookup_subscription",
            run: () =>
              executeSubscription(
                {
                  customerEmail: supportCase.customer.email,
                  binding: resolveConfiguredBinding(bindings.commerce),
                },
                { mastra, requestContext, tracingContext },
              ),
          }),
        );

        if (
          bindings.commerce.providerKind === "stripe" &&
          orderLookup.found &&
          subscriptionLookup.found &&
          supportCase.triage?.intent !== "cancellation"
        )
          throw new Error(
            "Stripe refund target is ambiguous between Checkout and a subscription invoice.",
          );

        // A renewal's paid Invoice/InvoicePayment is a distinct immutable
        // refund target. Never silently fall back to an initial Checkout.
        const refundTargetId =
          orderLookup.order?.orderId ??
          subscriptionLookup.subscription?.refundOrderId;
        const refundHistory = refundTargetId
          ? refundHistorySchema.parse(
              await traceOperationalPort({
                mastra,
                tracingContext,
                kind: "tool",
                operation: "tool.lookup_customer_refund_history",
                run: () =>
                  executeRefundHistory(
                    {
                      orderId: refundTargetId,
                      binding: resolveConfiguredBinding(bindings.commerce),
                    },
                    { mastra, requestContext, tracingContext },
                  ),
              }),
            )
          : { refunds: [] };

        await caseStore.update(supportCase.id, {
          orderLookup,
          subscriptionLookup,
          refundHistory,
        });
        return { caseId: supportCase.id, turnId: inputData.turnId };
      },
    );
  },
});

const draftResponseStep = createStep({
  id: "draft-response",
  description:
    "Runs the response agent to draft a grounded reply and refund recommendation.",
  inputSchema: caseIdSchema,
  outputSchema: caseIdSchema,
  execute: async ({ inputData, mastra, requestContext, tracingContext }) => {
    const { supportCase, turn, ownerId } = await getCaseOrThrow(
      inputData.caseId,
      inputData.turnId,
    );
    const latestMessage = turn.message!;
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

    const bindings = bindingsForPersistedCase(supportCase);
    const result = await withTrustedCommerceScope(
      {
        caseId: supportCase.id,
        ownerId,
        tenantId: bindings.commerce.tenantId,
      },
      () =>
        mastra.getAgent("responseAgent").generate(
          [
            {
              role: "user",
              content: `Draft a resolution for this support case. Here is everything retrieved so far as JSON - use only this data, plus your tools if you need to double check something:\n\n${JSON.stringify(context, null, 2)}`,
            },
          ],
          {
            structuredOutput: { schema: draftResolutionSchema },
            memory: {
              thread: threadIdForCase(
                supportCase.id,
                bindings.support.tenantId,
              ),
              resource: resourceIdForOwner(ownerId, bindings.support.tenantId),
            },
            requestContext,
            tracingContext,
          },
        ),
    );

    const responseUsage = result.usage;
    const existingUsage = supportCase.agentUsage;
    const parsedDraft = draftResolutionSchema.parse(result.object);
    // A cancellation effect has a deliberately small non-model authority
    // surface.  The current, verified customer turn must match this complete
    // command form; mentioning cancellation or a refund elsewhere is never
    // enough to create an external effect.
    const hasNoRefundCancellationAuthority =
      supportCase.triage?.intent === "cancellation" &&
      explicitNoRefundCancellation(latestMessage.body);
    const policyMatches = supportCase.policyMatches ?? [];
    const validCitations = new Set(
      policyMatches.flatMap((entry) => [entry.title, entry.source]),
    );
    const missingEvidence = policyMatches.length === 0;
    const requiresSupportingCitation =
      hasNoRefundCancellationAuthority ||
      parsedDraft.recommendRefund ||
      !parsedDraft.requiresEscalation;
    const invalidCitation =
      (requiresSupportingCitation && parsedDraft.citedSources.length === 0) ||
      parsedDraft.citedSources.some(
        (citation) => !validCitations.has(citation),
      );
    // Retrieval is not a decision. Re-read the selected authoritative
    // publication just before committing the draft so expiry, rollback, or a
    // stale/tampered vector result cannot support a customer promise.
    const authoritativeTexts = new Map<string, string>();
    const applicableEvidence = await Promise.all(
      parsedDraft.citedSources.map(async (citation) => {
        const match = policyMatches.find(
          (entry) => entry.title === citation || entry.source === citation,
        );
        if (
          !match?.source ||
          !match.documentHash ||
          !match.generationId ||
          !match.version ||
          !match.effectiveAt ||
          !match.indexedAt ||
          !match.providerKind ||
          !match.providerAccountId ||
          match.providerKind !== bindings.knowledge.providerKind ||
          match.providerAccountId !== bindings.knowledge.providerAccountId
        )
          return false;
        try {
          if (
            (await knowledgePublicationStore.activeGeneration(
              bindings.knowledge,
            )) !== match.generationId
          )
            return false;
          const authoritative = await knowledgePublicationStore.document(
            bindings.knowledge,
            match.generationId,
            match.source,
            match.documentHash,
          );
          const now = Date.now();
          const valid = Boolean(
            authoritative &&
            authoritative.title === match.title &&
            authoritative.version === match.version &&
            authoritative.effectiveAt === match.effectiveAt &&
            authoritative.indexedAt === match.indexedAt &&
            authoritative.expiresAt === match.expiresAt &&
            authoritative?.text.includes(match.text) &&
            Date.parse(authoritative.effectiveAt) <= now &&
            (!authoritative.expiresAt ||
              Date.parse(authoritative.expiresAt) > now),
          );
          if (valid && authoritative)
            authoritativeTexts.set(match.source, authoritative.text);
          return valid;
        } catch {
          return false;
        }
      }),
    );
    const staleOrUnauthoritativeEvidence =
      requiresSupportingCitation && !applicableEvidence.every(Boolean);
    const invalidPolicySelection =
      !parsedDraft.requiresEscalation &&
      (parsedDraft.selectedPolicyExcerpts.length === 0 ||
        parsedDraft.selectedPolicyExcerpts.some((selection) => {
          const match = policyMatches.find(
            (entry) =>
              (entry.source === selection.source ||
                entry.title === selection.source) &&
              parsedDraft.citedSources.some(
                (citation) =>
                  citation === entry.source || citation === entry.title,
              ),
          );
          return (
            !match ||
            !authoritativeTexts.get(match.source)?.includes(selection.excerpt)
          );
        }));
    // A model cannot turn absent, stale, or conflicting evidence into an
    // executable promise. Preserve its text for staff review, but force the
    // durable case down the escalation path and suppress a refund proposal.
    // An escalation is deliberately a handoff, not a license to deliver
    // arbitrary model prose.  Keep the model's proposed text only in staff
    // metadata: even a non-refund draft can falsely assert that a refund was
    // issued or rely on evidence that expired while it was being generated.
    const writerRequiresEscalation =
      !hasNoRefundCancellationAuthority && parsedDraft.requiresEscalation;
    const escalationReason =
      supportCase.triage?.intent === "account_issue"
        ? "Account requests require a support specialist with verified account-service access."
        : escalationReasonForDraft({
            triage: supportCase.triage,
            missingEvidence,
            invalidCitation: invalidCitation || invalidPolicySelection,
            staleEvidence: staleOrUnauthoritativeEvidence,
            writerRequiresEscalation,
            writerReason: parsedDraft.escalationReason,
          });
    const mustUseSafeEscalation = escalationReason !== undefined;
    const evidenceSafeDraft = mustUseSafeEscalation
      ? {
          ...parsedDraft,
          draftResponse: safeEscalationResponse,
          recommendRefund: false,
          refundAmount: undefined,
          refundCurrency: undefined,
          refundReason: undefined,
          requiresEscalation: true,
          escalationReason,
        }
      : parsedDraft;
    // A qualifying no-refund cancellation is authorized by the immutable
    // customer turn, never by a draft recommendation.  Remove every refund
    // field before the later cancellation and native-approval steps run, so a
    // conflicting model response cannot persist a refund command or suspend
    // the agent lifecycle.
    const safeDraft = hasNoRefundCancellationAuthority
      ? {
          ...evidenceSafeDraft,
          recommendRefund: false,
          refundAmount: undefined,
          refundCurrency: undefined,
          refundReason: undefined,
        }
      : evidenceSafeDraft;
    await caseStore.update(supportCase.id, {
      draft: safeDraft,
      metadata: mustUseSafeEscalation
        ? {
            ...supportCase.metadata,
            rejectedDraftForStaff: {
              draftResponse: parsedDraft.draftResponse,
              citedSources: parsedDraft.citedSources,
              reason: safeDraft.escalationReason,
            },
          }
        : supportCase.metadata,
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
    return { caseId: supportCase.id, turnId: inputData.turnId };
  },
});

const approvalInputSchema = caseIdSchema;
const approvalOutputSchema = z.object({
  caseId: z.string(),
  turnId: z.string(),
  approved: z.boolean(),
  approverId: z.string().optional(),
  note: z.string().optional(),
});

/** A running snapshot can be restarted after the API accepted a decision but
 * before Mastra persisted the downstream step.  The restarted checkpoint has
 * no resumeData, so recover only an already durable decision.  Approval is
 * tied to the immutable action row, never just mutable case metadata. */
async function recoveredApprovalDecision(
  supportCase: SupportCase,
  turnId: string,
) {
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
    turnId,
    approved: decision.approved,
    approverId: decision.approverId,
    note: decision.note,
  };
}

export function explicitNoRefundCancellation(body: string) {
  const normalized = body.trim().replace(/\s+/g, " ").toLowerCase();
  return /^(?:please )?cancel(?: my)? subscription(?: at the end of (?:the )?(?:current )?(?:billing )?period)?[.!]? (?:i )?(?:do not|don't) want (?:a )?refund[.!]?$/.test(
    normalized,
  );
}

const scheduleCancellationStep = createStep({
  id: "schedule-subscription-cancellation",
  description:
    "Schedules only an explicit verified-owner no-refund cancellation at period end.",
  inputSchema: caseIdSchema,
  outputSchema: caseIdSchema,
  execute: async ({ inputData, mastra, requestContext, tracingContext }) => {
    const { supportCase, turn, ownerId } = await getCaseOrThrow(
      inputData.caseId,
      inputData.turnId,
    );
    if (supportCase.triage?.intent !== "cancellation") return inputData;
    const subscription = supportCase.subscriptionLookup?.subscription;
    // Triage and the grounded writer decide whether this turn needs staff
    // review before any provider effect is considered.  Finalization repeats
    // this decision for its response, but it is too late to use it as the
    // first effect fence: a cancellation POST must never precede escalation.
    const escalationReason =
      triageEscalationReason(supportCase.triage) ??
      supportCase.draft?.escalationReason;
    if (
      escalationReason ||
      supportCase.draft?.requiresEscalation ||
      !subscription ||
      subscription.status !== "active" ||
      !explicitNoRefundCancellation(turn.message!.body) ||
      supportCase.draft?.recommendRefund
    ) {
      await caseStore.update(supportCase.id, {
        status: "escalated",
        escalationReason:
          escalationReason ??
          "Cancellation requires an explicit no-refund request for one active owned subscription.",
      });
      return inputData;
    }
    if (!mastra)
      throw new Error(
        "The resolve workflow must run through a registered Mastra instance.",
      );
    const binding = resolveConfiguredBinding(
      bindingsForPersistedCase(supportCase).transactions,
    );
    const raw = {
      caseId: supportCase.id,
      turnId: inputData.turnId,
      ownerId,
      binding,
      subscriptionId: subscription.subscriptionId,
      cancellationMode: "period_end" as const,
      sourceMessageId: turn.message!.id,
      sourceMessageHash: createHash("sha256")
        .update(turn.message!.body)
        .digest("hex"),
      idempotencyKey: `cancel:${supportCase.id}:${inputData.turnId}`,
    };
    const fingerprint = cancellationFingerprint(raw);
    const command = { ...raw, fingerprint };
    await caseStore.saveAction(
      supportCase.id,
      "subscription-cancellation-command",
      fingerprint,
      command,
    );
    await caseStore.bindTurnCommand(
      supportCase.id,
      inputData.turnId,
      fingerprint,
    );
    const tool = mastra.getTool("scheduleSubscriptionCancellationTool");
    if (!tool.execute)
      throw new Error("Registered cancellation tool has no execute function.");
    try {
      const effect = await withTrustedCancellationScope(
        {
          caseId: supportCase.id,
          turnId: inputData.turnId,
          commandFingerprint: fingerprint,
        },
        () =>
          tool.execute!(command, { mastra, requestContext, tracingContext }),
      );
      await caseStore.update(supportCase.id, {
        metadata: { ...supportCase.metadata, cancellationEffect: effect },
      });
    } catch (error) {
      await caseStore.saveAction(
        supportCase.id,
        "subscription-cancellation-failure",
        fingerprint,
        { message: String(error) },
      );
      await caseStore.update(supportCase.id, {
        status: "escalated",
        escalationReason:
          "Subscription cancellation requires additional review.",
      });
    }
    return inputData;
  },
});

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
  execute: async ({
    inputData,
    resumeData,
    suspend,
    mastra,
    requestContext,
    tracingContext,
  }) => {
    const { supportCase } = await getCaseOrThrow(
      inputData.caseId,
      inputData.turnId,
    );
    const bindings = bindingsForPersistedCase(supportCase);
    const draft = supportCase.draft;

    if (!draft?.recommendRefund) {
      return {
        caseId: supportCase.id,
        turnId: inputData.turnId,
        approved: false,
      };
    }

    // Do not create an executable native command for a recommendation which
    // local policy already requires a human escalation to handle.  The same
    // rule is repeated by LocalRuntime in its provider write transaction.
    if (
      draft.requiresEscalation ||
      (draft.refundAmount ?? 0) > STANDARD_REFUND_REVIEW_LIMIT
    ) {
      if (!draft.requiresEscalation)
        await caseStore.update(supportCase.id, {
          draft: {
            ...draft,
            requiresEscalation: true,
            escalationReason: `Refund amount ${draft.refundAmount} exceeds the ${STANDARD_REFUND_REVIEW_LIMIT} standard review limit and needs manual handling.`,
          },
        });
      return {
        caseId: supportCase.id,
        turnId: inputData.turnId,
        approved: false,
      };
    }

    if (!resumeData) {
      const recovered = await recoveredApprovalDecision(
        supportCase,
        inputData.turnId,
      );
      if (recovered) return recovered;
      const amount = draft.refundAmount ?? 0;
      const currency = draft.refundCurrency ?? "USD";
      const turnId = inputData.turnId;
      const command = {
        approvalCaseId: supportCase.id,
        orderId:
          supportCase.orderLookup?.order?.orderId ??
          supportCase.subscriptionLookup?.subscription?.refundOrderId ??
          "",
        amount,
        currency,
        reason: draft.refundReason ?? "Approved support refund",
        // A conversation may legitimately issue a later, distinct command.
        // The effect key is therefore stable for this immutable turn only.
        idempotencyKey: `${supportCase.id}:${turnId}`,
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
      // Tool.execute does not create a Mastra span when this trusted workflow
      // invokes a deterministic provider port directly.  Quote is a real
      // financial-provider boundary even though it has no effect, so include
      // it in the workflow's tenant/turn trace before native suspension.
      await traceOperationalPort({
        mastra,
        tracingContext,
        kind: "provider",
        operation: "transactions.quote_refund",
        run: () =>
          providerRegistry(binding)
            .transactions(binding)
            .quoteRefund(approvedCommand),
      });
      await persistentCaseStore.saveAction(
        supportCase.id,
        "refund-command",
        command.fingerprint,
        approvedCommand,
      );
      // Bind the exact evidence selected for this immutable command and turn.
      // Later case projections/drafts are mutable operational state and must
      // never decide whether a suspended approval may create an effect.
      await persistentCaseStore.saveAction(
        supportCase.id,
        "refund-policy-evidence",
        command.fingerprint,
        {
          turnId,
          binding: {
            tenantId: bindings.knowledge.tenantId,
            providerKind: bindings.knowledge.providerKind,
            providerAccountId: bindings.knowledge.providerAccountId,
          },
          citations: parsedDraftEvidence(supportCase, draft.citedSources),
        },
      );
      await persistentCaseStore.bindTurnCommand(
        supportCase.id,
        turnId,
        command.fingerprint,
      );
      if (!mastra)
        throw new Error(
          "Native refund approval requires the registered Mastra instance.",
        );
      const executionAgent = mastra.getAgent("refundExecutionAgent");
      // This is a real Agent lifecycle. requireApproval is set on issue_refund;
      // generate must therefore persist a native snapshot before the workflow
      // presents its one shared decision.
      const native = await executionAgent.generate(
        `Call issue_refund once with exactly this immutable command JSON: ${JSON.stringify(
          {
            caseId: supportCase.id,
            orderId: command.orderId,
            amount: command.amount,
            currency: command.currency,
            reason: command.reason,
            idempotencyKey: command.idempotencyKey,
            fingerprint: command.fingerprint,
          },
        )}`,
        { requestContext, tracingContext },
      );
      const suspended = native as {
        finishReason?: string;
        runId?: string;
        suspendPayload?: {
          toolCallId?: string;
          toolName?: string;
          args?: unknown;
        };
      };
      const expectedNativeArgs = {
        caseId: supportCase.id,
        orderId: command.orderId,
        amount: command.amount,
        currency: command.currency,
        reason: command.reason,
        idempotencyKey: command.idempotencyKey,
        fingerprint: command.fingerprint,
      };
      const nativeArgs = refundExecutionInputSchema.safeParse(
        suspended.suspendPayload?.args,
      );
      if (
        suspended.finishReason !== "suspended" ||
        !suspended.runId ||
        suspended.suspendPayload?.toolName !== "issue_refund" ||
        !suspended.suspendPayload.toolCallId ||
        !nativeArgs.success ||
        nativeArgs.data.caseId !== expectedNativeArgs.caseId ||
        nativeArgs.data.orderId !== expectedNativeArgs.orderId ||
        nativeArgs.data.amount !== expectedNativeArgs.amount ||
        nativeArgs.data.currency !== expectedNativeArgs.currency ||
        nativeArgs.data.reason !== expectedNativeArgs.reason ||
        nativeArgs.data.idempotencyKey !== expectedNativeArgs.idempotencyKey ||
        nativeArgs.data.fingerprint !== expectedNativeArgs.fingerprint
      )
        throw new Error(
          "Native refund agent did not suspend on the immutable tool call.",
        );
      await caseStore.update(supportCase.id, {
        status: "waiting_approval",
        metadata: {
          ...supportCase.metadata,
          refundCommand: command,
          nativeApproval: {
            runId: suspended.runId,
            toolCallId: suspended.suspendPayload.toolCallId,
            fingerprint: command.fingerprint,
            turnId,
          },
        },
      });
      return await suspend({
        caseId: supportCase.id,
        refundAmount: draft.refundAmount ?? 0,
        refundCurrency: draft.refundCurrency ?? "USD",
        refundReason: draft.refundReason ?? "",
        orderId:
          supportCase.orderLookup?.order?.orderId ??
          supportCase.subscriptionLookup?.subscription?.refundOrderId ??
          "",
        draftResponse: draft.draftResponse,
      });
    }

    if (!(supportCase.metadata as Record<string, unknown>).refundCommand)
      throw new Error("The persisted refund command is missing.");
    // HTTP records the authenticated decision atomically before it resumes the
    // workflow.  This step must only consume that record, never manufacture a
    // second decision from resume data (which is network-controlled input).
    const persisted = supportCase.approval;
    if (!persisted)
      throw new Error(
        "Legacy approval has no authenticated Phase 003 decision and cannot execute.",
      );
    if (
      persisted.approved !== resumeData.approved ||
      persisted.approverId !== resumeData.approverId
    )
      throw new Error(
        "The workflow resume does not match the durable approval decision.",
      );

    return {
      caseId: supportCase.id,
      turnId: inputData.turnId,
      approved: persisted.approved,
      approverId: persisted.approverId,
      note: persisted.note,
    };
  },
});

const resolveCaseStep = createStep({
  id: "resolve-case",
  description:
    "Finalizes a durably executed refund or marks the case resolved/escalated.",
  inputSchema: approvalOutputSchema,
  outputSchema: z.object({
    caseId: z.string(),
    turnId: z.string(),
    status: z.enum(["resolved", "escalated"]),
  }),
  execute: async ({ inputData, mastra }) => {
    const { supportCase } = await getCaseOrThrow(
      inputData.caseId,
      inputData.turnId,
    );
    const draft = supportCase.draft!;
    const triageReason = triageEscalationReason(supportCase.triage);
    let finalResponse =
      draft.requiresEscalation || triageReason
        ? safeEscalationResponse
        : renderGroundedSupportResponse(
            supportCase,
            draft.selectedPolicyExcerpts,
          );
    let status: "resolved" | "escalated" = draft.requiresEscalation
      ? "escalated"
      : "resolved";
    let escalationReason = triageReason ?? draft.escalationReason;
    if (triageReason) status = "escalated";
    const mustEscalate = Boolean(triageReason || draft.requiresEscalation);

    const cancellation = (supportCase.metadata as Record<string, unknown>)
      .cancellationEffect as
      { status?: string; cancelsAt?: string } | undefined;
    if (
      !mustEscalate &&
      supportCase.triage?.intent === "cancellation" &&
      cancellation?.status === "scheduled" &&
      cancellation.cancelsAt
    ) {
      status = "resolved";
      finalResponse = `Your subscription is scheduled to cancel at the end of the current billing period on ${cancellation.cancelsAt}.`;
    } else if (
      !mustEscalate &&
      supportCase.triage?.intent === "cancellation" &&
      !cancellation
    ) {
      status = "escalated";
      finalResponse = safeEscalationResponse;
      escalationReason ??=
        "Subscription cancellation was not durably scheduled.";
    }

    if (draft.recommendRefund && !mustEscalate) {
      if (!inputData.approved) {
        status = "escalated";
        escalationReason = `Refund declined by ${inputData.approverId ?? "reviewer"}${inputData.note ? `: ${inputData.note}` : "."}`;
        finalResponse = `Thanks for your patience - a specialist is going to take a closer look at your case and follow up shortly.`;
      } else {
        const orderId =
          supportCase.orderLookup?.order?.orderId ??
          supportCase.subscriptionLookup?.subscription?.refundOrderId;
        if (!orderId) {
          status = "escalated";
          escalationReason =
            "Refund was approved but no order id was on file - needs manual handling.";
        } else if ((draft.refundAmount ?? 0) > STANDARD_REFUND_REVIEW_LIMIT) {
          status = "escalated";
          escalationReason = `Refund amount ${draft.refundAmount} exceeds the ${STANDARD_REFUND_REVIEW_LIMIT} standard review limit and needs a senior approver.`;
        } else {
          if (!mastra)
            throw new Error(
              "The resolve workflow must run through a registered Mastra instance.",
            );
          // Phase 003 executes through the native Agent approval lifecycle.
          // The tool writes its durable result before this workflow resumes;
          // never call a requireApproval tool directly from a workflow step.
          const completed = await completedRefundResponse(
            supportCase,
            inputData.turnId,
          );
          if (completed) {
            status = "resolved";
            finalResponse = completed;
          } else if (supportCase.refundResult?.status === "failed") {
            status = "escalated";
            escalationReason =
              "Stripe reported that the approved refund failed and requires staff review.";
            finalResponse =
              "The refund requires additional review. A support specialist will follow up shortly.";
          } else
            throw new Error(
              "Native approval resumed without a matching durable refund effect; recovery must reconcile the immutable command.",
            );
        }
      }
    }

    // A financial terminalization may be committed by an authoritative Stripe
    // webhook between the approved tool receipt and this native continuation.
    // Both paths must use the immutable refund-command/turn identity, so the
    // transaction's INSERT OR IGNORE converges on one customer notification.
    const terminalOutboxKind =
      draft.recommendRefund && supportCase.refundResult?.status === "skipped"
        ? "refund-final"
        : "final";
    const message = {
      // Deterministic identities make an active-step replay converge on the
      // already finalized message/outbox pair.
      id: `msg_${supportCase.id}_${inputData.turnId}_final`,
      author: "agent" as const,
      authorName: "Support Agent",
      body: finalResponse,
      createdAt: new Date().toISOString(),
    };
    const supportBinding = resolveConfiguredBinding(
      bindingsForPersistedCase(supportCase).support,
    );
    const providerPlan = providerRegistry(supportBinding)
      .support(supportBinding)
      .planFinalizationOutbox?.({
        caseId: supportCase.id,
        turnId: inputData.turnId,
        status,
        subject: supportCase.subject,
        escalationReason,
      });
    await persistentCaseStore.finalizeCaseAndEnqueue({
      caseId: supportCase.id,
      turnId: inputData.turnId,
      status,
      finalResponse,
      escalationReason,
      message,
      outbox: {
        id: `outbox_${supportCase.id}_${inputData.turnId}_${terminalOutboxKind}`,
        caseId: supportCase.id,
        binding: supportBinding,
        body: finalResponse,
        status,
      },
      additionalOutbox: providerPlan?.map((operation) => ({
        id: `outbox_${supportCase.id}_${inputData.turnId}_${operation.suffix}`,
        caseId: supportCase.id,
        binding: supportBinding,
        body: operation.body,
        status: operation.status,
        operation: operation.operation,
      })),
    });
    await deliverOutbox(undefined, 10, caseStore, { mastra }).catch((error) =>
      mastra
        ?.getLogger()
        ?.warn("Local outbox delivery failed; recovery will retry it.", {
          error,
          caseId: supportCase.id,
        }),
    );

    return { caseId: supportCase.id, turnId: inputData.turnId, status };
  },
});

export const resolveSupportCaseWorkflow = createWorkflow({
  id: "resolve-support-case",
  description:
    "The core resolution pipeline: classify -> retrieve policy -> inspect order -> draft response -> human refund approval -> finalize an executed effect or escalate.",
  inputSchema: caseIdSchema,
  outputSchema: z.object({
    caseId: z.string(),
    turnId: z.string(),
    status: z.enum(["resolved", "escalated"]),
  }),
})
  .then(classifyStep)
  .then(retrievePolicyStep)
  .then(inspectOrderStep)
  .then(draftResponseStep)
  .then(scheduleCancellationStep)
  .then(requestApprovalStep)
  .then(resolveCaseStep)
  .commit();

export const REQUEST_APPROVAL_STEP_ID = requestApprovalStep.id;
