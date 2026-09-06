import { createClient } from "@libsql/client";
import { LibSQLStore } from "@mastra/libsql";

const defaults = {
  rawPayloadDays: 7,
  caseDays: 90,
  traceDays: 30,
  financialAuditDays: 365,
};

function bounded(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > fallback)
    throw new Error(`${name} must be an integer from 1 through ${fallback}.`);
  return value;
}

function policyFromEnvironment() {
  return {
    rawPayloadDays: bounded(
      "SUPPORT_RETENTION_RAW_PAYLOAD_DAYS",
      defaults.rawPayloadDays,
    ),
    caseDays: bounded("SUPPORT_RETENTION_CASE_DAYS", defaults.caseDays),
    traceDays: bounded("SUPPORT_RETENTION_TRACE_DAYS", defaults.traceDays),
    financialAuditDays: bounded(
      "SUPPORT_RETENTION_FINANCIAL_AUDIT_DAYS",
      defaults.financialAuditDays,
    ),
  };
}

function cutoff(days, current) {
  return new Date(
    current.getTime() - days * 24 * 60 * 60 * 1_000,
  ).toISOString();
}

function retentionClock() {
  const supplied = process.env.SUPPORT_TEST_RETENTION_NOW;
  if (supplied !== undefined) {
    if (process.env.NODE_ENV !== "test")
      throw new Error(
        "SUPPORT_TEST_RETENTION_NOW is available only under NODE_ENV=test.",
      );
    const parsed = new Date(supplied);
    if (Number.isNaN(parsed.getTime()))
      throw new Error("SUPPORT_TEST_RETENTION_NOW must be an ISO timestamp.");
    return parsed;
  }
  return new Date();
}

async function tableExists(client, name) {
  return Boolean(
    (
      await client.execute({
        sql: "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        args: [name],
      })
    ).rows[0],
  );
}

