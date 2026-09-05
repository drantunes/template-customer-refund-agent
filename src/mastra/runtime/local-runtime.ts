import type { Client } from "@libsql/client";
import { createHash } from "node:crypto";
import { caseStore, type CaseStore } from "../lib/case-store";
import { refundFingerprint } from "../lib/money";
import { POLICY_DOCUMENTS } from "../knowledge/policy-docs";
import type {
  CommerceOrder,
  CommerceProvider,
  CommerceRefund,
  CommerceSubscription,
  CaseProviderBindings,
  DeliveryReceipt,
  KnowledgeEvidence,
  KnowledgeProvider,
  ProviderBinding,
  ProviderRegistry,
  RefundCommand,
  RefundEffect,
  SupportChannelProvider,
  TransactionalActionProvider,
} from "../providers/contracts";
import { bindingsForCase } from "../providers/contracts";

const LOCAL = "local" as const;
export const defaultLocalBinding = (
  externalConversationId = "local",
): ProviderBinding => ({
  tenantId: "local-demo",
  providerKind: LOCAL,
  providerAccountId: "local-demo",
  externalConversationId,
});
const text = (value: unknown) => String(value ?? "");

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
  constructor(client: Client = caseStore.getClientForTests()) {
    this.client = client;
  }
  private async ensured() {
    this.ready ??= this.init();
    await this.ready;
  }
  private async init() {
    await this.client.executeMultiple(`
      CREATE TABLE IF NOT EXISTS local_orders (tenant_id TEXT NOT NULL, provider_account_id TEXT NOT NULL, order_id TEXT NOT NULL, customer_email TEXT NOT NULL, product TEXT NOT NULL, amount_minor INTEGER NOT NULL, currency TEXT NOT NULL, status TEXT NOT NULL, charge_count INTEGER NOT NULL, placed_at TEXT NOT NULL, PRIMARY KEY(tenant_id, provider_account_id, order_id));
      CREATE TABLE IF NOT EXISTS local_subscriptions (tenant_id TEXT NOT NULL, provider_account_id TEXT NOT NULL, subscription_id TEXT NOT NULL, customer_email TEXT NOT NULL, plan TEXT NOT NULL, amount_minor INTEGER NOT NULL, currency TEXT NOT NULL, status TEXT NOT NULL, renews_at TEXT NOT NULL, PRIMARY KEY(tenant_id, provider_account_id, subscription_id));
      CREATE TABLE IF NOT EXISTS local_refunds (refund_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, provider_account_id TEXT NOT NULL, order_id TEXT NOT NULL, amount_minor INTEGER NOT NULL, currency TEXT NOT NULL, reason TEXT NOT NULL, issued_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS local_knowledge (tenant_id TEXT NOT NULL, provider_account_id TEXT NOT NULL, source TEXT NOT NULL, title TEXT NOT NULL, text TEXT NOT NULL, version TEXT NOT NULL, PRIMARY KEY(tenant_id, provider_account_id, source));
      CREATE TABLE IF NOT EXISTS local_deliveries (tenant_id TEXT NOT NULL, provider_account_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, payload_fingerprint TEXT NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY(tenant_id, provider_account_id, idempotency_key));
    `);
    try {
      await this.client.execute(
        "ALTER TABLE local_deliveries ADD COLUMN payload_fingerprint TEXT NOT NULL DEFAULT ''",
      );
    } catch (error) {
      if (!String(error).includes("duplicate column")) throw error;
    }
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
    const url = process.env.TURSO_DATABASE_URL || "file:./mastra.db";
    if (!url.startsWith("file:"))
      throw new Error(
        "Refusing local fixture seed: TURSO_DATABASE_URL must use a file: URL.",
      );
    await this.ensured();
    const args = [binding.tenantId, binding.providerAccountId];
    await this.client.batch(
      [
        {
          sql: "INSERT OR IGNORE INTO local_orders VALUES (?, ?, 'ORD-1001', 'alex@example.com', 'Pro Plan - Monthly', 4900, 'USD', 'fulfilled', 2, '2026-08-01T14:00:00.000Z')",
          args,
        },
        {
          sql: "INSERT OR IGNORE INTO local_orders VALUES (?, ?, 'ORD-1002', 'jordan@example.com', 'Wireless Headphones', 12999, 'USD', 'shipped', 1, '2026-08-10T09:30:00.000Z')",
          args,
        },
        {
          sql: "INSERT OR IGNORE INTO local_orders VALUES (?, ?, 'ORD-1003', 'sam@example.com', 'Standing Desk', 34900, 'USD', 'fulfilled', 1, '2026-07-20T11:15:00.000Z')",
          args,
        },
        {
          sql: "INSERT OR IGNORE INTO local_orders VALUES (?, ?, 'ORD-1004', 'riley@example.com', 'Team Plan - Annual', 58800, 'USD', 'fulfilled', 1, '2026-05-02T08:00:00.000Z')",
          args,
        },
        {
          sql: "INSERT OR IGNORE INTO local_subscriptions VALUES (?, ?, 'SUB-1001', 'alex@example.com', 'Pro Plan - Monthly', 4900, 'USD', 'active', '2026-09-01T00:00:00.000Z')",
          args,
        },
        {
          sql: "INSERT OR IGNORE INTO local_subscriptions VALUES (?, ?, 'SUB-1004', 'riley@example.com', 'Team Plan - Annual', 58800, 'USD', 'active', '2027-05-02T00:00:00.000Z')",
          args,
        },
        ...POLICY_DOCUMENTS.map((document) => ({
          sql: "INSERT OR IGNORE INTO local_knowledge VALUES (?, ?, ?, ?, ?, 'local-v1')",
          args: [...args, document.source, document.title, document.text],
        })),
      ],
      "write",
    );
  }
  /** Deletes only this fixture binding, leaving other tenant/account data untouched. */
  async reset(binding: ProviderBinding = defaultLocalBinding()) {
    const url = process.env.TURSO_DATABASE_URL || "file:./mastra.db";
    if (!url.startsWith("file:"))
      throw new Error(
        "Refusing local fixture reset: TURSO_DATABASE_URL must use a file: URL.",
      );
    await this.ensured();
    const args = [binding.tenantId, binding.providerAccountId];
    const effects = await this.client.execute({
      sql: "SELECT COUNT(*) AS total FROM local_refunds WHERE tenant_id = ? AND provider_account_id = ?",
      args,
    });
    if (Number(effects.rows[0]?.total ?? 0) > 0)
      throw new Error(
        "Refusing fixture reset: durable refund/idempotency effects exist for this binding. Use a new local database rather than deleting financial history.",
      );
    await this.client.batch(
      [
        {
          sql: "DELETE FROM local_refunds WHERE tenant_id = ? AND provider_account_id = ?",
          args,
        },
        {
          sql: "DELETE FROM local_orders WHERE tenant_id = ? AND provider_account_id = ?",
          args,
        },
        {
          sql: "DELETE FROM local_subscriptions WHERE tenant_id = ? AND provider_account_id = ?",
          args,
        },
        {
          sql: "DELETE FROM local_knowledge WHERE tenant_id = ? AND provider_account_id = ?",
          args,
        },
        {
          sql: "DELETE FROM local_deliveries WHERE tenant_id = ? AND provider_account_id = ?",
          args,
        },
      ],
      "write",
    );
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
    const where = orderId ? "order_id = ?" : "lower(customer_email) = lower(?)";
    const value = orderId ?? email;
    const result = await this.client.execute({
      sql: `SELECT * FROM local_orders WHERE tenant_id = ? AND provider_account_id = ? AND ${where} ORDER BY placed_at DESC`,
      args: [binding.tenantId, binding.providerAccountId, value],
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
  async issueRefund(command: RefundCommand): Promise<RefundEffect> {
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
    const approval = await this.client.execute({
      sql: "SELECT data FROM support_cases WHERE id = ?",
      args: [command.approvalCaseId],
    });
    const approvedCase = approval.rows[0]
      ? (JSON.parse(String(approval.rows[0].data)) as {
          approval?: { approved?: boolean };
          metadata?: { refundCommand?: { fingerprint?: string } };
        })
      : undefined;
    if (
      !approvedCase?.approval?.approved ||
      approvedCase.metadata?.refundCommand?.fingerprint !== fingerprint
    )
      throw new Error(
        "Refund execution requires the matching persisted approved command.",
      );
    const tx = await this.client.transaction("write");
    try {
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
        await tx.rollback();
        return { ...effect, replayed: true };
      }
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
      sql: "SELECT source, version FROM local_knowledge WHERE tenant_id = ? AND provider_account_id = ?",
      args: [binding.tenantId, binding.providerAccountId],
    });
    return result.rows.map((row) => ({
      source: text(row.source),
      version: text(row.version),
      changedAt: "2026-09-05T00:00:00.000Z",
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
          score: 1,
        }
      : undefined;
  }
}

class LocalSupportProvider implements SupportChannelProvider {
  readonly kind = LOCAL;
  constructor(
    private readonly client: Client,
    private readonly ready: Promise<void>,
  ) {}
  async normalizeInbound(payload: unknown) {
    const value = payload as {
      externalId?: string;
      from?: string;
      fromName?: string;
      subject?: string;
      body?: string;
      receivedAt?: string;
    };
    if (!value?.externalId || !value.from || !value.body)
      throw new Error("Invalid local inbound payload.");
    const createdAt = value.receivedAt ?? new Date().toISOString();
    return {
      binding: defaultLocalBinding(value.externalId),
      externalId: value.externalId,
      source: "mock-email" as const,
      customer: { email: value.from, name: value.fromName },
      subject: value.subject || "(no subject)",
      message: {
        id: `msg_${crypto.randomUUID().slice(0, 8)}`,
        author: "customer" as const,
        authorName: value.fromName ?? value.from,
        body: value.body,
        createdAt,
      },
      rawPayload: value as Record<string, unknown>,
    };
  }
  async deliver(
    binding: ProviderBinding,
    _body: string,
    _status: string,
    idempotencyKey?: string,
  ): Promise<DeliveryReceipt> {
    await this.ready;
    const key = idempotencyKey ?? `direct_${crypto.randomUUID()}`;
    const payloadFingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          tenantId: binding.tenantId,
          providerKind: binding.providerKind,
          providerAccountId: binding.providerAccountId,
          externalConversationId: binding.externalConversationId,
          body: _body,
          status: _status,
        }),
      )
      .digest("hex");
    const existing = await this.client.execute({
      sql: "SELECT payload_fingerprint, receipt FROM local_deliveries WHERE tenant_id = ? AND provider_account_id = ? AND idempotency_key = ?",
      args: [binding.tenantId, binding.providerAccountId, key],
    });
    if (existing.rows[0]) {
      if (String(existing.rows[0].payload_fingerprint) !== payloadFingerprint)
        throw new Error(
          "Delivery idempotency key was reused with different content.",
        );
      return JSON.parse(String(existing.rows[0].receipt)) as DeliveryReceipt;
    }
    const receipt: DeliveryReceipt = {
      receiptId: `receipt_${crypto.randomUUID()}`,
      deliveredAt: new Date().toISOString(),
      providerMessageId: `local_${crypto.randomUUID()}`,
    };
    try {
      await this.client.execute({
        sql: "INSERT INTO local_deliveries(tenant_id, provider_account_id, idempotency_key, payload_fingerprint, receipt) VALUES (?, ?, ?, ?, ?)",
        args: [
          binding.tenantId,
          binding.providerAccountId,
          key,
          payloadFingerprint,
          JSON.stringify(receipt),
        ],
      });
    } catch (error) {
      const raced = await this.client.execute({
        sql: "SELECT payload_fingerprint, receipt FROM local_deliveries WHERE tenant_id = ? AND provider_account_id = ? AND idempotency_key = ?",
        args: [binding.tenantId, binding.providerAccountId, key],
      });
      if (!raced.rows[0]) throw error;
      if (String(raced.rows[0].payload_fingerprint) !== payloadFingerprint)
        throw new Error(
          "Delivery idempotency key was reused with different content.",
        );
      return JSON.parse(String(raced.rows[0].receipt)) as DeliveryReceipt;
    }
    return receipt;
  }
  async addInternalNote(
    binding: ProviderBinding,
    body: string,
    _idempotencyKey: string,
  ) {
    return this.deliver(binding, body, "note", _idempotencyKey);
  }
  async updateStatus(
    binding: ProviderBinding,
    status: string,
    _idempotencyKey: string,
  ) {
    return this.deliver(binding, "", status, _idempotencyKey);
  }
}

