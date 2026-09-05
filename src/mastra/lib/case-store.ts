import { createClient, type Client } from "@libsql/client";
import type { CaseMessage, SupportCase } from "../domain/support-case";
import {
  bindingsForCase,
  sameBinding,
  type ProviderBinding,
} from "../providers/contracts";
import { waitForMastraStorage } from "../runtime/storage-lifecycle";

export type DispatchState =
  "pending" | "claimed" | "completed" | "suspended" | "failed";
export type OutboxState = "pending" | "claimed" | "delivered" | "failed";
export interface OutboxRecord {
  id: string;
  caseId: string;
  binding: ProviderBinding;
  body: string;
  status: string;
  state: OutboxState;
  attempts: number;
  receipt?: unknown;
  lastError?: string;
  leaseToken?: string;
}
export interface DispatchRecord {
  id: string;
  caseId: string;
  runId: string;
  state: DispatchState;
  attempts: number;
  /** Whether this dispatch had already crossed the durable start boundary. */
  wasStarted: boolean;
  leaseToken?: string;
}
export class StaleCaseWriteError extends Error {
  constructor(id: string) {
    super(`Stale case write rejected for ${id}.`);
  }
}

function config(url = process.env.TURSO_DATABASE_URL || "file:./mastra.db") {
  return { url, authToken: process.env.TURSO_AUTH_TOKEN || undefined };
}
function now() {
  return new Date().toISOString();
}
function parse(row: Record<string, unknown>): SupportCase {
  return JSON.parse(String(row.data)) as SupportCase;
}

