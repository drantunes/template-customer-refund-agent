import { createClient, type Client } from "@libsql/client";
import { createHash } from "node:crypto";
import type { CaseMessage, SupportCase } from "../domain/support-case";
import {
  bindingsForCase,
  sameBinding,
  type ProviderBinding,
} from "../providers/contracts";
import { waitForMastraStorage } from "../runtime/storage-lifecycle";
import {
  getSharedLocalSqliteClient,
  serializeSqliteClient,
} from "./sqlite-client";
import { activeDispatchLeaseScope } from "./dispatch-lease-scope";
import type { DispatchLeaseScope } from "./dispatch-lease-scope";

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
  /** Immutable inbound turn this workflow run owns. */
  turnId: string;
  runId: string;
  state: DispatchState;
  attempts: number;
  /** Whether this dispatch had already crossed the durable start boundary. */
  wasStarted: boolean;
  leaseToken?: string;
}
export interface SupportTurnRecord {
  id: string;
  eventId: string;
  sequence: number;
  state: string;
  runId?: string;
  commandFingerprint?: string;
  message?: CaseMessage;
  outcome?: Record<string, unknown>;
}
export const retentionDefaults = {
  rawPayloadDays: 7,
  caseDays: 90,
  traceDays: 30,
  financialAuditDays: 365,
} as const;
export interface RetentionPolicy {
  rawPayloadDays: number;
  caseDays: number;
  traceDays: number;
  financialAuditDays: number;
}
export function retentionPolicyFromEnvironment(): RetentionPolicy {
  const bounded = (name: string, fallback: number, maximum: number) => {
    const raw = process.env[name];
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > maximum)
      throw new Error(`${name} must be an integer from 1 through ${maximum}.`);
    return value;
  };
  return {
    rawPayloadDays: bounded(
      "SUPPORT_RETENTION_RAW_PAYLOAD_DAYS",
      retentionDefaults.rawPayloadDays,
      retentionDefaults.rawPayloadDays,
    ),
    caseDays: bounded(
      "SUPPORT_RETENTION_CASE_DAYS",
      retentionDefaults.caseDays,
      retentionDefaults.caseDays,
    ),
    traceDays: bounded(
      "SUPPORT_RETENTION_TRACE_DAYS",
      retentionDefaults.traceDays,
      retentionDefaults.traceDays,
    ),
    financialAuditDays: bounded(
      "SUPPORT_RETENTION_FINANCIAL_AUDIT_DAYS",
      retentionDefaults.financialAuditDays,
      retentionDefaults.financialAuditDays,
    ),
  };
}
export interface RetentionResult {
  rawPayloadsRedacted: number;
  casesRedacted: number;
  tracesRedacted: number;
  auditsDeleted: number;
  messagesDeleted: number;
  turnsRedacted: number;
  outboxRecordsRedacted: number;
  dispatchesExpired: number;
  decisionsRedacted: number;
  actionsRedacted: number;
  auditPayloadsRedacted: number;
  financialReasonsRedacted: number;
  mastraMessagesDeleted: number;
  mastraSpansDeleted: number;
  /** Pending cases older than the case window are closed without an effect. */
  pendingCasesExpired: number;
  /** Inbound snapshots are enumerated by their real storage name and age. */
  rawWorkflowSnapshotBefore: string;
  /** Expired app cases identify native snapshots even before a decision exists. */
  expiredCaseIds: string[];
  /** Mastra workflow runs whose snapshots can be removed after case redaction. */
  expiredWorkflowRunIds: string[];
}
export class StaleCaseWriteError extends Error {
  constructor(id: string) {
    super(`Stale case write rejected for ${id}.`);
  }
}

function config(url = process.env.TURSO_DATABASE_URL || "file:./mastra.db") {
  return {
    url,
    authToken: process.env.TURSO_AUTH_TOKEN || undefined,
    ...(url.startsWith("file:") || url.includes(":memory:")
      ? { timeout: 0 }
      : {}),
  };
}
function now() {
  return new Date().toISOString();
}

// Production workers always lease a dispatch for 30 seconds. The narrowly
// test-only override lets integration coverage cross that boundary without
// changing the deployed lifetime.
function dispatchLeaseDurationMs() {
  if (process.env.NODE_ENV !== "test") return 30_000;
  const configured = Number(process.env.SUPPORT_TEST_DISPATCH_LEASE_MS);
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : 30_000;
}

function dispatchLeaseUntil() {
  return new Date(Date.now() + dispatchLeaseDurationMs()).toISOString();
}
function parse(row: Record<string, unknown>): SupportCase {
  return JSON.parse(String(row.data)) as SupportCase;
}
function scopedEventId(binding: ProviderBinding, eventId: string) {
  // `support_events.id` is the physical primary key as well as the logical
  // event key.  Qualify it too: the logical uniqueness constraint is scoped,
  // and a global physical id must not reintroduce the old collision.
  return `event_${createHash("sha256")
    .update(
      JSON.stringify([binding.tenantId, binding.providerAccountId, eventId]),
    )
    .digest("hex")}`;
}

export function isRetentionTombstone(supportCase: SupportCase) {
  return (
    (supportCase.metadata as Record<string, unknown>).retentionRedactedAt !==
    undefined
  );
}