export const localRuntime = new LocalRuntime();

/** Delivers accepted domain outcomes separately from workflow completion. */
export async function deliverOutbox(
  registry: ProviderRegistry = localRuntime,
  limit = 10,
  store: CaseStore = caseStore,
) {
  const items = await store.claimOutbox(limit);
  for (const item of items)
    try {
      const receipt = await registry
        .support(item.binding)
        .deliver(item.binding, item.body, item.status, item.id);
      await store.completeOutbox(item.id, receipt);
    } catch (error) {
      const message = String(error);
      const status = Number(message.match(/\b([1-5]\d\d)\b/)?.[1]);
      const terminal =
        /permanent/i.test(message) ||
        (status >= 400 && status < 500 && status !== 408 && status !== 429);
      await store.retryOutbox(item.id, error, terminal || item.attempts >= 3);
    }
  return items.length;
}

/** Restarts interrupted Mastra work; suspended approvals remain suspended. */
export async function recoverLocalWorkflows(
  mastra: { getWorkflow(id: string): any },
  limit = 10,
  store: CaseStore = caseStore,
) {
  const dispatches = await store.claimDispatch(limit);
  for (const dispatch of dispatches) {
    try {
      const supportCase = await store.get(dispatch.caseId);
      if (!supportCase) {
        await store.completeDispatch(
          dispatch.id,
          "failed",
          "Case missing during recovery.",
        );
        continue;
      }
      if (supportCase.status === "waiting_approval") {
        await store.completeDispatch(dispatch.id, "suspended");
        continue;
      }
      const workflow = mastra.getWorkflow("resolveSupportCaseWorkflow");
      const existing = await workflow.getWorkflowRunById?.(dispatch.runId);
      if (
        existing?.status === "suspended" ||
        existing?.status === "waiting" ||
        existing?.status === "paused"
      ) {
        await store.completeDispatch(dispatch.id, "suspended");
        continue;
      }
      if (existing?.status === "success") {
        await store.completeDispatch(dispatch.id, "completed");
        continue;
      }
      if (
        existing?.status &&
        existing.status !== "running" &&
        existing.status !== "pending"
      ) {
        await store.completeDispatch(dispatch.id, "failed", existing.status);
        continue;
      }
      const run = await workflow.createRun({ runId: dispatch.runId });
      // `restart()` only resumes an installed active run.  A process can die
      // after acceptance but before first start, which has no run record yet.
      const result = existing
        ? await run.restart()
        : await run.start({ inputData: { caseId: dispatch.caseId } });
      await store.completeDispatch(
        dispatch.id,
        result.status === "suspended"
          ? "suspended"
          : result.status === "success"
            ? "completed"
            : "failed",
        result.status === "failed" ? "Workflow restart failed." : undefined,
      );
    } catch (error) {
      await store.completeDispatch(dispatch.id, "failed", error);
    }
  }
  return dispatches.length;
}

