import { createClient } from "@libsql/client";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const mode = process.argv[2];
if (mode !== "seed" && mode !== "reset") {
  throw new Error("Usage: npm run local:seed | npm run local:reset");
}
const url = process.env.TURSO_DATABASE_URL || "file:./support-local.db";
if (!url.startsWith("file:")) {
  throw new Error(
    "Refusing local fixture operation: TURSO_DATABASE_URL must use a file: URL. Remote databases are never seeded or reset by this command.",
  );
}
const tenantId = process.env.LOCAL_FIXTURE_TENANT || "local-demo";
const accountId = process.env.LOCAL_FIXTURE_ACCOUNT || "local-demo";
const client = createClient({ url, timeout: 0 });
await client.execute("PRAGMA busy_timeout = 0;");
await client.executeMultiple(`
  CREATE TABLE IF NOT EXISTS local_orders (tenant_id TEXT NOT NULL, provider_account_id TEXT NOT NULL, order_id TEXT NOT NULL, customer_email TEXT NOT NULL, product TEXT NOT NULL, amount_minor INTEGER NOT NULL, currency TEXT NOT NULL, status TEXT NOT NULL, charge_count INTEGER NOT NULL, placed_at TEXT NOT NULL, PRIMARY KEY(tenant_id, provider_account_id, order_id));
  CREATE TABLE IF NOT EXISTS local_subscriptions (tenant_id TEXT NOT NULL, provider_account_id TEXT NOT NULL, subscription_id TEXT NOT NULL, customer_email TEXT NOT NULL, plan TEXT NOT NULL, amount_minor INTEGER NOT NULL, currency TEXT NOT NULL, status TEXT NOT NULL, renews_at TEXT NOT NULL, PRIMARY KEY(tenant_id, provider_account_id, subscription_id));
  CREATE TABLE IF NOT EXISTS local_refunds (refund_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, provider_account_id TEXT NOT NULL, order_id TEXT NOT NULL, amount_minor INTEGER NOT NULL, currency TEXT NOT NULL, reason TEXT NOT NULL, issued_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS local_knowledge (tenant_id TEXT NOT NULL, provider_account_id TEXT NOT NULL, source TEXT NOT NULL, title TEXT NOT NULL, text TEXT NOT NULL, version TEXT NOT NULL, PRIMARY KEY(tenant_id, provider_account_id, source));
  CREATE TABLE IF NOT EXISTS local_deliveries (tenant_id TEXT NOT NULL, provider_account_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, payload_fingerprint TEXT NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY(tenant_id, provider_account_id, idempotency_key));
`);
const args = [tenantId, accountId];
if (mode === "reset") {
  const tx = await client.transaction("write");
  try {
    const effects = await tx.execute({
      sql: "SELECT (SELECT COUNT(*) FROM local_refunds WHERE tenant_id = ? AND provider_account_id = ?) + (SELECT COUNT(*) FROM local_deliveries WHERE tenant_id = ? AND provider_account_id = ?) AS total",
      args: [...args, ...args],
    });
    if (Number(effects.rows[0]?.total ?? 0) > 0)
      throw new Error(
        "Refusing fixture reset: durable refund/idempotency or delivery effects exist for this binding. Use a new local database rather than deleting history.",
      );
    await tx.batch(
      ["local_orders", "local_subscriptions", "local_knowledge"].map(
        (table) => ({
          sql: `DELETE FROM ${table} WHERE tenant_id = ? AND provider_account_id = ?`,
          args,
        }),
      ),
    );
    await tx.commit();
  } catch (error) {
    try {
      await tx.rollback();
    } catch {}
    throw error;
  }
  console.log(
    `Reset local fixtures for ${tenantId}/${accountId}; durable case and Mastra tables were untouched.`,
  );
} else {
  const orders = [
    [
      "ORD-1001",
      "alex@example.com",
      "Pro Plan - Monthly",
      4900,
      "USD",
      "fulfilled",
      2,
      "2026-08-01T14:00:00.000Z",
    ],
    [
      "ORD-1002",
      "jordan@example.com",
      "Wireless Headphones",
      12999,
      "USD",
      "shipped",
      1,
      "2026-08-10T09:30:00.000Z",
    ],
    [
      "ORD-1003",
      "sam@example.com",
      "Standing Desk",
      34900,
      "USD",
      "fulfilled",
      1,
      "2026-07-20T11:15:00.000Z",
    ],
    [
      "ORD-1004",
      "riley@example.com",
      "Team Plan - Annual",
      58800,
      "USD",
      "fulfilled",
      1,
      "2026-05-02T08:00:00.000Z",
    ],
  ];
  const subscriptions = [
    [
      "SUB-1001",
      "alex@example.com",
      "Pro Plan - Monthly",
      4900,
      "USD",
      "active",
      "2026-09-01T00:00:00.000Z",
    ],
    [
      "SUB-1004",
      "riley@example.com",
      "Team Plan - Annual",
      58800,
      "USD",
      "active",
      "2027-05-02T00:00:00.000Z",
    ],
  ];
  const docsDirectory = join(
    dirname(fileURLToPath(import.meta.url)),
    "../src/mastra/knowledge/docs",
  );
  const knowledge = readdirSync(docsDirectory)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => {
      const source = readFileSync(join(docsDirectory, name), "utf8");
      const title = source.match(/title:\s*"([^"]+)"/);
      const policy = source.match(/source:\s*"([^"]+)"/);
      const text = source.match(/text:\s*`([\s\S]*?)`,\s*};/);
      if (!title || !policy || !text)
        throw new Error(
          `Cannot parse deterministic local policy fixture ${name}.`,
        );
      return [policy[1], title[1], text[1]];
    });
  await client.batch(
    [
      ...orders.map((row) => ({
        sql: "INSERT OR IGNORE INTO local_orders VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        args: [...args, ...row],
      })),
      ...subscriptions.map((row) => ({
        sql: "INSERT OR IGNORE INTO local_subscriptions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        args: [...args, ...row],
      })),
      ...knowledge.map((row) => ({
        sql: "INSERT OR IGNORE INTO local_knowledge VALUES (?, ?, ?, ?, ?, 'local-v1')",
        args: [...args, ...row],
      })),
    ],
    "write",
  );
  console.log(
    `Seeded deterministic local commerce fixtures for ${tenantId}/${accountId}.`,
  );
}
client.close();
