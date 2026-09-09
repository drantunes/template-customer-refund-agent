import { createClient, type Client } from "@libsql/client";
import { createHash } from "node:crypto";
import { moneyToLegacyAmount, structurallyEqual } from "./money";
import type {
  CaseFeedback,
  CaseMessage,
  SupportCase,
} from "../domain/support-case";
import {
  bindingsForCase,
  sameBinding,
  type ProviderBinding,
  type RefundCommand,
  type SubscriptionCancellationCommand,
} from "../providers/contracts";
import { ownerIdForCustomer } from "../server/auth";
import { waitForMastraStorage } from "../runtime/storage-lifecycle";
import {
  getSharedLocalSqliteClient,
  serializeSqliteClient,
} from "./sqlite-client";
import { resolveDatabaseUrl } from "./database-url";
import { activeDispatchLeaseScope } from "./dispatch-lease-scope";
import type { DispatchLeaseScope } from "./dispatch-lease-scope";

const MAX_INTERCOM_PROVIDER_RETRY_DELAY_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_INTERCOM_FALLBACK_RETRY_DELAY_MS = 60_000;

export type DispatchState =
  "pending" | "claimed" | "completed" | "suspended" | "failed";
export type OutboxState =
  "pending" | "claimed" | "started" | "delivered" | "failed" | "uncertain";
