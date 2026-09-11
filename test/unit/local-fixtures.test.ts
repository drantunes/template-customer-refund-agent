import { rm } from "node:fs/promises";
import { createClient } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  localFixtureBinding,
  seedLocalFixtures,
} from "../../src/mastra/runtime/local-fixtures";
import { temporaryDatabasePath } from "../support/temp-path";

const files: string[] = [];

afterEach(async () => {
  delete process.env.TURSO_DATABASE_URL;
  await Promise.all(files.splice(0).map((file) => rm(file, { force: true })));
});

describe("local subscription billing-term migration", () => {
  it("backfills the known annual fixture instead of retaining SQLite's new monthly default", async () => {
    const path = temporaryDatabasePath("phase008-recurring-migration");
    files.push(path, `${path}-shm`, `${path}-wal`);
    process.env.TURSO_DATABASE_URL = `file:${path}`;
    const client = createClient({ url: process.env.TURSO_DATABASE_URL });
    const binding = localFixtureBinding();
    await client.executeMultiple(`
      CREATE TABLE local_subscriptions (
        tenant_id TEXT NOT NULL,
        provider_account_id TEXT NOT NULL,
        subscription_id TEXT NOT NULL,
        customer_email TEXT NOT NULL,
        plan TEXT NOT NULL,
        amount_minor INTEGER NOT NULL,
        currency TEXT NOT NULL,
        status TEXT NOT NULL,
        renews_at TEXT NOT NULL,
        PRIMARY KEY(tenant_id, provider_account_id, subscription_id)
      );
    `);
    await client.execute({
      sql: "INSERT INTO local_subscriptions VALUES (?, ?, 'SUB-1004', 'riley@example.com', 'Team Plan - Annual', 58800, 'USD', 'active', '2027-05-02T00:00:00.000Z')",
      args: [binding.tenantId, binding.providerAccountId],
    });

    await seedLocalFixtures(client, binding);

    const annual = await client.execute({
      sql: "SELECT recurring_interval, recurring_interval_count, quantity FROM local_subscriptions WHERE tenant_id = ? AND provider_account_id = ? AND subscription_id = 'SUB-1004'",
      args: [binding.tenantId, binding.providerAccountId],
    });
    expect(annual.rows).toEqual([
      expect.objectContaining({
        recurring_interval: "year",
        recurring_interval_count: 1,
        quantity: 1,
      }),
    ]);
    client.close();
  });
});