async function sweepCases(client, policy, current = new Date()) {
  const rawCutoff = cutoff(policy.rawPayloadDays, current);
  const traceCutoff = cutoff(policy.traceDays, current);
  const caseCutoff = cutoff(policy.caseDays, current);
  const auditCutoff = cutoff(policy.financialAuditDays, current);
  const result = {
    rawPayloadsRedacted: 0,
    casesRedacted: 0,
    tracesRedacted: 0,
    supervisorExecutionsDeleted: 0,
    auditsDeleted: 0,
    messagesDeleted: 0,
    turnsRedacted: 0,
    outboxRecordsRedacted: 0,
    dispatchesExpired: 0,
    decisionsRedacted: 0,
    actionsRedacted: 0,
    auditPayloadsRedacted: 0,
    financialReasonsRedacted: 0,
    pendingCasesExpired: 0,
    rawWorkflowSnapshotBefore: rawCutoff,
    expiredCaseIds: [],
    expiredWorkflowRunIds: [],
  };
  const rows = await client.execute({
    sql: "SELECT id, data, version, created_at, accepted_at FROM support_cases WHERE COALESCE(accepted_at, created_at) < ? OR updated_at < ?",
    args: [rawCutoff, traceCutoff],
  });
  for (const row of rows.rows) {
    const data = JSON.parse(String(row.data));
    const acceptedAt = String(row.accepted_at ?? row.created_at);
    const metadata = { ...(data.metadata ?? {}) };
    if (metadata.retentionRedactedAt !== undefined)
      result.expiredCaseIds.push(String(row.id));
    let updated = { ...data, metadata };
    let changed = false;
    let redactedCase = false;
    if (acceptedAt < rawCutoff && "rawPayload" in metadata) {
      delete metadata.rawPayload;
      result.rawPayloadsRedacted += 1;
      changed = true;
    }
    if (acceptedAt < traceCutoff && updated.traceId) {
      updated = { ...updated, traceId: undefined };
      result.tracesRedacted += 1;
      changed = true;
    }
    // A tombstone may have been contaminated by an older deployment. Include
    // table-only copies in the repair predicate so repeated CLI sweeps remain
    // idempotent once every durable content projection is clean.
    const residualContent =
      acceptedAt < caseCutoff && metadata.retentionRedactedAt !== undefined
        ? await client.execute({
            sql: `SELECT 1 FROM support_messages WHERE case_id = ?
              UNION ALL SELECT 1 FROM support_turns WHERE case_id = ? AND (message_data IS NOT NULL OR outcome_data IS NOT NULL)
              UNION ALL SELECT 1 FROM support_outbox WHERE case_id = ? AND (body <> '[redacted]' OR receipt IS NOT NULL OR last_error IS NOT NULL)
              UNION ALL SELECT 1 FROM support_decisions WHERE case_id = ? AND note IS NOT NULL
              UNION ALL SELECT 1 FROM support_actions WHERE case_id = ? AND data <> '{}'
              LIMIT 1`,
            args: [
              String(row.id),
              String(row.id),
              String(row.id),
              String(row.id),
              String(row.id),
            ],
          })
        : undefined;
    if (
      acceptedAt < caseCutoff &&
      (metadata.retentionRedactedAt === undefined ||
        data.messages.length > 0 ||
        data.approval !== undefined ||
        data.feedback !== undefined ||
        data.customer?.email !== "redacted@invalid.local" ||
        data.subject !== "Redacted support case" ||
        data.finalResponse !== undefined ||
        data.draft !== undefined ||
        Boolean(residualContent?.rows[0]))
    ) {
      const wasPending = ["new", "processing", "waiting_approval"].includes(
        data.status,
      );
      const command = metadata.refundCommand;
      updated = {
        ...updated,
        customer: { email: "redacted@invalid.local" },
        subject: "Redacted support case",
        messages: [],
        approval: undefined,
        ...(wasPending
          ? {
              status: "failed",
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
          providerBinding: metadata.providerBinding,
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
      result.casesRedacted += 1;
      result.expiredCaseIds.push(String(row.id));
      if (wasPending) result.pendingCasesExpired += 1;
      if (data.workflowRunId)
        result.expiredWorkflowRunIds.push(data.workflowRunId);
      if (typeof metadata.nativeApproval?.runId === "string")
        result.expiredWorkflowRunIds.push(metadata.nativeApproval.runId);
      if (await tableExists(client, "support_dispatch")) {
        const dispatches = await client.execute({
          sql: "SELECT run_id FROM support_dispatch WHERE case_id = ?",
          args: [String(row.id)],
        });
        for (const dispatch of dispatches.rows)
          result.expiredWorkflowRunIds.push(String(dispatch.run_id));
      }
      const nativeRuns = await client.execute({
        sql: "SELECT native_run_id FROM support_decisions WHERE case_id = ? AND native_run_id IS NOT NULL",
        args: [String(row.id)],
      });
      for (const native of nativeRuns.rows)
        result.expiredWorkflowRunIds.push(String(native.native_run_id));
      const turnRuns = await client.execute({
        sql: "SELECT run_id FROM support_turns WHERE case_id = ? AND run_id IS NOT NULL",
        args: [String(row.id)],
      });
      for (const turn of turnRuns.rows)
        result.expiredWorkflowRunIds.push(String(turn.run_id));
      changed = true;
      redactedCase = true;
    }
    if (!changed) continue;

    const transaction = await client.transaction("write");
    try {
      const write = await transaction.execute({
        sql: "UPDATE support_cases SET data = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?",
        args: [
          JSON.stringify(updated),
          current.toISOString(),
          String(row.id),
          Number(row.version ?? 1),
        ],
      });
      if (Number(write.rowsAffected ?? 0) !== 1)
        throw new Error(
          `Retention write lost its case fence for ${String(row.id)}.`,
        );
      if (redactedCase) {
        const deleted = await transaction.execute({
          sql: "DELETE FROM support_messages WHERE case_id = ?",
          args: [String(row.id)],
        });
        result.messagesDeleted += Number(deleted.rowsAffected ?? 0);
        const turns = await transaction.execute({
          sql: "UPDATE support_turns SET message_data = NULL, outcome_data = NULL, updated_at = ? WHERE case_id = ? AND (message_data IS NOT NULL OR outcome_data IS NOT NULL)",
          args: [current.toISOString(), String(row.id)],
        });
        result.turnsRedacted += Number(turns.rowsAffected ?? 0);
        const dispatches = await transaction.execute({
          sql: "UPDATE support_dispatch SET state = CASE WHEN state IN ('pending', 'claimed', 'started', 'suspended') THEN 'failed' ELSE state END, lease_until = NULL, lease_token = NULL, last_error = NULL, updated_at = ? WHERE case_id = ?",
          args: [current.toISOString(), String(row.id)],
        });
        result.dispatchesExpired += Number(dispatches.rowsAffected ?? 0);
        const outbox = await transaction.execute({
          sql: "UPDATE support_outbox SET body = '[redacted]', receipt = NULL, last_error = NULL, lease_until = NULL, lease_token = NULL, updated_at = ? WHERE case_id = ? AND (body <> '[redacted]' OR receipt IS NOT NULL OR last_error IS NOT NULL)",
          args: [current.toISOString(), String(row.id)],
        });
        result.outboxRecordsRedacted += Number(outbox.rowsAffected ?? 0);
        const decisions = await transaction.execute({
          sql: "UPDATE support_decisions SET note = NULL WHERE case_id = ? AND note IS NOT NULL",
          args: [String(row.id)],
        });
        result.decisionsRedacted += Number(decisions.rowsAffected ?? 0);
        const actions = await transaction.execute({
          sql: "UPDATE support_actions SET data = '{}' WHERE case_id = ? AND data <> '{}'",
          args: [String(row.id)],
        });
        result.actionsRedacted += Number(actions.rowsAffected ?? 0);
      }
      await transaction.commit();
    } catch (error) {
      try {
        await transaction.rollback();
      } catch {}
      throw error;
    }
  }
  const audits = await client.execute({
    sql: "DELETE FROM support_audit WHERE created_at < ?",
    args: [auditCutoff],
  });
  result.auditsDeleted = Number(audits.rowsAffected ?? 0);
  if (await tableExists(client, "support_supervisor_executions")) {
    const deleted = await client.execute({
      sql: "DELETE FROM support_supervisor_executions WHERE created_at < ?",
      args: [traceCutoff],
    });
    result.supervisorExecutionsDeleted = Number(deleted.rowsAffected ?? 0);
  }
  if (await tableExists(client, "local_refunds")) {
    const reasons = await client.execute({
      sql: "UPDATE local_refunds SET reason = '[redacted]' WHERE issued_at < ? AND reason <> '[redacted]'",
      args: [caseCutoff],
    });
    result.financialReasonsRedacted = Number(reasons.rowsAffected ?? 0);
  }
  result.expiredCaseIds = [...new Set(result.expiredCaseIds)];
  result.expiredWorkflowRunIds = [...new Set(result.expiredWorkflowRunIds)];
  return result;
}

const url = process.env.TURSO_DATABASE_URL || "file:./mastra.db";
// Validate every input before opening a connection or changing a database.
if (!url.startsWith("file:"))
  throw new Error(
    "Refusing retention cleanup: TURSO_DATABASE_URL must be a local file: URL. Remote databases are never cleaned by this command.",
  );
const policy = policyFromEnvironment();
const client = createClient({ url, timeout: 0 });

try {
  for (const table of [
    "support_cases",
    "support_messages",
    "support_turns",
    "support_dispatch",
    "support_outbox",
    "support_decisions",
    "support_actions",
    "support_audit",
    "support_supervisor_executions",
  ])
    if (!(await tableExists(client, table)))
      throw new Error(
        `Refusing retention cleanup: ${table} is missing. Start the local app once so its supported migrations finish first.`,
      );
  const caseColumns = await client.execute("PRAGMA table_info(support_cases)");
  if (!caseColumns.rows.some((column) => column.name === "accepted_at"))
    throw new Error(
      "Refusing retention cleanup: support schema v9 acceptance-time migration is missing. Start the local app once so its supported migrations finish first.",
    );

  const cases = await sweepCases(client, policy, retentionClock());
  const storage = new LibSQLStore({
    id: "support-retention-cli",
    client,
    maxRetries: 5,
    initialBackoffMs: 5,
    retention: {
      memory: {
        messages: { maxAge: `${policy.caseDays}d`, batchSize: 500 },
        resources: { maxAge: `${policy.caseDays}d`, batchSize: 500 },
        threads: { maxAge: `${policy.caseDays}d`, batchSize: 500 },
      },
      observability: {
        spans: { maxAge: `${policy.traceDays}d`, batchSize: 500 },
      },
    },
  });
  await storage.init();
  const workflows = await storage.getStore("workflows");
  const expiredRuns = new Set(cases.expiredWorkflowRunIds);
  const expiredCaseIds = new Set(cases.expiredCaseIds);
  const inboundNames = new Set([
    "ingest-support-case",
    "ingestSupportCaseWorkflow",
  ]);
  const recoverableNames = new Set([
    "resolve-support-case",
    "resolveSupportCaseWorkflow",
    "agentic-loop",
    "durable-agentic-loop",
    "executionWorkflow",
  ]);
  const snapshotsDeleted = [];
  const workflowRuns = await workflows?.listWorkflowRuns({ perPage: false });
  const snapshotContainsExpiredCase = (snapshot) => {
    const visit = (value) => {
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
  for (const run of workflowRuns?.runs ?? []) {
    if (
      !(
        inboundNames.has(run.workflowName) &&
        run.createdAt.toISOString() < cases.rawWorkflowSnapshotBefore
      ) &&
      !(
        recoverableNames.has(run.workflowName) &&
        (expiredRuns.has(run.runId) ||
          snapshotContainsExpiredCase(run.snapshot))
      )
    )
      continue;
    await workflows?.deleteWorkflowRunById({
      workflowName: run.workflowName,
      runId: run.runId,
    });
    snapshotsDeleted.push(`${run.workflowName}:${run.runId}`);
  }
  const mastra = await storage.prune({ maxBatches: 10, maxRows: 5_000 });
  console.log(JSON.stringify({ policy, cases, snapshotsDeleted, mastra }));
} finally {
  client.close();
}
