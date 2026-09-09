import { Mastra } from "@mastra/core/mastra";
import { LibSQLStore } from "@mastra/libsql";
import {
  MastraPlatformExporter,
  MastraStorageExporter,
  Observability,
  SensitiveDataFilter,
} from "@mastra/observability";
import { triageAgent } from "./agents/triage-agent";
import { responseAgent } from "./agents/response-agent";
import { supportSupervisorAgent } from "./agents/support-supervisor";
import { refundExecutionAgent } from "./agents/refund-execution-agent";
import { ingestSupportCaseWorkflow } from "./workflows/ingest-support-case";
import { resolveSupportCaseWorkflow } from "./workflows/resolve-support-case";
import { indexSupportKnowledgeWorkflow } from "./workflows/index-support-knowledge";
import { liveSupportScorerRegistry } from "./evals";
import {
  closeSharedLocalSqliteClient,
  getMastraSharedLocalSqliteClient,
} from "./lib/sqlite-client";
import { vectorStore } from "./lib/vector-store";
import { supportRoutes } from "./server/routes";
import { issueRefundTool } from "./tools/issue-refund";
import { scheduleSubscriptionCancellationTool } from "./tools/schedule-subscription-cancellation";
import {
  lookupCustomerRefundHistoryTool,
  lookupOrderTool,
  lookupSubscriptionTool,
} from "./tools/lookup-order";
import { searchSupportKnowledgeTool } from "./tools/search-support-knowledge";
import { startLocalRuntimeWorkers } from "./runtime/local-runtime";
import {
  setMastraStorageReady,
  startAfterStorageReady,
} from "./runtime/storage-lifecycle";
import { LocalSupportAuthProvider } from "./server/auth";
import { studioSupervisorMiddleware } from "./server/studio-supervisor";
import { retentionPolicyFromEnvironment } from "./lib/case-store";
import {
  ApplicationSpanRedactor,
  RedactingPinoLogger,
} from "./lib/observability-redaction";
import {
  registerConfiguredIntercomProvider,
  registerConfiguredStripeProvider,
} from "./providers/registry";

const retentionPolicy = retentionPolicyFromEnvironment();
let localRuntimeWorkers: Promise<undefined | (() => Promise<void>)> =
  Promise.resolve(undefined);

// This is deliberately evaluated during composition: an explicit external
// opt-in with incomplete development configuration fails rather than routing
// an Intercom case to local fixtures.
registerConfiguredIntercomProvider();
registerConfiguredStripeProvider();

export const mastra = new Mastra({
  agents: {
    triageAgent,
    responseAgent,
    supportSupervisorAgent,
    refundExecutionAgent,
  },
  workflows: {
    ingestSupportCaseWorkflow,
    resolveSupportCaseWorkflow,
    indexSupportKnowledgeWorkflow,
  },
  tools: {
    searchSupportKnowledgeTool,
    lookupOrderTool,
    lookupSubscriptionTool,
    lookupCustomerRefundHistoryTool,
    issueRefundTool,
    scheduleSubscriptionCancellationTool,
  },
  scorers: process.env.DISABLE_RUNTIME_SCORERS ? {} : liveSupportScorerRegistry,
  vectors: {
    supportKnowledge: vectorStore,
  },
  storage: new LibSQLStore({
    id: "mastra-storage",
    // Supported client injection makes Mastra and CaseStore share one
    // cooperative write queue while keeping their table ownership separate.
    client: getMastraSharedLocalSqliteClient(),
    maxRetries: 5,
    initialBackoffMs: 5,
    // Use Mastra's supported retention API for its own memory and telemetry
    // tables. Workflow snapshots are intentionally not configured here: their
    // durable authority is retained until an explicit lifecycle policy exists.
    retention: {
      memory: {
        messages: { maxAge: `${retentionPolicy.caseDays}d`, batchSize: 500 },
        resources: { maxAge: `${retentionPolicy.caseDays}d`, batchSize: 500 },
        threads: { maxAge: `${retentionPolicy.caseDays}d`, batchSize: 500 },
      },
      observability: {
        spans: { maxAge: `${retentionPolicy.traceDays}d`, batchSize: 500 },
      },
    },
  }),
  server: {
    apiRoutes: supportRoutes,
    middleware: studioSupervisorMiddleware,
    // This protects the configured server's built-in agent/tool/workflow,
    // approval, memory and storage routes as well as our custom API routes.
    auth: new LocalSupportAuthProvider(),
    // This module owns SIGINT/SIGTERM so it can stop local recovery before
    // Mastra and the shared SQLite client close. The generated CLI cannot
    // drain HTTP connections while custom signal handling is enabled.
    handleShutdownSignals: false,
  },
  logger: new RedactingPinoLogger({
    name: "support-refund-agent",
    level: "info",
  }),
  observability: new Observability({
    configs: {
      default: {
        serviceName: "support-refund-agent",
        exporters: [new MastraStorageExporter(), new MastraPlatformExporter()],
        spanOutputProcessors: [
          new ApplicationSpanRedactor(),
          new SensitiveDataFilter(),
        ],
      },
    },
  }),
});

// Composite storage initialization is the installed supported path. App-owned
// case migrations wait on it, preventing concurrent schema DDL on one file.
const storageReady = mastra.getStorage()?.init() ?? Promise.resolve();
setMastraStorageReady(storageReady);
// Mastra loads this module for both `npm run dev` and `npm run start`; recovery
// starts after Mastra storage is ready so it cannot race its schema initialization.
localRuntimeWorkers = startAfterStorageReady(
  storageReady,
  () =>
    process.env.VITEST
      ? undefined
      : startLocalRuntimeWorkers(mastra, mastra.getLogger()),
  (error) =>
    mastra
      .getLogger()
      .error("Mastra storage initialization failed.", { error }),
);

/** The supported orderly local shutdown: flush Mastra before releasing SQLite. */
export async function shutdownLocalMastra() {
  const stopWorkers = await localRuntimeWorkers.catch(() => undefined);
  await stopWorkers?.();
  await mastra.shutdown();
  await closeSharedLocalSqliteClient();
}

let signalShutdown: Promise<never> | undefined;
function shutdownFromSignal(signal: "SIGINT" | "SIGTERM") {
  signalShutdown ??= shutdownLocalMastra().then(
    () => process.exit(0),
    (error) => {
      mastra.getLogger().error("Local runtime shutdown failed.", {
        error,
        signal,
      });
      process.exit(1);
    },
  );
  return signalShutdown;
}
if (!process.env.VITEST) {
  process.once("SIGINT", () => void shutdownFromSignal("SIGINT"));
  process.once("SIGTERM", () => void shutdownFromSignal("SIGTERM"));
}