/**
 * Studio/start lifecycle hook. It seeds only the configured local fixture and
 * runs one bounded recovery sweep immediately, then keeps a non-blocking
 * worker alive for interrupted dispatch and delivery work.
 */
export function startLocalRuntimeWorkers(
  mastra: Parameters<typeof recoverLocalWorkflows>[0],
  logger?: { warn(message: string, meta?: Record<string, unknown>): void },
) {
  let running = false;
  const sweep = async () => {
    if (running) return;
    running = true;
    try {
      const url = process.env.TURSO_DATABASE_URL || "file:./mastra.db";
      if (!url.startsWith("file:"))
        throw new Error(
          "Refusing local runtime worker: TURSO_DATABASE_URL must use a file: URL.",
        );
      await localRuntime.seed(defaultLocalBinding());
      await recoverLocalWorkflows(mastra);
      await deliverOutbox();
    } catch (error) {
      logger?.warn("Local runtime recovery sweep failed.", { error });
    } finally {
      running = false;
    }
  };
  // Let Mastra finish initializing its own LibSQL tables before this app-owned
  // client touches the same file. Starting both schema writers concurrently
  // produces SQLITE_BUSY on a pristine local database.
  const initial = setTimeout(() => void sweep(), 1_000);
  const timer = setInterval(() => void sweep(), 5_000);
  timer.unref();
  return () => {
    clearTimeout(initial);
    clearInterval(timer);
  };
}
