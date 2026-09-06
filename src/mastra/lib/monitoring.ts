import type { Mastra } from "@mastra/core/mastra";
import { caseStore } from "./case-store";
import { legacyAmountToMoney } from "./money";
import type { SupportCase } from "../domain/support-case";
import { bindingsForCase } from "../providers/contracts";
import { alertReasons } from "./operational-alerts";

type Availability<T> = T | null;
type StoredSpan = {
  name: string;
  spanType: string;
  startedAt: Date;
  endedAt?: Date | null;
  error?: unknown;
  attributes?: unknown;
};

function minutesBetween(startIso: string, endIso: string): number {
  return (new Date(endIso).getTime() - new Date(startIso).getTime()) / 60_000;
}
function numberAt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}
function recordAt(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export interface CaseFunnelMetrics {
  totalCases: number;
  new: number;
  processing: number;
  waitingApproval: number;
  resolved: number;
  escalated: number;
  failed: number;
  containmentRate: Availability<number>;
  escalationRate: Availability<number>;
  avgResolutionMinutes: Availability<number>;
}
export interface CurrencyTotal {
  currency: string;
  minor: number;
}
export interface RefundApprovalMetrics {
  recommended: number;
  approved: number;
  rejected: number;
  executed: number;
  failed: number;
  autoEscalated: number;
  approvalRate: Availability<number>;
  /** Exact minor-unit totals; different currencies are never added together. */
  executedTotals: CurrencyTotal[];
}
export interface FeedbackMetrics {
  totalResponses: number;
  up: number;
  down: number;
  satisfactionRate: Availability<number>;
  recent: Array<{
    caseId: string;
    subject: string;
    rating: "up" | "down";
    submittedAt: string;
    turnId?: string;
    runId?: string;
    traceId?: string;
  }>;
}
export interface ModelUsageMetrics {
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostMicrosUsd: Availability<number>;
}
export interface OperationMetrics {
  operation: string;
  calls: number;
  errorRate: Availability<number>;
  p95Ms: Availability<number>;
}
export interface MonitoringSummary {
  generatedAt: string;
  casesConsidered: number;
  funnel: CaseFunnelMetrics;
  refunds: RefundApprovalMetrics;
  feedback: FeedbackMetrics;
  telemetry: {
    observedTraces: number;
    observedSpans: number;
    providerOrToolErrorRate: Availability<number>;
    providerOrToolP95Ms: Availability<number>;
    modelUsage: ModelUsageMetrics[];
    workflowStages: OperationMetrics[];
    providerCalls: OperationMetrics[];
    toolCalls: OperationMetrics[];
    unavailable: string[];
    alerts: string[];
  };
  failures: {
    rejectedDecisions: number;
    workflow: number;
    financial: number;
    delivery: number;
  };
}

function percentile95(values: number[]): Availability<number> {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.ceil(sorted.length * 0.95) - 1]! : null;
}
function durationMs(span: Pick<StoredSpan, "startedAt" | "endedAt">) {
  return span.endedAt
    ? Math.max(0, span.endedAt.getTime() - span.startedAt.getTime())
    : undefined;
}
function operationMetrics(spans: StoredSpan[]): OperationMetrics[] {
  const grouped = new Map<string, StoredSpan[]>();
  for (const span of spans)
    grouped.set(span.name, [...(grouped.get(span.name) ?? []), span]);
  return [...grouped]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([operation, entries]) => ({
      operation,
      calls: entries.length,
      // The redactor leaves undefined absent. A redacted non-null error remains
      // a true error without exporting prose or credentials.
      errorRate:
        entries.filter(
          (span) => span.error !== undefined && span.error !== null,
        ).length / entries.length,
      p95Ms: percentile95(
        entries
          .map(durationMs)
          .filter((value): value is number => value !== undefined),
      ),
    }));
}

