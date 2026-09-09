/**
 * Provider-neutral boundaries used by workflows and tools.  A case stores the
 * binding that selected each port, so a later configuration change cannot
 * redirect an already accepted event or financial effect.
 */
export interface ProviderBinding {
  tenantId: string;
  providerKind: "local" | "intercom" | "stripe";
  providerAccountId: string;
  externalConversationId: string;
}

/** A case persists each binding independently; local fixtures use the same
 * account by default, but that convenience never changes a saved case. */
export interface CaseProviderBindings {
  support: ProviderBinding;
  commerce: ProviderBinding;
  transactions: ProviderBinding;
  knowledge: ProviderBinding;
}

export interface Money {
  /** ISO 4217 code. Amounts are always integer minor units. */
  currency: string;
  minor: number;
}

export interface SupportChannelProvider {
  readonly kind: ProviderBinding["providerKind"];
  normalizeInbound(payload: unknown): Promise<{
    binding: ProviderBinding;
    externalId: string;
    source: "mock-email" | "chat" | "intercom-conversation";
    customer: { email: string; name?: string };
    subject: string;
    message: {
      id: string;
      author: "customer";
      authorName?: string;
      body: string;
      createdAt: string;
    };
    rawPayload: Record<string, unknown>;
  }>;
  deliver(
    binding: ProviderBinding,
    body: string,
    status: string,
    idempotencyKey?: string,
  ): Promise<DeliveryReceipt>;
  addInternalNote(
    binding: ProviderBinding,
    body: string,
    idempotencyKey: string,
  ): Promise<DeliveryReceipt>;
  updateStatus(
    binding: ProviderBinding,
    status: string,
    idempotencyKey: string,
  ): Promise<DeliveryReceipt>;
  /** Provider-owned follow-up operations for a terminal case. The workflow
   * persists this normalized plan atomically with its canonical reply. */
  planFinalizationOutbox?(input: {
    caseId: string;
    turnId: string;
    status: "resolved" | "escalated";
    subject: string;
    escalationReason?: string;
  }): Array<{
    suffix: "note" | "status" | "ticket";
    operation: "note" | "status" | "ticket";
    body: string;
    status: string;
  }>;
  /** Conversation remains canonical.  This is deliberately optional and is
   * called only by a configured structured-escalation intent. */
  convertToTicket?(
    binding: ProviderBinding,
    input: { title: string; description: string },
    idempotencyKey: string,
  ): Promise<DeliveryReceipt>;
}

export interface CommerceProvider {
  readonly kind: ProviderBinding["providerKind"];
  findOrder(
    binding: ProviderBinding,
    email: string,
    orderId?: string,
  ): Promise<CommerceOrder | undefined>;
  findSubscription(
    binding: ProviderBinding,
    email: string,
  ): Promise<CommerceSubscription | undefined>;
  refunds(binding: ProviderBinding, orderId: string): Promise<CommerceRefund[]>;
}

export interface TransactionalActionProvider {
  readonly kind: ProviderBinding["providerKind"];
  quoteRefund(command: RefundCommand): Promise<RefundQuote>;
  issueRefund(
    command: RefundCommand,
    authorization?: import("./native-execution").NativeRefundExecutionAuthorization,
  ): Promise<RefundEffect>;
  scheduleSubscriptionCancellation(
    command: SubscriptionCancellationCommand,
  ): Promise<SubscriptionCancellationEffect>;
  retrieveSubscriptionCancellation(
    command: SubscriptionCancellationCommand,
  ): Promise<SubscriptionCancellationEffect | undefined>;
}

export interface KnowledgeProvider {
  readonly kind: ProviderBinding["providerKind"];
  search(
    binding: ProviderBinding,
    query: string,
    topK: number,
  ): Promise<KnowledgeEvidence[]>;
  listChanged(
    binding: ProviderBinding,
    since?: string,
  ): Promise<KnowledgeDocumentRef[]>;
  fetchDocument(
    binding: ProviderBinding,
    source: string,
  ): Promise<KnowledgeEvidence | undefined>;
}

