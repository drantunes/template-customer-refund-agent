import type { Client } from "@libsql/client";
import { POLICY_DOCUMENTS } from "../knowledge/policy-docs.ts";
import type { ProviderBinding } from "../providers/contracts";
import { requireLocalDatabaseUrl } from "../lib/database-url.ts";

const localSchema = `
  CREATE TABLE IF NOT EXISTS local_orders (tenant_id TEXT NOT NULL, provider_account_id TEXT NOT NULL, order_id TEXT NOT NULL, customer_email TEXT NOT NULL, product TEXT NOT NULL, amount_minor INTEGER NOT NULL, currency TEXT NOT NULL, status TEXT NOT NULL, charge_count INTEGER NOT NULL, placed_at TEXT NOT NULL, PRIMARY KEY(tenant_id, provider_account_id, order_id));
  CREATE TABLE IF NOT EXISTS local_subscriptions (tenant_id TEXT NOT NULL, provider_account_id TEXT NOT NULL, subscription_id TEXT NOT NULL, customer_email TEXT NOT NULL, plan TEXT NOT NULL, amount_minor INTEGER NOT NULL, currency TEXT NOT NULL, status TEXT NOT NULL, renews_at TEXT NOT NULL, cancel_at_period_end INTEGER NOT NULL DEFAULT 0, cancels_at TEXT, PRIMARY KEY(tenant_id, provider_account_id, subscription_id));
  CREATE TABLE IF NOT EXISTS local_refunds (refund_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, provider_account_id TEXT NOT NULL, order_id TEXT NOT NULL, amount_minor INTEGER NOT NULL, currency TEXT NOT NULL, reason TEXT NOT NULL, issued_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS local_knowledge (tenant_id TEXT NOT NULL, provider_account_id TEXT NOT NULL, source TEXT NOT NULL, title TEXT NOT NULL, text TEXT NOT NULL, version TEXT NOT NULL, effective_at TEXT, expires_at TEXT, PRIMARY KEY(tenant_id, provider_account_id, source));
  CREATE TABLE IF NOT EXISTS local_deliveries (tenant_id TEXT NOT NULL, provider_account_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, payload_fingerprint TEXT NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY(tenant_id, provider_account_id, idempotency_key));
`;

export const localFixtureOrders = [
  {
    orderId: "ORD-1001",
    customerEmail: "alex@example.com",
    product: "Pro Plan - Monthly",
    amountMinor: 4900,
    currency: "USD",
    status: "fulfilled",
    chargeCount: 2,
    placedAt: "2026-08-01T14:00:00.000Z",
  },
  {
    orderId: "ORD-1002",
    customerEmail: "jordan@example.com",
    product: "Wireless Headphones",
    amountMinor: 12999,
    currency: "USD",
    status: "shipped",
    chargeCount: 1,
    placedAt: "2026-08-10T09:30:00.000Z",
  },
  {
    orderId: "ORD-1003",
    customerEmail: "sam@example.com",
    product: "Standing Desk",
    amountMinor: 34900,
    currency: "USD",
    status: "fulfilled",
    chargeCount: 1,
    placedAt: "2026-07-20T11:15:00.000Z",
  },
  {
    orderId: "ORD-1004",
    customerEmail: "riley@example.com",
    product: "Team Plan - Annual",
    amountMinor: 58800,
    currency: "USD",
    status: "fulfilled",
    chargeCount: 1,
    placedAt: "2026-05-02T08:00:00.000Z",
  },
] as const;
export const localFixtureSubscriptions = [
  {
    subscriptionId: "SUB-1001",
    customerEmail: "alex@example.com",
    plan: "Pro Plan - Monthly",
    amountMinor: 4900,
    currency: "USD",
    status: "active",
    renewsAt: "2026-09-01T00:00:00.000Z",
  },
  {
    subscriptionId: "SUB-1004",
    customerEmail: "riley@example.com",
    plan: "Team Plan - Annual",
    amountMinor: 58800,
    currency: "USD",
    status: "active",
    renewsAt: "2027-05-02T00:00:00.000Z",
  },
] as const;

export function localFixtureBinding(
  tenantId = process.env.LOCAL_FIXTURE_TENANT || "local-demo",
  providerAccountId = process.env.LOCAL_FIXTURE_ACCOUNT || "local-demo",
): ProviderBinding {
  return {
    tenantId,
    providerKind: "local",
    providerAccountId,
    externalConversationId: "local",
  };
}