async function readTrustedSpanMetrics(mastra: Mastra, cases: SupportCase[]) {
  const observability = await mastra.getStorage()?.getStore("observability");
  const traceIds = new Set<string>();
  for (const supportCase of cases) {
    for (const turn of await caseStore.turns(supportCase.id)) {
      const telemetry = recordAt(turn.outcome?.telemetry);
      if (typeof telemetry?.traceId === "string")
        traceIds.add(telemetry.traceId);
    }
    // Compatibility for pre-turn-telemetry records; normal paths only use a
    // turn reference and later projections cannot overwrite it.
    if (supportCase.traceId) traceIds.add(supportCase.traceId);
  }
  if (!observability)
    return {
      observedTraces: 0,
      observedSpans: 0,
      providerOrToolErrorRate: null,
      providerOrToolP95Ms: null,
      modelUsage: [],
      workflowStages: [],
      providerCalls: [],
      toolCalls: [],
      unavailable: ["observability-storage"],
      alerts: [],
    };
  const traces = await Promise.all(
    [...traceIds].map((traceId) => observability.getTrace({ traceId })),
  );
  const spans = traces.flatMap((trace) => trace?.spans ?? []) as StoredSpan[];
  const operational = spans.filter((span) =>
    ["tool_call", "provider_tool_call", "model_inference"].includes(
      span.spanType,
    ),
  );
  const models = spans.filter((span) => span.spanType === "model_generation");
  const modelUsage = new Map<string, ModelUsageMetrics>();
  for (const span of models) {
    const attributes = recordAt(span.attributes);
    const model =
      typeof attributes?.responseModel === "string"
        ? attributes.responseModel
        : typeof attributes?.model === "string"
          ? attributes.model
          : "unknown";
    const usage = recordAt(attributes?.usage);
    const inputTokens = numberAt(usage?.inputTokens);
    const outputTokens = numberAt(usage?.outputTokens);
    const cost = numberAt(
      recordAt(attributes?.costContext)?.estimatedCostMicrosUsd,
    );
    if (inputTokens === undefined || outputTokens === undefined) continue;
    const current = modelUsage.get(model) ?? {
      model,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostMicrosUsd: 0,
    };
    current.inputTokens += inputTokens;
    current.outputTokens += outputTokens;
    current.estimatedCostMicrosUsd =
      current.estimatedCostMicrosUsd === null || cost === undefined
        ? null
        : current.estimatedCostMicrosUsd + cost;
    modelUsage.set(model, current);
  }
  return {
    observedTraces: traces.filter(Boolean).length,
    observedSpans: spans.length,
    providerOrToolErrorRate: operational.length
      ? operational.filter(
          (span) => span.error !== undefined && span.error !== null,
        ).length / operational.length
      : null,
    providerOrToolP95Ms: percentile95(
      operational
        .map(durationMs)
        .filter((value): value is number => value !== undefined),
    ),
    modelUsage: [...modelUsage.values()].sort((a, b) =>
      a.model.localeCompare(b.model),
    ),
    workflowStages: operationMetrics(
      spans.filter((span) => span.spanType === "workflow_step"),
    ),
    providerCalls: operationMetrics(
      spans.filter((span) =>
        ["provider_tool_call", "model_inference"].includes(span.spanType),
      ),
    ),
    toolCalls: operationMetrics(
      spans.filter((span) => span.spanType === "tool_call"),
    ),
    unavailable: [
      ...(traceIds.size === 0 ? ["trace-correlation"] : []),
      ...(models.length === 0 ? ["model-usage"] : []),
      ...(models.some(
        (span) =>
          numberAt(recordAt(recordAt(span.attributes)?.usage)?.inputTokens) ===
          undefined,
      )
        ? ["partial-model-usage"]
        : []),
    ],
    alerts: alertReasons(
      operational.map((span) => ({
        providerOrTool: span.name,
        occurredAt: span.startedAt,
        durationMs: durationMs(span) ?? 0,
        failed: span.error !== undefined && span.error !== null,
      })),
    ),
  };
}