/** App-owned migrations never enumerate, rename, or drop Mastra-owned tables. */
export class CaseStore {
  private readonly client: Client;
  private readonly ownsClient: boolean;
  private ready?: Promise<void>;
  constructor(options: { client?: Client; url?: string } = {}) {
    if (options.client) {
      this.client = serializeSqliteClient(options.client);
      this.ownsClient = true;
    } else if (options.url) {
      this.client = serializeSqliteClient(createClient(config(options.url)));
      this.ownsClient = true;
    } else {
      this.client = getSharedLocalSqliteClient();
      // Mastra owns the shared client lifecycle and closes it during shutdown.
      this.ownsClient = false;
    }
  }
  async close() {
    if (this.ownsClient) this.client.close();
  }
  async migrate(target = 9): Promise<void> {
    await this.client.execute(
      "CREATE TABLE IF NOT EXISTS support_schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
    );
    const applied = await this.client.execute(
      "SELECT version FROM support_schema_migrations ORDER BY version",
    );
    let version = Number(applied.rows.at(-1)?.version ?? 0);
    if (!Number.isInteger(target) || target < 0 || target > 9)
      throw new Error("Unsupported support schema target version.");
    // Versions 6 through 8 introduced append-only turn, decision, and audit
    // records. Their inverse would discard or weaken durable financial/replay
    // evidence, so refuse before changing any schema or migration marker.
    if (version >= 6 && target < version)
      throw new Error(
        `Refusing unsupported downgrade from support schema v${version} to v${target}.`,
      );
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
    if (version === 6) await this.up6();
    if (version === 7) await this.up7();
    if (version === 8) await this.up8();
    if (version === 9) {
      await this.up9();
      return;
    }
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
  /** Phase 003 audit records are append-only.  The current case projection is
   * useful for UI, but it is never the authority for a second decision. */
  private async up6() {
    await this.client.executeMultiple(`
      CREATE TABLE IF NOT EXISTS support_turns (
        id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(case_id, event_id),
        UNIQUE(case_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS support_decisions (
        id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL UNIQUE,
        command_fingerprint TEXT NOT NULL,
        native_run_id TEXT,
        native_tool_call_id TEXT,
        principal_id TEXT NOT NULL,
        approved INTEGER NOT NULL,
        note TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS support_audit (
        id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        actor_id TEXT,
        data TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }
  /** A case is a conversation, not a work item. Each inbound turn owns a
   * separate dispatch and may create its own immutable approval command. */
  private async up7() {
    const tx = await this.client.transaction("write");
    try {
      await tx
        .executeMultiple(
          `
        ALTER TABLE support_turns ADD COLUMN run_id TEXT;
        ALTER TABLE support_turns ADD COLUMN command_fingerprint TEXT;
      `,
        )
        .catch?.(() => undefined);
      // SQLite cannot drop the old case_id UNIQUE constraint in place.
      await tx.executeMultiple(`
        CREATE TABLE support_dispatch_v7 (
          id TEXT PRIMARY KEY,
          case_id TEXT NOT NULL,
          turn_id TEXT NOT NULL UNIQUE,
          run_id TEXT NOT NULL UNIQUE,
          state TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          lease_until TEXT,
          last_error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          lease_token TEXT
        );
        INSERT INTO support_dispatch_v7(id, case_id, turn_id, run_id, state, attempts, lease_until, last_error, created_at, updated_at, lease_token)
        SELECT id, case_id, 'legacy:' || case_id, run_id, state, attempts, lease_until, last_error, created_at, updated_at, lease_token FROM support_dispatch;
        DROP TABLE support_dispatch;
        ALTER TABLE support_dispatch_v7 RENAME TO support_dispatch;
        CREATE INDEX support_dispatch_claimable ON support_dispatch(state, created_at);
        CREATE INDEX support_dispatch_case_state ON support_dispatch(case_id, state, created_at);

        CREATE TABLE support_decisions_v7 (
          id TEXT PRIMARY KEY,
          case_id TEXT NOT NULL,
          turn_id TEXT NOT NULL,
          command_fingerprint TEXT NOT NULL,
          native_run_id TEXT,
          native_tool_call_id TEXT,
          principal_id TEXT NOT NULL,
          approved INTEGER NOT NULL,
          note TEXT,
          created_at TEXT NOT NULL,
          UNIQUE(case_id, turn_id, command_fingerprint)
        );
        INSERT INTO support_decisions_v7(id, case_id, turn_id, command_fingerprint, native_run_id, native_tool_call_id, principal_id, approved, note, created_at)
        SELECT id, case_id, 'legacy:' || case_id, command_fingerprint, native_run_id, native_tool_call_id, principal_id, approved, note, created_at FROM support_decisions;
        DROP TABLE support_decisions;
        ALTER TABLE support_decisions_v7 RENAME TO support_decisions;
        CREATE INDEX support_decisions_command ON support_decisions(case_id, command_fingerprint);
      `);
      await tx.commit();
    } catch (error) {
      try {
        await tx.rollback();
      } catch {}
      throw error;
    }
  }
  /** Per-turn inputs and outputs are immutable history. The case remains only
   * the current active-turn projection used by the UI. */
  private async up8() {
    for (const sql of [
      "ALTER TABLE support_turns ADD COLUMN message_data TEXT",
      "ALTER TABLE support_turns ADD COLUMN outcome_data TEXT",
    ]) {
      try {
        await this.client.execute(sql);
      } catch (error) {
        if (!String(error).includes("duplicate column")) throw error;
      }
    }
    const rows = await this.client.execute(
      "SELECT support_turns.id, support_turns.case_id, support_turns.sequence, support_cases.data FROM support_turns JOIN support_cases ON support_cases.id = support_turns.case_id WHERE support_turns.message_data IS NULL",
    );
    for (const row of rows.rows) {
      const value = row as Record<string, unknown>;
      const supportCase = parse({ data: value.data });
      const message = supportCase.messages.filter(
        (entry) => entry.author === "customer",
      )[Math.max(0, Number(value.sequence) - 1)];
      if (message)
        await this.client.execute({
          sql: "UPDATE support_turns SET message_data = ? WHERE id = ?",
          args: [JSON.stringify(message), String(value.id)],
        });
    }
  }
  /** Canonical conversation identity and trusted acceptance time are persisted
   * independently of provider-supplied event timestamps.  Historical conflicts
   * must be resolved by an operator, never guessed and merged by a migration. */
  private async up9() {
    const nowAtMigration = now();
    const tx = await this.client.transaction("write");
    try {
      try {
        await tx.execute(
          "ALTER TABLE support_cases ADD COLUMN accepted_at TEXT",
        );
      } catch (error) {
        if (!String(error).includes("duplicate column")) throw error;
      }
      await tx.executeMultiple(`
        CREATE TABLE IF NOT EXISTS support_conversations (
          tenant_id TEXT NOT NULL,
          provider_kind TEXT NOT NULL,
          provider_account_id TEXT NOT NULL,
          external_conversation_id TEXT NOT NULL,
          case_id TEXT NOT NULL UNIQUE,
          owner_id TEXT NOT NULL,
          PRIMARY KEY(tenant_id, provider_kind, provider_account_id, external_conversation_id)
        );
      `);
      const cases = await tx.execute(
        "SELECT id, data, created_at, accepted_at FROM support_cases",
      );
      for (const row of cases.rows) {
        const value = row as Record<string, unknown>;
        const supportCase = parse(value);
        const binding = this.binding(supportCase);
        const storedOwner = (supportCase.metadata as Record<string, unknown>)
          .ownerId;
        const ownerId =
          typeof storedOwner === "string" && storedOwner
            ? storedOwner
            : `legacy:${createHash("sha256").update(String(value.id)).digest("hex")}`;
        const existing = await tx.execute({
          sql: "SELECT case_id, owner_id FROM support_conversations WHERE tenant_id = ? AND provider_kind = ? AND provider_account_id = ? AND external_conversation_id = ?",
          args: [
            binding.tenantId,
            binding.providerKind,
            binding.providerAccountId,
            binding.externalConversationId,
          ],
        });
        if (
          existing.rows[0] &&
          (String(existing.rows[0].case_id) !== String(value.id) ||
            String(existing.rows[0].owner_id) !== ownerId)
        )
          throw new Error(
            `Refusing canonical conversation migration: ambiguous historical conversation ${binding.tenantId}/${binding.providerAccountId}/${binding.externalConversationId}.`,
          );
        await tx.execute({
          sql: "INSERT OR IGNORE INTO support_conversations(tenant_id, provider_kind, provider_account_id, external_conversation_id, case_id, owner_id) VALUES (?, ?, ?, ?, ?, ?)",
          args: [
            binding.tenantId,
            binding.providerKind,
            binding.providerAccountId,
            binding.externalConversationId,
            String(value.id),
            ownerId,
          ],
        });
        const evidence = await tx.execute({
          sql: "SELECT accepted_at FROM support_events WHERE case_id = ? ORDER BY accepted_at LIMIT 1",
          args: [String(value.id)],
        });
        const candidate = String(
          evidence.rows[0]?.accepted_at ?? value.created_at,
        );
        const acceptedAt =
          Number.isNaN(Date.parse(candidate)) || candidate > nowAtMigration
            ? nowAtMigration
            : candidate;
        await tx.execute({
          sql: "UPDATE support_cases SET accepted_at = COALESCE(accepted_at, ?) WHERE id = ?",
          args: [acceptedAt, String(value.id)],
        });
      }
      await tx.execute({
        sql: "INSERT INTO support_schema_migrations(version, applied_at) VALUES (9, ?)",
        args: [now()],
      });
      await tx.commit();
    } catch (error) {
      try {
        await tx.rollback();
      } catch {}
      throw error;
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
      // The injected Mastra client intentionally skips its internal local
      // pragmas, so set WAL only after its schema initialization has finished.
      await this.client.execute("PRAGMA journal_mode=WAL;");
      // Do not synchronously wait in SQLite for another Mastra connection: a
      // blocked native call can prevent that connection's pending commit from
      // running. serializeSqliteClient retries lock conflicts after yielding.
      await this.client.execute("PRAGMA busy_timeout = 0;");
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
  async findConversation(
    tenantId: string,
    externalConversationId: string,
  ): Promise<SupportCase | undefined> {
    await this.ensured();
    const result = await this.client.execute({
      sql: "SELECT c.data FROM support_conversations x JOIN support_cases c ON c.id = x.case_id WHERE x.tenant_id = ? AND x.provider_kind = 'local' AND x.provider_account_id = 'local-demo' AND x.external_conversation_id = ?",
      args: [tenantId, externalConversationId],
    });
    return result.rows[0]
      ? parse(result.rows[0] as Record<string, unknown>)
      : undefined;
  }
  async create(case_: SupportCase) {
    await this.ensured();
    const persisted = this.withBindings(case_);
    const binding = this.binding(persisted);
    const tx = await this.client.transaction("write");
    try {
      await tx.execute({
        sql: "INSERT INTO support_cases(id, source, external_id, data, created_at, updated_at, version, tenant_id, provider_account_id, provider_binding, accepted_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)",
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
          persisted.createdAt,
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
      const lease = activeDispatchLeaseScope();
      if (lease) {
        if (lease.caseId !== id)
          throw new Error(
            "Workflow dispatch scope cannot project another case.",
          );
        const owned = await tx.execute({
          sql: "SELECT id FROM support_dispatch WHERE id = ? AND case_id = ? AND turn_id = ? AND lease_token = ? AND state IN ('claimed', 'started') AND lease_until > ?",
          args: [
            lease.dispatchId,
            lease.caseId,
            lease.turnId,
            lease.leaseToken,
            now(),
          ],
        });
        if (!owned.rows[0])
          throw new StaleCaseWriteError(
            `Dispatch lease is no longer current for ${id}.`,
          );
      }
      const version = Number(row.version ?? 1);
      if (expectedVersion !== undefined && expectedVersion !== version)
        throw new StaleCaseWriteError(id);
      const current = parse(row as Record<string, unknown>);
      if (isRetentionTombstone(current))
        throw new Error("Expired support case is a retention tombstone.");
      const updated = this.withBindings({
        ...current,
        ...patch,
        updatedAt: now(),
      } as SupportCase);
      this.assertBindingsUnchanged(current, updated);
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
        if (isRetentionTombstone(current))
          throw new Error("Expired support case is a retention tombstone.");
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
  /** Append a follow-up to the canonical conversation.  A unique inbound
   * event gets one ordered turn; a duplicate returns false without changing
   * messages, approvals or dispatch state. */
  async appendFollowUp(input: {
    caseId: string;
    eventId: string;
    message: CaseMessage;
    runId: string;
    /** Set only by authenticated ingress after owner verification. */
    expectedOwnerId?: string;
  }): Promise<{
    appended: boolean;
    supportCase: SupportCase;
    turnId?: string;
  }> {
    await this.ensured();
    const tx = await this.client.transaction("write");
    try {
      const read = await tx.execute({
        sql: "SELECT data, version FROM support_cases WHERE id = ?",
        args: [input.caseId],
      });
      const row = read.rows[0];
      if (!row) throw new Error(`Support case not found: ${input.caseId}`);
      const current = parse(row as Record<string, unknown>);
      if (isRetentionTombstone(current))
        throw new Error("Expired support case is a retention tombstone.");
      if (input.expectedOwnerId) {
        const binding = this.binding(current);
        const canonical = await tx.execute({
          sql: "SELECT owner_id FROM support_conversations WHERE tenant_id = ? AND provider_kind = ? AND provider_account_id = ? AND external_conversation_id = ? AND case_id = ?",
          args: [
            binding.tenantId,
            binding.providerKind,
            binding.providerAccountId,
            binding.externalConversationId,
            input.caseId,
          ],
        });
        if (
          !canonical.rows[0] ||
          String(canonical.rows[0].owner_id) !== input.expectedOwnerId
        )
          throw new Error(
            "Inbound conversation is owned by another principal.",
          );
      }
      const seen = await tx.execute({
        sql: "SELECT id FROM support_turns WHERE case_id = ? AND event_id = ?",
        args: [input.caseId, input.eventId],
      });
      if (seen.rows[0]) {
        await tx.rollback();
        return { appended: false, supportCase: current };
      }
      const next = await tx.execute({
        sql: "SELECT COALESCE(MAX(sequence), 0) + 1 AS value FROM support_turns WHERE case_id = ?",
        args: [input.caseId],
      });
      const sequence = Number(next.rows[0]?.value ?? 1);
      const turnId = `turn_${crypto.randomUUID()}`;
      const invalidatesApproval = current.status === "waiting_approval";
      const terminal =
        current.status === "resolved" || current.status === "escalated";
      const activeTurnId = (current.metadata as Record<string, unknown>)
        .activeTurnId;
      if (
        (invalidatesApproval || terminal) &&
        typeof activeTurnId === "string"
      ) {
        await tx.execute({
          sql: "UPDATE support_turns SET outcome_data = COALESCE(outcome_data, ?), updated_at = ? WHERE id = ? AND case_id = ?",
          args: [
            JSON.stringify({
              status: current.status,
              triage: current.triage,
              policyMatches: current.policyMatches,
              orderLookup: current.orderLookup,
              subscriptionLookup: current.subscriptionLookup,
              refundHistory: current.refundHistory,
              draft: current.draft,
              approval: current.approval,
              refundResult: current.refundResult,
              finalResponse: current.finalResponse,
              escalationReason: current.escalationReason,
              workflowRunId: current.workflowRunId,
            }),
            now(),
            activeTurnId,
            input.caseId,
          ],
        });
      }
      const resetProjection = invalidatesApproval || terminal;
      const updated: SupportCase = {
        ...current,
        messages: current.messages.some(
          (message) => message.id === input.message.id,
        )
          ? current.messages
          : [...current.messages, input.message],
        // A pending turn never takes ownership away from a running dispatch.
        // The scheduler activates it only after the prior turn is terminal.
        status: resetProjection ? "new" : current.status,
        triage: resetProjection ? undefined : current.triage,
        policyMatches: resetProjection ? undefined : current.policyMatches,
        orderLookup: resetProjection ? undefined : current.orderLookup,
        subscriptionLookup: resetProjection
          ? undefined
          : current.subscriptionLookup,
        refundHistory: resetProjection ? undefined : current.refundHistory,
        draft: resetProjection ? undefined : current.draft,
        approval: resetProjection ? undefined : current.approval,
        refundResult: resetProjection ? undefined : current.refundResult,
        finalResponse: resetProjection ? undefined : current.finalResponse,
        escalationReason: resetProjection
          ? undefined
          : current.escalationReason,
        workflowRunId: resetProjection ? undefined : current.workflowRunId,
        traceId: resetProjection ? undefined : current.traceId,
        agentUsage: resetProjection ? undefined : current.agentUsage,
        updatedAt: now(),
        metadata: {
          ...current.metadata,
          pendingApprovalInvalidatedAt: invalidatesApproval
            ? now()
            : current.metadata.pendingApprovalInvalidatedAt,
          pendingTurnId: turnId,
          ...(resetProjection
            ? {
                activeTurnId: undefined,
                refundCommand: undefined,
                nativeApproval: undefined,
                refundEffects: undefined,
              }
            : {}),
        },
      };
      await tx.execute({
        sql: "INSERT INTO support_turns(id, case_id, event_id, sequence, state, created_at, updated_at, run_id, message_data) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)",
        args: [
          turnId,
          input.caseId,
          input.eventId,
          sequence,
          now(),
          now(),
          input.runId,
          JSON.stringify(input.message),
        ],
      });
      const binding = this.binding(current);
      await tx.execute({
        sql: "INSERT INTO support_events(id, tenant_id, provider_account_id, source, external_id, case_id, accepted_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        args: [
          scopedEventId(binding, input.eventId),
          binding.tenantId,
          binding.providerAccountId,
          current.source,
          input.eventId,
          input.caseId,
          now(),
        ],
      });
      await tx.execute({
        sql: "INSERT OR IGNORE INTO support_messages(id, case_id, data, created_at) VALUES (?, ?, ?, ?)",
        args: [
          input.message.id,
          input.caseId,
          JSON.stringify(input.message),
          input.message.createdAt,
        ],
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
      if (invalidatesApproval)
        await tx.execute({
          sql: "INSERT INTO support_audit(id, case_id, kind, data, created_at) VALUES (?, ?, 'approval-invalidated-follow-up', ?, ?)",
          args: [
            `audit_${crypto.randomUUID()}`,
            input.caseId,
            JSON.stringify({ eventId: input.eventId }),
            now(),
          ],
        });
      if (invalidatesApproval)
        await tx.execute({
          sql: "UPDATE support_dispatch SET state = 'completed', lease_until = NULL, lease_token = NULL, updated_at = ? WHERE case_id = ? AND state = 'suspended'",
          args: [now(), input.caseId],
        });
      await tx.execute({
        sql: "INSERT INTO support_dispatch(id, case_id, turn_id, run_id, state, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)",
        args: [
          `dispatch_${turnId}`,
          input.caseId,
          turnId,
          input.runId,
          now(),
          now(),
        ],
      });
      await tx.commit();
      return { appended: true, supportCase: updated, turnId };
    } catch (error) {
      try {
        await tx.rollback();
      } catch {}
      throw error;
    }
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
    const initialTurnId = `turn_${crypto.randomUUID()}`;
    const persisted = this.withBindings({
      ...case_,
      metadata: { ...case_.metadata, activeTurnId: initialTurnId },
    });
    const binding = this.binding(persisted);
    const storageEventId = scopedEventId(binding, eventId);
    const storedOwner = (persisted.metadata as Record<string, unknown>).ownerId;
    const ownerId =
      typeof storedOwner === "string" && storedOwner ? storedOwner : undefined;
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
        if (ownerId) {
          const winner = await tx.execute({
            sql: "SELECT owner_id FROM support_conversations WHERE case_id = ?",
            args: [String(exists.rows[0].case_id)],
          });
          if (!winner.rows[0] || String(winner.rows[0].owner_id) !== ownerId)
            throw new Error(
              "Inbound conversation is owned by another principal.",
            );
        }
        await tx.rollback();
        return { caseId: String(exists.rows[0].case_id), isNew: false };
      }
      const canonical = ownerId
        ? await tx.execute({
            sql: "SELECT case_id, owner_id FROM support_conversations WHERE tenant_id = ? AND provider_kind = ? AND provider_account_id = ? AND external_conversation_id = ?",
            args: [
              binding.tenantId,
              binding.providerKind,
              binding.providerAccountId,
              binding.externalConversationId,
            ],
          })
        : { rows: [] };
      if (canonical.rows[0]) {
        const caseId = String(canonical.rows[0].case_id);
        if (String(canonical.rows[0].owner_id) !== ownerId)
          throw new Error(
            "Inbound conversation is owned by another principal.",
          );
        const existingCase = await tx.execute({
          sql: "SELECT data FROM support_cases WHERE id = ?",
          args: [caseId],
        });
        const existing = existingCase.rows[0]
          ? parse(existingCase.rows[0] as Record<string, unknown>)
          : undefined;
        if (!existing)
          throw new Error("Canonical conversation points to a missing case.");
        if (isRetentionTombstone(existing))
          throw new Error("Expired support case is a retention tombstone.");
        await tx.rollback();
        return { caseId, isNew: true, appendRequired: true };
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
            storageEventId,
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
        sql: "INSERT INTO support_cases(id, source, external_id, data, created_at, updated_at, version, tenant_id, provider_account_id, provider_binding, accepted_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)",
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
          persisted.createdAt,
        ],
      });
      if (ownerId)
        await tx.execute({
          sql: "INSERT INTO support_conversations(tenant_id, provider_kind, provider_account_id, external_conversation_id, case_id, owner_id) VALUES (?, ?, ?, ?, ?, ?)",
          args: [
            binding.tenantId,
            binding.providerKind,
            binding.providerAccountId,
            binding.externalConversationId,
            persisted.id,
            ownerId,
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
          storageEventId,
          binding.tenantId,
          binding.providerAccountId,
          persisted.source,
          persisted.externalId,
          persisted.id,
          now(),
        ],
      });
      const initialMessage = persisted.messages.at(-1);
      if (!initialMessage)
        throw new Error("Inbound support case requires a customer message.");
      await tx.execute({
        sql: "INSERT INTO support_turns(id, case_id, event_id, sequence, state, created_at, updated_at, run_id, message_data) VALUES (?, ?, ?, 1, 'pending', ?, ?, ?, ?)",
        args: [
          initialTurnId,
          persisted.id,
          eventId,
          now(),
          now(),
          runId,
          JSON.stringify(initialMessage),
        ],
      });
      await tx.execute({
        sql: "INSERT INTO support_dispatch(id, case_id, turn_id, run_id, state, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)",
        args: [
          `dispatch_${storageEventId}`,
          persisted.id,
          initialTurnId,
          runId,
          now(),
          now(),
        ],
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
    turnId: string;
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
        (current.metadata as Record<string, unknown>).activeTurnId !==
        input.turnId
      )
        throw new StaleCaseWriteError(input.caseId);
      const lease = activeDispatchLeaseScope();
      if (lease) {
        if (lease.caseId !== input.caseId || lease.turnId !== input.turnId)
          throw new Error(
            "Workflow dispatch scope cannot finalize another turn.",
          );
        const owned = await tx.execute({
          sql: "SELECT id FROM support_dispatch WHERE id = ? AND case_id = ? AND turn_id = ? AND lease_token = ? AND state IN ('claimed', 'started') AND lease_until > ?",
          args: [
            lease.dispatchId,
            lease.caseId,
            lease.turnId,
            lease.leaseToken,
            now(),
          ],
        });
        if (!owned.rows[0])
          throw new StaleCaseWriteError(
            `Dispatch lease is no longer current for ${input.caseId}.`,
          );
      }
      const priorOutcome = await tx.execute({
        sql: "SELECT outcome_data FROM support_turns WHERE id = ? AND case_id = ?",
        args: [input.turnId, input.caseId],
      });
      const existingOutcome = priorOutcome.rows[0]?.outcome_data
        ? (JSON.parse(String(priorOutcome.rows[0].outcome_data)) as {
            finalResponse?: string;
            status?: string;
            [key: string]: unknown;
          })
        : undefined;
      // Telemetry is attached before terminalization.  It is not itself a
      // terminal outcome, so only a prior final response can participate in
      // replay-conflict detection.
      if (existingOutcome?.finalResponse !== undefined) {
        const outcome = existingOutcome;
        if (
          outcome.finalResponse !== input.finalResponse ||
          outcome.status !== input.status
        )
          throw new Error(
            "Conflicting replay attempted to finalize a support turn.",
          );
      }
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
      await tx.execute({
        sql: "UPDATE support_turns SET state = ?, outcome_data = ?, updated_at = ? WHERE id = ? AND case_id = ?",
        args: [
          input.status,
          JSON.stringify({
            ...existingOutcome,
            status: input.status,
            finalResponse: input.finalResponse,
            escalationReason: input.escalationReason,
            approval: updated.approval,
            refundResult: updated.refundResult,
            draft: updated.draft,
          }),
          now(),
          input.turnId,
          input.caseId,
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
    for (const row of exhausted.rows) {
      const caseId = String(row.case_id);
      const tx = await this.client.transaction("write");
      try {
        const changed = await tx.execute({
          sql: "UPDATE support_dispatch SET state = 'failed', lease_until = NULL, lease_token = NULL, last_error = COALESCE(last_error, 'Dispatch lease exhausted after three attempts.'), updated_at = ? WHERE case_id = ? AND state IN ('claimed', 'started') AND lease_until < ? AND attempts >= 3",
          args: [claimedAt, caseId, claimedAt],
        });
        if (Number(changed.rowsAffected) === 1) {
          const caseRow = await tx.execute({
            sql: "SELECT data, version FROM support_cases WHERE id = ?",
            args: [caseId],
          });
          if (caseRow.rows[0]) {
            const current = parse(caseRow.rows[0] as Record<string, unknown>);
            if (current.status !== "waiting_approval") {
              const updated = this.withBindings({
                ...current,
                status: "failed" as const,
                escalationReason:
                  "Workflow recovery exhausted its durable lease attempts.",
                metadata: { ...current.metadata, workflowStatus: "failed" },
                updatedAt: now(),
              });
              const write = await tx.execute({
                sql: "UPDATE support_cases SET data = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?",
                args: [
                  JSON.stringify(updated),
                  updated.updatedAt,
                  caseId,
                  Number(caseRow.rows[0].version ?? 1),
                ],
              });
              if (Number(write.rowsAffected) !== 1)
                throw new StaleCaseWriteError(caseId);
            }
          }
        }
        await tx.commit();
      } catch (error) {
        try {
          await tx.rollback();
        } catch {}
        throw error;
      }
    }
    const leaseUntil = dispatchLeaseUntil();
    const rows = await this.client.execute({
      sql: "SELECT candidate.* FROM support_dispatch AS candidate JOIN support_turns AS candidate_turn ON candidate_turn.id = candidate.turn_id WHERE (candidate.state = 'pending' OR (candidate.state IN ('claimed', 'started') AND candidate.lease_until < ?)) AND candidate.attempts < 3 AND NOT EXISTS (SELECT 1 FROM support_dispatch AS active WHERE active.case_id = candidate.case_id AND active.id <> candidate.id AND active.state IN ('claimed', 'started', 'suspended')) AND NOT EXISTS (SELECT 1 FROM support_dispatch AS earlier JOIN support_turns AS earlier_turn ON earlier_turn.id = earlier.turn_id WHERE earlier.case_id = candidate.case_id AND earlier.state = 'pending' AND earlier_turn.sequence < candidate_turn.sequence) ORDER BY candidate.created_at, candidate_turn.sequence, candidate.id LIMIT ?",
      args: [claimedAt, limit],
    });
    const claimed: DispatchRecord[] = [];
    for (const row of rows.rows) {
      const leaseToken = crypto.randomUUID();
      const update = await this.client.execute({
        sql: "UPDATE support_dispatch AS candidate SET state = 'claimed', attempts = attempts + 1, lease_until = ?, lease_token = ?, updated_at = ? WHERE id = ? AND (state = 'pending' OR (state IN ('claimed', 'started') AND lease_until < ?)) AND NOT EXISTS (SELECT 1 FROM support_dispatch AS active WHERE active.case_id = candidate.case_id AND active.id <> candidate.id AND active.state IN ('claimed', 'started', 'suspended')) AND NOT EXISTS (SELECT 1 FROM support_dispatch AS earlier JOIN support_turns AS earlier_turn ON earlier_turn.id = earlier.turn_id JOIN support_turns AS candidate_turn ON candidate_turn.id = candidate.turn_id WHERE earlier.case_id = candidate.case_id AND earlier.state = 'pending' AND earlier_turn.sequence < candidate_turn.sequence)",
        args: [leaseUntil, leaseToken, claimedAt, String(row.id), claimedAt],
      });
      if (Number(update.rowsAffected) === 1)
        claimed.push({
          id: String(row.id),
          caseId: String(row.case_id),
          turnId: String(row.turn_id),
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
    const checkedAt = now();
    const updated = await this.client.execute({
      // Never let an old worker resurrect a lease after another worker can
      // legally reclaim it.  Renewal is a heartbeat, not a new claim.
      sql: "UPDATE support_dispatch SET lease_until = ?, updated_at = ? WHERE id = ? AND lease_token = ? AND state IN ('claimed', 'started') AND lease_until > ?",
      args: [dispatchLeaseUntil(), checkedAt, id, leaseToken, checkedAt],
    });
    return Number(updated.rowsAffected) === 1;
  }
  async hasDispatchLease(scope: DispatchLeaseScope) {
    await this.ensured();
    const result = await this.client.execute({
      sql: "SELECT id FROM support_dispatch WHERE id = ? AND case_id = ? AND turn_id = ? AND lease_token = ? AND state IN ('claimed', 'started') AND lease_until > ?",
      args: [
        scope.dispatchId,
        scope.caseId,
        scope.turnId,
        scope.leaseToken,
        now(),
      ],
    });
    return Boolean(result.rows[0]);
  }
  async completeDispatch(
    id: string,
    state: Exclude<DispatchState, "pending" | "claimed">,
    error?: unknown,
    leaseToken?: string,
  ) {
    await this.ensured();
    const tx = await this.client.transaction("write");
    try {
      const transitioned = await tx.execute({
        sql: `UPDATE support_dispatch SET state = ?, lease_until = NULL, lease_token = NULL, last_error = ?, updated_at = ? WHERE id = ?${leaseToken ? " AND lease_token = ? AND state IN ('claimed', 'started') AND lease_until > ?" : ""}`,
        args: leaseToken
          ? [state, error ? String(error) : null, now(), id, leaseToken, now()]
          : [state, error ? String(error) : null, now(), id],
      });
      // A stale worker must never overwrite the newer worker's turn outcome.
      if (Number(transitioned.rowsAffected) !== 1) {
        await tx.rollback();
        return false;
      }
      await tx.execute({
        sql: "UPDATE support_turns SET state = ?, updated_at = ? WHERE id = (SELECT turn_id FROM support_dispatch WHERE id = ?)",
        args: [state, now(), id],
      });
      await tx.commit();
      return true;
    } catch (error) {
      try {
        await tx.rollback();
      } catch {}
      throw error;
    }
  }
  /** Atomically project a fenced workflow failure to its dispatch and public
   * case.  Callers must not write the case first: a lease can change between
   * separate writes even when a heartbeat looked healthy moments earlier. */
  async failDispatchAndCase(
    id: string,
    caseId: string,
    error: unknown,
    leaseToken?: string,
  ) {
    await this.ensured();
    const tx = await this.client.transaction("write");
    try {
      const transitioned = await tx.execute({
        sql: `UPDATE support_dispatch SET state = 'failed', lease_until = NULL, lease_token = NULL, last_error = ?, updated_at = ? WHERE id = ? AND case_id = ? AND state IN ('claimed', 'started')${leaseToken ? " AND lease_token = ? AND lease_until > ?" : ""}`,
        args: leaseToken
          ? [String(error), now(), id, caseId, leaseToken, now()]
          : [String(error), now(), id, caseId],
      });
      if (Number(transitioned.rowsAffected) !== 1) {
        await tx.rollback();
        return false;
      }
      await tx.execute({
        sql: "UPDATE support_turns SET state = 'failed', outcome_data = COALESCE(outcome_data, ?), updated_at = ? WHERE id = (SELECT turn_id FROM support_dispatch WHERE id = ?) AND case_id = ?",
        args: [
          JSON.stringify({ status: "failed", escalationReason: String(error) }),
          now(),
          id,
          caseId,
        ],
      });
      const caseRow = await tx.execute({
        sql: "SELECT data, version FROM support_cases WHERE id = ?",
        args: [caseId],
      });
      if (caseRow.rows[0]) {
        const current = parse(caseRow.rows[0] as Record<string, unknown>);
        const updated = this.withBindings({
          ...current,
          status: "failed" as const,
          escalationReason: String(error),
          metadata: { ...current.metadata, workflowStatus: "failed" },
          updatedAt: now(),
        });
        const write = await tx.execute({
          sql: "UPDATE support_cases SET data = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?",
          args: [
            JSON.stringify(updated),
            updated.updatedAt,
            caseId,
            Number(caseRow.rows[0].version ?? 1),
          ],
        });
        if (Number(write.rowsAffected) !== 1)
          throw new StaleCaseWriteError(caseId);
      }
      await tx.commit();
      return true;
    } catch (error) {
      try {
        await tx.rollback();
      } catch {}
      throw error;
    }
  }
  async markDispatchStarted(dispatchId: string, leaseToken?: string) {
    await this.ensured();
    await this.client.execute({
      sql: `UPDATE support_dispatch SET state = 'started', updated_at = ? WHERE id = ? AND state = 'claimed'${leaseToken ? " AND lease_token = ?" : ""}`,
      args: leaseToken ? [now(), dispatchId, leaseToken] : [now(), dispatchId],
    });
    await this.client.execute({
      sql: "UPDATE support_turns SET state = 'processing', updated_at = ? WHERE id = (SELECT turn_id FROM support_dispatch WHERE id = ?)",
      args: [now(), dispatchId],
    });
  }
  /** The turn claim, public active projection, and started state change as one
   * transaction. A queued turn can never inherit a prior turn's identity. */
  async activateDispatch(dispatch: DispatchRecord) {
    if (!dispatch.leaseToken) return false;
    await this.ensured();
    const tx = await this.client.transaction("write");
    try {
      const started = await tx.execute({
        sql: "UPDATE support_dispatch SET state = 'started', updated_at = ? WHERE id = ? AND case_id = ? AND turn_id = ? AND state = 'claimed' AND lease_token = ?",
        args: [
          now(),
          dispatch.id,
          dispatch.caseId,
          dispatch.turnId,
          dispatch.leaseToken,
        ],
      });
      if (Number(started.rowsAffected) !== 1) {
        await tx.rollback();
        return false;
      }
      const row = await tx.execute({
        sql: "SELECT data, version FROM support_cases WHERE id = ?",
        args: [dispatch.caseId],
      });
      if (!row.rows[0])
        throw new Error(`Support case not found: ${dispatch.caseId}`);
      const current = parse(row.rows[0] as Record<string, unknown>);
      const previousTurnId = (current.metadata as Record<string, unknown>)
        .activeTurnId;
      const switchesTurn = previousTurnId !== dispatch.turnId;
      if (switchesTurn && typeof previousTurnId === "string")
        await tx.execute({
          sql: "UPDATE support_turns SET outcome_data = COALESCE(outcome_data, ?), updated_at = ? WHERE id = ? AND case_id = ?",
          args: [
            JSON.stringify({
              status: current.status,
              triage: current.triage,
              policyMatches: current.policyMatches,
              orderLookup: current.orderLookup,
              subscriptionLookup: current.subscriptionLookup,
              refundHistory: current.refundHistory,
              draft: current.draft,
              approval: current.approval,
              refundResult: current.refundResult,
              finalResponse: current.finalResponse,
              escalationReason: current.escalationReason,
              workflowRunId: current.workflowRunId,
            }),
            now(),
            previousTurnId,
            dispatch.caseId,
          ],
        });
      const updated = this.withBindings({
        ...current,
        status: "processing",
        triage: switchesTurn ? undefined : current.triage,
        policyMatches: switchesTurn ? undefined : current.policyMatches,
        orderLookup: switchesTurn ? undefined : current.orderLookup,
        subscriptionLookup: switchesTurn
          ? undefined
          : current.subscriptionLookup,
        refundHistory: switchesTurn ? undefined : current.refundHistory,
        draft: switchesTurn ? undefined : current.draft,
        approval: switchesTurn ? undefined : current.approval,
        refundResult: switchesTurn ? undefined : current.refundResult,
        finalResponse: switchesTurn ? undefined : current.finalResponse,
        escalationReason: switchesTurn ? undefined : current.escalationReason,
        traceId: switchesTurn ? undefined : current.traceId,
        agentUsage: switchesTurn ? undefined : current.agentUsage,
        workflowRunId: dispatch.runId,
        metadata: {
          ...current.metadata,
          activeTurnId: dispatch.turnId,
          pendingTurnId: undefined,
          ...(switchesTurn
            ? {
                refundCommand: undefined,
                nativeApproval: undefined,
                refundEffects: undefined,
              }
            : {}),
        },
        updatedAt: now(),
      });
      const written = await tx.execute({
        sql: "UPDATE support_cases SET data = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?",
        args: [
          JSON.stringify(updated),
          updated.updatedAt,
          dispatch.caseId,
          Number(row.rows[0].version ?? 1),
        ],
      });
      if (Number(written.rowsAffected) !== 1)
        throw new StaleCaseWriteError(dispatch.caseId);
      await tx.execute({
        sql: "UPDATE support_turns SET state = 'processing', updated_at = ? WHERE id = ? AND case_id = ?",
        args: [now(), dispatch.turnId, dispatch.caseId],
      });
      await tx.commit();
      return true;
    } catch (error) {
      try {
        await tx.rollback();
      } catch {}
      throw error;
    }
  }
  async turns(caseId: string): Promise<SupportTurnRecord[]> {
    await this.ensured();
    const rows = await this.client.execute({
      sql: "SELECT id, event_id, sequence, state, run_id, command_fingerprint, message_data, outcome_data FROM support_turns WHERE case_id = ? ORDER BY sequence",
      args: [caseId],
    });
    return rows.rows.map((row) => ({
      id: String(row.id),
      eventId: String(row.event_id),
      sequence: Number(row.sequence),
      state: String(row.state),
      runId: row.run_id ? String(row.run_id) : undefined,
      commandFingerprint: row.command_fingerprint
        ? String(row.command_fingerprint)
        : undefined,
      message: row.message_data
        ? (JSON.parse(String(row.message_data)) as CaseMessage)
        : undefined,
      outcome: row.outcome_data
        ? (JSON.parse(String(row.outcome_data)) as Record<string, unknown>)
        : undefined,
    }));
  }
  async turn(
    caseId: string,
    turnId: string,
  ): Promise<SupportTurnRecord | undefined> {
    return (await this.turns(caseId)).find((turn) => turn.id === turnId);
  }
  /** Immutable turn correlation survives later follow-up projections. */
  async recordTurnTelemetry(
    caseId: string,
    turnId: string,
    telemetry: { traceId?: string; workflowRunId?: string },
  ) {
    await this.ensured();
    const current = await this.turn(caseId, turnId);
    if (!current) throw new Error("Turn is missing for telemetry correlation.");
    await this.client.execute({
      sql: "UPDATE support_turns SET outcome_data = ?, updated_at = ? WHERE id = ? AND case_id = ?",
      args: [
        JSON.stringify({ ...current.outcome, telemetry }),
        now(),
        turnId,
        caseId,
      ],
    });
  }
  async bindTurnCommand(caseId: string, turnId: string, fingerprint: string) {
    await this.ensured();
    const changed = await this.client.execute({
      sql: "UPDATE support_turns SET command_fingerprint = ?, updated_at = ? WHERE id = ? AND case_id = ? AND (command_fingerprint IS NULL OR command_fingerprint = ?)",
      args: [fingerprint, now(), turnId, caseId, fingerprint],
    });
    if (Number(changed.rowsAffected) !== 1)
      throw new Error("Turn command is missing, already bound, or changed.");
  }
  /** Acquire the same durable lease used by recovery before a normal ingest starts. */
  async claimDispatchForStart(
    caseId: string,
    runId?: string,
  ): Promise<DispatchRecord | undefined> {
    await this.ensured();
    const claimedAt = now();
    const leaseUntil = dispatchLeaseUntil();
    const row = await this.client.execute({
      sql: "SELECT candidate.* FROM support_dispatch AS candidate JOIN support_turns AS candidate_turn ON candidate_turn.id = candidate.turn_id WHERE candidate.case_id = ? AND candidate.state = 'pending' AND (? IS NULL OR candidate.run_id = ?) AND NOT EXISTS (SELECT 1 FROM support_dispatch AS active WHERE active.case_id = candidate.case_id AND active.id <> candidate.id AND active.state IN ('claimed', 'started', 'suspended')) ORDER BY candidate_turn.sequence LIMIT 1",
      args: [caseId, runId ?? null, runId ?? null],
    });
    if (!row.rows[0]) return undefined;
    const leaseToken = crypto.randomUUID();
    const update = await this.client.execute({
      sql: "UPDATE support_dispatch AS candidate SET state = 'claimed', attempts = attempts + 1, lease_until = ?, lease_token = ?, updated_at = ? WHERE id = ? AND state = 'pending' AND NOT EXISTS (SELECT 1 FROM support_dispatch AS active WHERE active.case_id = candidate.case_id AND active.id <> candidate.id AND active.state IN ('claimed', 'started', 'suspended')) AND NOT EXISTS (SELECT 1 FROM support_dispatch AS earlier JOIN support_turns AS earlier_turn ON earlier_turn.id = earlier.turn_id JOIN support_turns AS candidate_turn ON candidate_turn.id = candidate.turn_id WHERE earlier.case_id = candidate.case_id AND earlier.state = 'pending' AND earlier_turn.sequence < candidate_turn.sequence)",
      args: [leaseUntil, leaseToken, claimedAt, String(row.rows[0].id)],
    });
    if (Number(update.rowsAffected) !== 1) return undefined;
    const current = row.rows[0] as Record<string, unknown>;
    return {
      id: String(current.id),
      caseId,
      turnId: String(current.turn_id),
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
    turnId?: string,
  ): Promise<DispatchRecord | undefined> {
    await this.ensured();
    const claimedAt = now();
    const leaseToken = crypto.randomUUID();
    const row = await this.client.execute({
      sql: "SELECT * FROM support_dispatch WHERE case_id = ? AND (state = 'suspended' OR (state = 'claimed' AND lease_until < ?)) AND (? IS NULL OR turn_id = ?) ORDER BY created_at LIMIT 1",
      args: [caseId, claimedAt, turnId ?? null, turnId ?? null],
    });
    if (!row.rows[0]) {
      // Phase 001 and direct Studio workflow runs may have a durable case/run
      // but predate the dispatch table.  The caller has already verified a
      // waiting case and run id; backfill a suspended intent before claiming.
      if (!runId) return undefined;
      try {
        await this.client.execute({
          sql: "INSERT INTO support_dispatch(id, case_id, turn_id, run_id, state, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, 'suspended', 0, ?, ?)",
          args: [
            `dispatch_resume_${caseId}`,
            caseId,
            turnId ?? `legacy:${caseId}`,
            runId,
            claimedAt,
            claimedAt,
          ],
        });
      } catch (error) {
        if (!String(error).includes("UNIQUE")) throw error;
      }
      // A raced worker may have created or advanced the row.  Do one bounded
      // reread rather than recursively trying to insert forever.
      const backfilled = await this.client.execute({
        sql: "SELECT * FROM support_dispatch WHERE case_id = ? AND state = 'suspended' AND (? IS NULL OR turn_id = ?) ORDER BY created_at LIMIT 1",
        args: [caseId, turnId ?? null, turnId ?? null],
      });
      if (!backfilled.rows[0]) return undefined;
      const update = await this.client.execute({
        sql: "UPDATE support_dispatch SET state = 'claimed', lease_until = ?, lease_token = ?, updated_at = ? WHERE id = ? AND case_id = ? AND turn_id = ? AND (state = 'suspended' OR (state = 'claimed' AND lease_until < ?))",
        args: [
          dispatchLeaseUntil(),
          leaseToken,
          claimedAt,
          String(backfilled.rows[0].id),
          caseId,
          turnId ?? `legacy:${caseId}`,
          claimedAt,
        ],
      });
      if (Number(update.rowsAffected) !== 1) return undefined;
      const current = backfilled.rows[0] as Record<string, unknown>;
      return {
        id: String(current.id),
        caseId,
        turnId: String(current.turn_id),
        runId: String(current.run_id),
        state: "claimed",
        attempts: Number(current.attempts),
        wasStarted: true,
        leaseToken,
      };
    }
    const update = await this.client.execute({
      sql: "UPDATE support_dispatch SET state = 'claimed', lease_until = ?, lease_token = ?, updated_at = ? WHERE id = ? AND case_id = ? AND turn_id = ? AND (state = 'suspended' OR (state = 'claimed' AND lease_until < ?))",
      args: [
        dispatchLeaseUntil(),
        leaseToken,
        claimedAt,
        String(row.rows[0].id),
        caseId,
        turnId ?? String(row.rows[0].turn_id),
        claimedAt,
      ],
    });
    if (Number(update.rowsAffected) !== 1) return undefined;
    const current = row.rows[0] as Record<string, unknown>;
    return {
      id: String(current.id),
      caseId,
      turnId: String(current.turn_id),
      runId: String(current.run_id),
      state: "claimed",
      attempts: Number(current.attempts),
      wasStarted: true,
      leaseToken,
    };
  }
  async claimOutbox(limit = 10, excludeIds: readonly string[] = []) {
    await this.ensured();
    const claimedAt = now();
    const exhausted = await this.client.execute({
      sql: "SELECT case_id FROM support_outbox WHERE state = 'claimed' AND lease_until < ? AND attempts >= 3",
      args: [claimedAt],
    });
    for (const row of exhausted.rows) {
      const caseId = String(row.case_id);
      const tx = await this.client.transaction("write");
      try {
        const changed = await tx.execute({
          sql: "UPDATE support_outbox SET state = 'failed', lease_until = NULL, lease_token = NULL, last_error = COALESCE(last_error, 'Delivery lease exhausted after three attempts.'), updated_at = ? WHERE case_id = ? AND state = 'claimed' AND lease_until < ? AND attempts >= 3",
          args: [claimedAt, caseId, claimedAt],
        });
        if (Number(changed.rowsAffected) === 1) {
          const caseRow = await tx.execute({
            sql: "SELECT data, version FROM support_cases WHERE id = ?",
            args: [caseId],
          });
          if (caseRow.rows[0]) {
            const current = parse(caseRow.rows[0] as Record<string, unknown>);
            const updated = this.withBindings({
              ...current,
              metadata: {
                ...current.metadata,
                deliveryStatus: "failed",
                deliveryError: "Delivery lease exhausted after three attempts.",
              },
              updatedAt: now(),
            });
            const write = await tx.execute({
              sql: "UPDATE support_cases SET data = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?",
              args: [
                JSON.stringify(updated),
                updated.updatedAt,
                caseId,
                Number(caseRow.rows[0].version ?? 1),
              ],
            });
            if (Number(write.rowsAffected) !== 1)
              throw new StaleCaseWriteError(caseId);
          }
        }
        await tx.commit();
      } catch (error) {
        try {
          await tx.rollback();
        } catch {}
        throw error;
      }
    }
    const leaseUntil = new Date(Date.now() + 30_000).toISOString();
    const excluded = excludeIds.length
      ? ` AND id NOT IN (${excludeIds.map(() => "?").join(", ")})`
      : "";
    const rows = await this.client.execute({
      sql: `SELECT * FROM support_outbox WHERE (state = 'pending' OR (state = 'claimed' AND lease_until < ?)) AND attempts < 3${excluded} ORDER BY created_at LIMIT ?`,
      args: [claimedAt, ...excludeIds, limit],
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
    await this.ensured();
    const tx = await this.client.transaction("write");
    try {
      // The terminal case projection is part of the same fenced transition as
      // the outbox row.  A stale worker therefore cannot overwrite the case
      // after the current owner has delivered the item.
      const changed = await tx.execute({
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
      if (Number(changed.rowsAffected) !== 1) {
        await tx.rollback();
        return false;
      }
      if (terminal) {
        const outbox = await tx.execute({
          sql: "SELECT case_id FROM support_outbox WHERE id = ?",
          args: [id],
        });
        const caseId = outbox.rows[0]
          ? String(outbox.rows[0].case_id)
          : undefined;
        if (caseId) {
          const row = await tx.execute({
            sql: "SELECT data, version FROM support_cases WHERE id = ?",
            args: [caseId],
          });
          if (row.rows[0]) {
            const current = parse(row.rows[0] as Record<string, unknown>);
            const updated = this.withBindings({
              ...current,
              metadata: {
                ...current.metadata,
                deliveryStatus: "failed",
                deliveryError: String(error),
              },
              updatedAt: now(),
            });
            const caseWrite = await tx.execute({
              sql: "UPDATE support_cases SET data = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?",
              args: [
                JSON.stringify(updated),
                updated.updatedAt,
                caseId,
                Number(row.rows[0].version ?? 1),
              ],
            });
            if (Number(caseWrite.rowsAffected) !== 1)
              throw new StaleCaseWriteError(caseId);
          }
        }
      }
      await tx.commit();
      return true;
    } catch (error) {
      try {
        await tx.rollback();
      } catch {}
      throw error;
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
  /** Atomically records the sole authorized decision for a command. The
   * caller must invoke this before native approval/resume; a losing concurrent
   * request cannot mutate the case projection or execute the effect. */
  async recordApprovalDecision(input: {
    caseId: string;
    turnId?: string;
    commandFingerprint: string;
    principalId: string;
    approved: boolean;
    note?: string;
    nativeRunId?: string;
    nativeToolCallId?: string;
  }): Promise<{ won: boolean; decisionId?: string }> {
    await this.ensured();
    const tx = await this.client.transaction("write");
    try {
      const command = await tx.execute({
        sql: "SELECT data FROM support_actions WHERE case_id = ? AND kind = 'refund-command' AND fingerprint = ?",
        args: [input.caseId, input.commandFingerprint],
      });
      if (!command.rows[0])
        throw new Error("Approval command is missing or has changed.");
      const currentResult = await tx.execute({
        sql: "SELECT data, version FROM support_cases WHERE id = ?",
        args: [input.caseId],
      });
      const row = currentResult.rows[0];
      if (!row) throw new Error(`Support case not found: ${input.caseId}`);
      const current = parse(row as Record<string, unknown>);
      if (current.status !== "waiting_approval")
        throw new Error("Case is not waiting for approval.");
      const turnId =
        input.turnId ??
        ((current.metadata as Record<string, unknown>).activeTurnId as
          string | undefined) ??
        `legacy:${input.caseId}`;
      const existing = await tx.execute({
        sql: "SELECT id FROM support_decisions WHERE case_id = ? AND turn_id = ? AND command_fingerprint = ?",
        args: [input.caseId, turnId, input.commandFingerprint],
      });
      if (existing.rows[0]) {
        await tx.rollback();
        return { won: false };
      }
      const decisionId = `decision_${crypto.randomUUID()}`;
      const updated: SupportCase = {
        ...current,
        approval: {
          approved: input.approved,
          approverId: input.principalId,
          note: input.note,
        },
        status: "processing",
        updatedAt: now(),
      };
      await tx.execute({
        sql: "INSERT INTO support_decisions(id, case_id, turn_id, command_fingerprint, native_run_id, native_tool_call_id, principal_id, approved, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        args: [
          decisionId,
          input.caseId,
          turnId,
          input.commandFingerprint,
          input.nativeRunId ?? null,
          input.nativeToolCallId ?? null,
          input.principalId,
          input.approved ? 1 : 0,
          input.note ?? null,
          now(),
        ],
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
        sql: "INSERT INTO support_audit(id, case_id, kind, actor_id, data, created_at) VALUES (?, ?, 'approval-decision', ?, ?, ?)",
        args: [
          `audit_${crypto.randomUUID()}`,
          input.caseId,
          input.principalId,
          JSON.stringify({
            decisionId,
            commandFingerprint: input.commandFingerprint,
            approved: input.approved,
          }),
          now(),
        ],
      });
      await tx.commit();
      return { won: true, decisionId };
    } catch (error) {
      try {
        await tx.rollback();
      } catch {}
      throw error;
    }
  }
  async approvalDecision(caseId: string, turnId?: string) {
    await this.ensured();
    const result = await this.client.execute({
      sql: "SELECT command_fingerprint, native_run_id, native_tool_call_id, principal_id, approved, turn_id FROM support_decisions WHERE case_id = ? AND (? IS NULL OR turn_id = ?) ORDER BY created_at DESC LIMIT 1",
      args: [caseId, turnId ?? null, turnId ?? null],
    });
    const row = result.rows[0];
    return row
      ? {
          commandFingerprint: String(row.command_fingerprint),
          nativeRunId: row.native_run_id
            ? String(row.native_run_id)
            : undefined,
          nativeToolCallId: row.native_tool_call_id
            ? String(row.native_tool_call_id)
            : undefined,
          principalId: String(row.principal_id),
          approved: Number(row.approved) === 1,
          turnId: String(row.turn_id),
        }
      : undefined;
  }
  /** Monitoring reads immutable decision rows rather than a mutable case
   * projection, so a later follow-up cannot erase earlier approval outcomes. */
  async monitoringDecisions(caseIds: string[]) {
    await this.ensured();
    if (!caseIds.length)
      return [] as Array<{ caseId: string; turnId: string; approved: boolean }>;
    const placeholders = caseIds.map(() => "?").join(", ");
    const result = await this.client.execute({
      sql: `SELECT case_id, turn_id, approved FROM support_decisions WHERE case_id IN (${placeholders}) ORDER BY created_at`,
      args: caseIds,
    });
    return result.rows.map((row) => ({
      caseId: String(row.case_id),
      turnId: String(row.turn_id),
      approved: Number(row.approved) === 1,
    }));
  }
  /** Separate failure counters intentionally do not collapse rejection,
   * workflow, financial, and delivery into one misleading error rate. */
  async monitoringOperationalFailures(caseIds: string[]) {
    await this.ensured();
    if (!caseIds.length)
      return { rejectedDecisions: 0, workflow: 0, financial: 0, delivery: 0 };
    const placeholders = caseIds.map(() => "?").join(", ");
    const [decisions, workflow, financial, delivery] = await Promise.all([
      this.client.execute({
        sql: `SELECT COUNT(*) AS total FROM support_decisions WHERE approved = 0 AND case_id IN (${placeholders})`,
        args: caseIds,
      }),
      this.client.execute({
        sql: `SELECT COUNT(*) AS total FROM support_turns WHERE state = 'failed' AND case_id IN (${placeholders})`,
        args: caseIds,
      }),
      this.client.execute({
        sql: `SELECT COUNT(*) AS total FROM support_turns AS t JOIN support_decisions AS d ON d.case_id = t.case_id AND d.turn_id = t.id AND d.approved = 1 WHERE t.state = 'failed' AND t.case_id IN (${placeholders})`,
        args: caseIds,
      }),
      this.client.execute({
        sql: `SELECT COUNT(*) AS total FROM support_outbox WHERE state = 'failed' AND case_id IN (${placeholders})`,
        args: caseIds,
      }),
    ]);
    const total = (result: { rows: Array<Record<string, unknown>> }) =>
      Number(result.rows[0]?.total ?? 0);
    return {
      rejectedDecisions: total(decisions),
      workflow: total(workflow),
      financial: total(financial),
      delivery: total(delivery),
    };
  }
  /** Decisions are durable authority. A worker uses this queue after an HTTP
   * process dies between recording the one decision and resuming Mastra. */
  /** Native resume is driven by the one durable decision, whether it approved
   * or declined the command.  The dispatch lease is the fence: a worker only
   * reads rows that have not already been claimed for resume. */
  async nativeDecisionsNeedingRecovery(limit = 10) {
    await this.ensured();
    const rows = await this.client.execute({
      sql: "SELECT d.case_id, d.turn_id, d.command_fingerprint, d.native_run_id, d.native_tool_call_id, d.principal_id, d.approved, d.note, c.data, p.id AS dispatch_id, p.run_id AS workflow_run_id, p.state AS dispatch_state FROM support_decisions d JOIN support_cases c ON c.id = d.case_id LEFT JOIN support_dispatch p ON p.case_id = d.case_id AND p.turn_id = d.turn_id WHERE d.native_run_id IS NOT NULL AND d.native_tool_call_id IS NOT NULL AND (p.state = 'suspended' OR p.state IS NULL OR (p.state = 'claimed' AND p.lease_until < ?)) ORDER BY d.created_at LIMIT ?",
      args: [now(), limit],
    });
    return rows.rows.map((row) => ({
      caseId: String(row.case_id),
      turnId: String(row.turn_id),
      fingerprint: String(row.command_fingerprint),
      nativeRunId: String(row.native_run_id),
      nativeToolCallId: String(row.native_tool_call_id),
      principalId: String(row.principal_id),
      approved: Number(row.approved) === 1,
      note: row.note ? String(row.note) : undefined,
      workflowRunId: row.workflow_run_id
        ? String(row.workflow_run_id)
        : undefined,
      supportCase: JSON.parse(String(row.data)) as SupportCase,
    }));
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
  /** Enforce DEC-015 without deleting the durable replay keys or the financial
   * audit window.  Expired case rows become minimal tombstones so pending
   * references remain valid while customer content and trace references do not. */
  async enforceRetention(
    clock: () => Date = () => new Date(),
    policy: RetentionPolicy = retentionPolicyFromEnvironment(),
  ): Promise<RetentionResult> {
    await this.ensured();
    const current = clock();
    const cutoff = (days: number) =>
      new Date(current.getTime() - days * 24 * 60 * 60 * 1_000).toISOString();
    const rawCutoff = cutoff(policy.rawPayloadDays);
    const traceCutoff = cutoff(policy.traceDays);
    const caseCutoff = cutoff(policy.caseDays);
    const auditCutoff = cutoff(policy.financialAuditDays);
    const rows = await this.client.execute(
      "SELECT id, data, version, created_at, accepted_at FROM support_cases WHERE COALESCE(accepted_at, created_at) < ? OR updated_at < ?",
      [rawCutoff, traceCutoff],
    );
    let rawPayloadsRedacted = 0;
    let casesRedacted = 0;
    let tracesRedacted = 0;
    let messagesDeleted = 0;
    let turnsRedacted = 0;
    let outboxRecordsRedacted = 0;
    let dispatchesExpired = 0;
    let decisionsRedacted = 0;
    let actionsRedacted = 0;
    let auditPayloadsRedacted = 0;
    let financialReasonsRedacted = 0;
    let pendingCasesExpired = 0;
    const expiredCaseIds = new Set<string>();
    const expiredWorkflowRunIds = new Set<string>();
    for (const row of rows.rows) {
      const id = String(row.id);
      const supportCase = parse(row as Record<string, unknown>);
      const acceptedAt = String(row.accepted_at ?? row.created_at);
      const metadata = { ...supportCase.metadata };
      // A prior supported-storage delete may have failed after this durable
      // tombstone committed. Keep the case association in later sweeps so
      // snapshot cleanup is retryable without retaining a content copy forever.
      if (metadata.retentionRedactedAt !== undefined) expiredCaseIds.add(id);
      let changed = false;
      let deleteMessages = false;
      if (acceptedAt < rawCutoff && "rawPayload" in metadata) {
        delete metadata.rawPayload;
        rawPayloadsRedacted += 1;
        changed = true;
      }
      let updated: SupportCase = { ...supportCase, metadata };
      if (acceptedAt < traceCutoff && updated.traceId) {
        updated = { ...updated, traceId: undefined };
        tracesRedacted += 1;
        changed = true;
      }
      // Tombstones are normally clean after their first sweep, but a previous
      // version allowed content to be appended after the tombstone marker was
      // written. Check every durable content projection before deciding that a
      // marked case needs no work; otherwise table-only leftovers would live
      // forever because the case JSON is already minimal.
      const residualContent =
        acceptedAt < caseCutoff && metadata.retentionRedactedAt !== undefined
          ? await this.client.execute({
              sql: `SELECT 1 FROM support_messages WHERE case_id = ?
                UNION ALL SELECT 1 FROM support_turns WHERE case_id = ? AND (message_data IS NOT NULL OR outcome_data IS NOT NULL)
                UNION ALL SELECT 1 FROM support_outbox WHERE case_id = ? AND (body <> '[redacted]' OR receipt IS NOT NULL OR last_error IS NOT NULL)
                UNION ALL SELECT 1 FROM support_decisions WHERE case_id = ? AND note IS NOT NULL
                UNION ALL SELECT 1 FROM support_actions WHERE case_id = ? AND data <> '{}'
                LIMIT 1`,
              args: [id, id, id, id, id],
            })
          : undefined;
      if (
        acceptedAt < caseCutoff &&
        (metadata.retentionRedactedAt === undefined ||
          supportCase.messages.length > 0 ||
          supportCase.approval !== undefined ||
          supportCase.feedback !== undefined ||
          supportCase.customer.email !== "redacted@invalid.local" ||
          supportCase.subject !== "Redacted support case" ||
          supportCase.finalResponse !== undefined ||
          supportCase.draft !== undefined ||
          Boolean(residualContent?.rows[0]))
      ) {
        const binding = this.binding(supportCase);
        const wasPending = ["new", "processing", "waiting_approval"].includes(
          supportCase.status,
        );
        const command = metadata.refundCommand as
          { fingerprint?: unknown; idempotencyKey?: unknown } | undefined;
        updated = {
          ...updated,
          customer: { email: "redacted@invalid.local" },
          subject: "Redacted support case",
          messages: [],
          approval: undefined,
          ...(wasPending
            ? {
                // Closing a stale in-flight case fails closed. Keep only a
                // non-executable fingerprint/replay reference for audit and
                // reconciliation; the decision route rejects this status.
                status: "failed" as const,
              }
            : {}),
          triage: undefined,
          policyMatches: undefined,
          orderLookup: undefined,
          subscriptionLookup: undefined,
          refundHistory: undefined,
          draft: undefined,
          finalResponse: undefined,
          escalationReason: wasPending
            ? "Pending case expired under DEC-015 before a financial decision."
            : undefined,
          feedback: undefined,
          agentUsage: undefined,
          traceId: undefined,
          metadata: {
            providerBinding: binding,
            retentionRedactedAt: current.toISOString(),
            ...(wasPending
              ? {
                  pendingRetentionExpiredAt: current.toISOString(),
                  ...(command?.fingerprint
                    ? {
                        refundCommand: {
                          fingerprint: command.fingerprint,
                          ...(command.idempotencyKey
                            ? { idempotencyKey: command.idempotencyKey }
                            : {}),
                        },
                      }
                    : {}),
                }
              : {}),
          },
        };
        if (wasPending) pendingCasesExpired += 1;
        casesRedacted += 1;
        expiredCaseIds.add(id);
        if (supportCase.workflowRunId)
          expiredWorkflowRunIds.add(supportCase.workflowRunId);
        const nativeApproval = metadata.nativeApproval as
          { runId?: unknown } | undefined;
        if (typeof nativeApproval?.runId === "string")
          expiredWorkflowRunIds.add(nativeApproval.runId);
        const dispatchedRuns = await this.client.execute({
          sql: "SELECT run_id FROM support_dispatch WHERE case_id = ?",
          args: [id],
        });
        for (const run of dispatchedRuns.rows)
          expiredWorkflowRunIds.add(String(run.run_id));
        const nativeRuns = await this.client.execute({
          sql: "SELECT native_run_id FROM support_decisions WHERE case_id = ? AND native_run_id IS NOT NULL",
          args: [id],
        });
        for (const run of nativeRuns.rows)
          expiredWorkflowRunIds.add(String(run.native_run_id));
        const turnRuns = await this.client.execute({
          sql: "SELECT run_id FROM support_turns WHERE case_id = ? AND run_id IS NOT NULL",
          args: [id],
        });
        for (const run of turnRuns.rows)
          expiredWorkflowRunIds.add(String(run.run_id));
        deleteMessages = true;
        changed = true;
      }
      if (changed) {
        const tx = await this.client.transaction("write");
        try {
          const write = await tx.execute({
            sql: "UPDATE support_cases SET data = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?",
            args: [
              JSON.stringify(updated),
              current.toISOString(),
              id,
              Number(row.version ?? 1),
            ],
          });
          if (Number(write.rowsAffected ?? 0) !== 1)
            throw new StaleCaseWriteError(id);
          if (deleteMessages) {
            const deleted = await tx.execute({
              sql: "DELETE FROM support_messages WHERE case_id = ?",
              args: [id],
            });
            messagesDeleted += Number(deleted.rowsAffected ?? 0);
            const turns = await tx.execute({
              sql: "UPDATE support_turns SET message_data = NULL, outcome_data = NULL, updated_at = ? WHERE case_id = ? AND (message_data IS NOT NULL OR outcome_data IS NOT NULL)",
              args: [current.toISOString(), id],
            });
            turnsRedacted += Number(turns.rowsAffected ?? 0);
            // Expire in-flight authority before removing its native snapshot.
            // The retained row remains a non-executable audit/replay reference.
            const dispatches = await tx.execute({
              sql: "UPDATE support_dispatch SET state = CASE WHEN state IN ('pending', 'claimed', 'started', 'suspended') THEN 'failed' ELSE state END, lease_until = NULL, lease_token = NULL, last_error = NULL, updated_at = ? WHERE case_id = ?",
              args: [current.toISOString(), id],
            });
            dispatchesExpired += Number(dispatches.rowsAffected ?? 0);
            const outbox = await tx.execute({
              sql: "UPDATE support_outbox SET body = '[redacted]', receipt = NULL, last_error = NULL, lease_until = NULL, lease_token = NULL, updated_at = ? WHERE case_id = ? AND (body <> '[redacted]' OR receipt IS NOT NULL OR last_error IS NOT NULL)",
              args: [current.toISOString(), id],
            });
            outboxRecordsRedacted += Number(outbox.rowsAffected ?? 0);
            const decisions = await tx.execute({
              sql: "UPDATE support_decisions SET note = NULL WHERE case_id = ? AND note IS NOT NULL",
              args: [id],
            });
            decisionsRedacted += Number(decisions.rowsAffected ?? 0);
            const actions = await tx.execute({
              sql: "UPDATE support_actions SET data = '{}' WHERE case_id = ? AND data <> '{}'",
              args: [id],
            });
            actionsRedacted += Number(actions.rowsAffected ?? 0);
          }
          await tx.commit();
        } catch (error) {
          try {
            await tx.rollback();
          } catch {}
          throw error;
        }
      }
    }
    const audits = await this.client.execute({
      sql: "DELETE FROM support_audit WHERE created_at < ?",
      args: [auditCutoff],
    });
    // LocalRuntime owns the financial table and may not be initialized in a
    // storage-only invocation. If it exists, its freeform reason follows the
    // case-content window while the immutable financial identifiers remain.
    try {
      const financialReasons = await this.client.execute({
        sql: "UPDATE local_refunds SET reason = '[redacted]' WHERE issued_at < ? AND reason <> '[redacted]'",
        args: [caseCutoff],
      });
      financialReasonsRedacted += Number(financialReasons.rowsAffected ?? 0);
    } catch (error) {
      if (!String(error).includes("no such table")) throw error;
    }
    return {
      rawPayloadsRedacted,
      casesRedacted,
      tracesRedacted,
      auditsDeleted: Number(audits.rowsAffected ?? 0),
      messagesDeleted,
      turnsRedacted,
      outboxRecordsRedacted,
      dispatchesExpired,
      decisionsRedacted,
      actionsRedacted,
      auditPayloadsRedacted,
      financialReasonsRedacted,
      // Mastra owns its tables. The configured LibSQLStore retention policy
      // removes its messages, resources, threads, and spans via storage.prune.
      mastraMessagesDeleted: 0,
      mastraSpansDeleted: 0,
      pendingCasesExpired,
      rawWorkflowSnapshotBefore: rawCutoff,
      expiredCaseIds: [...expiredCaseIds],
      expiredWorkflowRunIds: [...expiredWorkflowRunIds],
    };
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
