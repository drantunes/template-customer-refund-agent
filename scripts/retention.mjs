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
    auditsDeleted: 0,
    messagesDeleted: 0,
    pendingCasesExpired: 0,
    expiredWorkflowRunIds: [],
  };
  const rows = await client.execute({
    sql: "SELECT id, data, version, created_at FROM support_cases WHERE created_at < ? OR updated_at < ?",
    args: [rawCutoff, traceCutoff],
  });
  for (const row of rows.rows) {
    const data = JSON.parse(String(row.data));
    const createdAt = String(row.created_at);
    const metadata = { ...(data.metadata ?? {}) };
    let updated = { ...data, metadata };
    let changed = false;
    let redactedCase = false;
    if (createdAt < rawCutoff && "rawPayload" in metadata) {
      delete metadata.rawPayload;
      result.rawPayloadsRedacted += 1;
      changed = true;
    }
    if (createdAt < traceCutoff && updated.traceId) {
      updated = { ...updated, traceId: undefined };
      result.tracesRedacted += 1;
      changed = true;
    }
    if (createdAt < caseCutoff && metadata.retentionRedactedAt === undefined) {
      const wasPending = ["new", "processing", "waiting_approval"].includes(
        data.status,
      );
      const command = metadata.refundCommand;
      updated = {
        ...updated,
        customer: { email: "redacted@invalid.local" },
        subject: "Redacted support case",
        messages: [],
        ...(wasPending
          ? {
              status: "failed",
              approval: undefined,
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
      if (wasPending) result.pendingCasesExpired += 1;
      if (data.workflowRunId)
        result.expiredWorkflowRunIds.push(data.workflowRunId);
      if (await tableExists(client, "support_dispatch")) {
        const dispatches = await client.execute({
          sql: "SELECT run_id FROM support_dispatch WHERE case_id = ?",
          args: [String(row.id)],
        });
        for (const dispatch of dispatches.rows)
          result.expiredWorkflowRunIds.push(String(dispatch.run_id));
      }
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
  for (const table of ["support_cases", "support_messages", "support_audit"])
    if (!(await tableExists(client, table)))
      throw new Error(
        `Refusing retention cleanup: ${table} is missing. Start the local app once so its supported migrations finish first.`,
      );

  const cases = await sweepCases(client, policy);
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
  for (const runId of new Set(cases.expiredWorkflowRunIds))
    await workflows?.deleteWorkflowRunById({
      workflowName: "resolveSupportCaseWorkflow",
      runId,
    });
  const mastra = await storage.prune({ maxBatches: 10, maxRows: 5_000 });
  console.log(JSON.stringify({ policy, cases, mastra }));
} finally {
  client.close();
}