export function computeCaseFunnelMetrics(
  cases: SupportCase[],
): CaseFunnelMetrics {
  const byStatus = {
    new: 0,
    processing: 0,
    waiting_approval: 0,
    resolved: 0,
    escalated: 0,
    failed: 0,
  };
  for (const supportCase of cases) byStatus[supportCase.status] += 1;
  const decided = byStatus.resolved + byStatus.escalated;
  const durations = cases
    .filter((item) => item.status === "resolved" || item.status === "escalated")
    .map((item) => minutesBetween(item.createdAt, item.updatedAt))
    .filter((value) => Number.isFinite(value) && value >= 0);
  return {
    totalCases: cases.length,
    new: byStatus.new,
    processing: byStatus.processing,
    waitingApproval: byStatus.waiting_approval,
    resolved: byStatus.resolved,
    escalated: byStatus.escalated,
    failed: byStatus.failed,
    containmentRate: decided ? byStatus.resolved / decided : null,
    escalationRate: decided ? byStatus.escalated / decided : null,
    avgResolutionMinutes: durations.length
      ? durations.reduce((sum, value) => sum + value, 0) / durations.length
      : null,
  };
}
function refundResult(value: unknown) {
  const item = recordAt(value);
  if (
    !item ||
    typeof item.currency !== "string" ||
    typeof item.amount !== "number" ||
    !Number.isFinite(item.amount)
  )
    return undefined;
  try {
    return {
      status: item.status,
      idempotencyKey: item.idempotencyKey,
      ...legacyAmountToMoney(item.amount, item.currency),
    };
  } catch {
    return undefined;
  }
}
export async function computeRefundApprovalMetrics(
  cases: SupportCase[],
): Promise<RefundApprovalMetrics> {
  let recommended = 0,
    autoEscalated = 0,
    executed = 0,
    failed = 0;
  const totals = new Map<string, number>();
  const effectKeys = new Set<string>();
  for (const supportCase of cases) {
    const turns = await caseStore.turns(supportCase.id);
    for (const turn of turns) {
      const draft = recordAt(turn.outcome?.draft);
      if (draft?.recommendRefund === true) recommended += 1;
      if (
        turn.outcome?.status === "escalated" &&
        draft?.recommendRefund === true &&
        !recordAt(turn.outcome?.approval)
      )
        autoEscalated += 1;
      const result = refundResult(turn.outcome?.refundResult);
      if (result?.status === "executed") {
        const key = String(result.idempotencyKey ?? turn.id);
        if (!effectKeys.has(key)) {
          effectKeys.add(key);
          executed += 1;
          totals.set(
            result.currency,
            (totals.get(result.currency) ?? 0) + result.minor,
          );
        }
      }
      if (turn.state === "failed" && draft?.recommendRefund === true)
        failed += 1;
    }
    const effects = recordAt(
      (supportCase.metadata as Record<string, unknown>).refundEffects,
    );
    for (const effect of Object.values(effects ?? {})) {
      const result = refundResult(effect);
      const key = String(result?.idempotencyKey ?? "");
      if (result?.status === "executed" && key && !effectKeys.has(key)) {
        effectKeys.add(key);
        executed += 1;
        totals.set(
          result.currency,
          (totals.get(result.currency) ?? 0) + result.minor,
        );
      }
    }
    if (!turns.length && supportCase.draft?.recommendRefund) recommended += 1;
  }
  const decisions = await caseStore.monitoringDecisions(
    cases.map((item) => item.id),
  );
  const approved = decisions.filter((item) => item.approved).length;
  const rejected = decisions.filter((item) => !item.approved).length;
  return {
    recommended,
    approved,
    rejected,
    executed,
    failed,
    autoEscalated,
    approvalRate: approved + rejected ? approved / (approved + rejected) : null,
    executedTotals: [...totals]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, minor]) => ({ currency, minor })),
  };
}
export function computeFeedbackMetrics(cases: SupportCase[]): FeedbackMetrics {
  const feedback = cases.filter(
    (
      item,
    ): item is SupportCase & {
      feedback: NonNullable<SupportCase["feedback"]>;
    } => !!item.feedback,
  );
  const up = feedback.filter((item) => item.feedback.rating === "up").length;
  return {
    totalResponses: feedback.length,
    up,
    down: feedback.length - up,
    satisfactionRate: feedback.length ? up / feedback.length : null,
    recent: [...feedback]
      .sort((a, b) =>
        a.feedback.submittedAt < b.feedback.submittedAt ? 1 : -1,
      )
      .slice(0, 10)
      .map((item) => ({
        caseId: item.id,
        subject: item.subject,
        rating: item.feedback.rating,
        submittedAt: item.feedback.submittedAt,
        turnId: item.feedback.turnId,
        runId: item.feedback.runId,
        traceId: item.feedback.traceId,
      })),
  };
}
export async function computeMonitoringSummary(
  mastra: Mastra,
  tenantId: string,
): Promise<MonitoringSummary> {
  const cases = (await caseStore.list()).filter(
    (supportCase) => bindingsForCase(supportCase).support.tenantId === tenantId,
  );
  const failures = await caseStore.monitoringOperationalFailures(
    cases.map((item) => item.id),
  );
  const telemetry = await readTrustedSpanMetrics(mastra, cases);
  if (failures.financial > 0 && !telemetry.alerts.includes("refund-failure"))
    telemetry.alerts.push("refund-failure");
  return {
    generatedAt: new Date().toISOString(),
    casesConsidered: cases.length,
    funnel: computeCaseFunnelMetrics(cases),
    refunds: await computeRefundApprovalMetrics(cases),
    feedback: computeFeedbackMetrics(cases),
    telemetry,
    failures,
  };
}
