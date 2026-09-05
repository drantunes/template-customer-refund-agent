import { Mastra } from "@mastra/core/mastra";
import { LibSQLStore } from "@mastra/libsql";
import { PinoLogger } from "@mastra/loggers";
import {
  MastraPlatformExporter,
  MastraStorageExporter,
  Observability,
  SensitiveDataFilter,
} from "@mastra/observability";
import { triageAgent } from "./agents/triage-agent";
import { responseAgent } from "./agents/response-agent";
import { supportSupervisorAgent } from "./agents/support-supervisor";
import { ingestSupportCaseWorkflow } from "./workflows/ingest-support-case";
import { resolveSupportCaseWorkflow } from "./workflows/resolve-support-case";
import { indexSupportKnowledgeWorkflow } from "./workflows/index-support-knowledge";
import { supportEvalScorerRegistry } from "./evals";
import { getSharedLocalSqliteClient } from "./lib/sqlite-client";
import { vectorStore } from "./lib/vector-store";
import { supportRoutes } from "./server/routes";
import { issueRefundTool } from "./tools/issue-refund";
import {
  lookupCustomerRefundHistoryTool,
  lookupOrderTool,
  lookupSubscriptionTool,
} from "./tools/lookup-order";
import { searchSupportKnowledgeTool } from "./tools/search-support-knowledge";
import { startLocalRuntimeWorkers } from "./runtime/local-runtime";
import { setMastraStorageReady } from "./runtime/storage-lifecycle";

export const mastra = new Mastra({
  agents: {
    triageAgent,
    responseAgent,
    supportSupervisorAgent,
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
  },
  scorers: supportEvalScorerRegistry,
  vectors: {
    supportKnowledge: vectorStore,
  },
  storage: new LibSQLStore({
    id: "mastra-storage",
    // Supported client injection makes Mastra and CaseStore share one
    // cooperative write queue while keeping their table ownership separate.
    client: getSharedLocalSqliteClient(),
    maxRetries: 5,
    initialBackoffMs: 5,
  }),
  server: {
    apiRoutes: supportRoutes,
  },
  logger: new PinoLogger({ name: "support-refund-agent", level: "info" }),
  observability: new Observability({
    configs: {
      default: {
        serviceName: "support-refund-agent",
        exporters: [new MastraStorageExporter(), new MastraPlatformExporter()],
        spanOutputProcessors: [new SensitiveDataFilter()],
      },
    },
  }),
});

// Composite storage initialization is the installed supported path. App-owned
// case migrations wait on it, preventing concurrent schema DDL on one file.
const storageReady = mastra.getStorage()?.init() ?? Promise.resolve();
setMastraStorageReady(storageReady);
void storageReady.catch((error) =>
  mastra.getLogger().error("Mastra storage initialization failed.", { error }),
);

// Mastra loads this module for both `npm run dev` and `npm run start`; recovery
// starts after Mastra storage is ready so it cannot race its schema initialization.
if (!process.env.VITEST)
  void storageReady.then(() =>
    startLocalRuntimeWorkers(mastra, mastra.getLogger()),
  );