export type OutboxOperation = "reply" | "note" | "status" | "ticket";
export interface OutboxRecord {
  id: string;
  caseId: string;
  binding: ProviderBinding;
  body: string;
  status: string;
  operation?: OutboxOperation;
  /** Hash of the immutable operation payload.  A retry cannot mutate it. */
  payloadFingerprint?: string;
  nextAttemptAt?: string;
  state: OutboxState;
  attempts: number;
  receipt?: unknown;
  lastError?: string;
  leaseToken?: string;
  /** Immutable originating response correlation.  Legacy rows may be unknown. */
  originatingTurnId?: string;
  originatingRunId?: string;
  originatingTraceId?: string;
  correlationState?: "known" | "unknown";
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
export interface FeedbackRecord {
  id: string;
  caseId: string;
  feedback: CaseFeedback;
  attributionState?: "known" | "legacy-unknown";
}
/**
 * An authenticated staff investigation is observability bookkeeping, not a
 * support turn or a case-state transition.  Its identifiers are server-derived
 * correlation keys only; request/response content is never retained here.
 */
export interface SupervisorExecutionRecord {
  id: string;
  tenantId: string;
  caseId: string;
  threadId: string;
  actorId: string;
  runId: string;
  traceId?: string;
  state: "completed" | "failed";
  createdAt: string;
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
  supervisorExecutionsDeleted: number;
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

function config(url = resolveDatabaseUrl()) {
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

/** Provider message IDs are only unique within their conversation/account.
 * The app-owned retention mirror has one physical primary key, so qualify its
 * storage key without changing the domain-visible message identity. */
function scopedMessageId(caseId: string, messageId: string) {
  return `message_${createHash("sha256")
    .update(JSON.stringify([caseId, messageId]))
    .digest("hex")}`;
}

export function isRetentionTombstone(supportCase: SupportCase) {
  return (
    (supportCase.metadata as Record<string, unknown>).retentionRedactedAt !==
    undefined
  );
}

/**
 * A terminal financial operation must remain a replay barrier after its
 * provider identifiers age out.  The key and fingerprint live in the table
 * columns; this deliberately contains no provider, customer, order, payment,
 * refund, or subscription data.
 */
export const financialRetentionTombstone = Object.freeze({
  retention: "terminal-financial-effect",
});

export function isFinancialRetentionTombstone(effect: unknown) {
  return (
    !!effect &&
    typeof effect === "object" &&
    !Array.isArray(effect) &&
    Object.keys(effect).length === 1 &&
    (effect as { retention?: unknown }).retention ===
      financialRetentionTombstone.retention
  );
}

function financialRetentionTombstoneError() {
  return new Error(
    "A retained terminal financial tombstone blocks replay or a new provider effect.",
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
  async migrate(target = 22): Promise<void> {
    await this.client.execute(
      "CREATE TABLE IF NOT EXISTS support_schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
    );
    const applied = await this.client.execute(
      "SELECT version FROM support_schema_migrations ORDER BY version",
    );
    let version = Number(applied.rows.at(-1)?.version ?? 0);
    if (!Number.isInteger(target) || target < 0 || target > 22)
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
    if (version === 10) {
      await this.up10();
      return;
    }
    if (version === 11) {
      await this.up11();
      return;
    }
    if (version === 12) {
      await this.up12();
      return;
    }
    if (version === 13) {
      await this.up13();
      return;
    }
    if (version === 16) {
      await this.up16();
      return;
    }
    if (version === 17) {
      await this.up17();
      return;
    }
    if (version === 18) {
      await this.up18();
      return;
    }
    if (version === 19) {
      await this.up19();
      return;
    }
    if (version === 20) {
      await this.up20();
      return;
    }
    if (version === 21) {
      await this.up21();
      return;
    }
    if (version === 22) {
      await this.up22();
      return;
    }
    if (version === 14) {
      await this.up14();
      return;
    }
    if (version === 15) {
      await this.up15();
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
  /** Ratings belong to the response turn, not the mutable case projection. */
  private async up10() {
    await this.client.executeMultiple(`
      CREATE TABLE IF NOT EXISTS support_feedback (
        id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(case_id, turn_id, actor_id)
      );
      CREATE INDEX IF NOT EXISTS support_feedback_case_created
        ON support_feedback(case_id, created_at DESC);
    `);
    await this.client.execute({
      sql: "INSERT INTO support_schema_migrations(version, applied_at) VALUES (10, ?)",
      args: [now()],
    });
  }
  /**
   * Phase 004 makes both the response correlation and the feedback history
   * durable. Existing outbox/feedback rows are retained: a row is backfilled
   * only when its deterministic final-response id identifies exactly one turn;
   * all other historical attribution is explicitly marked unknown.
   */
  private async up11() {
    const outboxRows = await this.client.execute(
      "SELECT id, case_id FROM support_outbox",
    );
    const feedbackRows = await this.client.execute(
      "SELECT id, case_id, turn_id, actor_id, data, created_at FROM support_feedback",
    );
    const cases = await this.client.execute(
      "SELECT id, data FROM support_cases",
    );
    const tx = await this.client.transaction("write");
    try {
      for (const sql of [
        "ALTER TABLE support_outbox ADD COLUMN originating_turn_id TEXT",
        "ALTER TABLE support_outbox ADD COLUMN originating_run_id TEXT",
        "ALTER TABLE support_outbox ADD COLUMN originating_trace_id TEXT",
        "ALTER TABLE support_outbox ADD COLUMN correlation_state TEXT NOT NULL DEFAULT 'unknown'",
      ]) {
        try {
          await tx.execute(sql);
        } catch (error) {
          if (!String(error).includes("duplicate column")) throw error;
        }
      }
      for (const row of outboxRows.rows) {
        const caseId = String(row.case_id);
        const turns = await tx.execute({
          sql: "SELECT id, run_id, outcome_data FROM support_turns WHERE case_id = ?",
          args: [caseId],
        });
        const turn = turns.rows.find(
          (candidate) =>
            String(row.id) === `outbox_${caseId}_${String(candidate.id)}_final`,
        ) as Record<string, unknown> | undefined;
        if (!turn) continue;
        const outcome = turn.outcome_data
          ? (JSON.parse(String(turn.outcome_data)) as {
              telemetry?: { traceId?: unknown };
            })
          : undefined;
        const traceId = outcome?.telemetry?.traceId;
        await tx.execute({
          sql: "UPDATE support_outbox SET originating_turn_id = ?, originating_run_id = ?, originating_trace_id = ?, correlation_state = ? WHERE id = ?",
          args: [
            String(turn.id),
            turn.run_id ? String(turn.run_id) : null,
            typeof traceId === "string" ? traceId : null,
            typeof traceId === "string" ? "known" : "unknown",
            String(row.id),
          ],
        });
      }
      await tx.executeMultiple(`
        CREATE TABLE support_feedback_v11 (
          id TEXT PRIMARY KEY,
          case_id TEXT NOT NULL,
          turn_id TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          data TEXT NOT NULL,
          created_at TEXT,
          dedupe_key TEXT NOT NULL,
          attribution_state TEXT NOT NULL DEFAULT 'known'
        );
      `);
      for (const row of feedbackRows.rows) {
        const feedback = JSON.parse(String(row.data)) as { rating?: unknown };
        await tx.execute({
          sql: "INSERT INTO support_feedback_v11(id, case_id, turn_id, actor_id, data, created_at, dedupe_key, attribution_state) VALUES (?, ?, ?, ?, ?, ?, ?, 'known')",
          args: [
            String(row.id),
            String(row.case_id),
            String(row.turn_id),
            String(row.actor_id),
            String(row.data),
            row.created_at ? String(row.created_at) : null,
            String(feedback.rating ?? "unknown"),
          ],
        });
      }
      await tx.executeMultiple(`
        DROP TABLE support_feedback;
        ALTER TABLE support_feedback_v11 RENAME TO support_feedback;
        CREATE UNIQUE INDEX support_feedback_exact_rating
          ON support_feedback(case_id, turn_id, actor_id, dedupe_key);
        CREATE INDEX support_feedback_case_created
          ON support_feedback(case_id, created_at DESC);
      `);
      for (const row of cases.rows) {
        const supportCase = parse(row as Record<string, unknown>);
        if (!supportCase.feedback) continue;
        await this.insertLegacyFeedback(
          tx,
          supportCase.id,
          supportCase.feedback,
        );
      }
      await tx.execute({
        sql: "INSERT INTO support_schema_migrations(version, applied_at) VALUES (11, ?)",
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
  /**
   * Supervisor traces are not operational workflow turns.  Store their
   * authenticated, tenant-qualified association append-only so a later
   * follow-up cannot overwrite the original correlation on the case record.
   */
  private async up12() {
    await this.client.executeMultiple(`
      CREATE TABLE IF NOT EXISTS support_supervisor_executions (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        case_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        trace_id TEXT,
        state TEXT NOT NULL CHECK(state IN ('completed', 'failed')),
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS support_supervisor_executions_run
        ON support_supervisor_executions(run_id);
      CREATE INDEX IF NOT EXISTS support_supervisor_executions_tenant_case_created
        ON support_supervisor_executions(tenant_id, case_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS support_supervisor_executions_trace
        ON support_supervisor_executions(trace_id);
    `);
    await this.client.execute({
      sql: "INSERT INTO support_schema_migrations(version, applied_at) VALUES (12, ?)",
      args: [now()],
    });
  }
  /** Additive outbox evolution.  Legacy rows retain their original binding
   * and are explicitly represented as reply operations; no provider route is
   * reinterpreted during migration. */
  private async up13() {
    const tx = await this.client.transaction("write");
    try {
      for (const sql of [
        "ALTER TABLE support_outbox ADD COLUMN operation TEXT NOT NULL DEFAULT 'reply'",
        "ALTER TABLE support_outbox ADD COLUMN payload_fingerprint TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE support_outbox ADD COLUMN next_attempt_at TEXT",
      ])
        try {
          await tx.execute(sql);
        } catch (error) {
          if (!String(error).includes("duplicate column")) throw error;
        }
      await tx.executeMultiple(`
        CREATE TABLE IF NOT EXISTS support_outbox_account_limits (
          tenant_id TEXT NOT NULL, provider_kind TEXT NOT NULL, provider_account_id TEXT NOT NULL,
          blocked_until TEXT NOT NULL, updated_at TEXT NOT NULL,
          PRIMARY KEY(tenant_id, provider_kind, provider_account_id)
        );
        CREATE INDEX IF NOT EXISTS support_outbox_claimable_v13 ON support_outbox(state, next_attempt_at, created_at);
      `);
      const rows = await tx.execute(
        "SELECT id, binding, body, status, operation, payload_fingerprint FROM support_outbox",
      );
      for (const row of rows.rows) {
        const operation = String(row.operation || "reply");
        const fingerprint = createHash("sha256")
          .update(
            JSON.stringify({
              binding: JSON.parse(String(row.binding)),
              operation,
              body: String(row.body),
              status: String(row.status),
            }),
          )
          .digest("hex");
        await tx.execute({
          sql: "UPDATE support_outbox SET payload_fingerprint = ? WHERE id = ? AND payload_fingerprint = ''",
          args: [fingerprint, String(row.id)],
        });
      }
      await tx.execute({
        sql: "INSERT INTO support_schema_migrations(version, applied_at) VALUES (13, ?)",
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
  /** Stripe accepts an idempotency key only for a bounded provider window.
   * Store intent before POST so a restart can retrieve/reconcile the original
   * refund instead of issuing a fresh request after that window expires. */
  private async up14() {
    await this.client.executeMultiple(`
      CREATE TABLE IF NOT EXISTS support_stripe_refund_attempts (
        id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        provider_account_id TEXT NOT NULL,
        command_fingerprint TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        dispatch_id TEXT NOT NULL,
        lease_token TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('prepared','pending','succeeded','failed','unknown','quarantined')),
        refund_id TEXT,
        provider_status TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        next_attempt_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS support_stripe_refund_attempt_command
        ON support_stripe_refund_attempts(case_id, command_fingerprint);
      CREATE INDEX IF NOT EXISTS support_stripe_refund_attempt_reconcile
        ON support_stripe_refund_attempts(status, next_attempt_at, updated_at);
    `);
    await this.client.execute({
      sql: "INSERT INTO support_schema_migrations(version, applied_at) VALUES (14, ?)",
      args: [now()],
    });
  }
  /** Version 15 seals the command/turn that owns an external attempt. A
   * follow-up projection must never redirect an in-flight refund recovery. */
  private async up15() {
    for (const sql of [
      "ALTER TABLE support_stripe_refund_attempts ADD COLUMN turn_id TEXT",
      "ALTER TABLE support_stripe_refund_attempts ADD COLUMN command_data TEXT",
    ])
      try {
        await this.client.execute(sql);
      } catch (error) {
        if (!String(error).includes("duplicate column")) throw error;
      }
    await this.client.execute({
      sql: "INSERT INTO support_schema_migrations(version, applied_at) VALUES (15, ?)",
      args: [now()],
    });
  }
  /** Reconciliation is a separately fenced job.  A provider result can arrive
   * after the workflow lease ends, so workers claim a short CAS lease rather
   * than racing on every pending row. */
  private async up16() {
    for (const sql of [
      "ALTER TABLE support_stripe_refund_attempts ADD COLUMN reconcile_lease_token TEXT",
      "ALTER TABLE support_stripe_refund_attempts ADD COLUMN reconcile_lease_until TEXT",
    ])
      try {
        await this.client.execute(sql);
      } catch (error) {
        if (!String(error).includes("duplicate column")) throw error;
      }
    await this.client.execute({
      sql: "INSERT INTO support_schema_migrations(version, applied_at) VALUES (16, ?)",
      args: [now()],
    });
  }
  /** The exact target/body for an uncertain Stripe POST is immutable before
   * the effect boundary. Recovery must not re-quote a changed balance. */
  private async up17() {
    try {
      await this.client.execute(
        "ALTER TABLE support_stripe_refund_attempts ADD COLUMN stripe_request_data TEXT",
      );
    } catch (error) {
      if (!String(error).includes("duplicate column")) throw error;
    }
    await this.client.execute({
      sql: "INSERT INTO support_schema_migrations(version, applied_at) VALUES (17, ?)",
      args: [now()],
    });
  }
  /** Poll observations must not extend the 365-day financial audit period. */
  private async up18() {
    for (const sql of [
      "ALTER TABLE support_stripe_refund_attempts ADD COLUMN terminal_at TEXT",
      "ALTER TABLE support_stripe_refund_attempts ADD COLUMN reconcile_attempts INTEGER NOT NULL DEFAULT 0",
    ])
      try {
        await this.client.execute(sql);
      } catch (error) {
        if (!String(error).includes("duplicate column")) throw error;
      }
    await this.client.execute({
      sql: "UPDATE support_stripe_refund_attempts SET terminal_at = updated_at WHERE terminal_at IS NULL AND status IN ('succeeded', 'failed', 'quarantined')",
    });
    await this.client.execute({
      sql: "INSERT INTO support_schema_migrations(version, applied_at) VALUES (18, ?)",
      args: [now()],
    });
  }
  private async up19() {
    await this.client.executeMultiple(`
      CREATE TABLE IF NOT EXISTS support_subscription_cancellation_attempts (
        idempotency_key TEXT PRIMARY KEY, case_id TEXT NOT NULL, turn_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL, provider_account_id TEXT NOT NULL, subscription_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL, command_data TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('prepared','scheduled','unknown','failed')),
        cancels_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS support_subscription_cancellation_command
        ON support_subscription_cancellation_attempts(case_id, fingerprint);
    `);
    await this.client.execute({
      sql: "INSERT INTO support_schema_migrations(version, applied_at) VALUES (19, ?)",
      args: [now()],
    });
  }
  private async up20() {
    await this.client.executeMultiple(`
      CREATE TABLE support_subscription_cancellation_attempts_v20 (
        idempotency_key TEXT PRIMARY KEY, case_id TEXT NOT NULL, turn_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL, provider_account_id TEXT NOT NULL, subscription_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL, command_data TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('prepared','scheduled','unknown','failed','quarantined')),
        cancels_at TEXT, terminal_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO support_subscription_cancellation_attempts_v20(
        idempotency_key, case_id, turn_id, tenant_id, provider_account_id,
        subscription_id, fingerprint, command_data, status, cancels_at,
        terminal_at, created_at, updated_at
      ) SELECT
        idempotency_key, case_id, turn_id, tenant_id, provider_account_id,
        subscription_id, fingerprint, command_data, status, cancels_at,
        CASE WHEN status IN ('scheduled', 'failed') THEN updated_at ELSE NULL END,
        created_at, updated_at
      FROM support_subscription_cancellation_attempts;
      DROP TABLE support_subscription_cancellation_attempts;
      ALTER TABLE support_subscription_cancellation_attempts_v20
        RENAME TO support_subscription_cancellation_attempts;
      CREATE UNIQUE INDEX support_subscription_cancellation_command
        ON support_subscription_cancellation_attempts(case_id, fingerprint);
    `);
    await this.client.execute({
      sql: "INSERT INTO support_schema_migrations(version, applied_at) VALUES (20, ?)",
      args: [now()],
    });
  }
  private async up21() {
    await this.client.executeMultiple(`
      CREATE TABLE support_subscription_cancellation_attempts_v21 (
        idempotency_key TEXT PRIMARY KEY, case_id TEXT NOT NULL, turn_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL, provider_account_id TEXT NOT NULL, subscription_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL, command_data TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('prepared','claimed','scheduled','unknown','failed','quarantined')),
        cancels_at TEXT, terminal_at TEXT, next_reconcile_at TEXT,
        reconcile_lease_token TEXT, reconcile_lease_until TEXT,
        reconcile_attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO support_subscription_cancellation_attempts_v21(
        idempotency_key, case_id, turn_id, tenant_id, provider_account_id,
        subscription_id, fingerprint, command_data, status, cancels_at,
        terminal_at, next_reconcile_at, reconcile_lease_token,
        reconcile_lease_until, reconcile_attempts, created_at, updated_at
      ) SELECT
        idempotency_key, case_id, turn_id, tenant_id, provider_account_id,
        subscription_id, fingerprint, command_data, status, cancels_at,
        terminal_at, CASE WHEN status = 'unknown' THEN updated_at ELSE NULL END,
        NULL, NULL, 0, created_at, updated_at
      FROM support_subscription_cancellation_attempts;
      DROP TABLE support_subscription_cancellation_attempts;
      ALTER TABLE support_subscription_cancellation_attempts_v21
        RENAME TO support_subscription_cancellation_attempts;
      CREATE UNIQUE INDEX support_subscription_cancellation_command
        ON support_subscription_cancellation_attempts(case_id, fingerprint);
      CREATE INDEX support_subscription_cancellation_recovery_due
        ON support_subscription_cancellation_attempts(status, next_reconcile_at);
    `);
    await this.client.execute({
      sql: "INSERT INTO support_schema_migrations(version, applied_at) VALUES (21, ?)",
      args: [now()],
    });
  }
  /** A signed Stripe event is acknowledged only after its durable local work
   * is complete.  The receipt contains no raw webhook body or provider
   * payload; its short lease fences concurrent delivery attempts. */
  private async up22() {
    await this.client.executeMultiple(`
      CREATE TABLE IF NOT EXISTS support_stripe_webhook_receipts (
        event_id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK(state IN ('processing','completed','failed')),
        lease_token TEXT,
        lease_until TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS support_stripe_webhook_receipts_retention
        ON support_stripe_webhook_receipts(state, completed_at, created_at);
    `);
    await this.client.execute({
      sql: "INSERT INTO support_schema_migrations(version, applied_at) VALUES (22, ?)",
      args: [now()],
    });
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
  /** Version is a fence for projections which must not overwrite a provider
   * finalizer that races after an external-effect receipt. */
  async version(id: string) {
    await this.ensured();
    const row = await this.client.execute({
      sql: "SELECT version FROM support_cases WHERE id = ?",
      args: [id],
    });
    if (!row.rows[0]) throw new Error(`Support case not found: ${id}`);
    return Number(row.rows[0].version ?? 1);
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
          // Telemetry can be recorded before a turn is terminal. Merge the
          // immutable projection into that object in this same transaction;
          // COALESCE used to discard the draft/approval snapshot here.
          sql: "UPDATE support_turns SET outcome_data = json_patch(COALESCE(outcome_data, '{}'), ?), updated_at = ? WHERE id = ? AND case_id = ?",
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
          scopedMessageId(input.caseId, input.message.id),
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
            scopedMessageId(persisted.id, message.id),
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
    const operation = record.operation ?? "reply";
    const payloadFingerprint =
      record.payloadFingerprint ??
      this.outboxFingerprint(
        record.binding,
        operation,
        record.body,
        record.status,
      );
    await this.client.execute({
      sql: "INSERT INTO support_outbox(id, case_id, binding, body, status, operation, payload_fingerprint, state, originating_turn_id, originating_run_id, originating_trace_id, correlation_state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)",
      args: [
        record.id,
        record.caseId,
        JSON.stringify(record.binding),
        record.body,
        record.status,
        operation,
        payloadFingerprint,
        record.originatingTurnId ?? null,
        record.originatingRunId ?? null,
        record.originatingTraceId ?? null,
        record.correlationState ?? "unknown",
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
    additionalOutbox?: Array<Omit<OutboxRecord, "state" | "attempts">>;
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
        sql: "SELECT run_id, outcome_data FROM support_turns WHERE id = ? AND case_id = ?",
        args: [input.turnId, input.caseId],
      });
      const existingOutcome = priorOutcome.rows[0]?.outcome_data
        ? (JSON.parse(String(priorOutcome.rows[0].outcome_data)) as {
            finalResponse?: string;
            status?: string;
            telemetry?: { traceId?: unknown };
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
      const operation = input.outbox.operation ?? "reply";
      const payloadFingerprint =
        input.outbox.payloadFingerprint ??
        this.outboxFingerprint(
          input.outbox.binding,
          operation,
          input.outbox.body,
          input.outbox.status,
        );
      const prior = await tx.execute({
        sql: "SELECT case_id, binding, body, status, operation, payload_fingerprint, originating_turn_id, originating_run_id, originating_trace_id, correlation_state FROM support_outbox WHERE id = ?",
        args: [input.outbox.id],
      });
      if (prior.rows[0]) {
        const existing = prior.rows[0] as Record<string, unknown>;
        if (
          String(existing.case_id) !== input.caseId ||
          String(existing.body) !== input.outbox.body ||
          String(existing.status) !== input.outbox.status ||
          String(existing.binding) !== JSON.stringify(input.outbox.binding) ||
          String(existing.operation ?? "reply") !== operation ||
          String(existing.payload_fingerprint ?? "") !== payloadFingerprint
        )
          throw new Error(
            "Conflicting replay attempted to enqueue a delivery.",
          );
      } else {
        await tx.execute({
          sql: "INSERT INTO support_outbox(id, case_id, binding, body, status, operation, payload_fingerprint, state, originating_turn_id, originating_run_id, originating_trace_id, correlation_state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)",
          args: [
            input.outbox.id,
            input.caseId,
            JSON.stringify(input.outbox.binding),
            input.outbox.body,
            input.outbox.status,
            operation,
            payloadFingerprint,
            input.turnId,
            priorOutcome.rows[0]?.run_id
              ? String(priorOutcome.rows[0].run_id)
              : null,
            typeof existingOutcome?.telemetry?.traceId === "string"
              ? existingOutcome.telemetry.traceId
              : null,
            typeof existingOutcome?.telemetry?.traceId === "string"
              ? "known"
              : "unknown",
            now(),
            now(),
          ],
        });
      }
      for (const extra of input.additionalOutbox ?? []) {
        const extraOperation = extra.operation ?? "reply";
        const extraFingerprint =
          extra.payloadFingerprint ??
          this.outboxFingerprint(
            extra.binding,
            extraOperation,
            extra.body,
            extra.status,
          );
        const existing = await tx.execute({
          sql: "SELECT case_id, binding, body, status, operation, payload_fingerprint FROM support_outbox WHERE id = ?",
          args: [extra.id],
        });
        if (existing.rows[0]) {
          const row = existing.rows[0] as Record<string, unknown>;
          if (
            String(row.case_id) !== input.caseId ||
            String(row.binding) !== JSON.stringify(extra.binding) ||
            String(row.body) !== extra.body ||
            String(row.status) !== extra.status ||
            String(row.operation ?? "reply") !== extraOperation ||
            String(row.payload_fingerprint ?? "") !== extraFingerprint
          )
            throw new Error(
              "Conflicting replay attempted to enqueue an additional delivery.",
            );
          continue;
        }
        await tx.execute({
          sql: "INSERT INTO support_outbox(id, case_id, binding, body, status, operation, payload_fingerprint, state, originating_turn_id, originating_run_id, originating_trace_id, correlation_state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)",
          args: [
            extra.id,
            input.caseId,
            JSON.stringify(extra.binding),
            extra.body,
            extra.status,
            extraOperation,
            extraFingerprint,
            input.turnId,
            priorOutcome.rows[0]?.run_id
              ? String(priorOutcome.rows[0].run_id)
              : null,
            typeof existingOutcome?.telemetry?.traceId === "string"
              ? existingOutcome.telemetry.traceId
              : null,
            typeof existingOutcome?.telemetry?.traceId === "string"
              ? "known"
              : "unknown",
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
      sql: "SELECT case_id, id FROM support_dispatch WHERE state IN ('claimed', 'started') AND lease_until < ? AND attempts >= 3",
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
                status: "escalated" as const,
                escalationReason:
                  "Workflow recovery exhausted its durable lease attempts.",
                metadata: { ...current.metadata, workflowStatus: "escalated" },
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
              await tx.execute({
                sql: "UPDATE support_turns SET state = 'escalated', outcome_data = json_patch(COALESCE(outcome_data, '{}'), ?), updated_at = ? WHERE id = (SELECT turn_id FROM support_dispatch WHERE id = ?)",
                args: [
                  JSON.stringify({
                    status: "escalated",
                    escalationReason:
                      "Workflow recovery exhausted its durable lease attempts.",
                    operationalFailure: {
                      disposition: "escalate",
                      recordedAt: now(),
                    },
                  }),
                  now(),
                  String(row.id),
                ],
              });
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
  /**
   * This is the last durable authorization boundary before a Stripe refund
   * can create an effect.  It intentionally runs after remote preflight and
   * keeps the dispatch/reconciliation lease, immutable command/target,
   * originating turn, owner, and binding in one write transaction.
   *
   * A successful return is immediately followed by the provider POST.  Do
   * not add network work after this method in a caller.
   */
  async authorizeStripeRefundFirstEffect(input: {
    command: RefundCommand;
    request: { paymentIntentId: string; providerRefs: unknown[] };
    ownerId: string;
    dispatch?: DispatchLeaseScope;
    reconciliationLeaseToken?: string;
    validatePolicy: (
      tx: Awaited<ReturnType<Client["transaction"]>>,
    ) => Promise<void>;
  }) {
    await this.ensured();
    if (
      (input.dispatch === undefined) ===
      (input.reconciliationLeaseToken === undefined)
    )
      throw new Error(
        "Refund first-effect authorization requires exactly one current lease.",
      );
    const tx = await this.client.transaction("write");
    try {
      const command = input.command;
      const attemptResult = await tx.execute({
        sql: "SELECT * FROM support_stripe_refund_attempts WHERE idempotency_key = ? AND command_fingerprint = ?",
        args: [command.idempotencyKey, command.fingerprint],
      });
      const attempt = attemptResult.rows[0] as
        Record<string, unknown> | undefined;
      const caseResult = await tx.execute({
        sql: "SELECT data FROM support_cases WHERE id = ?",
        args: [command.approvalCaseId],
      });
      const supportCase = caseResult.rows[0]
        ? parse({ data: caseResult.rows[0].data })
        : undefined;
      const actionResult = await tx.execute({
        sql: "SELECT data FROM support_actions WHERE case_id = ? AND kind = 'refund-command' AND fingerprint = ?",
        args: [command.approvalCaseId, command.fingerprint],
      });
      const immutable = actionResult.rows[0]
        ? JSON.parse(String(actionResult.rows[0].data))
        : undefined;
      const turnResult = await tx.execute({
        sql: "SELECT command_fingerprint FROM support_turns WHERE id = ? AND case_id = ?",
        args: [String(attempt?.turn_id ?? ""), command.approvalCaseId],
      });
      const request = attempt?.stripe_request_data
        ? JSON.parse(String(attempt.stripe_request_data))
        : undefined;
      const ownerCurrent =
        supportCase &&
        (supportCase.metadata as Record<string, unknown>).ownerId ===
          input.ownerId &&
        ownerIdForCustomer(
          command.binding.tenantId,
          supportCase.customer.email,
        ) === input.ownerId;
      const commandCurrent =
        attempt &&
        ["prepared", "unknown"].includes(String(attempt.status)) &&
        String(attempt.case_id) === command.approvalCaseId &&
        String(attempt.tenant_id) === command.binding.tenantId &&
        String(attempt.provider_account_id) ===
          command.binding.providerAccountId &&
        String(attempt.command_fingerprint) === command.fingerprint &&
        structurallyEqual(
          attempt.command_data
            ? JSON.parse(String(attempt.command_data))
            : undefined,
          command,
        ) &&
        structurallyEqual(request, input.request) &&
        structurallyEqual(immutable, command) &&
        String(turnResult.rows[0]?.command_fingerprint ?? "") ===
          command.fingerprint &&
        supportCase !== undefined &&
        structurallyEqual(
          bindingsForCase(supportCase).transactions,
          command.binding,
        ) &&
        ownerCurrent;
      let leaseCurrent = false;
      if (input.dispatch) {
        const dispatch = await tx.execute({
          sql: "SELECT id FROM support_dispatch WHERE id = ? AND case_id = ? AND turn_id = ? AND lease_token = ? AND state IN ('claimed', 'started') AND lease_until > ?",
          args: [
            input.dispatch.dispatchId,
            input.dispatch.caseId,
            input.dispatch.turnId,
            input.dispatch.leaseToken,
            now(),
          ],
        });
        leaseCurrent =
          Boolean(dispatch.rows[0]) &&
          String(attempt?.dispatch_id ?? "") === input.dispatch.dispatchId &&
          String(attempt?.lease_token ?? "") === input.dispatch.leaseToken &&
          String(attempt?.turn_id ?? "") === input.dispatch.turnId &&
          (supportCase?.metadata as Record<string, unknown> | undefined)
            ?.activeTurnId === input.dispatch.turnId;
      } else if (input.reconciliationLeaseToken) {
        leaseCurrent =
          String(attempt?.reconcile_lease_token ?? "") ===
            input.reconciliationLeaseToken &&
          Date.parse(String(attempt?.reconcile_lease_until ?? "")) > Date.now();
      }
      if (!commandCurrent || !leaseCurrent) {
        await tx.rollback();
        return false;
      }
      // The published policy evidence is immutable, but the deterministic
      // case policy can become more restrictive while a provider preflight is
      // in flight. A stale worker must observe that current prohibition at
      // the same transaction boundary as its lease and command checks.
      if (supportCase.draft?.requiresEscalation) {
        await tx.rollback();
        return false;
      }
      await input.validatePolicy(tx);
      await tx.commit();
      return true;
    } catch (error) {
      try {
        await tx.rollback();
      } catch {}
      throw error;
    }
  }
  /** The cancellation's durable claimed marker records a recovery obligation,
   * but is never permission to POST after preflight.  Re-check its current
   * workflow lease, command, turn, owner, and binding at the effect edge. */
  async authorizeSubscriptionCancellationFirstEffect(input: {
    command: SubscriptionCancellationCommand;
    dispatch: DispatchLeaseScope;
  }) {
    await this.ensured();
    const tx = await this.client.transaction("write");
    try {
      const command = input.command;
      const attemptResult = await tx.execute({
        sql: "SELECT * FROM support_subscription_cancellation_attempts WHERE idempotency_key = ? AND fingerprint = ?",
        args: [command.idempotencyKey, command.fingerprint],
      });
      const attempt = attemptResult.rows[0] as
        Record<string, unknown> | undefined;
      const caseResult = await tx.execute({
        sql: "SELECT data FROM support_cases WHERE id = ?",
        args: [command.caseId],
      });
      const supportCase = caseResult.rows[0]
        ? parse({ data: caseResult.rows[0].data })
        : undefined;
      const actionResult = await tx.execute({
        sql: "SELECT data FROM support_actions WHERE case_id = ? AND kind = 'subscription-cancellation-command' AND fingerprint = ?",
        args: [command.caseId, command.fingerprint],
      });
      const immutable = actionResult.rows[0]
        ? JSON.parse(String(actionResult.rows[0].data))
        : undefined;
      const turnResult = await tx.execute({
        sql: "SELECT command_fingerprint FROM support_turns WHERE id = ? AND case_id = ?",
        args: [command.turnId, command.caseId],
      });
      const dispatch = await tx.execute({
        sql: "SELECT id FROM support_dispatch WHERE id = ? AND case_id = ? AND turn_id = ? AND lease_token = ? AND state IN ('claimed', 'started') AND lease_until > ?",
        args: [
          input.dispatch.dispatchId,
          input.dispatch.caseId,
          input.dispatch.turnId,
          input.dispatch.leaseToken,
          now(),
        ],
      });
      const current =
        Boolean(dispatch.rows[0]) &&
        attempt &&
        String(attempt.status) === "claimed" &&
        String(attempt.case_id) === command.caseId &&
        String(attempt.turn_id) === command.turnId &&
        String(attempt.tenant_id) === command.binding.tenantId &&
        String(attempt.provider_account_id) ===
          command.binding.providerAccountId &&
        String(attempt.subscription_id) === command.subscriptionId &&
        structurallyEqual(
          attempt.command_data
            ? JSON.parse(String(attempt.command_data))
            : undefined,
          command,
        ) &&
        structurallyEqual(immutable, command) &&
        String(turnResult.rows[0]?.command_fingerprint ?? "") ===
          command.fingerprint &&
        supportCase !== undefined &&
        (supportCase.metadata as Record<string, unknown>).activeTurnId ===
          command.turnId &&
        (supportCase.metadata as Record<string, unknown>).ownerId ===
          command.ownerId &&
        ownerIdForCustomer(
          command.binding.tenantId,
          supportCase.customer.email,
        ) === command.ownerId &&
        structurallyEqual(
          bindingsForCase(supportCase).transactions,
          command.binding,
        );
      if (!current) {
        await tx.rollback();
        return false;
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
        sql: "UPDATE support_turns SET state = CASE WHEN ? = 'completed' AND state IN ('resolved', 'escalated') THEN state ELSE ? END, updated_at = ? WHERE id = (SELECT turn_id FROM support_dispatch WHERE id = ?)",
        args: [state, state, now(), id],
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
    terminalStatus: "failed" | "escalated" = "failed",
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
      const caseRow = await tx.execute({
        sql: "SELECT data, version FROM support_cases WHERE id = ?",
        args: [caseId],
      });
      const current = caseRow.rows[0]
        ? parse(caseRow.rows[0] as Record<string, unknown>)
        : undefined;
      await tx.execute({
        sql: "UPDATE support_turns SET state = ?, outcome_data = json_patch(COALESCE(outcome_data, '{}'), ?), updated_at = ? WHERE id = (SELECT turn_id FROM support_dispatch WHERE id = ?) AND case_id = ?",
        args: [
          terminalStatus,
          JSON.stringify({
            status: terminalStatus,
            triage: current?.triage,
            policyMatches: current?.policyMatches,
            orderLookup: current?.orderLookup,
            subscriptionLookup: current?.subscriptionLookup,
            refundHistory: current?.refundHistory,
            draft: current?.draft,
            approval: current?.approval,
            refundResult: current?.refundResult,
            finalResponse: current?.finalResponse,
            escalationReason: String(error),
            workflowRunId: current?.workflowRunId,
            ...(terminalStatus === "escalated"
              ? {
                  operationalFailure: {
                    disposition: "escalate",
                    recordedAt: now(),
                  },
                }
              : {}),
          }),
          now(),
          id,
          caseId,
        ],
      });
      if (caseRow.rows[0] && current) {
        const updated = this.withBindings({
          ...current,
          status: terminalStatus,
          escalationReason: String(error),
          metadata: { ...current.metadata, workflowStatus: terminalStatus },
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
  /** A provider/tool fault has a bounded durable retry path. The claim counter
   * is incremented before work begins, so this may only restore attempts 1-2;
   * the third failed claim falls through to terminal human escalation. */
  async retryDispatch(
    id: string,
    caseId: string,
    error: unknown,
    leaseToken?: string,
  ) {
    await this.ensured();
    const tx = await this.client.transaction("write");
    try {
      const retried = await tx.execute({
        sql: `UPDATE support_dispatch SET state = 'pending', lease_until = NULL, lease_token = NULL, last_error = ?, updated_at = ? WHERE id = ? AND case_id = ? AND state IN ('claimed', 'started') AND attempts < 3${leaseToken ? " AND lease_token = ?" : ""}`,
        args: leaseToken
          ? [String(error), now(), id, caseId, leaseToken]
          : [String(error), now(), id, caseId],
      });
      if (Number(retried.rowsAffected) !== 1) {
        await tx.rollback();
        return false;
      }
      await tx.execute({
        sql: "UPDATE support_turns SET state = 'pending', outcome_data = json_patch(COALESCE(outcome_data, '{}'), ?), updated_at = ? WHERE id = (SELECT turn_id FROM support_dispatch WHERE id = ?) AND case_id = ?",
        args: [
          JSON.stringify({
            operationalFailure: { disposition: "retry", recordedAt: now() },
          }),
          now(),
          id,
          caseId,
        ],
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
          sql: "UPDATE support_turns SET outcome_data = json_patch(COALESCE(outcome_data, '{}'), ?), updated_at = ? WHERE id = ? AND case_id = ?",
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
  /**
   * Called only after the route has authenticated the actor and read the
   * authoritative case binding.  Do not accept model-authored metadata here.
   */
  async recordSupervisorExecution(
    execution: Omit<SupervisorExecutionRecord, "id" | "createdAt">,
  ) {
    await this.ensured();
    await this.client.execute({
      sql: "INSERT INTO support_supervisor_executions(id, tenant_id, case_id, thread_id, actor_id, run_id, trace_id, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      args: [
        `supervisor_execution_${crypto.randomUUID()}`,
        execution.tenantId,
        execution.caseId,
        execution.threadId,
        execution.actorId,
        execution.runId,
        execution.traceId ?? null,
        execution.state,
        now(),
      ],
    });
  }
  /**
   * Monitoring joins the stored association to the durable case scope.  The
   * association's tenant field is therefore a second consistency check, never
   * authority by itself.
   */
  async supervisorExecutionsForMonitoring(tenantId: string, caseIds: string[]) {
    await this.ensured();
    if (!caseIds.length) return [] as SupervisorExecutionRecord[];
    const rows = await this.client.execute({
      sql: `SELECT e.id, e.tenant_id, e.case_id, e.thread_id, e.actor_id, e.run_id, e.trace_id, e.state, e.created_at
        FROM support_supervisor_executions e
        JOIN support_cases c ON c.id = e.case_id
        WHERE e.tenant_id = ? AND c.tenant_id = ? AND e.case_id IN (${caseIds.map(() => "?").join(", ")})
        ORDER BY e.created_at`,
      args: [tenantId, tenantId, ...caseIds],
    });
    return rows.rows.map((row) => ({
      id: String(row.id),
      tenantId: String(row.tenant_id),
      caseId: String(row.case_id),
      threadId: String(row.thread_id),
      actorId: String(row.actor_id),
      runId: String(row.run_id),
      traceId: row.trace_id ? String(row.trace_id) : undefined,
      state: String(row.state) as SupervisorExecutionRecord["state"],
      createdAt: String(row.created_at),
    }));
  }
  private async insertLegacyFeedback(
    tx: Pick<Client, "execute">,
    caseId: string,
    feedback: CaseFeedback,
  ) {
    const turn =
      typeof feedback.turnId === "string"
        ? await tx.execute({
            sql: "SELECT id FROM support_turns WHERE id = ? AND case_id = ?",
            args: [feedback.turnId, caseId],
          })
        : undefined;
    const knownTurn = turn?.rows[0] ? String(turn.rows[0].id) : undefined;
    const knownActor =
      typeof feedback.actorId === "string" && feedback.actorId.length > 0
        ? feedback.actorId
        : undefined;
    const knownTime =
      typeof feedback.submittedAt === "string" &&
      Number.isFinite(Date.parse(feedback.submittedAt));
    const attributionState =
      knownTurn && knownActor && knownTime ? "known" : "legacy-unknown";
    const turnId = knownTurn ?? `legacy:unknown:${caseId}`;
    const actorId = knownActor ?? "legacy:unknown";
    const existing = await tx.execute({
      sql: "SELECT id FROM support_feedback WHERE case_id = ? AND turn_id = ? AND actor_id = ? AND dedupe_key = ?",
      args: [caseId, turnId, actorId, feedback.rating],
    });
    if (existing.rows[0]) return;
    await tx.execute({
      sql: "INSERT INTO support_feedback(id, case_id, turn_id, actor_id, data, created_at, dedupe_key, attribution_state) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      args: [
        `feedback_legacy_${crypto.randomUUID()}`,
        caseId,
        turnId,
        actorId,
        JSON.stringify(feedback),
        knownTime ? feedback.submittedAt : null,
        feedback.rating,
        attributionState,
      ],
    });
  }
  async recordFeedback(input: {
    caseId: string;
    turnId: string;
    actorId: string;
    feedback: CaseFeedback;
  }): Promise<CaseFeedback> {
    await this.ensured();
    const tx = await this.client.transaction("write");
    try {
      const turn = await tx.execute({
        sql: "SELECT state, run_id, outcome_data FROM support_turns WHERE id = ? AND case_id = ?",
        args: [input.turnId, input.caseId],
      });
      const row = turn.rows[0] as Record<string, unknown> | undefined;
      const outcome = row?.outcome_data
        ? (JSON.parse(String(row.outcome_data)) as {
            status?: unknown;
            finalResponse?: unknown;
            telemetry?: { traceId?: unknown };
          })
        : undefined;
      // Dispatch completion is a separate lifecycle. A finalized immutable
      // response remains rateable even though its dispatch is "completed".
      if (
        !row ||
        !["resolved", "escalated"].includes(String(outcome?.status)) ||
        typeof outcome?.finalResponse !== "string"
      )
        throw new Error("Feedback must target a completed response turn.");
      const telemetry = outcome?.telemetry;
      if (
        input.feedback.runId !==
          (row.run_id ? String(row.run_id) : undefined) ||
        input.feedback.traceId !==
          (typeof telemetry?.traceId === "string"
            ? telemetry.traceId
            : undefined)
      )
        throw new Error(
          "Feedback correlation does not match the response turn.",
        );
      const supportCase = await tx.execute({
        sql: "SELECT data FROM support_cases WHERE id = ?",
        args: [input.caseId],
      });
      const legacy = supportCase.rows[0]
        ? parse(supportCase.rows[0] as Record<string, unknown>).feedback
        : undefined;
      // A projection can predate the feedback table or point to an earlier
      // turn. Preserve it before the route replaces the active projection.
      if (legacy) await this.insertLegacyFeedback(tx, input.caseId, legacy);
      const existing = await tx.execute({
        sql: "SELECT data FROM support_feedback WHERE case_id = ? AND turn_id = ? AND actor_id = ? AND dedupe_key = ?",
        args: [
          input.caseId,
          input.turnId,
          input.actorId,
          input.feedback.rating,
        ],
      });
      if (existing.rows[0]) {
        await tx.commit();
        return JSON.parse(String(existing.rows[0].data)) as CaseFeedback;
      }
      await tx.execute({
        sql: "INSERT INTO support_feedback(id, case_id, turn_id, actor_id, data, created_at, dedupe_key, attribution_state) VALUES (?, ?, ?, ?, ?, ?, ?, 'known')",
        args: [
          `feedback_${crypto.randomUUID()}`,
          input.caseId,
          input.turnId,
          input.actorId,
          JSON.stringify(input.feedback),
          input.feedback.submittedAt,
          input.feedback.rating,
        ],
      });
      await tx.commit();
      return input.feedback;
    } catch (error) {
      try {
        await tx.rollback();
      } catch {}
      throw error;
    }
  }
  async feedback(caseIds: string[]): Promise<FeedbackRecord[]> {
    await this.ensured();
    if (!caseIds.length) return [];
    const rows = await this.client.execute({
      sql: `SELECT id, case_id, data, attribution_state FROM support_feedback WHERE case_id IN (${caseIds.map(() => "?").join(", ")}) ORDER BY created_at DESC`,
      args: caseIds,
    });
    return rows.rows.map((row) => ({
      id: String(row.id),
      caseId: String(row.case_id),
      feedback: JSON.parse(String(row.data)) as CaseFeedback,
      attributionState:
        String(row.attribution_state) === "legacy-unknown"
          ? "legacy-unknown"
          : "known",
    }));
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
    // A durable marker is written before a non-idempotent Intercom POST.  If a
    // process disappears after that point, the remote effect is unknowable and
    // must be escalated rather than reclaimed like an effectless local claim.
    const interrupted = await this.client.execute({
      sql: "SELECT id FROM support_outbox WHERE state = 'started' AND lease_until < ? AND json_extract(binding, '$.providerKind') = 'intercom'",
      args: [claimedAt],
    });
    for (const row of interrupted.rows)
      await this.markOutboxUncertain(
        String(row.id),
        "Intercom operation was interrupted after its durable start marker.",
        undefined,
        "started",
      );
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
      // A rate limit blocks its whole provider account, not unrelated tenants.
      // Within a case, earlier undelivered operations fence later operations.
      sql: `SELECT candidate.* FROM support_outbox candidate
        WHERE (candidate.state = 'pending' OR (candidate.state = 'claimed' AND candidate.lease_until < ?))
          AND candidate.attempts < 3
          AND (candidate.next_attempt_at IS NULL OR candidate.next_attempt_at <= ?)
          AND NOT EXISTS (SELECT 1 FROM support_outbox_account_limits l WHERE l.tenant_id = json_extract(candidate.binding, '$.tenantId') AND l.provider_kind = json_extract(candidate.binding, '$.providerKind') AND l.provider_account_id = json_extract(candidate.binding, '$.providerAccountId') AND l.blocked_until > ?)
          AND NOT EXISTS (SELECT 1 FROM support_outbox earlier WHERE earlier.case_id = candidate.case_id AND (earlier.created_at < candidate.created_at OR (earlier.created_at = candidate.created_at AND earlier.id < candidate.id)) AND earlier.state <> 'delivered')
          ${excluded} ORDER BY candidate.created_at, candidate.id LIMIT ?`,
      args: [claimedAt, claimedAt, claimedAt, ...excludeIds, limit],
    });
    const claimed: OutboxRecord[] = [];
    for (const row of rows.rows) {
      const leaseToken = crypto.randomUUID();
      const changed = await this.client.execute({
        sql: `UPDATE support_outbox SET state = 'claimed', attempts = attempts + 1, lease_until = ?, lease_token = ?, updated_at = ? WHERE id = ? AND (state = 'pending' OR (state = 'claimed' AND lease_until < ?)) AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
          AND NOT EXISTS (SELECT 1 FROM support_outbox_account_limits l WHERE l.tenant_id = json_extract(support_outbox.binding, '$.tenantId') AND l.provider_kind = json_extract(support_outbox.binding, '$.providerKind') AND l.provider_account_id = json_extract(support_outbox.binding, '$.providerAccountId') AND l.blocked_until > ?)
          AND NOT EXISTS (SELECT 1 FROM support_outbox earlier WHERE earlier.case_id = support_outbox.case_id AND (earlier.created_at < support_outbox.created_at OR (earlier.created_at = support_outbox.created_at AND earlier.id < support_outbox.id)) AND earlier.state <> 'delivered')`,
        args: [
          leaseUntil,
          leaseToken,
          claimedAt,
          String(row.id),
          claimedAt,
          claimedAt,
          claimedAt,
        ],
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
      sql: "UPDATE support_outbox SET lease_until = ?, updated_at = ? WHERE id = ? AND lease_token = ? AND state IN ('claimed', 'started')",
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
  /** Durable pre-effect boundary for providers without a documented idempotency
   * key.  It is intentionally not used by the local provider's recovery path. */
  async markOutboxStarted(id: string, leaseToken: string) {
    await this.ensured();
    const changed = await this.client.execute({
      sql: "UPDATE support_outbox SET state = 'started', updated_at = ? WHERE id = ? AND state = 'claimed' AND lease_token = ? AND lease_until > ?",
      args: [now(), id, leaseToken, now()],
    });
    return Number(changed.rowsAffected) === 1;
  }
  /** A POST with an unknown outcome is never eligible for automatic replay.
   * Persist it visibly and project an escalation marker for staff recovery. */
  async markOutboxUncertain(
    id: string,
    error: unknown,
    leaseToken?: string,
    expectedState?: "claimed" | "started",
  ) {
    await this.ensured();
    const tx = await this.client.transaction("write");
    try {
      const changed = await tx.execute({
        sql: `UPDATE support_outbox SET state = 'uncertain', last_error = ?, lease_until = NULL, lease_token = NULL, updated_at = ? WHERE id = ?${leaseToken ? " AND lease_token = ?" : ""}${expectedState ? " AND state = ?" : ""}`,
        args: [
          String(error),
          now(),
          id,
          ...(leaseToken ? [leaseToken] : []),
          ...(expectedState ? [expectedState] : []),
        ],
      });
      if (Number(changed.rowsAffected) !== 1) {
        await tx.rollback();
        return false;
      }
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
            status: "escalated",
            escalationReason:
              "Outbound Intercom effect has an uncertain remote outcome and requires manual reconciliation.",
            metadata: {
              ...current.metadata,
              deliveryStatus: "uncertain",
              deliveryError: String(error),
            },
            updatedAt: now(),
          });
          const write = await tx.execute({
            sql: "UPDATE support_cases SET data = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?",
            args: [
              JSON.stringify(updated),
              updated.updatedAt,
              caseId,
              Number(row.rows[0].version ?? 1),
            ],
          });
          if (Number(write.rowsAffected) !== 1)
            throw new StaleCaseWriteError(caseId);
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
  async retryOutbox(
    id: string,
    error: unknown,
    terminal = false,
    leaseToken?: string,
    retryAfterMs?: number,
    rateLimited = false,
  ) {
    await this.ensured();
    const tx = await this.client.transaction("write");
    try {
      // The terminal case projection is part of the same fenced transition as
      // the outbox row.  A stale worker therefore cannot overwrite the case
      // after the current owner has delivered the item.
      const outboxRow = await tx.execute({
        sql: "SELECT binding, attempts FROM support_outbox WHERE id = ?",
        args: [id],
      });
      const binding = outboxRow.rows[0]
        ? (JSON.parse(String(outboxRow.rows[0].binding)) as ProviderBinding)
        : undefined;
      const providerDelayIsValid =
        retryAfterMs === undefined ||
        (Number.isFinite(retryAfterMs) &&
          retryAfterMs >= 0 &&
          retryAfterMs <= MAX_INTERCOM_PROVIDER_RETRY_DELAY_MS);
      if (
        !terminal &&
        binding?.providerKind === "intercom" &&
        !providerDelayIsValid
      ) {
        // A provider-directed delay we cannot represent must be surfaced as a
        // terminal local failure. Never silently bring the retry forward.
        terminal = true;
        error = `Permanent: Intercom provider retry delay is outside scheduler bounds. ${String(error)}`;
      }
      // Provider-directed waits are retained exactly. Exponential fallback is
      // separately bounded for local operational recovery.
      const retryDelayMs =
        retryAfterMs ??
        Math.min(
          Math.max(
            1_000 * 2 ** Number(outboxRow.rows[0]?.attempts ?? 1),
            1_000,
          ),
          MAX_INTERCOM_FALLBACK_RETRY_DELAY_MS,
        );
      const retryAt =
        !terminal && binding?.providerKind === "intercom"
          ? new Date(Date.now() + retryDelayMs).toISOString()
          : null;
      if (rateLimited && !terminal && binding?.providerKind === "intercom") {
        await tx.execute({
          sql: "INSERT INTO support_outbox_account_limits(tenant_id, provider_kind, provider_account_id, blocked_until, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(tenant_id, provider_kind, provider_account_id) DO UPDATE SET blocked_until = CASE WHEN excluded.blocked_until > blocked_until THEN excluded.blocked_until ELSE blocked_until END, updated_at = excluded.updated_at",
          args: [
            binding.tenantId,
            binding.providerKind,
            binding.providerAccountId,
            retryAt!,
            now(),
          ],
        });
      }
      const changed = await tx.execute({
        sql: `UPDATE support_outbox SET state = ?, last_error = ?, next_attempt_at = ?, lease_until = NULL, lease_token = NULL, updated_at = ? WHERE id = ?${leaseToken ? " AND lease_token = ?" : ""}`,
        args: leaseToken
          ? [
              terminal ? "failed" : "pending",
              String(error),
              retryAt,
              now(),
              id,
              leaseToken,
            ]
          : [
              terminal ? "failed" : "pending",
              String(error),
              retryAt,
              now(),
              id,
            ],
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
      operation: ["reply", "note", "status", "ticket"].includes(
        String(row.operation),
      )
        ? (String(row.operation) as OutboxOperation)
        : "reply",
      payloadFingerprint: row.payload_fingerprint
        ? String(row.payload_fingerprint)
        : undefined,
      nextAttemptAt: row.next_attempt_at
        ? String(row.next_attempt_at)
        : undefined,
      state,
      attempts: Number(row.attempts) + 1,
      receipt: row.receipt ? JSON.parse(String(row.receipt)) : undefined,
      lastError: row.last_error ? String(row.last_error) : undefined,
      leaseToken: row.lease_token ? String(row.lease_token) : undefined,
      originatingTurnId: row.originating_turn_id
        ? String(row.originating_turn_id)
        : undefined,
      originatingRunId: row.originating_run_id
        ? String(row.originating_run_id)
        : undefined,
      originatingTraceId: row.originating_trace_id
        ? String(row.originating_trace_id)
        : undefined,
      correlationState:
        String(row.correlation_state) === "known" ? "known" : "unknown",
    };
  }
  private outboxFingerprint(
    binding: ProviderBinding,
    operation: OutboxOperation,
    body: string,
    status: string,
  ) {
    return createHash("sha256")
      .update(JSON.stringify({ binding, operation, body, status }))
      .digest("hex");
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
  /** Atomically claim one verified Stripe event. A completed receipt is an
   * acknowledgement-only replay; an unexpired lease asks the provider to retry
   * later without starting a second reconciliation. */
  async claimStripeWebhookEvent(
    eventId: string,
  ): Promise<
    | { state: "claimed"; leaseToken: string }
    | { state: "completed" }
    | { state: "in-progress" }
  > {
    await this.ensured();
    const tx = await this.client.transaction("write");
    const claimedAt = now();
    const leaseUntil = new Date(Date.now() + 30_000).toISOString();
    const leaseToken = crypto.randomUUID();
    try {
      const existing = await tx.execute({
        sql: "SELECT state, lease_until FROM support_stripe_webhook_receipts WHERE event_id = ?",
        args: [eventId],
      });
      const row = existing.rows[0] as Record<string, unknown> | undefined;
      if (!row) {
        await tx.execute({
          sql: "INSERT INTO support_stripe_webhook_receipts(event_id, state, lease_token, lease_until, created_at, updated_at) VALUES (?, 'processing', ?, ?, ?, ?)",
          args: [eventId, leaseToken, leaseUntil, claimedAt, claimedAt],
        });
        await tx.commit();
        return { state: "claimed", leaseToken };
      }
      if (String(row.state) === "completed") {
        await tx.rollback();
        return { state: "completed" };
      }
      if (
        String(row.state) === "processing" &&
        typeof row.lease_until === "string" &&
        row.lease_until > claimedAt
      ) {
        await tx.rollback();
        return { state: "in-progress" };
      }
      const recovered = await tx.execute({
        sql: "UPDATE support_stripe_webhook_receipts SET state = 'processing', lease_token = ?, lease_until = ?, updated_at = ? WHERE event_id = ? AND state <> 'completed'",
        args: [leaseToken, leaseUntil, claimedAt, eventId],
      });
      if (Number(recovered.rowsAffected) !== 1)
        throw new Error("Stripe webhook receipt claim was lost.");
      await tx.commit();
      return { state: "claimed", leaseToken };
    } catch (error) {
      try {
        await tx.rollback();
      } catch {}
      throw error;
    }
  }
  /** Completion is deliberately separate from receipt creation: a process can
   * die after claiming, and a later signed delivery can recover the expired
   * lease instead of treating unprocessed work as a duplicate. */
  async completeStripeWebhookEvent(eventId: string, leaseToken: string) {
    await this.ensured();
    const completedAt = now();
    const result = await this.client.execute({
      sql: "UPDATE support_stripe_webhook_receipts SET state = 'completed', lease_token = NULL, lease_until = NULL, completed_at = ?, updated_at = ? WHERE event_id = ? AND state = 'processing' AND lease_token = ?",
      args: [completedAt, completedAt, eventId, leaseToken],
    });
    return Number(result.rowsAffected) === 1;
  }
  /** Do not persist provider error details here. A failed receipt is immediately
   * recoverable by the next signed delivery and carries no raw webhook data. */
  async failStripeWebhookEvent(eventId: string, leaseToken: string) {
    await this.ensured();
    const result = await this.client.execute({
      sql: "UPDATE support_stripe_webhook_receipts SET state = 'failed', lease_token = NULL, lease_until = NULL, updated_at = ? WHERE event_id = ? AND state = 'processing' AND lease_token = ?",
      args: [now(), eventId, leaseToken],
    });
    return Number(result.rowsAffected) === 1;
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
        // Exhausted retries deliberately become customer-visible escalations;
        // their immutable operationalFailure is still a workflow failure.
        sql: `SELECT COUNT(*) AS total FROM support_turns WHERE (state = 'failed' OR (state = 'escalated' AND json_extract(outcome_data, '$.operationalFailure.disposition') = 'escalate')) AND case_id IN (${placeholders})`,
        args: caseIds,
      }),
      this.client.execute({
        // A workflow/delivery failure after a successful refund is not a
        // financial failure. Only an explicitly durable provider failure is.
        sql: `SELECT COUNT(*) AS total FROM support_actions WHERE kind = 'refund-failure' AND case_id IN (${placeholders})`,
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
  async monitoringFinancialFailures(caseIds: string[]) {
    await this.ensured();
    if (!caseIds.length) return 0;
    const result = await this.client.execute({
      sql: `SELECT COUNT(*) AS total FROM support_actions WHERE kind = 'refund-failure' AND case_id IN (${caseIds.map(() => "?").join(", ")})`,
      args: caseIds,
    });
    return Number(result.rows[0]?.total ?? 0);
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
    // Stripe's immutable attempt ledger is the authority for a financial
    // replay. A success effect can be written before a later provider failure
    // arrives, so never expose that stale row after the ledger terminalizes
    // failed/quarantined. Local effects have no Stripe attempt and retain the
    // original direct idempotency behavior.
    const ledger = await this.client.execute({
      sql: "SELECT status FROM support_stripe_refund_attempts WHERE idempotency_key = ?",
      args: [key],
    });
    if (ledger.rows[0] && String(ledger.rows[0].status) !== "succeeded")
      return undefined;
    const result = await this.client.execute({
      sql: "SELECT fingerprint, effect FROM support_idempotency WHERE idempotency_key = ?",
      args: [key],
    });
    if (!result.rows[0]) return undefined;
    const effect = JSON.parse(String(result.rows[0].effect));
    if (isFinancialRetentionTombstone(effect))
      throw financialRetentionTombstoneError();
    return {
      fingerprint: String(result.rows[0].fingerprint),
      effect,
    };
  }
  /** Project one native tool receipt with its replay effect only while the
   * current immutable Stripe attempt still permits it. This reads the attempt
   * and case in the same write transaction, so a webhook finalizer cannot win
   * between a separate version read and a stale projection/effect write. */
  async projectRefundToolExecution(input: {
    caseId: string;
    turnId: string;
    fingerprint: string;
    idempotencyKey: string;
    result: NonNullable<SupportCase["refundResult"]>;
    effect?: unknown;
  }): Promise<NonNullable<SupportCase["refundResult"]>> {
    await this.ensured();
    const tx = await this.client.transaction("write");
    try {
      const caseResult = await tx.execute({
        sql: "SELECT data, version FROM support_cases WHERE id = ?",
        args: [input.caseId],
      });
      const row = caseResult.rows[0] as Record<string, unknown> | undefined;
      if (!row) throw new Error(`Support case not found: ${input.caseId}`);
      const current = parse({ data: row.data });
      const metadata = current.metadata as Record<string, unknown>;
      const command = metadata.refundCommand as
        { fingerprint?: unknown; idempotencyKey?: unknown } | undefined;
      const native = metadata.nativeApproval as
        { fingerprint?: unknown; turnId?: unknown } | undefined;
      // Migrations give pre-turn records a durable legacy turn identity, but
      // those records have no activeTurnId projection marker. Accept only the
      // exact per-case legacy identity when the marker is absent; any actual
      // active turn, including a newer one, must still match this execution.
      const currentTurn =
        metadata.activeTurnId === input.turnId ||
        (metadata.activeTurnId === undefined &&
          input.turnId === `legacy:${input.caseId}`);
      if (
        !currentTurn ||
        command?.fingerprint !== input.fingerprint ||
        command.idempotencyKey !== input.idempotencyKey ||
        native?.fingerprint !== input.fingerprint ||
        native.turnId !== input.turnId
      )
        throw new Error(
          "Refund projection does not match the current immutable command and turn.",
        );
      const lease = activeDispatchLeaseScope();
      if (lease) {
        const owned = await tx.execute({
          sql: "SELECT id FROM support_dispatch WHERE id = ? AND case_id = ? AND turn_id = ? AND lease_token = ? AND state IN ('claimed', 'started') AND lease_until > ?",
          args: [
            lease.dispatchId,
            input.caseId,
            input.turnId,
            lease.leaseToken,
            now(),
          ],
        });
        if (!owned.rows[0])
          throw new StaleCaseWriteError(
            `Dispatch lease is no longer current for ${input.caseId}.`,
          );
      }
      const ledgerResult = await tx.execute({
        sql: "SELECT case_id, turn_id, command_fingerprint, status FROM support_stripe_refund_attempts WHERE idempotency_key = ?",
        args: [input.idempotencyKey],
      });
      const ledger = ledgerResult.rows[0] as
        Record<string, unknown> | undefined;
      if (ledger) {
        if (
          String(ledger.case_id) !== input.caseId ||
          String(ledger.turn_id) !== input.turnId ||
          String(ledger.command_fingerprint) !== input.fingerprint
        )
          throw new Error(
            "Refund projection ledger does not match the immutable command and turn.",
          );
        if (["failed", "quarantined"].includes(String(ledger.status))) {
          const authoritative = current.refundResult;
          if (!authoritative || authoritative.status !== "failed")
            throw new Error(
              "Failed refund ledger is missing its authoritative case projection.",
            );
          await tx.commit();
          return authoritative;
        }
      }
      const updated = this.withBindings({
        ...current,
        refundResult: input.result,
        metadata: {
          ...metadata,
          refundEffects: {
            ...(metadata.refundEffects as Record<string, unknown> | undefined),
            [input.fingerprint]: input.result,
          },
        },
        updatedAt: now(),
      } as SupportCase);
      const write = await tx.execute({
        sql: "UPDATE support_cases SET data = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?",
        args: [
          JSON.stringify(updated),
          updated.updatedAt,
          input.caseId,
          Number(row.version),
        ],
      });
      if (Number(write.rowsAffected ?? 0) !== 1)
        throw new StaleCaseWriteError(input.caseId);
      if (input.effect)
        await tx.execute({
          sql: "INSERT OR IGNORE INTO support_idempotency(idempotency_key, fingerprint, effect, created_at) VALUES (?, ?, ?, ?)",
          args: [
            input.idempotencyKey,
            input.fingerprint,
            JSON.stringify(input.effect),
            now(),
          ],
        });
      await tx.commit();
      return input.result;
    } catch (error) {
      try {
        await tx.rollback();
      } catch {}
      throw error;
    }
  }
  async prepareStripeRefundAttempt(input: {
    caseId: string;
    binding: ProviderBinding;
    fingerprint: string;
    idempotencyKey: string;
    dispatchId: string;
    leaseToken: string;
    turnId: string;
    command: unknown;
  }) {
    await this.ensured();
    const retained = await this.client.execute({
      sql: "SELECT effect FROM support_idempotency WHERE idempotency_key = ?",
      args: [input.idempotencyKey],
    });
    if (
      retained.rows[0] &&
      isFinancialRetentionTombstone(JSON.parse(String(retained.rows[0].effect)))
    )
      throw financialRetentionTombstoneError();
    const createdAt = now();
    await this.client.execute({
      sql: "INSERT OR IGNORE INTO support_stripe_refund_attempts(id, case_id, tenant_id, provider_account_id, command_fingerprint, idempotency_key, dispatch_id, lease_token, turn_id, command_data, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?)",
      args: [
        `stripe_attempt_${crypto.randomUUID()}`,
        input.caseId,
        input.binding.tenantId,
        input.binding.providerAccountId,
        input.fingerprint,
        input.idempotencyKey,
        input.dispatchId,
        input.leaseToken,
        input.turnId,
        JSON.stringify(input.command),
        createdAt,
        createdAt,
      ],
    });
    const row = await this.client.execute({
      sql: "SELECT * FROM support_stripe_refund_attempts WHERE idempotency_key = ?",
      args: [input.idempotencyKey],
    });
    const found = row.rows[0] as Record<string, unknown> | undefined;
    if (
      !found ||
      String(found.case_id) !== input.caseId ||
      String(found.tenant_id) !== input.binding.tenantId ||
      String(found.provider_account_id) !== input.binding.providerAccountId ||
      String(found.command_fingerprint) !== input.fingerprint ||
      String(found.turn_id) !== input.turnId ||
      !structurallyEqual(
        found.command_data ? JSON.parse(String(found.command_data)) : undefined,
        input.command,
      )
    )
      throw new Error(
        "Stripe idempotency key was reused with a conflicting command.",
      );
    return this.stripeAttempt(found);
  }
  async updateStripeRefundAttempt(
    idempotencyKey: string,
    update: {
      status: "pending" | "succeeded" | "failed" | "unknown" | "quarantined";
      refundId?: string;
      providerStatus?: string;
      nextAttemptAt?: string;
    },
  ) {
    await this.ensured();
    const terminal = ["succeeded", "failed", "quarantined"].includes(
      update.status,
    );
    const write = await this.client.execute({
      sql: "UPDATE support_stripe_refund_attempts SET status = ?, refund_id = COALESCE(?, refund_id), provider_status = COALESCE(?, provider_status), next_attempt_at = ?, reconcile_lease_token = NULL, reconcile_lease_until = NULL, terminal_at = CASE WHEN ? THEN COALESCE(terminal_at, ?) ELSE terminal_at END, updated_at = ? WHERE idempotency_key = ? AND (status NOT IN ('succeeded', 'failed', 'quarantined') OR status = ?)",
      args: [
        update.status,
        update.refundId ?? null,
        update.providerStatus ?? null,
        update.nextAttemptAt ?? null,
        terminal ? 1 : 0,
        now(),
        now(),
        idempotencyKey,
        update.status,
      ],
    });
    return Number(write.rowsAffected ?? 0) === 1;
  }
  async persistStripeRefundRequest(
    idempotencyKey: string,
    request: { paymentIntentId: string; providerRefs: unknown[] },
  ) {
    await this.ensured();
    const write = await this.client.execute({
      sql: "UPDATE support_stripe_refund_attempts SET stripe_request_data = ?, updated_at = ? WHERE idempotency_key = ? AND status = 'prepared' AND stripe_request_data IS NULL",
      args: [JSON.stringify(request), now(), idempotencyKey],
    });
    if (Number(write.rowsAffected ?? 0) !== 1) {
      const found = await this.stripeRefundAttempt(idempotencyKey);
      if (
        !found?.stripeRequest ||
        !structurallyEqual(found.stripeRequest, request)
      )
        throw new Error("Stripe refund request target was already changed.");
    }
    return this.stripeRefundAttempt(idempotencyKey);
  }
  /** Release only the lease owned by this reconciliation worker while
   * scheduling its retry. A stale worker cannot clobber a newer claim. */
  async rescheduleStripeRefundAttempt(input: {
    idempotencyKey: string;
    reconcileLeaseToken: string;
    status: "pending" | "succeeded" | "unknown" | "quarantined";
    refundId?: string;
    providerStatus?: string;
    nextAttemptAt?: string;
  }) {
    await this.ensured();
    const write = await this.client.execute({
      sql: "UPDATE support_stripe_refund_attempts SET status = ?, refund_id = COALESCE(?, refund_id), provider_status = COALESCE(?, provider_status), next_attempt_at = ?, reconcile_lease_token = NULL, reconcile_lease_until = NULL, terminal_at = CASE WHEN ? THEN COALESCE(terminal_at, ?) ELSE terminal_at END, reconcile_attempts = reconcile_attempts + 1, updated_at = ? WHERE idempotency_key = ? AND reconcile_lease_token = ? AND reconcile_lease_until > ? AND status NOT IN ('succeeded', 'failed', 'quarantined')",
      args: [
        input.status,
        input.refundId ?? null,
        input.providerStatus ?? null,
        input.nextAttemptAt ?? null,
        input.status === "quarantined" ? 1 : 0,
        now(),
        now(),
        input.idempotencyKey,
        input.reconcileLeaseToken,
        now(),
      ],
    });
    return Number(write.rowsAffected ?? 0) === 1;
  }
  /** Commit terminal provider state, the case projection, and its one customer
   * notification together. A crash cannot leave a succeeded attempt with no
   * final outbox item, and a later follow-up cannot be overwritten because the
   * attempt's immutable originating turn owns the projection. */
  async finalizeStripeRefundReconciliation(input: {
    idempotencyKey: string;
    status: "succeeded" | "failed" | "pending" | "quarantined";
    refundId: string;
    providerStatus: string;
    effect?: unknown;
    reconcileLeaseToken?: string;
  }) {
    await this.ensured();
    const tx = await this.client.transaction("write");
    try {
      const attemptResult = await tx.execute({
        sql: "SELECT * FROM support_stripe_refund_attempts WHERE idempotency_key = ?",
        args: [input.idempotencyKey],
      });
      const attempt = attemptResult.rows[0] as
        Record<string, unknown> | undefined;
      if (!attempt) {
        await tx.rollback();
        return false;
      }
      const previousStatus = String(attempt.status);
      const leaseOwned =
        !input.reconcileLeaseToken ||
        (String(attempt.reconcile_lease_token ?? "") ===
          input.reconcileLeaseToken &&
          Date.parse(String(attempt.reconcile_lease_until ?? "")) > Date.now());
      const transitionAllowed =
        leaseOwned &&
        !(
          input.status === "succeeded" &&
          ["failed", "quarantined"].includes(previousStatus)
        ) &&
        !(
          input.status === "pending" &&
          ["succeeded", "failed", "quarantined"].includes(previousStatus)
        ) &&
        !(
          input.status === "quarantined" &&
          ["succeeded", "failed", "quarantined"].includes(previousStatus)
        );
      if (!transitionAllowed) {
        await tx.rollback();
        return false;
      }
      const terminal = ["succeeded", "failed", "quarantined"].includes(
        input.status,
      );
      const updateArgs: (string | number | null)[] = [
        input.status,
        input.refundId,
        input.providerStatus,
        input.status === "pending"
          ? new Date(Date.now() + 30_000).toISOString()
          : input.status === "succeeded"
            ? new Date(Date.now() + 5 * 60_000).toISOString()
            : null,
        terminal ? 1 : 0,
        now(),
        now(),
        input.idempotencyKey,
      ];
      let updateSql =
        "UPDATE support_stripe_refund_attempts SET status = ?, refund_id = ?, provider_status = ?, next_attempt_at = ?, reconcile_lease_token = NULL, reconcile_lease_until = NULL, terminal_at = CASE WHEN ? THEN COALESCE(terminal_at, ?) ELSE terminal_at END, reconcile_attempts = reconcile_attempts + 1, updated_at = ? WHERE idempotency_key = ? AND (status NOT IN ('succeeded', 'failed', 'quarantined') OR (status = 'succeeded' AND ? = 'failed') OR (status = 'failed' AND ? = 'failed'))";
      updateArgs.push(input.status);
      updateArgs.push(input.status);
      if (input.reconcileLeaseToken) {
        updateSql +=
          " AND reconcile_lease_token = ? AND reconcile_lease_until > ?";
        updateArgs.push(input.reconcileLeaseToken, now());
      }
      const attemptWrite = await tx.execute({
        sql: updateSql,
        args: updateArgs,
      });
      if (Number(attemptWrite.rowsAffected ?? 0) !== 1) {
        await tx.rollback();
        return false;
      }
      if (input.status === "pending") {
        await tx.commit();
        return false;
      }
      // A later authoritative failure supersedes a previously persisted
      // success effect in this same ledger/case transaction. Readers also
      // consult the attempt ledger, but deleting the stale effect prevents a
      // process restart from treating historical success bytes as executable.
      if (input.status === "failed")
        await tx.execute({
          sql: "DELETE FROM support_idempotency WHERE idempotency_key = ? AND fingerprint = ?",
          args: [input.idempotencyKey, String(attempt.command_fingerprint)],
        });
      const caseResult = await tx.execute({
        sql: "SELECT data, version FROM support_cases WHERE id = ?",
        args: [String(attempt.case_id)],
      });
      const row = caseResult.rows[0] as Record<string, unknown> | undefined;
      if (!row) {
        await tx.commit();
        return false;
      }
      const current = parse({ data: row.data });
      const turnId = attempt.turn_id ? String(attempt.turn_id) : undefined;
      const activeTurnId = (current.metadata as Record<string, unknown>)
        .activeTurnId;
      // Keep the provider audit authoritative, but never change a current case
      // projection that belongs to a newer customer turn.
      if (!turnId) {
        await tx.commit();
        return false;
      }
      // A follow-up owns the current case projection, but it cannot erase the
      // financial outcome of this attempt's immutable originating turn.
      if (activeTurnId !== turnId) {
        const response =
          input.status === "succeeded"
            ? "Your refund has been issued."
            : "The refund requires additional review. A support specialist will follow up shortly.";
        const terminal =
          input.status === "succeeded" ? "resolved" : "escalated";
        await tx.execute({
          sql: "UPDATE support_turns SET state = ?, outcome_data = json_patch(COALESCE(outcome_data, '{}'), ?), updated_at = ? WHERE id = ? AND case_id = ?",
          args: [
            terminal,
            JSON.stringify({
              status: terminal,
              finalResponse: response,
              refundId: input.refundId,
            }),
            now(),
            turnId,
            current.id,
          ],
        });
        if (input.status === "succeeded")
          await tx.execute({
            sql: "INSERT OR IGNORE INTO support_idempotency(idempotency_key, fingerprint, effect, created_at) VALUES (?, ?, ?, ?)",
            args: [
              input.idempotencyKey,
              String(attempt.command_fingerprint),
              JSON.stringify(input.effect ?? {}),
              now(),
            ],
          });
        else
          await tx.execute({
            sql: "INSERT OR IGNORE INTO support_actions(id, case_id, kind, fingerprint, data, created_at) VALUES (?, ?, 'refund-failure', ?, ?, ?)",
            args: [
              `action_${current.id}_${turnId}_refund-failure`,
              current.id,
              String(attempt.command_fingerprint),
              JSON.stringify({
                category: "provider",
                classification: "confirmed-failed",
                refundId: input.refundId,
              }),
              now(),
            ],
          });
        await tx.execute({
          sql: "INSERT OR IGNORE INTO support_outbox(id, case_id, binding, body, status, operation, payload_fingerprint, state, originating_turn_id, correlation_state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'reply', ?, 'pending', ?, 'unknown', ?, ?)",
          args: [
            `outbox_${current.id}_${turnId}_${input.status === "succeeded" ? "refund-final" : "refund-failed"}`,
            current.id,
            JSON.stringify(bindingsForCase(current).support),
            response,
            terminal,
            this.outboxFingerprint(
              bindingsForCase(current).support,
              "reply",
              response,
              terminal,
            ),
            turnId,
            now(),
            now(),
          ],
        });
        await tx.commit();
        return true;
      }
      if (input.status === "succeeded") {
        const currentRefund = current.refundResult;
        if (currentRefund?.status === "failed") {
          await tx.commit();
          return false;
        }
        const command = attempt.command_data
          ? (JSON.parse(String(attempt.command_data)) as {
              amount?: { currency?: string; minor?: number };
              orderId?: string;
            })
          : undefined;
        const derivedRefund =
          currentRefund ??
          (typeof command?.amount?.currency === "string" &&
          typeof command.amount.minor === "number"
            ? {
                refundId: input.refundId,
                orderId: command.orderId ?? "unknown",
                amount: moneyToLegacyAmount({
                  currency: command.amount.currency,
                  minor: command.amount.minor,
                }),
                currency: command.amount.currency,
                status: "pending" as const,
                idempotencyKey: input.idempotencyKey,
                executedAt: now(),
              }
            : undefined);
        if (!derivedRefund) {
          await tx.commit();
          return false;
        }
        const result = { ...derivedRefund, status: "executed" as const };
        const response = `Your refund of ${result.amount} ${result.currency} has been issued.`;
        const updated = {
          ...current,
          status: "resolved" as const,
          refundResult: result,
          finalResponse: response,
          updatedAt: now(),
        };
        const write = await tx.execute({
          sql: "UPDATE support_cases SET data = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?",
          args: [
            JSON.stringify(updated),
            updated.updatedAt,
            current.id,
            Number(row.version),
          ],
        });
        await tx.execute({
          sql: "UPDATE support_turns SET state = 'resolved', outcome_data = json_patch(COALESCE(outcome_data, '{}'), ?), updated_at = ? WHERE id = ? AND case_id = ?",
          args: [
            JSON.stringify({
              status: "resolved",
              finalResponse: response,
              refundId: input.refundId,
            }),
            now(),
            turnId,
            current.id,
          ],
        });
        if (Number(write.rowsAffected ?? 0) !== 1)
          throw new StaleCaseWriteError(current.id);
        await tx.execute({
          sql: "INSERT OR IGNORE INTO support_idempotency(idempotency_key, fingerprint, effect, created_at) VALUES (?, ?, ?, ?)",
          args: [
            input.idempotencyKey,
            String(attempt.command_fingerprint),
            JSON.stringify(input.effect ?? {}),
            now(),
          ],
        });
        await tx.execute({
          sql: "INSERT OR IGNORE INTO support_outbox(id, case_id, binding, body, status, operation, payload_fingerprint, state, originating_turn_id, correlation_state, created_at, updated_at) VALUES (?, ?, ?, ?, 'resolved', 'reply', ?, 'pending', ?, 'unknown', ?, ?)",
          args: [
            `outbox_${current.id}_${turnId}_refund-final`,
            current.id,
            JSON.stringify(bindingsForCase(current).support),
            response,
            this.outboxFingerprint(
              bindingsForCase(current).support,
              "reply",
              response,
              "resolved",
            ),
            turnId,
            now(),
            now(),
          ],
        });
      } else {
        const correction =
          "The refund requires additional review. A support specialist will follow up shortly.";
        const command = attempt.command_data
          ? (JSON.parse(String(attempt.command_data)) as {
              amount?: { currency?: string; minor?: number };
              orderId?: string;
            })
          : undefined;
        const derivedRefund =
          current.refundResult ??
          (typeof command?.amount?.currency === "string" &&
          typeof command.amount.minor === "number"
            ? {
                refundId: input.refundId,
                orderId: command.orderId ?? "unknown",
                amount: moneyToLegacyAmount({
                  currency: command.amount.currency,
                  minor: command.amount.minor,
                }),
                currency: command.amount.currency,
                status: "pending" as const,
                idempotencyKey: input.idempotencyKey,
                executedAt: now(),
              }
            : undefined);
        const updated = {
          ...current,
          status: "escalated" as const,
          escalationReason:
            "Stripe reported that the approved refund failed and requires staff review.",
          refundResult: derivedRefund
            ? { ...derivedRefund, status: "failed" as const }
            : undefined,
          finalResponse: correction,
          updatedAt: now(),
        };
        const write = await tx.execute({
          sql: "UPDATE support_cases SET data = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?",
          args: [
            JSON.stringify(updated),
            updated.updatedAt,
            current.id,
            Number(row.version),
          ],
        });
        await tx.execute({
          sql: "UPDATE support_turns SET state = 'escalated', outcome_data = json_patch(COALESCE(outcome_data, '{}'), ?), updated_at = ? WHERE id = ? AND case_id = ?",
          args: [
            JSON.stringify({
              status: "escalated",
              finalResponse: correction,
              refundId: input.refundId,
            }),
            now(),
            turnId,
            current.id,
          ],
        });
        if (Number(write.rowsAffected ?? 0) !== 1)
          throw new StaleCaseWriteError(current.id);
        await tx.execute({
          sql: "INSERT OR IGNORE INTO support_actions(id, case_id, kind, fingerprint, data, created_at) VALUES (?, ?, 'refund-failure', ?, ?, ?)",
          args: [
            `action_${current.id}_${turnId}_refund-failure`,
            current.id,
            String(attempt.command_fingerprint),
            JSON.stringify({
              category: "provider",
              classification: "confirmed-failed",
              refundId: input.refundId,
              observedAt: now(),
            }),
            now(),
          ],
        });
        await tx.execute({
          sql: "INSERT OR IGNORE INTO support_outbox(id, case_id, binding, body, status, operation, payload_fingerprint, state, originating_turn_id, correlation_state, created_at, updated_at) VALUES (?, ?, ?, ?, 'escalated', 'reply', ?, 'pending', ?, 'unknown', ?, ?)",
          args: [
            `outbox_${current.id}_${turnId}_refund-failed`,
            current.id,
            JSON.stringify(bindingsForCase(current).support),
            correction,
            this.outboxFingerprint(
              bindingsForCase(current).support,
              "reply",
              correction,
              "escalated",
            ),
            turnId,
            now(),
            now(),
          ],
        });
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
  /** A preflight denial or a non-ambiguous Stripe POST rejection proves no
   * financial effect. Close its durable attempt, originating turn, audit and
   * one staff-review outbox item together; it must never enter GET recovery. */
  async finalizeStripeRefundNoEffectFailure(input: {
    idempotencyKey: string;
    fingerprint: string;
  }) {
    await this.ensured();
    const tx = await this.client.transaction("write");
    try {
      const found = await tx.execute({
        sql: "SELECT * FROM support_stripe_refund_attempts WHERE idempotency_key = ? AND command_fingerprint = ?",
        args: [input.idempotencyKey, input.fingerprint],
      });
      const attempt = found.rows[0] as Record<string, unknown> | undefined;
      if (
        !attempt ||
        !["prepared", "unknown"].includes(String(attempt.status))
      ) {
        await tx.rollback();
        return false;
      }
      const closed = await tx.execute({
        sql: "UPDATE support_stripe_refund_attempts SET status = 'failed', provider_status = 'confirmed-no-effect', next_attempt_at = NULL, reconcile_lease_token = NULL, reconcile_lease_until = NULL, terminal_at = COALESCE(terminal_at, ?), updated_at = ? WHERE idempotency_key = ? AND command_fingerprint = ? AND status IN ('prepared', 'unknown')",
        args: [now(), now(), input.idempotencyKey, input.fingerprint],
      });
      if (Number(closed.rowsAffected ?? 0) !== 1) {
        await tx.rollback();
        return false;
      }
      await tx.execute({
        sql: "DELETE FROM support_idempotency WHERE idempotency_key = ? AND fingerprint = ?",
        args: [input.idempotencyKey, input.fingerprint],
      });
      const caseResult = await tx.execute({
        sql: "SELECT data, version FROM support_cases WHERE id = ?",
        args: [String(attempt.case_id)],
      });
      const row = caseResult.rows[0] as Record<string, unknown> | undefined;
      if (!row) {
        await tx.commit();
        return false;
      }
      const current = parse({ data: row.data });
      const turnId = String(attempt.turn_id);
      const response =
        "The refund requires additional review. A support specialist will follow up shortly.";
      await tx.execute({
        sql: "UPDATE support_turns SET state = 'escalated', outcome_data = json_patch(COALESCE(outcome_data, '{}'), ?), updated_at = ? WHERE id = ? AND case_id = ?",
        args: [
          JSON.stringify({ status: "escalated", finalResponse: response }),
          now(),
          turnId,
          current.id,
        ],
      });
      await tx.execute({
        sql: "INSERT OR IGNORE INTO support_actions(id, case_id, kind, fingerprint, data, created_at) VALUES (?, ?, 'refund-failure', ?, ?, ?)",
        args: [
          `action_${current.id}_${turnId}_refund-no-effect`,
          current.id,
          input.fingerprint,
          JSON.stringify({
            category: "provider",
            classification: "confirmed-no-effect",
          }),
          now(),
        ],
      });
      await tx.execute({
        sql: "INSERT OR IGNORE INTO support_outbox(id, case_id, binding, body, status, operation, payload_fingerprint, state, originating_turn_id, correlation_state, created_at, updated_at) VALUES (?, ?, ?, ?, 'escalated', 'reply', ?, 'pending', ?, 'unknown', ?, ?)",
        args: [
          `outbox_${current.id}_${turnId}_refund-no-effect`,
          current.id,
          JSON.stringify(bindingsForCase(current).support),
          response,
          this.outboxFingerprint(
            bindingsForCase(current).support,
            "reply",
            response,
            "escalated",
          ),
          turnId,
          now(),
          now(),
        ],
      });
      if (
        (current.metadata as Record<string, unknown>).activeTurnId === turnId
      ) {
        const updated = {
          ...current,
          status: "escalated" as const,
          escalationReason:
            "The refund could not be completed and requires staff review.",
          finalResponse: response,
          updatedAt: now(),
        };
        const write = await tx.execute({
          sql: "UPDATE support_cases SET data = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?",
          args: [
            JSON.stringify(updated),
            updated.updatedAt,
            current.id,
            Number(row.version),
          ],
        });
        if (Number(write.rowsAffected ?? 0) !== 1)
          throw new StaleCaseWriteError(current.id);
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
  async stripeRefundAttempt(idempotencyKey: string) {
    await this.ensured();
    const row = await this.client.execute({
      sql: "SELECT * FROM support_stripe_refund_attempts WHERE idempotency_key = ?",
      args: [idempotencyKey],
    });
    return row.rows[0]
      ? this.stripeAttempt(row.rows[0] as Record<string, unknown>)
      : undefined;
  }
  async stripeRefundAttemptByRefundId(refundId: string) {
    await this.ensured();
    const row = await this.client.execute({
      sql: "SELECT * FROM support_stripe_refund_attempts WHERE refund_id = ?",
      args: [refundId],
    });
    return row.rows[0]
      ? this.stripeAttempt(row.rows[0] as Record<string, unknown>)
      : undefined;
  }
  async claimableStripeRefundAttempts(limit = 10) {
    await this.ensured();
    const claimedAt = now();
    const leaseUntil = new Date(Date.now() + 30_000).toISOString();
    const rows = await this.client.execute({
      sql: "SELECT * FROM support_stripe_refund_attempts WHERE status IN ('pending', 'unknown', 'prepared', 'succeeded') AND (next_attempt_at IS NULL OR next_attempt_at <= ?) AND (reconcile_lease_until IS NULL OR reconcile_lease_until < ?) ORDER BY updated_at LIMIT ?",
      args: [claimedAt, claimedAt, limit],
    });
    const claimed = [];
    for (const row of rows.rows) {
      const token = crypto.randomUUID();
      const write = await this.client.execute({
        sql: "UPDATE support_stripe_refund_attempts SET reconcile_lease_token = ?, reconcile_lease_until = ? WHERE id = ? AND status IN ('pending', 'unknown', 'prepared', 'succeeded') AND (reconcile_lease_until IS NULL OR reconcile_lease_until < ?) AND (next_attempt_at IS NULL OR next_attempt_at <= ?)",
        args: [token, leaseUntil, String(row.id), claimedAt, claimedAt],
      });
      if (Number(write.rowsAffected ?? 0) === 1) {
        const claimedRow = await this.client.execute({
          sql: "SELECT * FROM support_stripe_refund_attempts WHERE id = ? AND reconcile_lease_token = ?",
          args: [String(row.id), token],
        });
        if (claimedRow.rows[0])
          claimed.push({
            ...this.stripeAttempt(
              claimedRow.rows[0] as Record<string, unknown>,
            ),
            reconcileLeaseToken: token,
          });
      }
    }
    return claimed;
  }
  private stripeAttempt(row: Record<string, unknown>) {
    return {
      id: String(row.id),
      caseId: String(row.case_id),
      tenantId: String(row.tenant_id),
      providerAccountId: String(row.provider_account_id),
      fingerprint: String(row.command_fingerprint),
      idempotencyKey: String(row.idempotency_key),
      dispatchId: String(row.dispatch_id),
      leaseToken: String(row.lease_token),
      status: String(row.status) as
        | "prepared"
        | "pending"
        | "succeeded"
        | "failed"
        | "unknown"
        | "quarantined",
      refundId: row.refund_id ? String(row.refund_id) : undefined,
      providerStatus: row.provider_status
        ? String(row.provider_status)
        : undefined,
      turnId: row.turn_id ? String(row.turn_id) : undefined,
      command: row.command_data
        ? JSON.parse(String(row.command_data))
        : undefined,
      stripeRequest: row.stripe_request_data
        ? JSON.parse(String(row.stripe_request_data))
        : undefined,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      nextAttemptAt: row.next_attempt_at
        ? String(row.next_attempt_at)
        : undefined,
      reconcileLeaseToken: row.reconcile_lease_token
        ? String(row.reconcile_lease_token)
        : undefined,
      terminalAt: row.terminal_at ? String(row.terminal_at) : undefined,
      reconcileAttempts: Number(row.reconcile_attempts ?? 0),
    };
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
    // These records contain only correlation identifiers, but their trace
    // binding must not outlive the 30-day observability retention window.
    // A missing table is valid only while upgrading a pre-v12 database.
    let supervisorExecutionsDeleted = 0;
    try {
      const deleted = await this.client.execute({
        sql: "DELETE FROM support_supervisor_executions WHERE created_at < ?",
        args: [traceCutoff],
      });
      supervisorExecutionsDeleted = Number(deleted.rowsAffected ?? 0);
    } catch (error) {
      if (!String(error).includes("no such table")) throw error;
    }
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
                UNION ALL SELECT 1 FROM support_feedback WHERE case_id = ?
                LIMIT 1`,
              args: [id, id, id, id, id, id],
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
            // Ratings/comments are customer content. Aggregates only include
            // retained feedback; a tombstoned case cannot retain its rating.
            await tx.execute({
              sql: "DELETE FROM support_feedback WHERE case_id = ?",
              args: [id],
            });
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
    // Stripe attempts retain an immutable command for reconciliation, but its
    // free-form reason is customer content and follows the normal case window.
    try {
      const stripeReasons = await this.client.execute({
        sql: "UPDATE support_stripe_refund_attempts SET command_data = json_set(command_data, '$.reason', '[redacted]') WHERE created_at < ? AND command_data IS NOT NULL AND json_extract(command_data, '$.reason') <> '[redacted]'",
        args: [caseCutoff],
      });
      financialReasonsRedacted += Number(stripeReasons.rowsAffected ?? 0);
      // At the financial-audit boundary provider IDs and immutable command
      // metadata are no longer retained. Before removing a terminal attempt,
      // irreversibly replace any effect with a non-executable tombstone. The
      // original created_at is preserved, so this does not extend retention.
      // Pending/unknown attempts remain untouched because their external
      // outcome is unresolved and must never be reissued.
      await this.minimizeExpiredTerminalFinancialAttempts(auditCutoff);
      // Unrelated webhook receipt records are replay protection only. They do
      // not need a financial-audit lifetime and must not retain provider IDs.
      await this.client.execute({
        sql: "DELETE FROM support_actions WHERE case_id = 'stripe-webhook' AND kind = 'event' AND created_at < ?",
        args: [rawCutoff],
      });
      // A completed/failed receipt holds only an event ID and no raw payload,
      // but it still follows the seven-day webhook boundary. Never delete an
      // active lease: its owner may be completing a durable reconciliation, or
      // a later signed delivery may need to recover it after expiry.
      await this.client.execute({
        sql: "DELETE FROM support_stripe_webhook_receipts WHERE created_at < ? AND state IN ('completed', 'failed')",
        args: [rawCutoff],
      });
    } catch (error) {
      if (!String(error).includes("no such table")) throw error;
    }
    return {
      rawPayloadsRedacted,
      casesRedacted,
      tracesRedacted,
      supervisorExecutionsDeleted,
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
  /** Atomically remove identifying terminal attempts only after installing a
   * minimal idempotency tombstone. This covers failed/quarantined attempts
   * whose success effect was already removed by a late provider failure. */
  private async minimizeExpiredTerminalFinancialAttempts(auditCutoff: string) {
    const tx = await this.client.transaction("write");
    try {
      const candidates = await Promise.all([
        tx.execute({
          sql: "SELECT idempotency_key, command_fingerprint AS fingerprint, created_at FROM support_stripe_refund_attempts WHERE status IN ('succeeded', 'failed', 'quarantined') AND COALESCE(terminal_at, created_at) < ?",
          args: [auditCutoff],
        }),
        tx.execute({
          sql: "SELECT idempotency_key, fingerprint, created_at FROM support_subscription_cancellation_attempts WHERE status IN ('scheduled', 'failed', 'quarantined') AND COALESCE(terminal_at, created_at) < ?",
          args: [auditCutoff],
        }),
      ]);
      for (const result of candidates)
        for (const row of result.rows) {
          const key = String(row.idempotency_key);
          const fingerprint = String(row.fingerprint);
          const existing = await tx.execute({
            sql: "SELECT fingerprint FROM support_idempotency WHERE idempotency_key = ?",
            args: [key],
          });
          if (
            existing.rows[0] &&
            String(existing.rows[0].fingerprint) !== fingerprint
          )
            throw new Error(
              "Terminal financial attempt conflicts with its idempotency fingerprint.",
            );
          if (existing.rows[0])
            await tx.execute({
              sql: "UPDATE support_idempotency SET effect = ? WHERE idempotency_key = ? AND fingerprint = ?",
              args: [
                JSON.stringify(financialRetentionTombstone),
                key,
                fingerprint,
              ],
            });
          else
            await tx.execute({
              sql: "INSERT INTO support_idempotency(idempotency_key, fingerprint, effect, created_at) VALUES (?, ?, ?, ?)",
              args: [
                key,
                fingerprint,
                JSON.stringify(financialRetentionTombstone),
                String(row.created_at),
              ],
            });
        }
      await tx.execute({
        sql: "DELETE FROM support_stripe_refund_attempts WHERE status IN ('succeeded', 'failed', 'quarantined') AND COALESCE(terminal_at, created_at) < ?",
        args: [auditCutoff],
      });
      await tx.execute({
        sql: "DELETE FROM support_subscription_cancellation_attempts WHERE status IN ('scheduled', 'failed', 'quarantined') AND COALESCE(terminal_at, created_at) < ?",
        args: [auditCutoff],
      });
      await tx.commit();
    } catch (error) {
      try {
        await tx.rollback();
      } catch {}
      throw error;
    }
  }
  async recordEffect(key: string, fingerprint: string, effect: unknown) {
    await this.ensured();
    await this.client.execute({
      sql: "INSERT INTO support_idempotency(idempotency_key, fingerprint, effect, created_at) VALUES (?, ?, ?, ?)",
      args: [key, fingerprint, JSON.stringify(effect), now()],
    });
  }
  async prepareSubscriptionCancellationAttempt(input: {
    caseId: string;
    turnId: string;
    binding: ProviderBinding;
    subscriptionId: string;
    idempotencyKey: string;
    fingerprint: string;
    command: unknown;
  }) {
    await this.ensured();
    const retained = await this.client.execute({
      sql: "SELECT effect FROM support_idempotency WHERE idempotency_key = ?",
      args: [input.idempotencyKey],
    });
    if (
      retained.rows[0] &&
      isFinancialRetentionTombstone(JSON.parse(String(retained.rows[0].effect)))
    )
      throw financialRetentionTombstoneError();
    const command = input.command as Partial<{
      caseId: string;
      turnId: string;
      binding: ProviderBinding;
      subscriptionId: string;
      idempotencyKey: string;
      fingerprint: string;
    }>;
    if (
      command.caseId !== input.caseId ||
      command.turnId !== input.turnId ||
      command.subscriptionId !== input.subscriptionId ||
      command.idempotencyKey !== input.idempotencyKey ||
      command.fingerprint !== input.fingerprint ||
      !structurallyEqual(command.binding, input.binding)
    )
      throw new Error(
        "Cancellation attempt does not match its immutable command.",
      );
    const timestamp = now();
    await this.client.execute({
      sql: "INSERT OR IGNORE INTO support_subscription_cancellation_attempts(idempotency_key, case_id, turn_id, tenant_id, provider_account_id, subscription_id, fingerprint, command_data, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?)",
      args: [
        input.idempotencyKey,
        input.caseId,
        input.turnId,
        input.binding.tenantId,
        input.binding.providerAccountId,
        input.subscriptionId,
        input.fingerprint,
        JSON.stringify(input.command),
        timestamp,
        timestamp,
      ],
    });
    const result = await this.client.execute({
      sql: "SELECT * FROM support_subscription_cancellation_attempts WHERE idempotency_key = ?",
      args: [input.idempotencyKey],
    });
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (
      !row ||
      String(row.case_id) !== input.caseId ||
      String(row.turn_id) !== input.turnId ||
      String(row.fingerprint) !== input.fingerprint ||
      !structurallyEqual(JSON.parse(String(row.command_data)), input.command)
    )
      throw new Error(
        "Cancellation idempotency key was reused with another command.",
      );
    return {
      status: String(row.status),
      cancelsAt: row.cancels_at ? String(row.cancels_at) : undefined,
    };
  }
  /** Marks the hand-off immediately before a provider POST. A process crash
   * after this point is always recovered by GET; it can never issue a second
   * mutation from a durable prepared command. */
  async claimSubscriptionCancellationMutation(input: {
    idempotencyKey: string;
    fingerprint: string;
  }) {
    await this.ensured();
    const claimed = await this.client.execute({
      sql: "UPDATE support_subscription_cancellation_attempts SET status = 'claimed', updated_at = ? WHERE idempotency_key = ? AND fingerprint = ? AND status = 'prepared'",
      args: [now(), input.idempotencyKey, input.fingerprint],
    });
    return Number(claimed.rowsAffected ?? 0) === 1;
  }
  async finalizeSubscriptionCancellationAttempt(input: {
    idempotencyKey: string;
    fingerprint: string;
    status: "scheduled" | "unknown" | "failed";
    cancelsAt?: string;
    effect?: unknown;
  }) {
    await this.ensured();
    const terminal = input.status === "scheduled" || input.status === "failed";
    const tx = await this.client.transaction("write");
    try {
      const write = await tx.execute({
        sql: "UPDATE support_subscription_cancellation_attempts SET status = ?, cancels_at = COALESCE(?, cancels_at), terminal_at = CASE WHEN ? THEN COALESCE(terminal_at, ?) ELSE terminal_at END, next_reconcile_at = CASE WHEN ? = 'unknown' THEN ? ELSE NULL END, reconcile_lease_token = NULL, reconcile_lease_until = NULL, updated_at = ? WHERE idempotency_key = ? AND fingerprint = ? AND (status = 'claimed' OR status = ?)",
        args: [
          input.status,
          input.cancelsAt ?? null,
          terminal ? 1 : 0,
          terminal ? now() : null,
          input.status,
          input.status === "unknown" ? now() : null,
          now(),
          input.idempotencyKey,
          input.fingerprint,
          input.status,
        ],
      });
      if (Number(write.rowsAffected ?? 0) !== 1) {
        await tx.rollback();
        return false;
      }
      if (terminal && input.effect)
        await tx.execute({
          sql: "INSERT OR IGNORE INTO support_idempotency(idempotency_key, fingerprint, effect, created_at) VALUES (?, ?, ?, ?)",
          args: [
            input.idempotencyKey,
            input.fingerprint,
            JSON.stringify(input.effect),
            now(),
          ],
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
  async claimUnknownSubscriptionCancellationAttempts(limit = 10) {
    await this.ensured();
    const timestamp = now();
    const leaseUntil = new Date(Date.now() + 30_000).toISOString();
    const rows = await this.client.execute({
      sql: "SELECT * FROM support_subscription_cancellation_attempts WHERE status IN ('unknown', 'claimed') AND (next_reconcile_at IS NULL OR next_reconcile_at <= ?) AND (reconcile_lease_until IS NULL OR reconcile_lease_until < ?) ORDER BY COALESCE(next_reconcile_at, created_at), created_at LIMIT ?",
      args: [timestamp, timestamp, limit],
    });
    const claimed = [] as Array<{
      caseId: string;
      turnId: string;
      idempotencyKey: string;
      fingerprint: string;
      command: unknown;
      createdAt: string;
      recoveryClaim: string;
    }>;
    for (const row of rows.rows) {
      const value = row as Record<string, unknown>;
      const recoveryClaim = crypto.randomUUID();
      const write = await this.client.execute({
        sql: "UPDATE support_subscription_cancellation_attempts SET reconcile_lease_token = ?, reconcile_lease_until = ?, updated_at = ? WHERE idempotency_key = ? AND fingerprint = ? AND status IN ('unknown', 'claimed') AND (next_reconcile_at IS NULL OR next_reconcile_at <= ?) AND (reconcile_lease_until IS NULL OR reconcile_lease_until < ?)",
        args: [
          recoveryClaim,
          leaseUntil,
          timestamp,
          String(value.idempotency_key),
          String(value.fingerprint),
          timestamp,
          timestamp,
        ],
      });
      if (Number(write.rowsAffected ?? 0) !== 1) continue;
      claimed.push({
        caseId: String(value.case_id),
        turnId: String(value.turn_id),
        idempotencyKey: String(value.idempotency_key),
        fingerprint: String(value.fingerprint),
        command: JSON.parse(String(value.command_data)),
        createdAt: String(value.created_at),
        recoveryClaim,
      });
    }
    return claimed;
  }
  async rescheduleSubscriptionCancellationRecovery(input: {
    idempotencyKey: string;
    fingerprint: string;
    recoveryClaim: string;
  }) {
    await this.ensured();
    const current = await this.client.execute({
      sql: "SELECT reconcile_attempts FROM support_subscription_cancellation_attempts WHERE idempotency_key = ? AND fingerprint = ? AND reconcile_lease_token = ? AND status IN ('unknown', 'claimed')",
      args: [input.idempotencyKey, input.fingerprint, input.recoveryClaim],
    });
    const attempts = Number(current.rows[0]?.reconcile_attempts ?? 0) + 1;
    const delay = Math.min(
      60 * 60_000,
      30_000 * 2 ** Math.min(attempts - 1, 7),
    );
    const next = new Date(Date.now() + delay).toISOString();
    const write = await this.client.execute({
      sql: "UPDATE support_subscription_cancellation_attempts SET status = 'unknown', reconcile_attempts = ?, next_reconcile_at = ?, reconcile_lease_token = NULL, reconcile_lease_until = NULL, updated_at = ? WHERE idempotency_key = ? AND fingerprint = ? AND reconcile_lease_token = ? AND status IN ('unknown', 'claimed')",
      args: [
        attempts,
        next,
        now(),
        input.idempotencyKey,
        input.fingerprint,
        input.recoveryClaim,
      ],
    });
    return Number(write.rowsAffected ?? 0) === 1;
  }
  /** Atomically closes an uncertain cancellation and records the immutable
   * originating turn's customer notification. A later follow-up keeps the
   * mutable case projection, but cannot lose this terminal result. */
  async finalizeUnknownSubscriptionCancellation(input: {
    idempotencyKey: string;
    fingerprint: string;
    status: "scheduled" | "quarantined" | "failed";
    recoveryClaim?: string;
    effect?: {
      subscriptionId: string;
      cancelAtPeriodEnd: true;
      cancelsAt: string;
      idempotencyKey: string;
      replayed: boolean;
    };
  }) {
    await this.ensured();
    const tx = await this.client.transaction("write");
    try {
      const found = await tx.execute({
        sql: "SELECT * FROM support_subscription_cancellation_attempts WHERE idempotency_key = ? AND fingerprint = ?",
        args: [input.idempotencyKey, input.fingerprint],
      });
      const attempt = found.rows[0] as Record<string, unknown> | undefined;
      if (
        !attempt ||
        !["unknown", "claimed"].includes(String(attempt.status)) ||
        (input.recoveryClaim !== undefined &&
          String(attempt.reconcile_lease_token) !== input.recoveryClaim)
      ) {
        await tx.rollback();
        return false;
      }
      const terminal = await tx.execute({
        sql: "UPDATE support_subscription_cancellation_attempts SET status = ?, cancels_at = COALESCE(?, cancels_at), terminal_at = COALESCE(terminal_at, ?), next_reconcile_at = NULL, reconcile_lease_token = NULL, reconcile_lease_until = NULL, updated_at = ? WHERE idempotency_key = ? AND fingerprint = ? AND status IN ('unknown', 'claimed') AND (? IS NULL OR reconcile_lease_token = ?)",
        args: [
          input.status,
          input.effect?.cancelsAt ?? null,
          now(),
          now(),
          input.idempotencyKey,
          input.fingerprint,
          input.recoveryClaim ?? null,
          input.recoveryClaim ?? null,
        ],
      });
      if (Number(terminal.rowsAffected ?? 0) !== 1) {
        await tx.rollback();
        return false;
      }
      const caseResult = await tx.execute({
        sql: "SELECT data, version FROM support_cases WHERE id = ?",
        args: [String(attempt.case_id)],
      });
      const row = caseResult.rows[0] as Record<string, unknown> | undefined;
      if (!row) {
        await tx.commit();
        return false;
      }
      const current = parse({ data: row.data });
      const turnId = String(attempt.turn_id);
      const scheduled = input.status === "scheduled";
      const confirmedNoEffect = input.status === "failed";
      const status = scheduled ? "resolved" : "escalated";
      const response = scheduled
        ? `Your subscription is scheduled to cancel at the end of the current billing period on ${input.effect!.cancelsAt}.`
        : "The subscription cancellation requires additional review. A support specialist will follow up shortly.";
      await tx.execute({
        sql: "UPDATE support_turns SET state = ?, outcome_data = json_patch(COALESCE(outcome_data, '{}'), ?), updated_at = ? WHERE id = ? AND case_id = ?",
        args: [
          status,
          JSON.stringify({ status, finalResponse: response }),
          now(),
          turnId,
          current.id,
        ],
      });
      if (scheduled)
        await tx.execute({
          sql: "INSERT OR IGNORE INTO support_idempotency(idempotency_key, fingerprint, effect, created_at) VALUES (?, ?, ?, ?)",
          args: [
            input.idempotencyKey,
            input.fingerprint,
            JSON.stringify(input.effect),
            now(),
          ],
        });
      else
        await tx.execute({
          sql: "INSERT INTO support_actions(id, case_id, kind, fingerprint, data, created_at) VALUES (?, ?, 'subscription-cancellation-failure', ?, ?, ?) ON CONFLICT(kind, fingerprint) DO UPDATE SET data = excluded.data",
          args: [
            `action_${current.id}_${turnId}_cancellation-failed`,
            current.id,
            input.fingerprint,
            JSON.stringify({
              classification: confirmedNoEffect
                ? "confirmed-no-effect"
                : "unconfirmed-expired",
            }),
            now(),
          ],
        });
      await tx.execute({
        sql: "INSERT OR IGNORE INTO support_outbox(id, case_id, binding, body, status, operation, payload_fingerprint, state, originating_turn_id, correlation_state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'reply', ?, 'pending', ?, 'unknown', ?, ?)",
        args: [
          `outbox_${current.id}_${turnId}_cancellation-${scheduled ? "final" : "failed"}`,
          current.id,
          JSON.stringify(bindingsForCase(current).support),
          response,
          status,
          this.outboxFingerprint(
            bindingsForCase(current).support,
            "reply",
            response,
            status,
          ),
          turnId,
          now(),
          now(),
        ],
      });
      if (
        (current.metadata as Record<string, unknown>).activeTurnId === turnId
      ) {
        const updated = {
          ...current,
          status,
          finalResponse: response,
          escalationReason: scheduled
            ? undefined
            : confirmedNoEffect
              ? "The subscription cancellation could not be completed and requires staff review."
              : "Subscription cancellation could not be confirmed and requires staff review.",
          metadata: scheduled
            ? {
                ...current.metadata,
                cancellationEffect: {
                  subscriptionId: input.effect!.subscriptionId,
                  cancelsAt: input.effect!.cancelsAt,
                  status: "scheduled",
                },
              }
            : current.metadata,
          updatedAt: now(),
        };
        const write = await tx.execute({
          sql: "UPDATE support_cases SET data = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?",
          args: [
            JSON.stringify(updated),
            updated.updatedAt,
            current.id,
            Number(row.version),
          ],
        });
        if (Number(write.rowsAffected ?? 0) !== 1)
          throw new StaleCaseWriteError(current.id);
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
  getClientForTests() {
    return this.client;
  }
}
export const caseStore = new CaseStore();