export interface CommerceOrder {
  orderId: string;
  customerEmail: string;
  product: string;
  amount: Money;
  status: "fulfilled" | "shipped" | "processing" | "cancelled" | "refunded";
  chargeCount: number;
  placedAt: string;
  /** Provider-owned references are retained for audit/reconciliation without
   * making Stripe concepts part of the workflow contract. */
  providerRefs?: ProviderRef[];
  providerStatus?: string;
}
export interface CommerceSubscription {
  subscriptionId: string;
  customerEmail: string;
  plan: string;
  amount: Money;
  status: "active" | "cancelled" | "past_due";
  renewsAt: string;
  /** A period-end cancellation is a schedule, not an immediate termination. */
  cancelAtPeriodEnd?: true;
  cancelsAt?: string;
  providerRefs?: ProviderRef[];
  providerStatus?: string;
}
export interface CommerceRefund {
  refundId: string;
  orderId: string;
  amount: Money;
  reason: string;
  issuedAt: string;
  providerStatus?: string;
}
export interface ProviderRef {
  provider: "stripe";
  type: string;
  id: string;
  apiVersion: string;
  livemode: false;
}
export interface RefundCommand {
  /** Case whose persisted local approval authorizes this immutable command. */
  approvalCaseId: string;
  binding: ProviderBinding;
  orderId: string;
  amount: Money;
  reason: string;
  idempotencyKey: string;
  fingerprint: string;
}
export interface RefundEffect {
  refundId: string;
  orderId: string;
  amount: Money;
  idempotencyKey: string;
  executedAt: string;
  replayed: boolean;
  /** A provider accepting a refund request is not proof of settlement. */
  status?: "pending" | "succeeded" | "failed" | "unknown";
  /** Provider state is retained separately from the conservative local state. */
  providerStatus?: string;
  providerRefs?: ProviderRef[];
}
export interface RefundQuote {
  approvedAmount: Money;
  remainingAmount: Money;
  commandFingerprint: string;
}
/** The only non-refund cancellation supported by Phase 006: a verified owner
 * explicitly asks to cancel at period end and explicitly declines a refund. */
export interface SubscriptionCancellationCommand {
  caseId: string;
  turnId: string;
  ownerId: string;
  binding: ProviderBinding;
  subscriptionId: string;
  cancellationMode: "period_end";
  sourceMessageId: string;
  sourceMessageHash: string;
  idempotencyKey: string;
  fingerprint: string;
}
export interface SubscriptionCancellationEffect {
  subscriptionId: string;
  cancelAtPeriodEnd: true;
  cancelsAt: string;
  idempotencyKey: string;
  replayed: boolean;
}
export interface DeliveryReceipt {
  receiptId: string;
  deliveredAt: string;
  /** Present only when the provider proved a message/part was created. */
  providerMessageId?: string;
}
export interface KnowledgeEvidence {
  title: string;
  text: string;
  source: string;
  score: number;
  version: string;
  /** Source-owned applicability boundary. It is never inferred at indexing. */
  effectiveAt?: string;
  /** Source-owned expiry boundary; absent means the source gave no expiry. */
  expiresAt?: string;
}
export interface KnowledgeDocumentRef {
  source: string;
  version: string;
  changedAt: string;
}

export interface ProviderRegistry {
  support(binding: ProviderBinding): SupportChannelProvider;
  commerce(binding: ProviderBinding): CommerceProvider;
  transactions(binding: ProviderBinding): TransactionalActionProvider;
  knowledge(binding: ProviderBinding): KnowledgeProvider;
}

export function sameBinding(
  left: ProviderBinding,
  right: ProviderBinding,
): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.providerKind === right.providerKind &&
    left.providerAccountId === right.providerAccountId &&
    left.externalConversationId === right.externalConversationId
  );
}

/**
 * Read the immutable, independently selected ports saved with a case.  The
 * one-binding shape is only a legacy read path; every new accepted case is
 * normalized to the four-binding shape before it is stored.
 */
export function bindingsForCase(case_: {
  externalId: string;
  metadata: Record<string, unknown>;
}): CaseProviderBindings {
  const saved = case_.metadata.providerBindings as
    CaseProviderBindings | undefined;
  if (saved?.support && saved.commerce && saved.transactions && saved.knowledge)
    return saved;
  const legacy = case_.metadata.providerBinding as ProviderBinding | undefined;
  const binding = legacy ?? {
    tenantId: "local-demo",
    providerKind: "local" as const,
    providerAccountId: "local-demo",
    externalConversationId: case_.externalId,
  };
  return {
    support: binding,
    commerce: binding,
    transactions: binding,
    knowledge: binding,
  };
}