/** App-owned migrations never enumerate, rename, or drop Mastra-owned tables. */
export class CaseStore {
  private readonly client: Client;
  private ready?: Promise<void>;
  constructor(options: { client?: Client; url?: string } = {}) {
    this.client = options.client ?? createClient(config(options.url));
  }
  async close() {
    this.client.close();
  }
  async migrate(target = 5): Promise<void> {
    await this.client.execute(
      "CREATE TABLE IF NOT EXISTS support_schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
    );
    const applied = await this.client.execute(
      "SELECT version FROM support_schema_migrations ORDER BY version",
    );
    let version = Number(applied.rows.at(-1)?.version ?? 0);
    while (version < target) {
      version += 1;
      await this.up(version);
    }
    while (version > target) {
      await this.down(version);
      version -= 1;
    }
  }
  private async up(version: number) {
    if (version === 1)
      await this.client.executeMultiple(`
      CREATE TABLE IF NOT EXISTS support_cases (id TEXT PRIMARY KEY, source TEXT NOT NULL, external_id TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS support_cases_source_external_id ON support_cases(source, external_id);
    `);
    if (version === 2) {
      for (const sql of [
        "ALTER TABLE support_cases ADD COLUMN version INTEGER NOT NULL DEFAULT 1",
        "ALTER TABLE support_cases ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'local-demo'",
        'ALTER TABLE support_cases ADD COLUMN provider_binding TEXT NOT NULL DEFAULT \'{"tenantId":"local-demo","providerKind":"local","providerAccountId":"local-demo","externalConversationId":"legacy"}\'',
      ]) {
        try {
          await this.client.execute(sql);
        } catch (error) {
          if (!String(error).includes("duplicate column")) throw error;
        }
      }
      await this.client.executeMultiple(`
        CREATE TABLE IF NOT EXISTS support_messages (id TEXT PRIMARY KEY, case_id TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS support_events (id TEXT PRIMARY KEY, source TEXT NOT NULL, external_id TEXT NOT NULL, case_id TEXT NOT NULL, accepted_at TEXT NOT NULL, UNIQUE(source, external_id));
        CREATE TABLE IF NOT EXISTS support_actions (id TEXT PRIMARY KEY, case_id TEXT NOT NULL, kind TEXT NOT NULL, fingerprint TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(kind, fingerprint));
        CREATE TABLE IF NOT EXISTS support_idempotency (idempotency_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, effect TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS support_dispatch (id TEXT PRIMARY KEY, case_id TEXT NOT NULL UNIQUE, run_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, lease_until TEXT, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS support_outbox (id TEXT PRIMARY KEY, case_id TEXT NOT NULL, binding TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, receipt TEXT, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS support_outbox_claimable ON support_outbox(state, created_at);
      `);
      const cases = await this.client.execute(
        "SELECT id, data FROM support_cases",
      );
      for (const row of cases.rows)
        for (const message of parse(row as Record<string, unknown>).messages)
          await this.client.execute({
            sql: "INSERT OR IGNORE INTO support_messages(id, case_id, data, created_at) VALUES (?, ?, ?, ?)",
            args: [
              message.id,
              String(row.id),
              JSON.stringify(message),
              message.createdAt,
            ],
          });
    }
    if (version === 3) await this.up3();
    if (version === 4) await this.up4();
    if (version === 5) await this.up5();
    await this.client.execute({
      sql: "INSERT INTO support_schema_migrations(version, applied_at) VALUES (?, ?)",
      args: [version, now()],
    });
  }
  private async up3() {
    try {
      await this.client.execute(
        "ALTER TABLE support_outbox ADD COLUMN lease_until TEXT",
      );
    } catch (error) {
      if (!String(error).includes("duplicate column")) throw error;
    }
    const columns = await this.client.execute(
      "PRAGMA table_info(support_events)",
    );
    if (columns.rows.some((row) => String(row.name) === "tenant_id")) return;

    // Do not let a partly-applied ALTER skip this table rebuild.  The old event
    // key was global; the persisted case binding supplies the scoped key.
    const events = await this.client.execute("SELECT * FROM support_events");
    const cases = await this.client.execute(
      "SELECT id, tenant_id, provider_binding FROM support_cases",
    );
    const bindings = new Map(
      cases.rows.map((row) => {
        const value = row as Record<string, unknown>;
        const binding = JSON.parse(
          String(value.provider_binding),
        ) as ProviderBinding;
        return [String(value.id), binding] as const;
      }),
    );
    const tx = await this.client.transaction("write");
    try {
      await tx.executeMultiple(
        "CREATE TABLE support_events_v3 (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, provider_account_id TEXT NOT NULL, source TEXT NOT NULL, external_id TEXT NOT NULL, case_id TEXT NOT NULL, accepted_at TEXT NOT NULL, UNIQUE(tenant_id, provider_account_id, source, external_id));",
      );
      for (const row of events.rows) {
        const event = row as Record<string, unknown>;
        const binding = bindings.get(String(event.case_id));
        await tx.execute({
          sql: "INSERT INTO support_events_v3(id, tenant_id, provider_account_id, source, external_id, case_id, accepted_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          args: [
            String(event.id),
            binding?.tenantId ?? "local-demo",
            binding?.providerAccountId ?? "local-demo",
            String(event.source),
            String(event.external_id),
            String(event.case_id),
            String(event.accepted_at),
          ],
        });
      }
      await tx.executeMultiple(
        "DROP TABLE support_events; ALTER TABLE support_events_v3 RENAME TO support_events;",
      );
      await tx.commit();
    } catch (error) {
      try {
        await tx.rollback();
      } catch {}
      throw error;
    }
  }
  private async up4() {
    const indexes = await this.client.execute(
      "PRAGMA index_list(support_cases)",
    );
    const scoped = indexes.rows.some(
      (row) => String(row.name) === "support_cases_scoped_external_id",
    );
    if (scoped) return;
    const tx = await this.client.transaction("write");
    try {
      const cases = await tx.execute("SELECT * FROM support_cases");
      await tx.executeMultiple(
        "CREATE TABLE support_cases_v4 (id TEXT PRIMARY KEY, source TEXT NOT NULL, external_id TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, tenant_id TEXT NOT NULL, provider_account_id TEXT NOT NULL, provider_binding TEXT NOT NULL);",
      );
      for (const row of cases.rows) {
        const value = row as Record<string, unknown>;
        const binding = JSON.parse(
          String(value.provider_binding),
        ) as ProviderBinding;
        await tx.execute({
          sql: "INSERT INTO support_cases_v4(id, source, external_id, data, created_at, updated_at, version, tenant_id, provider_account_id, provider_binding) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          args: [
            String(value.id),
            String(value.source),
            String(value.external_id),
            String(value.data),
            String(value.created_at),
            String(value.updated_at),
            Number(value.version),
            binding.tenantId,
            binding.providerAccountId,
            String(value.provider_binding),
          ],
        });
      }
      await tx.executeMultiple(`
        DROP TABLE support_cases;
        ALTER TABLE support_cases_v4 RENAME TO support_cases;
        CREATE UNIQUE INDEX support_cases_scoped_external_id ON support_cases(tenant_id, provider_account_id, source, external_id);
      `);
      await tx.commit();
    } catch (error) {
      try {
        await tx.rollback();
      } catch {}
      throw error;
    }
  }
  private async up5() {
    for (const sql of [
      "ALTER TABLE support_dispatch ADD COLUMN lease_token TEXT",
      "ALTER TABLE support_outbox ADD COLUMN lease_token TEXT",
    ]) {
      try {
        await this.client.execute(sql);
      } catch (error) {
        if (!String(error).includes("duplicate column")) throw error;
      }
    }
  }
  private async down(version: number) {
    if (version === 3) {
      const count = await this.client.execute(
        "SELECT COUNT(*) AS total FROM support_events",
      );
      if (Number(count.rows[0]?.total ?? 0) > 0)
        throw new Error(
          "Refusing destructive downgrade: tenant-qualified events exist.",
        );
      await this.client.executeMultiple(
        "DROP TABLE support_events; CREATE TABLE support_events (id TEXT PRIMARY KEY, source TEXT NOT NULL, external_id TEXT NOT NULL, case_id TEXT NOT NULL, accepted_at TEXT NOT NULL, UNIQUE(source, external_id));",
      );
    }
    if (version === 4) {
      const duplicates = await this.client.execute(
        "SELECT source, external_id FROM support_cases GROUP BY source, external_id HAVING COUNT(*) > 1 LIMIT 1",
      );
      if (duplicates.rows[0])
        throw new Error(
          "Refusing destructive downgrade: tenant-scoped cases share a source/external id.",
        );
      await this.client.executeMultiple(`
        CREATE TABLE support_cases_v3 (id TEXT PRIMARY KEY, source TEXT NOT NULL, external_id TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, tenant_id TEXT NOT NULL, provider_binding TEXT NOT NULL, UNIQUE(source, external_id));
        INSERT INTO support_cases_v3(id, source, external_id, data, created_at, updated_at, version, tenant_id, provider_binding) SELECT id, source, external_id, data, created_at, updated_at, version, tenant_id, provider_binding FROM support_cases;
        DROP TABLE support_cases;
        ALTER TABLE support_cases_v3 RENAME TO support_cases;
      `);
    }
    if (version === 2) {
      const counts = await this.client.execute(
        "SELECT (SELECT COUNT(*) FROM support_outbox) + (SELECT COUNT(*) FROM support_dispatch) + (SELECT COUNT(*) FROM support_idempotency) + (SELECT COUNT(*) FROM support_actions) AS total",
      );
      if (Number(counts.rows[0]?.total ?? 0) > 0)
        throw new Error(
          "Refusing destructive downgrade: durable Phase 002 records exist.",
        );
      await this.client.executeMultiple(
        "DROP TABLE IF EXISTS support_outbox; DROP TABLE IF EXISTS support_dispatch; DROP TABLE IF EXISTS support_idempotency; DROP TABLE IF EXISTS support_actions; DROP TABLE IF EXISTS support_events; DROP TABLE IF EXISTS support_messages;",
      );
    }
    await this.client.execute({
      sql: "DELETE FROM support_schema_migrations WHERE version = ?",
      args: [version],
    });
  }
  private async ensured() {
    this.ready ??= (async () => {
      await waitForMastraStorage();
      await this.client.execute("PRAGMA busy_timeout = 30000;");
      await this.migrate();
    })();
    await this.ready;
  }
  private binding(case_: SupportCase): ProviderBinding {
    return bindingsForCase(case_).support;
  }
  /** New records always carry all four independently addressable bindings. */
  private withBindings(case_: SupportCase): SupportCase {
    const bindings = bindingsForCase(case_);
    return {
      ...case_,
      metadata: {
        ...case_.metadata,
        providerBinding: bindings.support,
        providerBindings: bindings,
      },
    };
  }
  private assertBindingsUnchanged(current: SupportCase, updated: SupportCase) {
    const before = bindingsForCase(current);
    const after = bindingsForCase(updated);
    for (const port of [
      "support",
      "commerce",
      "transactions",
      "knowledge",
    ] as const)
      if (!sameBinding(before[port], after[port]))
        throw new Error(`Persisted ${port} provider binding is immutable.`);
  }
  async findByExternalId(source: string, externalId: string) {
    await this.ensured();
    const result = await this.client.execute({
      sql: "SELECT data FROM support_cases WHERE source = ? AND external_id = ?",
      args: [source, externalId],
    });
    return result.rows[0]
      ? parse(result.rows[0] as Record<string, unknown>)
      : undefined;
  }
  async get(id: string) {
    await this.ensured();
    const result = await this.client.execute({
      sql: "SELECT data FROM support_cases WHERE id = ?",
      args: [id],
    });
    return result.rows[0]
      ? parse(result.rows[0] as Record<string, unknown>)
      : undefined;
  }
  async list() {
    await this.ensured();
    const result = await this.client.execute(
      "SELECT data FROM support_cases ORDER BY created_at DESC",
    );
    return result.rows.map((row) => parse(row as Record<string, unknown>));
  }
  async create(case_: SupportCase) {
    await this.ensured();
    const persisted = this.withBindings(case_);
    const binding = this.binding(persisted);
    const tx = await this.client.transaction("write");
    try {
      await tx.execute({
        sql: "INSERT INTO support_cases(id, source, external_id, data, created_at, updated_at, version, tenant_id, provider_account_id, provider_binding) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)",
        args: [
          persisted.id,
          persisted.source,
          persisted.externalId,
          JSON.stringify(persisted),
          persisted.createdAt,
          persisted.updatedAt,
          binding.tenantId,
          binding.providerAccountId,
          JSON.stringify(binding),
        ],
      });
      for (const message of persisted.messages)
        await tx.execute({
          sql: "INSERT INTO support_messages(id, case_id, data, created_at) VALUES (?, ?, ?, ?)",
          args: [
            message.id,
            persisted.id,
            JSON.stringify(message),
            message.createdAt,
          ],
        });
      await tx.commit();
    } catch (error) {
      try {
        await tx.rollback();
      } catch {}
      throw error;
    }
    return persisted;
  }
  async update(
    id: string,
    patch: Partial<SupportCase>,
    expectedVersion?: number,
  ) {
    await this.ensured();
    const tx = await this.client.transaction("write");
    try {
      const result = await tx.execute({
        sql: "SELECT data, version FROM support_cases WHERE id = ?",
        args: [id],
      });
      const row = result.rows[0];
      if (!row) throw new Error(`Support case not found: ${id}`);
      const version = Number(row.version ?? 1);
      if (expectedVersion !== undefined && expectedVersion !== version)
        throw new StaleCaseWriteError(id);
      const updated = this.withBindings({
        ...parse(row as Record<string, unknown>),
        ...patch,
        updatedAt: now(),
      } as SupportCase);
      this.assertBindingsUnchanged(
        parse(row as Record<string, unknown>),
        updated,
      );
      const write = await tx.execute({
        sql: "UPDATE support_cases SET data = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?",
        args: [JSON.stringify(updated), updated.updatedAt, id, version],
      });
      if (Number(write.rowsAffected) !== 1) throw new StaleCaseWriteError(id);
      if (patch.messages)
        for (const message of patch.messages)
          await tx.execute({
            sql: "INSERT OR IGNORE INTO support_messages(id, case_id, data, created_at) VALUES (?, ?, ?, ?)",
            args: [message.id, id, JSON.stringify(message), message.createdAt],
          });
      await tx.commit();
      return updated;
    } catch (error) {
      try {
        await tx.rollback();
      } catch {}
      throw error;
    }
  }
  async appendMessage(id: string, message: CaseMessage) {
    await this.ensured();
    // Retry the short CAS update so two inbound follow-ups cannot overwrite one another.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const tx = await this.client.transaction("write");
      try {
        const read = await tx.execute({
          sql: "SELECT data, version FROM support_cases WHERE id = ?",
          args: [id],
        });
        const row = read.rows[0];
        if (!row) throw new Error(`Support case not found: ${id}`);
        const current = parse(row as Record<string, unknown>);
        if (current.messages.some((entry) => entry.id === message.id)) {
          await tx.rollback();
          return current;
        }
        const updated = {
          ...current,
          messages: [...current.messages, message],
          updatedAt: now(),
        };
        const write = await tx.execute({
          sql: "UPDATE support_cases SET data = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?",
          args: [
            JSON.stringify(updated),
            updated.updatedAt,
            id,
            Number(row.version ?? 1),
          ],
        });
        if (Number(write.rowsAffected) === 1) {
          await tx.execute({
            sql: "INSERT INTO support_messages(id, case_id, data, created_at) VALUES (?, ?, ?, ?)",
            args: [message.id, id, JSON.stringify(message), message.createdAt],
          });
          await tx.commit();
          return updated;
        }
        await tx.rollback();
      } catch (error) {
        try {
          await tx.rollback();
        } catch {}
        throw error;
      }
    }
    throw new StaleCaseWriteError(id);
  }
  private async appendMessageRow(caseId: string, message: CaseMessage) {
    await this.client.execute({
      sql: "INSERT OR IGNORE INTO support_messages(id, case_id, data, created_at) VALUES (?, ?, ?, ?)",
      args: [message.id, caseId, JSON.stringify(message), message.createdAt],
    });
  }
  /** Atomic deduplication: event, case, messages and durable dispatch are committed together. */
  async acceptInbound(case_: SupportCase, eventId: string, runId: string) {
    await this.ensured();
    const persisted = this.withBindings(case_);
    const binding = this.binding(persisted);
    const tx = await this.client.transaction("write");
    try {
      const exists = await tx.execute({
        sql: "SELECT case_id FROM support_events WHERE tenant_id = ? AND provider_account_id = ? AND source = ? AND external_id = ?",
        args: [
          binding.tenantId,
          binding.providerAccountId,
          persisted.source,
          persisted.externalId,
        ],
      });
      if (exists.rows[0]) {
        await tx.rollback();
        return { caseId: String(exists.rows[0].case_id), isNew: false };
      }
      // Phase 001 cases predate support_events.  Treat their scoped case
      // identity as the already-accepted event and backfill it in this same
      // transaction, so a replay cannot create a second dispatch.
      const legacy = await tx.execute({
        sql: "SELECT id FROM support_cases WHERE tenant_id = ? AND provider_account_id = ? AND source = ? AND external_id = ?",
        args: [
          binding.tenantId,
          binding.providerAccountId,
          persisted.source,
          persisted.externalId,
        ],
      });
      if (legacy.rows[0]) {
        const caseId = String(legacy.rows[0].id);
        await tx.execute({
          sql: "INSERT OR IGNORE INTO support_events(id, tenant_id, provider_account_id, source, external_id, case_id, accepted_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          args: [
            eventId,
            binding.tenantId,
            binding.providerAccountId,
            persisted.source,
            persisted.externalId,
            caseId,
            now(),
          ],
        });
        await tx.commit();
        return { caseId, isNew: false };
      }
      await tx.execute({
        sql: "INSERT INTO support_cases(id, source, external_id, data, created_at, updated_at, version, tenant_id, provider_account_id, provider_binding) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)",
        args: [
          persisted.id,
          persisted.source,
          persisted.externalId,
          JSON.stringify(persisted),
          persisted.createdAt,
          persisted.updatedAt,
          binding.tenantId,
          binding.providerAccountId,
          JSON.stringify(binding),
        ],
      });
      for (const message of persisted.messages)
        await tx.execute({
          sql: "INSERT INTO support_messages(id, case_id, data, created_at) VALUES (?, ?, ?, ?)",
          args: [
            message.id,
            persisted.id,
            JSON.stringify(message),
            message.createdAt,
          ],
        });
      await tx.execute({
        sql: "INSERT INTO support_events(id, tenant_id, provider_account_id, source, external_id, case_id, accepted_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        args: [
          eventId,
          binding.tenantId,
          binding.providerAccountId,
          persisted.source,
          persisted.externalId,
          persisted.id,
          now(),
        ],
      });
      await tx.execute({
        sql: "INSERT INTO support_dispatch(id, case_id, run_id, state, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?)",
        args: [`dispatch_${eventId}`, persisted.id, runId, now(), now()],
      });
      await tx.commit();
      return { caseId: persisted.id, isNew: true };
    } catch (error) {
      try {
        await tx.rollback();
      } catch {}
      throw error;
    }
  }
  async enqueueDelivery(record: Omit<OutboxRecord, "state" | "attempts">) {
    await this.ensured();
    await this.client.execute({
      sql: "INSERT INTO support_outbox(id, case_id, binding, body, status, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)",
      args: [
        record.id,
        record.caseId,
        JSON.stringify(record.binding),
        record.body,
        record.status,
        now(),
        now(),
      ],
    });
  }
  /** The terminal case view, agent reply and delivery intent are one durable
   * decision.  Replays accept the same deterministic records and reject a
   * mismatched finalization instead of creating another customer reply. */
  async finalizeCaseAndEnqueue(input: {
    caseId: string;
    status: "resolved" | "escalated";
    finalResponse: string;
    escalationReason?: string;
    message: CaseMessage;
    outbox: Omit<OutboxRecord, "state" | "attempts">;
  }) {
    await this.ensured();
    const tx = await this.client.transaction("write");
    try {
      const rowResult = await tx.execute({
        sql: "SELECT data, version FROM support_cases WHERE id = ?",
        args: [input.caseId],
      });
      const row = rowResult.rows[0];
      if (!row) throw new Error(`Support case not found: ${input.caseId}`);
      const current = parse(row as Record<string, unknown>);
      if (
        current.finalResponse !== undefined &&
        (current.finalResponse !== input.finalResponse ||
          current.status !== input.status)
      )
        throw new Error(
          "Conflicting replay attempted to finalize a support case.",
        );
      const hasMessage = current.messages.some(
        (message) => message.id === input.message.id,
      );
      const updated = this.withBindings({
        ...current,
        status: input.status,
        finalResponse: input.finalResponse,
        escalationReason: input.escalationReason,
        messages: hasMessage
          ? current.messages
          : [...current.messages, input.message],
        updatedAt: now(),
      });
      const write = await tx.execute({
        sql: "UPDATE support_cases SET data = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?",
        args: [
          JSON.stringify(updated),
          updated.updatedAt,
          input.caseId,
          Number(row.version ?? 1),
        ],
      });
      if (Number(write.rowsAffected) !== 1)
        throw new StaleCaseWriteError(input.caseId);
      await tx.execute({
        sql: "INSERT OR IGNORE INTO support_messages(id, case_id, data, created_at) VALUES (?, ?, ?, ?)",
        args: [
          input.message.id,
          input.caseId,
          JSON.stringify(input.message),
          input.message.createdAt,
        ],
      });
      const prior = await tx.execute({
        sql: "SELECT case_id, binding, body, status FROM support_outbox WHERE id = ?",
        args: [input.outbox.id],
      });
      if (prior.rows[0]) {
        const existing = prior.rows[0] as Record<string, unknown>;
        if (
          String(existing.case_id) !== input.caseId ||
          String(existing.body) !== input.outbox.body ||
          String(existing.status) !== input.outbox.status ||
          String(existing.binding) !== JSON.stringify(input.outbox.binding)
        )
          throw new Error(
            "Conflicting replay attempted to enqueue a delivery.",
          );
      } else {
        await tx.execute({
          sql: "INSERT INTO support_outbox(id, case_id, binding, body, status, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)",
          args: [
            input.outbox.id,
            input.caseId,
            JSON.stringify(input.outbox.binding),
            input.outbox.body,
            input.outbox.status,
            now(),
            now(),
          ],
        });
      }
      await tx.commit();
      return updated;
    } catch (error) {
      try {
        await tx.rollback();
      } catch {}
      throw error;
    }
  }
  async claimDispatch(limit = 10): Promise<DispatchRecord[]> {
    await this.ensured();
    const claimedAt = now();
    const exhausted = await this.client.execute({
      sql: "SELECT case_id FROM support_dispatch WHERE state IN ('claimed', 'started') AND lease_until < ? AND attempts >= 3",
      args: [claimedAt],
    });
    await this.client.execute({
      sql: "UPDATE support_dispatch SET state = 'failed', lease_until = NULL, lease_token = NULL, last_error = COALESCE(last_error, 'Dispatch lease exhausted after three attempts.'), updated_at = ? WHERE state IN ('claimed', 'started') AND lease_until < ? AND attempts >= 3",
      args: [claimedAt, claimedAt],
    });
    for (const row of exhausted.rows) {
      const caseId = String(row.case_id);
      const current = await this.get(caseId);
      if (current && current.status !== "waiting_approval")
        await this.update(caseId, {
          status: "failed",
          escalationReason:
            "Workflow recovery exhausted its durable lease attempts.",
          metadata: { ...current.metadata, workflowStatus: "failed" },
        });
    }
    const leaseUntil = new Date(Date.now() + 30_000).toISOString();
    const rows = await this.client.execute({
      sql: "SELECT * FROM support_dispatch WHERE (state = 'pending' OR (state IN ('claimed', 'started') AND lease_until < ?)) AND attempts < 3 ORDER BY created_at LIMIT ?",
      args: [claimedAt, limit],
    });
    const claimed: DispatchRecord[] = [];
    for (const row of rows.rows) {
      const leaseToken = crypto.randomUUID();
      const update = await this.client.execute({
        sql: "UPDATE support_dispatch SET state = 'claimed', attempts = attempts + 1, lease_until = ?, lease_token = ?, updated_at = ? WHERE id = ? AND (state = 'pending' OR (state IN ('claimed', 'started') AND lease_until < ?))",
        args: [leaseUntil, leaseToken, claimedAt, String(row.id), claimedAt],
      });
      if (Number(update.rowsAffected) === 1)
        claimed.push({
          id: String(row.id),
          caseId: String(row.case_id),
          runId: String(row.run_id),
          state: "claimed",
          attempts: Number(row.attempts) + 1,
          wasStarted:
            String(row.state) === "started" || String(row.state) === "claimed",
          leaseToken,
        });
    }
    return claimed;
  }
  async renewDispatchLease(id: string, leaseToken: string) {
    await this.ensured();
    const updated = await this.client.execute({
      sql: "UPDATE support_dispatch SET lease_until = ?, updated_at = ? WHERE id = ? AND lease_token = ? AND state IN ('claimed', 'started')",
      args: [
        new Date(Date.now() + 30_000).toISOString(),
        now(),
        id,
        leaseToken,
      ],
    });
    return Number(updated.rowsAffected) === 1;
  }
  async completeDispatch(
    id: string,
    state: Exclude<DispatchState, "pending" | "claimed">,
    error?: unknown,
    leaseToken?: string,
  ) {
    await this.client.execute({
      sql: `UPDATE support_dispatch SET state = ?, lease_until = NULL, lease_token = NULL, last_error = ?, updated_at = ? WHERE id = ?${leaseToken ? " AND lease_token = ?" : ""}`,
      args: leaseToken
        ? [state, error ? String(error) : null, now(), id, leaseToken]
        : [state, error ? String(error) : null, now(), id],
    });
  }
  async markDispatchStarted(caseId: string, leaseToken?: string) {
    await this.ensured();
    await this.client.execute({
      sql: `UPDATE support_dispatch SET state = 'started', updated_at = ? WHERE case_id = ? AND state = 'claimed'${leaseToken ? " AND lease_token = ?" : ""}`,
      args: leaseToken ? [now(), caseId, leaseToken] : [now(), caseId],
    });
  }
  /** Acquire the same durable lease used by recovery before a normal ingest starts. */
  async claimDispatchForStart(
    caseId: string,
  ): Promise<DispatchRecord | undefined> {
    await this.ensured();
    const claimedAt = now();
    const leaseUntil = new Date(Date.now() + 30_000).toISOString();
    const row = await this.client.execute({
      sql: "SELECT * FROM support_dispatch WHERE case_id = ? AND state = 'pending'",
      args: [caseId],
    });
    if (!row.rows[0]) return undefined;
    const leaseToken = crypto.randomUUID();
    const update = await this.client.execute({
      sql: "UPDATE support_dispatch SET state = 'claimed', attempts = attempts + 1, lease_until = ?, lease_token = ?, updated_at = ? WHERE case_id = ? AND state = 'pending'",
      args: [leaseUntil, leaseToken, claimedAt, caseId],
    });
    if (Number(update.rowsAffected) !== 1) return undefined;
    const current = row.rows[0] as Record<string, unknown>;
    return {
      id: String(current.id),
      caseId,
      runId: String(current.run_id),
      state: "claimed",
      attempts: Number(current.attempts) + 1,
      wasStarted: false,
      leaseToken,
    };
  }
  /** Approval resume reacquires the dispatch lease so recovery and an API call
   * cannot both advance the suspended workflow. */
  async claimDispatchForResume(
    caseId: string,
    runId?: string,
  ): Promise<DispatchRecord | undefined> {
    await this.ensured();
    const claimedAt = now();
    const leaseToken = crypto.randomUUID();
    const row = await this.client.execute({
      sql: "SELECT * FROM support_dispatch WHERE case_id = ? AND state = 'suspended'",
      args: [caseId],
    });
    if (!row.rows[0]) {
      // Phase 001 and direct Studio workflow runs may have a durable case/run
      // but predate the dispatch table.  The caller has already verified a
      // waiting case and run id; backfill a suspended intent before claiming.
      if (!runId) return undefined;
      try {
        await this.client.execute({
          sql: "INSERT INTO support_dispatch(id, case_id, run_id, state, attempts, created_at, updated_at) VALUES (?, ?, ?, 'suspended', 0, ?, ?)",
          args: [
            `dispatch_resume_${caseId}`,
            caseId,
            runId,
            claimedAt,
            claimedAt,
          ],
        });
      } catch (error) {
        if (!String(error).includes("UNIQUE")) throw error;
      }
      return this.claimDispatchForResume(caseId, runId);
    }
    const update = await this.client.execute({
      sql: "UPDATE support_dispatch SET state = 'claimed', lease_until = ?, lease_token = ?, updated_at = ? WHERE case_id = ? AND state = 'suspended'",
      args: [
        new Date(Date.now() + 30_000).toISOString(),
        leaseToken,
        claimedAt,
        caseId,
      ],
    });
    if (Number(update.rowsAffected) !== 1) return undefined;
    const current = row.rows[0] as Record<string, unknown>;
    return {
      id: String(current.id),
      caseId,
      runId: String(current.run_id),
      state: "claimed",
      attempts: Number(current.attempts),
      wasStarted: true,
      leaseToken,
    };
  }
  async claimOutbox(limit = 10) {
    await this.ensured();
    const claimedAt = now();
    const exhausted = await this.client.execute({
      sql: "SELECT case_id FROM support_outbox WHERE state = 'claimed' AND lease_until < ? AND attempts >= 3",
      args: [claimedAt],
    });
    await this.client.execute({
      sql: "UPDATE support_outbox SET state = 'failed', lease_until = NULL, lease_token = NULL, last_error = COALESCE(last_error, 'Delivery lease exhausted after three attempts.'), updated_at = ? WHERE state = 'claimed' AND lease_until < ? AND attempts >= 3",
      args: [claimedAt, claimedAt],
    });
    for (const row of exhausted.rows) {
      const current = await this.get(String(row.case_id));
      if (current)
        await this.update(current.id, {
          metadata: {
            ...current.metadata,
            deliveryStatus: "failed",
            deliveryError: "Delivery lease exhausted after three attempts.",
          },
        });
    }
    const leaseUntil = new Date(Date.now() + 30_000).toISOString();
    const rows = await this.client.execute({
      sql: "SELECT * FROM support_outbox WHERE (state = 'pending' OR (state = 'claimed' AND lease_until < ?)) AND attempts < 3 ORDER BY created_at LIMIT ?",
      args: [claimedAt, limit],
    });
    const claimed: OutboxRecord[] = [];
    for (const row of rows.rows) {
      const leaseToken = crypto.randomUUID();
      const changed = await this.client.execute({
        sql: "UPDATE support_outbox SET state = 'claimed', attempts = attempts + 1, lease_until = ?, lease_token = ?, updated_at = ? WHERE id = ? AND (state = 'pending' OR (state = 'claimed' AND lease_until < ?))",
        args: [leaseUntil, leaseToken, claimedAt, String(row.id), claimedAt],
      });
      if (Number(changed.rowsAffected) === 1)
        claimed.push({
          ...this.outbox(row as Record<string, unknown>, "claimed"),
          attempts: Number(row.attempts) + 1,
          leaseToken,
        });
    }
    return claimed;
  }
  async renewOutboxLease(id: string, leaseToken: string) {
    await this.ensured();
    const updated = await this.client.execute({
      sql: "UPDATE support_outbox SET lease_until = ?, updated_at = ? WHERE id = ? AND lease_token = ? AND state = 'claimed'",
      args: [
        new Date(Date.now() + 30_000).toISOString(),
        now(),
        id,
        leaseToken,
      ],
    });
    return Number(updated.rowsAffected) === 1;
  }
  async completeOutbox(id: string, receipt: unknown, leaseToken?: string) {
    await this.client.execute({
      sql: `UPDATE support_outbox SET state = 'delivered', receipt = ?, lease_until = NULL, lease_token = NULL, updated_at = ? WHERE id = ?${leaseToken ? " AND lease_token = ?" : ""}`,
      args: leaseToken
        ? [JSON.stringify(receipt), now(), id, leaseToken]
        : [JSON.stringify(receipt), now(), id],
    });
  }
  async retryOutbox(
    id: string,
    error: unknown,
    terminal = false,
    leaseToken?: string,
  ) {
    await this.client.execute({
      sql: `UPDATE support_outbox SET state = ?, last_error = ?, lease_until = NULL, lease_token = NULL, updated_at = ? WHERE id = ?${leaseToken ? " AND lease_token = ?" : ""}`,
      args: leaseToken
        ? [
            terminal ? "failed" : "pending",
            String(error),
            now(),
            id,
            leaseToken,
          ]
        : [terminal ? "failed" : "pending", String(error), now(), id],
    });
    if (terminal) {
      const outbox = await this.client.execute({
        sql: "SELECT case_id FROM support_outbox WHERE id = ?",
        args: [id],
      });
      const caseId = outbox.rows[0]
        ? String(outbox.rows[0].case_id)
        : undefined;
      const current = caseId ? await this.get(caseId) : undefined;
      if (current)
        await this.update(current.id, {
          metadata: {
            ...current.metadata,
            deliveryStatus: "failed",
            deliveryError: String(error),
          },
        });
    }
  }
  private outbox(
    row: Record<string, unknown>,
    state: OutboxState,
  ): OutboxRecord {
    return {
      id: String(row.id),
      caseId: String(row.case_id),
      binding: JSON.parse(String(row.binding)),
      body: String(row.body),
      status: String(row.status),
      state,
      attempts: Number(row.attempts) + 1,
      receipt: row.receipt ? JSON.parse(String(row.receipt)) : undefined,
      lastError: row.last_error ? String(row.last_error) : undefined,
      leaseToken: row.lease_token ? String(row.lease_token) : undefined,
    };
  }
  async saveAction(
    caseId: string,
    kind: string,
    fingerprint: string,
    data: unknown,
  ) {
    await this.ensured();
    await this.client.execute({
      sql: "INSERT OR IGNORE INTO support_actions(id, case_id, kind, fingerprint, data, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      args: [
        `action_${crypto.randomUUID()}`,
        caseId,
        kind,
        fingerprint,
        JSON.stringify(data),
        now(),
      ],
    });
  }
  async getAction(caseId: string, kind: string, fingerprint: string) {
    await this.ensured();
    const result = await this.client.execute({
      sql: "SELECT data FROM support_actions WHERE case_id = ? AND kind = ? AND fingerprint = ?",
      args: [caseId, kind, fingerprint],
    });
    return result.rows[0] ? JSON.parse(String(result.rows[0].data)) : undefined;
  }
  async idempotency(key: string) {
    await this.ensured();
    const result = await this.client.execute({
      sql: "SELECT fingerprint, effect FROM support_idempotency WHERE idempotency_key = ?",
      args: [key],
    });
    return result.rows[0]
      ? {
          fingerprint: String(result.rows[0].fingerprint),
          effect: JSON.parse(String(result.rows[0].effect)),
        }
      : undefined;
  }
  async recordEffect(key: string, fingerprint: string, effect: unknown) {
    await this.ensured();
    await this.client.execute({
      sql: "INSERT INTO support_idempotency(idempotency_key, fingerprint, effect, created_at) VALUES (?, ?, ?, ?)",
      args: [key, fingerprint, JSON.stringify(effect), now()],
    });
  }
  getClientForTests() {
    return this.client;
  }
}
export const caseStore = new CaseStore();