export async function initializeLocalFixtures(client: Client) {
  await client.executeMultiple(localSchema);
  for (const sql of [
    "ALTER TABLE local_deliveries ADD COLUMN payload_fingerprint TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE local_knowledge ADD COLUMN effective_at TEXT",
    "ALTER TABLE local_knowledge ADD COLUMN expires_at TEXT",
    "ALTER TABLE local_subscriptions ADD COLUMN cancel_at_period_end INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE local_subscriptions ADD COLUMN cancels_at TEXT",
  ])
    try {
      await client.execute(sql);
    } catch (error) {
      if (!String(error).includes("duplicate column")) throw error;
    }
  await client.batch(
    POLICY_DOCUMENTS.map((document) => ({
      sql: "UPDATE local_knowledge SET effective_at = '2026-01-01T00:00:00.000Z' WHERE source = ? AND title = ? AND text = ? AND version = 'local-v1' AND effective_at IS NULL",
      args: [document.source, document.title, document.text],
    })),
    "write",
  );
}

export async function seedLocalFixtures(
  client: Client,
  binding: ProviderBinding,
) {
  requireLocalDatabaseUrl();
  await initializeLocalFixtures(client);
  const args = [binding.tenantId, binding.providerAccountId];
  await client.batch(
    [
      ...localFixtureOrders.map((row) => ({
        sql: "INSERT OR IGNORE INTO local_orders VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        args: [
          ...args,
          row.orderId,
          row.customerEmail,
          row.product,
          row.amountMinor,
          row.currency,
          row.status,
          row.chargeCount,
          row.placedAt,
        ],
      })),
      ...localFixtureSubscriptions.map((row) => ({
        sql: "INSERT OR IGNORE INTO local_subscriptions(tenant_id, provider_account_id, subscription_id, customer_email, plan, amount_minor, currency, status, renews_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        args: [
          ...args,
          row.subscriptionId,
          row.customerEmail,
          row.plan,
          row.amountMinor,
          row.currency,
          row.status,
          row.renewsAt,
        ],
      })),
      ...POLICY_DOCUMENTS.map((document) => ({
        sql: "INSERT OR IGNORE INTO local_knowledge(tenant_id, provider_account_id, source, title, text, version, effective_at, expires_at) VALUES (?, ?, ?, ?, ?, 'local-v1', '2026-01-01T00:00:00.000Z', NULL)",
        args: [...args, document.source, document.title, document.text],
      })),
    ],
    "write",
  );
}

export async function resetLocalFixtures(
  client: Client,
  binding: ProviderBinding,
) {
  requireLocalDatabaseUrl();
  await initializeLocalFixtures(client);
  const args = [binding.tenantId, binding.providerAccountId];
  const tx = await client.transaction("write");
  try {
    const effects = await tx.execute({
      sql: "SELECT (SELECT COUNT(*) FROM local_refunds WHERE tenant_id = ? AND provider_account_id = ?) + (SELECT COUNT(*) FROM local_deliveries WHERE tenant_id = ? AND provider_account_id = ?) + (SELECT COUNT(*) FROM local_subscriptions WHERE tenant_id = ? AND provider_account_id = ? AND (status != 'active' OR cancel_at_period_end = 1)) AS total",
      args: [...args, ...args, ...args],
    });
    if (Number(effects.rows[0]?.total ?? 0) > 0)
      throw new Error(
        "Refusing fixture reset: durable refund/idempotency or delivery effects, including cancellation history, exist for this binding. Use a new local database rather than deleting history.",
      );
    // Cancellation attempts carry an explicit binding; a global
    // support_idempotency row does not. Do not let another tenant's unrelated
    // replay key block this fixture binding's reset.
    const table = "support_subscription_cancellation_attempts";
    if (
      (
        await tx.execute({
          sql: "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
          args: [table],
        })
      ).rows[0]
    ) {
      const persisted = await tx.execute({
        sql: "SELECT COUNT(*) AS total FROM support_subscription_cancellation_attempts WHERE tenant_id = ? AND provider_account_id = ?",
        args,
      });
      if (Number(persisted.rows[0]?.total ?? 0) > 0)
        throw new Error(
          "Refusing fixture reset: durable idempotency or cancellation attempts exist. Use a new local database rather than deleting history.",
        );
    }
    await tx.batch(
      [
        "local_orders",
        "local_subscriptions",
        "local_knowledge",
        "local_refunds",
        "local_deliveries",
      ].map((table) => ({
        sql: `DELETE FROM ${table} WHERE tenant_id = ? AND provider_account_id = ?`,
        args,
      })),
    );
    await tx.commit();
  } catch (error) {
    try {
      await tx.rollback();
    } catch {}
    throw error;
  }
}
