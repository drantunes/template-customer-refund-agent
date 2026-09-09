import type { Client } from "@libsql/client";
import type { LanguageModelV2 } from "@ai-sdk/provider";
import type { Mastra } from "@mastra/core/mastra";
import type { TracingContext } from "@mastra/core/observability";
import { createHash } from "node:crypto";
import {
  caseStore,
  isFinancialRetentionTombstone,
  type CaseStore,
} from "../lib/case-store";
import {
  renewDispatchLeaseWhileRunning,
  withDispatchLeaseScope,
  activeDispatchLeaseScope,
} from "../lib/dispatch-lease-scope";
import { activeTrustedCancellationScope } from "../providers/cancellation-execution";
import type { DispatchRecord } from "../lib/case-store";
import type { SupportCase } from "../domain/support-case";
import {
  legacyAmountToMoney,
  moneyToLegacyAmount,
  refundFingerprint,
  structurallyEqual,
} from "../lib/money";
import { exceedsStandardRefundReviewLimit } from "../domain/refund-review-limit";
import {
  initializeLocalFixtures,
  resetLocalFixtures,
  seedLocalFixtures,
} from "./local-fixtures";
import { requireLocalDatabaseUrl } from "../lib/database-url";
import type {
  CommerceOrder,
  CommerceProvider,
  CommerceRefund,
  CommerceSubscription,
  CaseProviderBindings,
  KnowledgeEvidence,
  KnowledgeProvider,
  ProviderBinding,
  ProviderRegistry,
  RefundCommand,
  RefundEffect,
  SubscriptionCancellationCommand,
  SubscriptionCancellationEffect,
  SupportChannelProvider,
  TransactionalActionProvider,
} from "../providers/contracts";
import { bindingsForCase } from "../providers/contracts";
import {
  hasNativeRefundExecutionAuthorization,
  resumeApprovedNativeTool,
  type NativeRefundExecutionAuthorization,
} from "../providers/native-execution";
import { activePrincipalHasRole, ownerIdForCustomer } from "../server/auth";
import { traceOperationalPort } from "../lib/operational-spans";
import { retryOrEscalateOperationalFailure } from "../lib/operational-alerts";
import { isRefundPolicyEvidenceError } from "../lib/refund-policy-evidence";
import { assertRefundPolicyEvidenceAtFirstEffect } from "../lib/refund-policy-evidence-persistence";
import { IntercomHttpError } from "../providers/intercom/client";
import {
  defaultLocalBinding,
  LocalSupportProvider,
} from "./local-support-provider";

export {
  defaultLocalBinding,
  LocalSupportProvider,
} from "./local-support-provider";

// Keep this runtime boundary independent of the workflow module: the workflow
// itself uses LocalRuntime through providers and importing it here would create
// an ESM initialization cycle. This is the registered workflow step id.
const REQUEST_APPROVAL_STEP_ID = "request-approval";
const LOCAL = "local" as const;
const text = (value: unknown) => String(value ?? "");

/** Compare the persisted authorization command structurally. JSON text is not
 * an authority format: equivalent objects may have a different key order. */
function matchesPersistedRefundCommand(
  value: unknown,
  command: RefundCommand,
): boolean {
  if (!value || typeof value !== "object") return false;
  const stored = value as Partial<RefundCommand>;
  const binding = stored.binding;
  return (
    stored.approvalCaseId === command.approvalCaseId &&
    stored.orderId === command.orderId &&
    stored.reason === command.reason &&
    stored.idempotencyKey === command.idempotencyKey &&
    stored.fingerprint === command.fingerprint &&
    stored.amount?.currency === command.amount.currency &&
    stored.amount?.minor === command.amount.minor &&
    binding?.tenantId === command.binding.tenantId &&
    binding?.providerKind === command.binding.providerKind &&
    binding?.providerAccountId === command.binding.providerAccountId &&
    binding?.externalConversationId === command.binding.externalConversationId
  );
}

export function bindingsForPersistedCase(case_: {
  externalId: string;
  metadata: Record<string, unknown>;
}): CaseProviderBindings {
  return bindingsForCase(case_);
}
export function bindingForCase(case_: {
  externalId: string;
  metadata: Record<string, unknown>;
}): ProviderBinding {
  return bindingsForPersistedCase(case_).support;
}

export class LocalRuntime
  implements
    ProviderRegistry,
    CommerceProvider,
    TransactionalActionProvider,
    KnowledgeProvider
{
  readonly kind = LOCAL;
  private readonly client: Client;
  private ready?: Promise<void>;
  private readonly seeded = new Map<string, Promise<void>>();
  private readonly fixtureQueues = new Map<string, Promise<void>>();
  constructor(
    client: Client = caseStore.getClientForTests(),
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.client = client;
  }
  private async ensured() {
    this.ready ??= this.init();
    await this.ready;
  }
  private async init() {
    await initializeLocalFixtures(this.client);
  }
  private assertLocalBinding(binding: ProviderBinding) {
    if (
      binding.providerKind !== LOCAL ||
      !binding.tenantId ||
      !binding.providerAccountId ||
      !binding.externalConversationId
    )
      throw new Error("Invalid local provider binding.");
  }
  support(binding: ProviderBinding): SupportChannelProvider {
    this.assertLocalBinding(binding);
    return new LocalSupportProvider(this.client, this.ensured());
  }
  commerce(binding: ProviderBinding): CommerceProvider {
    this.assertLocalBinding(binding);
    return this;
  }
  transactions(binding: ProviderBinding): TransactionalActionProvider {
    this.assertLocalBinding(binding);
    return this;
  }
  knowledge(binding: ProviderBinding): KnowledgeProvider {
    this.assertLocalBinding(binding);
    return this;
  }
  async seed(binding: ProviderBinding = defaultLocalBinding()) {
    this.assertLocalBinding(binding);
    const key = `${binding.tenantId}\u0000${binding.providerAccountId}`;
    await this.queueFixtureOperation(key, async () => {
      let seed = this.seeded.get(key);
      if (!seed) {
        seed = this.seedOnce(binding).catch((error) => {
          this.seeded.delete(key);
          throw error;
        });
        this.seeded.set(key, seed);
      }
      await seed;
    });
  }
  /** Seed/reset share an in-process binding queue.  This preserves the reset
   * transaction boundary and makes a seed queued after reset restore fixtures
   * instead of returning an obsolete successful memo. */
  private async queueFixtureOperation<T>(
    key: string,
    operation: () => Promise<T>,
  ) {
    const prior = this.fixtureQueues.get(key) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(operation);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.fixtureQueues.set(key, settled);
    try {
      return await next;
    } finally {
      if (this.fixtureQueues.get(key) === settled)
        this.fixtureQueues.delete(key);
    }
  }
  private async seedOnce(binding: ProviderBinding) {
    await this.ensured();
    await seedLocalFixtures(this.client, binding);
  }
  /** Deletes only this fixture binding, leaving other tenant/account data untouched. */
  async reset(binding: ProviderBinding = defaultLocalBinding()) {
    this.assertLocalBinding(binding);
    const key = `${binding.tenantId}\u0000${binding.providerAccountId}`;
    await this.queueFixtureOperation(key, async () => {
      await this.ensured();
      await resetLocalFixtures(this.client, binding);
      // Only invalidate after a committed reset. A refused reset preserves
      // both durable history and the existing fixture memo.
      this.seeded.delete(key);
    });
  }
  private order(row: Record<string, unknown>): CommerceOrder {
    return {
      orderId: text(row.order_id),
      customerEmail: text(row.customer_email),
      product: text(row.product),
      amount: { minor: Number(row.amount_minor), currency: text(row.currency) },
      status: text(row.status) as CommerceOrder["status"],
      chargeCount: Number(row.charge_count),
      placedAt: text(row.placed_at),
    };
  }
  async findOrder(binding: ProviderBinding, email: string, orderId?: string) {
    await this.ensured();
    const where = orderId
      ? email
        ? "order_id = ? AND lower(customer_email) = lower(?)"
        : "order_id = ?"
      : "lower(customer_email) = lower(?)";
    const args = orderId
      ? email
        ? [binding.tenantId, binding.providerAccountId, orderId, email]
        : [binding.tenantId, binding.providerAccountId, orderId]
      : [binding.tenantId, binding.providerAccountId, email];
    const result = await this.client.execute({
      sql: `SELECT * FROM local_orders WHERE tenant_id = ? AND provider_account_id = ? AND ${where} ORDER BY placed_at DESC`,
      args,
    });
    if (result.rows.length > 1 && !orderId)
      throw new Error(
        "Ambiguous order lookup; an explicit order id is required.",
      );
    return result.rows[0]
      ? this.order(result.rows[0] as Record<string, unknown>)
      : undefined;
  }
  async findSubscription(binding: ProviderBinding, email: string) {
    await this.ensured();
    await this.client.execute({
      sql: "UPDATE local_subscriptions SET status = 'cancelled' WHERE tenant_id = ? AND provider_account_id = ? AND status = 'active' AND cancel_at_period_end = 1 AND cancels_at IS NOT NULL AND cancels_at <= ?",
      args: [
        binding.tenantId,
        binding.providerAccountId,
        this.clock().toISOString(),
      ],
    });
    const result = await this.client.execute({
      sql: "SELECT * FROM local_subscriptions WHERE tenant_id = ? AND provider_account_id = ? AND lower(customer_email) = lower(?)",
      args: [binding.tenantId, binding.providerAccountId, email],
    });
    if (result.rows.length > 1)
      throw new Error("Ambiguous subscription lookup.");
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row
      ? {
          subscriptionId: text(row.subscription_id),
          customerEmail: text(row.customer_email),
          plan: text(row.plan),
          amount: {
            minor: Number(row.amount_minor),
            currency: text(row.currency),
          },
          status: text(row.status) as CommerceSubscription["status"],
          renewsAt: text(row.renews_at),
          ...(Number(row.cancel_at_period_end) === 1
            ? {
                cancelAtPeriodEnd: true as const,
                cancelsAt: text(row.cancels_at),
              }
            : {}),
        }
      : undefined;
  }
  async refunds(binding: ProviderBinding, orderId: string) {
    await this.ensured();
    const result = await this.client.execute({
      sql: "SELECT * FROM local_refunds WHERE tenant_id = ? AND provider_account_id = ? AND order_id = ? ORDER BY issued_at",
      args: [binding.tenantId, binding.providerAccountId, orderId],
    });
    return result.rows.map((row) => {
      const r = row as Record<string, unknown>;
      return {
        refundId: text(r.refund_id),
        orderId: text(r.order_id),
        amount: { minor: Number(r.amount_minor), currency: text(r.currency) },
        reason: text(r.reason),
        issuedAt: text(r.issued_at),
      } satisfies CommerceRefund;
    });
  }
  async issueRefund(
    command: RefundCommand,
    authorization?: NativeRefundExecutionAuthorization,
  ): Promise<RefundEffect> {
    await this.ensured();
    if (
      !Number.isSafeInteger(command.amount.minor) ||
      command.amount.minor <= 0
    )
      throw new Error(
        "Refund amount must be a positive safe integer minor-unit value.",
      );
    if (!/^[A-Z]{3}$/.test(command.amount.currency))
      throw new Error("Refund currency must be an ISO 4217 uppercase code.");
    if (!command.orderId || !command.idempotencyKey || !command.reason)
      throw new Error(
        "Refund command requires order, reason, and idempotency key.",
      );
    const fingerprint = refundFingerprint(command);
    if (fingerprint !== command.fingerprint)
      throw new Error("Refund command fingerprint was tampered with.");
    const tx = await this.client.transaction("write");
    try {
      const approval = await tx.execute({
        sql: "SELECT data FROM support_cases WHERE id = ?",
        args: [command.approvalCaseId],
      });
      const approvedCase = approval.rows[0]
        ? (JSON.parse(String(approval.rows[0].data)) as {
            approval?: { approved?: boolean };
            customer?: { email?: string };
            draft?: { requiresEscalation?: boolean };
            metadata?: {
              ownerId?: string;
              refundCommand?: { fingerprint?: string };
              nativeApproval?: {
                runId?: string;
                toolCallId?: string;
                fingerprint?: string;
                turnId?: string;
              };
            };
          })
        : undefined;
      const action = await tx.execute({
        sql: "SELECT data FROM support_actions WHERE case_id = ? AND kind = ? AND fingerprint = ?",
        args: [command.approvalCaseId, "refund-command", fingerprint],
      });
      const approvedAction = action.rows[0]
        ? JSON.parse(String(action.rows[0].data))
        : undefined;
      const native = approvedCase?.metadata?.nativeApproval;
      if (
        !native?.runId ||
        !native.toolCallId ||
        !hasNativeRefundExecutionAuthorization(authorization, {
          nativeRunId: native.runId,
          nativeToolCallId: native.toolCallId,
          commandFingerprint: command.fingerprint,
          caseId: command.approvalCaseId,
        })
      )
        throw new Error(
          "Refund execution requires the approved native refund tool context.",
        );
      const decision = native?.turnId
        ? await tx.execute({
            sql: "SELECT command_fingerprint, native_run_id, native_tool_call_id, principal_id, approved FROM support_decisions WHERE case_id = ? AND turn_id = ? AND command_fingerprint = ?",
            args: [command.approvalCaseId, native.turnId, command.fingerprint],
          })
        : undefined;
      const decisionRow = decision?.rows[0] as
        Record<string, unknown> | undefined;
      if (
        !approvedCase?.approval?.approved ||
        !matchesPersistedRefundCommand(approvedAction, command) ||
        !native?.runId ||
        !native.toolCallId ||
        native.fingerprint !== command.fingerprint ||
        !decisionRow ||
        Number(decisionRow.approved) !== 1 ||
        String(decisionRow.command_fingerprint) !== command.fingerprint ||
        String(decisionRow.native_run_id) !== native.runId ||
        String(decisionRow.native_tool_call_id) !== native.toolCallId ||
        !activePrincipalHasRole(
          String(decisionRow.principal_id),
          command.binding.tenantId,
          "approver",
        )
      )
        throw new Error(
          "Refund execution requires a current authorized native decision bound to the immutable command.",
        );
      if (
        authorization!.turnId !== native.turnId ||
        authorization!.caseId !== command.approvalCaseId ||
        approvedCase?.draft?.requiresEscalation ||
        exceedsStandardRefundReviewLimit(command.amount)
      )
        throw new Error(
          "Refund execution is not permitted by the current deterministic policy.",
        );
      const durableLease = await tx.execute({
        sql: "SELECT id FROM support_dispatch WHERE id = ? AND case_id = ? AND turn_id = ? AND lease_token = ? AND state IN ('claimed', 'started') AND lease_until > ?",
        args: [
          authorization!.dispatchId,
          command.approvalCaseId,
          authorization!.turnId,
          authorization!.leaseToken,
          new Date().toISOString(),
        ],
      });
      if (!durableLease.rows[0])
        throw new Error(
          "Refund execution requires the current durable workflow dispatch lease.",
        );
      const replay = await tx.execute({
        sql: "SELECT fingerprint, effect FROM support_idempotency WHERE idempotency_key = ?",
        args: [command.idempotencyKey],
      });
      if (replay.rows[0]) {
        if (text(replay.rows[0].fingerprint) !== fingerprint)
          throw new Error(
            "Idempotency key was reused with a conflicting refund command.",
          );
        const effect = JSON.parse(text(replay.rows[0].effect)) as RefundEffect;
        if (isFinancialRetentionTombstone(effect))
          throw new Error(
            "A retained terminal financial tombstone blocks replay or a new provider effect.",
          );
        await tx.rollback();
        return { ...effect, replayed: true };
      }
      // This is deliberately below exact idempotency reconciliation and above
      // every provider-effect insert. A completed command can always be
      // projected once; a new effect cannot rely on evidence that expired or
      // was superseded while native approval was suspended.
      await assertRefundPolicyEvidenceAtFirstEffect(tx, command, native.turnId);
      const orderRows = await tx.execute({
        sql: "SELECT * FROM local_orders WHERE tenant_id = ? AND provider_account_id = ? AND order_id = ?",
        args: [
          command.binding.tenantId,
          command.binding.providerAccountId,
          command.orderId,
        ],
      });
      const order = orderRows.rows[0] as Record<string, unknown> | undefined;
      if (!order)
        throw new Error(
          `Cannot issue refund: order ${command.orderId} not found.`,
        );
      const email = approvedCase?.customer?.email;
      const verifiedOwner =
        typeof email === "string" && email.length > 0
          ? ownerIdForCustomer(command.binding.tenantId, email)
          : undefined;
      if (
        !verifiedOwner ||
        approvedCase?.metadata?.ownerId !== verifiedOwner ||
        text(order.customer_email).toLowerCase() !== email!.toLowerCase()
      )
        throw new Error(
          "Refund execution requires the current verified order owner.",
        );
      if (text(order.currency) !== command.amount.currency)
        throw new Error("Refund currency does not match the original charge.");
      const prior = await tx.execute({
        sql: "SELECT COALESCE(SUM(amount_minor), 0) AS total FROM local_refunds WHERE tenant_id = ? AND provider_account_id = ? AND order_id = ?",
        args: [
          command.binding.tenantId,
          command.binding.providerAccountId,
          command.orderId,
        ],
      });
      if (
        Number(prior.rows[0]?.total ?? 0) + command.amount.minor >
        Number(order.amount_minor)
      )
        throw new Error("Refund exceeds the remaining balance.");
      const executedAt = new Date().toISOString();
      const effect: RefundEffect = {
        refundId: `REF-${crypto.randomUUID()}`,
        orderId: command.orderId,
        amount: command.amount,
        idempotencyKey: command.idempotencyKey,
        executedAt,
        replayed: false,
      };
      await tx.execute({
        sql: "INSERT INTO local_refunds VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        args: [
          effect.refundId,
          command.binding.tenantId,
          command.binding.providerAccountId,
          command.orderId,
          command.amount.minor,
          command.amount.currency,
          command.reason,
          executedAt,
        ],
      });
      await tx.execute({
        sql: "INSERT INTO support_idempotency(idempotency_key, fingerprint, effect, created_at) VALUES (?, ?, ?, ?)",
        args: [
          command.idempotencyKey,
          fingerprint,
          JSON.stringify(effect),
          executedAt,
        ],
      });
      await tx.commit();
      return effect;
    } catch (error) {
      try {
        await tx.rollback();
      } catch {}
      throw error;
    }
  }
  async scheduleSubscriptionCancellation(
    command: SubscriptionCancellationCommand,
  ): Promise<SubscriptionCancellationEffect> {
    await this.ensured();
    const supportCase = await caseStore.get(command.caseId);
    const owner = supportCase
      ? ownerIdForCustomer(command.binding.tenantId, supportCase.customer.email)
      : undefined;
    if (
      !supportCase ||
      !owner ||
      supportCase.metadata.ownerId !== owner ||
      command.ownerId !== owner ||
      command.cancellationMode !== "period_end" ||
      !structurallyEqual(
        bindingsForCase(supportCase).transactions,
        command.binding,
      )
    )
      throw new Error("Cancellation requires the verified case owner.");
    const turn = await caseStore.turn(command.caseId, command.turnId);
    if (
      !turn?.message ||
      turn.message.id !== command.sourceMessageId ||
      createHash("sha256").update(turn.message.body).digest("hex") !==
        command.sourceMessageHash
    )
      throw new Error("Cancellation requires its immutable source message.");
    const trusted = activeTrustedCancellationScope();
    const lease = activeDispatchLeaseScope();
    const immutable = await caseStore.getAction(
      command.caseId,
      "subscription-cancellation-command",
      command.fingerprint,
    );
    if (
      !trusted ||
      !lease ||
      trusted.caseId !== command.caseId ||
      trusted.turnId !== command.turnId ||
      trusted.commandFingerprint !== command.fingerprint ||
      lease.caseId !== command.caseId ||
      lease.turnId !== trusted.turnId ||
      !(await caseStore.hasDispatchLease(lease)) ||
      !structurallyEqual(immutable, command)
    )
      throw new Error(
        "Cancellation requires the trusted current workflow command and lease.",
      );
    const existing = await caseStore.idempotency(command.idempotencyKey);
    if (existing) {
      if (existing.fingerprint !== command.fingerprint)
        throw new Error(
          "Idempotency key was reused with another cancellation.",
        );
      return {
        ...(existing.effect as SubscriptionCancellationEffect),
        replayed: true,
      };
    }
    const row = await this.client.execute({
      sql: "SELECT * FROM local_subscriptions WHERE tenant_id = ? AND provider_account_id = ? AND subscription_id = ? AND lower(customer_email) = lower(?) AND status = 'active' AND cancel_at_period_end = 0",
      args: [
        command.binding.tenantId,
        command.binding.providerAccountId,
        command.subscriptionId,
        supportCase.customer.email,
      ],
    });
    const subscription = row.rows[0] as Record<string, unknown> | undefined;
    if (!subscription)
      throw new Error("Cancellation requires one owned active subscription.");
    const effect: SubscriptionCancellationEffect = {
      subscriptionId: command.subscriptionId,
      cancelAtPeriodEnd: true,
      cancelsAt: text(subscription.renews_at),
      idempotencyKey: command.idempotencyKey,
      replayed: false,
    };
    await this.client.execute({
      sql: "UPDATE local_subscriptions SET cancel_at_period_end = 1, cancels_at = renews_at WHERE tenant_id = ? AND provider_account_id = ? AND subscription_id = ? AND status = 'active' AND cancel_at_period_end = 0",
      args: [
        command.binding.tenantId,
        command.binding.providerAccountId,
        command.subscriptionId,
      ],
    });
    return effect;
  }
  async retrieveSubscriptionCancellation(
    command: SubscriptionCancellationCommand,
  ) {
    await this.ensured();
    const supportCase = await caseStore.get(command.caseId);
    const owner = supportCase
      ? ownerIdForCustomer(command.binding.tenantId, supportCase.customer.email)
      : undefined;
    const turn = await caseStore.turn(command.caseId, command.turnId);
    const immutable = await caseStore.getAction(
      command.caseId,
      "subscription-cancellation-command",
      command.fingerprint,
    );
    if (
      !supportCase ||
      !owner ||
      owner !== command.ownerId ||
      supportCase.metadata.ownerId !== command.ownerId ||
      !turn?.message ||
      turn.message.id !== command.sourceMessageId ||
      createHash("sha256").update(turn.message.body).digest("hex") !==
        command.sourceMessageHash ||
      !structurallyEqual(
        bindingsForCase(supportCase).transactions,
        command.binding,
      ) ||
      !structurallyEqual(immutable, command)
    )
      throw new Error("Cancellation recovery command is no longer authorized.");
    await this.findSubscription(command.binding, supportCase.customer.email);
    const row = await this.client.execute({
      sql: "SELECT renews_at, status, cancel_at_period_end, cancels_at FROM local_subscriptions WHERE tenant_id = ? AND provider_account_id = ? AND subscription_id = ?",
      args: [
        command.binding.tenantId,
        command.binding.providerAccountId,
        command.subscriptionId,
      ],
    });
    const subscription = row.rows[0] as Record<string, unknown> | undefined;
    if (!subscription || Number(subscription.cancel_at_period_end) !== 1)
      return undefined;
    return {
      subscriptionId: command.subscriptionId,
      cancelAtPeriodEnd: true as const,
      cancelsAt: text(subscription.cancels_at ?? subscription.renews_at),
      idempotencyKey: command.idempotencyKey,
      replayed: true,
    };
  }
  async quoteRefund(command: RefundCommand) {
    await this.ensured();
    if (
      !Number.isSafeInteger(command.amount.minor) ||
      command.amount.minor <= 0
    )
      throw new Error(
        "Refund amount must be a positive safe integer minor-unit value.",
      );
    const order = await this.findOrder(command.binding, "", command.orderId);
    if (!order)
      throw new Error(
        `Cannot quote refund: order ${command.orderId} not found.`,
      );
    if (order.amount.currency !== command.amount.currency)
      throw new Error("Refund currency does not match the original charge.");
    const prior = await this.refunds(command.binding, command.orderId);
    const refunded = prior.reduce(
      (total, refund) => total + refund.amount.minor,
      0,
    );
    const remaining = order.amount.minor - refunded;
    if (command.amount.minor > remaining)
      throw new Error("Refund exceeds the remaining balance.");
    return {
      approvedAmount: command.amount,
      remainingAmount: { currency: order.amount.currency, minor: remaining },
      commandFingerprint: refundFingerprint(command),
    };
  }
  async search(
    binding: ProviderBinding,
    query: string,
    topK: number,
  ): Promise<KnowledgeEvidence[]> {
    await this.ensured();
    const terms = query.toLowerCase().split(/\W+/).filter(Boolean);
    const result = await this.client.execute({
      sql: "SELECT * FROM local_knowledge WHERE tenant_id = ? AND provider_account_id = ?",
      args: [binding.tenantId, binding.providerAccountId],
    });
    return result.rows
      .map((row) => {
        const value = row as Record<string, unknown>;
        const haystack =
          `${text(value.title)} ${text(value.text)}`.toLowerCase();
        return {
          title: text(value.title),
          text: text(value.text),
          source: text(value.source),
          version: text(value.version),
          effectiveAt: value.effective_at
            ? text(value.effective_at)
            : undefined,
          expiresAt: value.expires_at ? text(value.expires_at) : undefined,
          score:
            terms.filter((term) => haystack.includes(term)).length /
            Math.max(terms.length, 1),
        };
      })
      .filter((e) => e.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
  async listChanged(binding: ProviderBinding) {
    await this.ensured();
    const result = await this.client.execute({
      sql: "SELECT source, version, effective_at FROM local_knowledge WHERE tenant_id = ? AND provider_account_id = ?",
      args: [binding.tenantId, binding.providerAccountId],
    });
    return result.rows.map((row) => ({
      source: text(row.source),
      version: text(row.version),
      changedAt: text(row.effective_at),
    }));
  }
  async fetchDocument(binding: ProviderBinding, source: string) {
    await this.ensured();
    const result = await this.client.execute({
      sql: "SELECT * FROM local_knowledge WHERE tenant_id = ? AND provider_account_id = ? AND source = ?",
      args: [binding.tenantId, binding.providerAccountId, source],
    });
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row
      ? {
          title: text(row.title),
          text: text(row.text),
          source: text(row.source),
          version: text(row.version),
          effectiveAt: row.effective_at ? text(row.effective_at) : undefined,
          expiresAt: row.expires_at ? text(row.expires_at) : undefined,
          score: 1,
        }
      : undefined;
  }
}

export const localRuntime = new LocalRuntime();

/** Delivers accepted domain outcomes separately from workflow completion. */
export async function deliverOutbox(
  registry?: ProviderRegistry,
  limit = 10,
  store: CaseStore = caseStore,
  observability?: { mastra?: Mastra; tracingContext?: TracingContext },
) {
  const attempted = new Set<string>();
  let claimed = 0;
  while (claimed < limit) {
    // Claim only execution capacity. A retry becomes pending again, so omit
    // it from this bounded sweep rather than spending all attempts at once.
    const [item] = await store.claimOutbox(1, [...attempted]);
    if (!item) break;
    attempted.add(item.id);
    claimed += 1;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let lostOwnership = false;
    let intercomEffectMayHaveOccurred = false;
    const renew = async () => {
      try {
        if (!(await store.renewOutboxLease(item.id, item.leaseToken!)))
          lostOwnership = true;
      } catch {
        lostOwnership = true;
      }
    };
    try {
      // Outbox processing is global, but every attempt belongs to the durable
      // case that enqueued it. Never attach an arbitrary queue item to the
      // workflow that happened to trigger this sweep.
      const ownerCase = await store.get(item.caseId);
      const ownerBinding = ownerCase
        ? bindingsForPersistedCase(ownerCase).support
        : undefined;
      if (
        ownerBinding &&
        (ownerBinding.tenantId !== item.binding.tenantId ||
          ownerBinding.providerAccountId !== item.binding.providerAccountId)
      )
        throw new Error("Outbox item binding does not match its durable case.");
      const selected =
        registry ??
        (await import("../providers/registry")).providerRegistry(item.binding);
      // A claim only establishes a time-bounded reservation. Revalidate it
      // immediately before the provider effect; a lost renewal never starts
      // another delivery from this worker.
      await renew();
      if (lostOwnership) break;
      heartbeat = setInterval(() => void renew(), 10_000);
      heartbeat.unref();
      // Intercom has no documented idempotency key for these mutations. Record
      // intent-before-effect so a process loss can become durable uncertainty.
      if (item.binding.providerKind === "intercom") {
        if (!(await store.markOutboxStarted(item.id, item.leaseToken!))) {
          lostOwnership = true;
          break;
        }
      }
      const receipt = await traceOperationalPort({
        mastra: observability?.mastra,
        // Do not use the caller's context or the mutable case projection: a
        // later follow-up can replace both. The outbox owns its response turn.
        traceId:
          item.correlationState === "known"
            ? item.originatingTraceId
            : undefined,
        kind: "provider",
        operation: "support.deliver",
        run: () => {
          const support = selected.support(item.binding);
          // Once the POST boundary is entered, a caught local persistence or
          // adapter error cannot prove that Intercom did not apply it.
          const enterIntercomPostBoundary = () => {
            intercomEffectMayHaveOccurred =
              item.binding.providerKind === "intercom";
          };
          switch (item.operation ?? "reply") {
            case "note":
              enterIntercomPostBoundary();
              return support.addInternalNote(item.binding, item.body, item.id);
            case "status":
              enterIntercomPostBoundary();
              return support.updateStatus(item.binding, item.status, item.id);
            case "ticket":
              if (!support.convertToTicket)
                throw new Error(
                  "Permanent: configured support provider does not support ticket conversion.",
                );
              enterIntercomPostBoundary();
              return support.convertToTicket(
                item.binding,
                { title: item.status, description: item.body },
                item.id,
              );
            default:
              enterIntercomPostBoundary();
              return support.deliver(
                item.binding,
                item.body,
                item.status,
                item.id,
              );
          }
        },
      });
      if (lostOwnership) break;
      await store.completeOutbox(item.id, receipt, item.leaseToken);
    } catch (error) {
      if (lostOwnership) break;
      const safeIntercomNegativeResponse =
        error instanceof IntercomHttpError &&
        !error.ambiguous &&
        error.status >= 400 &&
        error.status < 500;
      // IntercomClient records the request method on its errors. A failed
      // Conversation GET has not entered a mutation boundary, even though the
      // durable intent marker was written before invoking the support adapter.
      const knownPreMutationIntercomReadFailure =
        error instanceof IntercomHttpError && error.requestMethod === "GET";
      if (
        item.binding.providerKind === "intercom" &&
        intercomEffectMayHaveOccurred &&
        !safeIntercomNegativeResponse &&
        !knownPreMutationIntercomReadFailure
      ) {
        // Includes receipt-persistence failures after a successful POST and
        // malformed/missing receipt correlation. If this durable quarantine
        // itself fails, let that failure propagate with the row still started;
        // it must never fall through to a pending replay.
        const quarantined = await store.markOutboxUncertain(
          item.id,
          error,
          item.leaseToken,
          "started",
        );
        if (!quarantined)
          throw new Error(
            "Unable to durably quarantine a possibly-applied Intercom effect.",
          );
        continue;
      }
      if (error instanceof IntercomHttpError && error.ambiguous) {
        await store.markOutboxUncertain(item.id, error, item.leaseToken);
        continue;
      }
      const message = String(error);
      const status = Number(message.match(/\b([1-5]\d\d)\b/)?.[1]);
      const terminal =
        /permanent/i.test(message) ||
        (status >= 400 && status < 500 && status !== 408 && status !== 429);
      await store.retryOutbox(
        item.id,
        error,
        terminal || item.attempts >= 3,
        item.leaseToken,
        error instanceof IntercomHttpError ? error.retryAfterMs : undefined,
        error instanceof IntercomHttpError && error.status === 429,
      );
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
    if (lostOwnership) break;
  }
  return claimed;
}

/** Restarts interrupted Mastra work; suspended approvals remain suspended. */
export async function recoverLocalWorkflows(
  mastra: {
    getWorkflow(id: string): any;
    /** Present on the registered runtime; optional for narrow recovery fakes. */
    observability?: Mastra["observability"];
  },
  limit = 10,
  store: CaseStore = caseStore,
) {
  const retryOperationalFailure = async (
    dispatch: DispatchRecord,
    error: unknown,
  ): Promise<"retried" | "escalate"> => {
    // This is the operational recovery path, not a dashboard-only
    // classification. Attempts are durably bounded by CaseStore at three.
    const result = await retryOrEscalateOperationalFailure({
      signal: {
        providerOrTool: "resolve-support-case",
        occurredAt: new Date(),
        durationMs: 0,
        failed: true,
      },
      retry: () =>
        store.retryDispatch(
          dispatch.id,
          dispatch.caseId,
          error,
          dispatch.leaseToken,
        ),
      // Recovery must defer its case projection until it knows the retry has
      // exhausted. The caller owns the fenced escalation transition.
      escalate: async () => false,
    });
    return result.disposition === "retry" ? "retried" : "escalate";
  };
  let claimed = 0;
  while (claimed < limit) {
    // Workflow restarts are sequential; claiming ahead would let a waiting
    // dispatch expire before its run can be started.
    const [dispatch] = await store.claimDispatch(1);
    if (!dispatch) break;
    claimed += 1;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let lostOwnership = false;
    const loseOwnership = () => {
      if (lostOwnership) return;
      lostOwnership = true;
    };
    const renew = async () => {
      try {
        if (
          !(await store.renewDispatchLease(dispatch.id, dispatch.leaseToken!))
        )
          loseOwnership();
      } catch {
        loseOwnership();
      }
    };
    try {
      const supportCase = await store.get(dispatch.caseId);
      if (!supportCase) {
        await store.completeDispatch(
          dispatch.id,
          "failed",
          "Case missing during recovery.",
          dispatch.leaseToken,
        );
        continue;
      }
      // Publication is a trusted worker responsibility, never a read-tool
      // side effect. This preserves the ordinary search capability as a pure
      // read while keeping the local quickstart operational after startup.
      const { publishKnowledge } = await import("../lib/publish-knowledge");
      await publishKnowledge(bindingsForPersistedCase(supportCase).knowledge, {
        onlyIfMissing: true,
        // The background worker is a real operational boundary. Its provider
        // reads need the registered observability instance just like a
        // foreground workflow, while lightweight recovery fakes remain pure.
        ...(mastra.observability ? { mastra: mastra as Mastra } : {}),
      });
      const workflow = mastra.getWorkflow("resolveSupportCaseWorkflow");
      const existing = await workflow.getWorkflowRunById?.(dispatch.runId);
      if (
        existing?.status === "suspended" ||
        existing?.status === "waiting" ||
        existing?.status === "paused"
      ) {
        await store.completeDispatch(
          dispatch.id,
          "suspended",
          undefined,
          dispatch.leaseToken,
        );
        continue;
      }
      // A persisted waiting_approval case only blocks recovery when the actual
      // Mastra snapshot is absent.  If a process died after resume accepted the
      // decision, its active snapshot is authoritative and must be resumed.
      if (supportCase.status === "waiting_approval" && !existing) {
        await store.completeDispatch(
          dispatch.id,
          "suspended",
          undefined,
          dispatch.leaseToken,
        );
        continue;
      }
      if (existing?.status === "success") {
        await store.completeDispatch(
          dispatch.id,
          "completed",
          undefined,
          dispatch.leaseToken,
        );
        continue;
      }
      if (
        existing?.status === "failed" ||
        existing?.status === "cancelled" ||
        existing?.status === "canceled"
      ) {
        await store.failDispatchAndCase(
          dispatch.id,
          dispatch.caseId,
          `Workflow recovery failed: ${existing.status}`,
          dispatch.leaseToken,
          "escalated",
        );
        continue;
      }
      const run = await workflow.createRun({ runId: dispatch.runId });
      // Do not write even the public run pointer after a slow lookup has
      // revealed that another worker owns this dispatch.
      await renew();
      if (lostOwnership) break;
      if (!(await store.activateDispatch(dispatch))) break;
      // `restart()` only resumes an installed active run.  A process can die
      // after acceptance but before first start, which has no run record yet.
      // Renew immediately before this external workflow effect instead of
      // relying on the claim made before the earlier storage lookups.
      await renew();
      if (lostOwnership) break;
      heartbeat = setInterval(() => void renew(), 10_000);
      heartbeat.unref();
      const result = await withDispatchLeaseScope<{ status: string }>(
        {
          dispatchId: dispatch.id,
          caseId: dispatch.caseId,
          turnId: dispatch.turnId,
          leaseToken: dispatch.leaseToken!,
        },
        () =>
          existing?.status === "running" || existing?.status === "pending"
            ? run.restart()
            : run.start({
                inputData: {
                  caseId: dispatch.caseId,
                  turnId: dispatch.turnId,
                },
              }),
      );
      if (lostOwnership) break;
      if (result.status === "failed") {
        const recovery = await retryOperationalFailure(
          dispatch,
          "Workflow restart failed.",
        ).catch(() => "escalate" as const);
        if (recovery === "retried") continue;
        await store.failDispatchAndCase(
          dispatch.id,
          dispatch.caseId,
          "Workflow restart failed.",
          dispatch.leaseToken,
          "escalated",
        );
      } else
        await store.completeDispatch(
          dispatch.id,
          result.status === "suspended" ? "suspended" : "completed",
          undefined,
          dispatch.leaseToken,
        );
    } catch (error) {
      if (!lostOwnership) {
        const recovery = await retryOperationalFailure(dispatch, error).catch(
          () => "escalate" as const,
        );
        if (recovery !== "retried")
          await store
            .failDispatchAndCase(
              dispatch.id,
              dispatch.caseId,
              error,
              dispatch.leaseToken,
              "escalated",
            )
            .catch(() => undefined);
      }
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
    if (lostOwnership) break;
  }
  return claimed;
}

/** Recover the crash window after the durable decision commit but before the
 * HTTP process resumed Mastra. A missing native snapshot is never authority;
 * it is tolerated only when the same immutable provider effect already exists. */
type NativeRecoveryMastra = Mastra;

type WorkflowRetentionStorage = NonNullable<
  ReturnType<NonNullable<NativeRecoveryMastra["getStorage"]>>
>;

/** Delete only snapshots whose app-owned copies have already expired. This
 * enumerates Mastra's supported workflow store so native suspension names are
 * not guessed from a resolution run id or deleted through direct SQL. */
export async function purgeExpiredWorkflowSnapshots(
  storage: WorkflowRetentionStorage | undefined,
  retention: {
    rawWorkflowSnapshotBefore: string;
    expiredCaseIds: readonly string[];
    expiredWorkflowRunIds: readonly string[];
  },
) {
  const workflows = await storage?.getStore?.("workflows");
  const expiredRunIds = new Set(retention.expiredWorkflowRunIds);
  const expiredCaseIds = new Set(retention.expiredCaseIds);
  const inboundWorkflowNames = new Set([
    "ingest-support-case",
    "ingestSupportCaseWorkflow",
  ]);
  const recoverableWorkflowNames = new Set([
    "resolve-support-case",
    "resolveSupportCaseWorkflow",
    "agentic-loop",
    "durable-agentic-loop",
    // Installed registered refundExecutionAgent currently persists its native
    // suspension under this storage workflow name.
    "executionWorkflow",
  ]);
  const runs = await workflows?.listWorkflowRuns({ perPage: false });
  const deleted: string[] = [];
  const snapshotContainsExpiredCase = (snapshot: unknown) => {
    const visit = (value: unknown): boolean => {
      if (!value || typeof value !== "object") return false;
      if (Array.isArray(value)) return value.some(visit);
      for (const [key, nested] of Object.entries(value)) {
        if (key === "caseId" && expiredCaseIds.has(String(nested))) return true;
        if (visit(nested)) return true;
      }
      return false;
    };
    try {
      return visit(
        typeof snapshot === "string" ? JSON.parse(snapshot) : snapshot,
      );
    } catch {
      return false;
    }
  };
  for (const run of runs?.runs ?? []) {
    const isExpiredInbound =
      inboundWorkflowNames.has(run.workflowName) &&
      run.createdAt.toISOString() < retention.rawWorkflowSnapshotBefore;
    const isExpiredAuthority =
      recoverableWorkflowNames.has(run.workflowName) &&
      (expiredRunIds.has(run.runId) ||
        snapshotContainsExpiredCase(run.snapshot));
    if (!isExpiredInbound && !isExpiredAuthority) continue;
    await workflows?.deleteWorkflowRunById({
      workflowName: run.workflowName,
      runId: run.runId,
    });
    deleted.push(`${run.workflowName}:${run.runId}`);
  }
  return deleted;
}

type PersistedRefundCommand = {
  orderId?: string;
  idempotencyKey?: string;
  fingerprint?: string;
  amount?: number;
  currency?: string;
};

/** Projects only an exact durable provider effect. A normal native-resume
 * return does not prove that its tool completed, so callers use this before
 * resuming the enclosing workflow. */
export async function reconcileApprovedRefundEffect(input: {
  store: CaseStore;
  supportCase: SupportCase;
  dispatch: DispatchRecord;
  fingerprint: string;
  command: PersistedRefundCommand | undefined;
}) {
  const { store, supportCase, dispatch, fingerprint, command } = input;
  if (!command?.idempotencyKey) return false;
  if (command.fingerprint !== fingerprint)
    throw new Error(
      "The persisted refund command does not match the approved fingerprint.",
    );
  const existing = await store.idempotency(command.idempotencyKey);
  if (!existing) return false;
  if (existing.fingerprint !== fingerprint)
    throw new Error(
      "A durable refund effect does not match the immutable approved command.",
    );
  const effect = existing.effect as RefundEffect;
  const expectedAmount =
    typeof command.amount === "number" && typeof command.currency === "string"
      ? legacyAmountToMoney(command.amount, command.currency)
      : undefined;
  if (
    effect.idempotencyKey !== command.idempotencyKey ||
    effect.orderId !== command.orderId ||
    !effect.amount ||
    !effect.refundId ||
    !expectedAmount ||
    effect.amount.currency !== expectedAmount.currency ||
    effect.amount.minor !== expectedAmount.minor ||
    !Number.isFinite(Date.parse(effect.executedAt))
  )
    throw new Error(
      "A durable refund effect does not exactly match the approved command.",
    );
  const reconciled = {
    refundId: effect.refundId,
    orderId: effect.orderId,
    amount: moneyToLegacyAmount(effect.amount),
    currency: effect.amount.currency,
    status: effect.replayed ? ("skipped" as const) : ("executed" as const),
    idempotencyKey: effect.idempotencyKey,
    executedAt: effect.executedAt,
  };
  await withDispatchLeaseScope(
    {
      dispatchId: dispatch.id,
      caseId: dispatch.caseId,
      turnId: dispatch.turnId,
      leaseToken: dispatch.leaseToken!,
    },
    () =>
      store.update(dispatch.caseId, {
        refundResult: reconciled,
        metadata: {
          ...supportCase.metadata,
          refundEffects: {
            ...((supportCase.metadata as Record<string, unknown>)
              .refundEffects as Record<string, unknown> | undefined),
            [fingerprint]: reconciled,
          },
        },
      }),
  );
  return true;
}

/** A native tool can legitimately finish with a Stripe refund in `pending`.
 * The approval snapshot has then been consumed, but settlement is still owned
 * by the durable attempt/reconciliation worker. Treat it as a valid native
 * outcome without projecting success or finalizing the customer response. */
async function hasPendingStripeRefundAttempt(
  store: CaseStore,
  caseId: string,
  fingerprint: string,
  command: PersistedRefundCommand | undefined,
) {
  if (!command?.idempotencyKey) return false;
  const attempt = await store.stripeRefundAttempt(command.idempotencyKey);
  return Boolean(
    attempt &&
    attempt.caseId === caseId &&
    attempt.fingerprint === fingerprint &&
    attempt.refundId &&
    attempt.status === "pending",
  );
}

/** A confirmed terminal provider rejection is a real native outcome too. It
 * has no successful idempotency effect by design, but the enclosing workflow
 * must consume it once and produce its staff-review response. */
async function hasFailedStripeRefundAttempt(
  store: CaseStore,
  caseId: string,
  fingerprint: string,
  command: PersistedRefundCommand | undefined,
) {
  if (!command?.idempotencyKey) return false;
  const attempt = await store.stripeRefundAttempt(command.idempotencyKey);
  return Boolean(
    attempt &&
    attempt.caseId === caseId &&
    attempt.fingerprint === fingerprint &&
    attempt.refundId &&
    attempt.status === "failed",
  );
}

export async function recoverApprovedNativeDecisions(
  mastra: NativeRecoveryMastra,
  store: CaseStore = caseStore,
  options: { model?: LanguageModelV2; disableScorers?: boolean } = {},
) {
  let recovered = 0;
  for (const item of await store.nativeDecisionsNeedingRecovery()) {
    // Claim before touching the native run.  The durable dispatch lease fences
    // HTTP and recovery workers from approving/declining the same snapshot.
    const dispatch = await store.claimDispatchForResume(
      item.caseId,
      item.workflowRunId,
      item.turnId,
    );
    if (!dispatch || !item.workflowRunId) continue;
    const command = (item.supportCase.metadata as Record<string, unknown>)
      .refundCommand as PersistedRefundCommand | undefined;
    const lease = renewDispatchLeaseWhileRunning(store, dispatch);
    try {
      await lease.renew();
      if (lease.lostOwnership) continue;
      lease.start();
      const reconciledBefore = item.approved
        ? await reconcileApprovedRefundEffect({
            store,
            supportCase: item.supportCase,
            dispatch,
            fingerprint: item.fingerprint,
            command,
          })
        : false;
      await withDispatchLeaseScope(
        {
          dispatchId: dispatch.id,
          caseId: dispatch.caseId,
          turnId: dispatch.turnId,
          leaseToken: dispatch.leaseToken!,
        },
        () =>
          reconciledBefore
            ? Promise.resolve(undefined)
            : resumeApprovedNativeTool({
                mastra,
                approved: item.approved,
                scope: {
                  caseId: dispatch.caseId,
                  turnId: dispatch.turnId,
                  nativeRunId: item.nativeRunId,
                  nativeToolCallId: item.nativeToolCallId,
                  commandFingerprint: item.fingerprint,
                  dispatchId: dispatch.id,
                  leaseToken: dispatch.leaseToken!,
                },
                ...(options.model ? { model: options.model } : {}),
              }),
      );
      if (lease.lostOwnership) continue;
      // A normal native transition can contain a caught tool failure.  Do not
      // resume and terminalize the enclosing workflow until its exact effect
      // is durable and projected. A missing effect after that normal return
      // is an explicit failed tool result; thrown native/snapshot errors use
      // the recoverable catch path below.
      // Stripe's failed terminalizer has already atomically closed the case,
      // immutable originating turn, and one staff-review outbox item. Resuming
      // the enclosing native workflow would create a second correction and
      // can never legitimately emit an issued reply.
      if (
        item.approved &&
        (await hasFailedStripeRefundAttempt(
          store,
          item.caseId,
          item.fingerprint,
          command,
        ))
      ) {
        await store.completeDispatch(
          dispatch.id,
          "completed",
          undefined,
          dispatch.leaseToken,
        );
        recovered += 1;
        continue;
      }
      const finalized = item.approved
        ? await reconcileApprovedRefundEffect({
            store,
            supportCase: (await store.get(item.caseId)) ?? item.supportCase,
            dispatch,
            fingerprint: item.fingerprint,
            command,
          })
        : false;
      if (
        item.approved &&
        !finalized &&
        !(await hasPendingStripeRefundAttempt(
          store,
          item.caseId,
          item.fingerprint,
          command,
        )) &&
        !(await hasFailedStripeRefundAttempt(
          store,
          item.caseId,
          item.fingerprint,
          command,
        ))
      ) {
        // The official native transition returned normally and the exact
        // durable effect is still absent. This is a completed tool failure,
        // not an uncertain provider response: leave a visible terminal case
        // instead of repeatedly resuming an already-consumed native snapshot.
        await store.failDispatchAndCase(
          dispatch.id,
          item.caseId,
          "Native approval completed without a durable refund effect.",
          dispatch.leaseToken,
          "escalated",
        );
        continue;
      }
      const run = await mastra
        .getWorkflow("resolveSupportCaseWorkflow")
        .createRun({
          runId: item.workflowRunId,
          ...(options.disableScorers ? { disableScorers: true } : {}),
        });
      const result = await withDispatchLeaseScope<{ status: string }>(
        {
          dispatchId: dispatch.id,
          caseId: dispatch.caseId,
          turnId: dispatch.turnId,
          leaseToken: dispatch.leaseToken!,
        },
        () =>
          run.resume({
            step: REQUEST_APPROVAL_STEP_ID,
            resumeData: {
              approved: item.approved,
              approverId: item.principalId,
              note: item.note,
            },
          }),
      );
      if (lease.lostOwnership) continue;
      if (result.status === "failed")
        await store.failDispatchAndCase(
          dispatch.id,
          item.caseId,
          "Workflow recovery failed after the native decision.",
          dispatch.leaseToken,
          "escalated",
        );
      else if (result.status === "success")
        await store.completeDispatch(
          dispatch.id,
          "completed",
          undefined,
          dispatch.leaseToken,
        );
      else
        await store.completeDispatch(
          dispatch.id,
          "suspended",
          `Workflow recovery returned ${result.status}.`,
          dispatch.leaseToken,
        );
      recovered += 1;
    } catch (error) {
      // The native snapshot may be temporarily unavailable after a process
      // crash. Return its lease to the suspended queue so a later bounded
      // sweep can reconcile it; never invent an approval or effect.
      if (
        /does not match the immutable approved command/.test(String(error)) ||
        isRefundPolicyEvidenceError(error)
      )
        await store
          .failDispatchAndCase(
            dispatch.id,
            item.caseId,
            error,
            dispatch.leaseToken,
            "escalated",
          )
          .catch(() => undefined);
      else
        await store
          .completeDispatch(
            dispatch.id,
            "suspended",
            error,
            dispatch.leaseToken,
          )
          .catch(() => undefined);
      continue;
    } finally {
      lease.stop();
    }
  }
  return recovered;
}

/**
 * Studio/start lifecycle hook. It seeds only the configured local fixture and
 * runs one bounded recovery sweep immediately, then keeps a non-blocking
 * worker alive for interrupted dispatch and delivery work.
 */
export function startLocalRuntimeWorkers(
  mastra: NativeRecoveryMastra,
  logger?: {
    warn(message: string, meta?: Record<string, unknown>): void;
    info?(message: string, meta?: Record<string, unknown>): void;
  },
  options?: {
    initialDelayMs?: number;
    intervalMs?: number;
    runSweep?: () => Promise<void>;
  },
) {
  let stopped = false;
  let running = false;
  let lastRetentionSweep = 0;
  const retentionInterval = Number(
    process.env.SUPPORT_RETENTION_SWEEP_MS ?? 86_400_000,
  );
  if (
    !Number.isInteger(retentionInterval) ||
    retentionInterval < 60_000 ||
    retentionInterval > 604_800_000
  )
    throw new Error(
      "SUPPORT_RETENTION_SWEEP_MS must be an integer from 60000 through 604800000.",
    );
  const sweep = async () => {
    if (running) return;
    running = true;
    try {
      requireLocalDatabaseUrl();
      await localRuntime.seed(defaultLocalBinding());
      await import("./studio-seed").then(({ ensureStudioSupervisorDemoCase }) =>
        ensureStudioSupervisorDemoCase(),
      );
      await recoverApprovedNativeDecisions(mastra).catch((error) =>
        logger?.warn("Native approval recovery failed.", { error }),
      );
      await recoverLocalWorkflows(mastra);
      await import("../providers/stripe/reconciliation")
        .then(({ reconcileStripeRefundAttempts }) =>
          reconcileStripeRefundAttempts(caseStore),
        )
        .catch((error) =>
          logger?.warn("Stripe refund reconciliation failed.", { error }),
        );
      await import("../providers/stripe/cancellation-reconciliation")
        .then(({ reconcileUnknownSubscriptionCancellations }) =>
          reconcileUnknownSubscriptionCancellations(caseStore),
        )
        .catch((error) =>
          logger?.warn("Stripe cancellation reconciliation failed.", { error }),
        );
      await deliverOutbox(undefined, 10, caseStore, { mastra });
      if (Date.now() - lastRetentionSweep >= retentionInterval) {
        const caseRetention = await caseStore.enforceRetention();
        const storage = mastra.getStorage?.();
        await purgeExpiredWorkflowSnapshots(storage, caseRetention);
        const mastraRetention = await storage?.prune({
          maxBatches: 10,
          maxRows: 5_000,
        });
        logger?.info?.("Completed bounded DEC-015 retention sweep.", {
          caseRetention,
          mastraRetention,
        });
        lastRetentionSweep = Date.now();
      }
    } catch (error) {
      logger?.warn("Local runtime recovery sweep failed.", { error });
    } finally {
      running = false;
    }
  };
  // Let Mastra finish initializing its own LibSQL tables before this app-owned
  // client touches the same file. Starting both schema writers concurrently
  // produces SQLITE_BUSY on a pristine local database.
  let activeSweep = Promise.resolve();
  const runSweep = options?.runSweep ?? sweep;
  const queueSweep = () => {
    if (stopped) return activeSweep;
    activeSweep = activeSweep.then(runSweep, runSweep);
    return activeSweep;
  };
  const initial = setTimeout(
    () => void queueSweep(),
    options?.initialDelayMs ?? 1_000,
  );
  const timer = setInterval(
    () => void queueSweep(),
    options?.intervalMs ?? 5_000,
  );
  timer.unref();
  return async () => {
    stopped = true;
    clearTimeout(initial);
    clearInterval(timer);
    await activeSweep;
  };
}
