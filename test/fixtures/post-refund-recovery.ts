import { mastra } from "../../src/mastra/index";
import { caseStore } from "../../src/mastra/lib/case-store";
import { recoverLocalWorkflows } from "../../src/mastra/runtime/local-runtime";
import { responseAgent } from "../../src/mastra/agents/response-agent";
import { searchSupportKnowledgeTool } from "../../src/mastra/tools/search-support-knowledge";
import { triageAgent } from "../../src/mastra/agents/triage-agent";
import { issueRefundTool } from "../../src/mastra/tools/issue-refund";

triageAgent.generate = async () =>
  ({
    object: {
      intent: "duplicate_charge",
      urgency: "normal",
      sentiment: "negative",
      requiresHumanReview: true,
      confidence: 1,
      rationale: "two-process recovery fixture",
    },
    usage: { inputTokens: 1, outputTokens: 1 },
  }) as never;
responseAgent.generate = async () =>
  ({
    object: {
      draftResponse: "Two-process refund response",
      citedSources: ["duplicate-charge-policy"],
      recommendRefund: true,
      refundAmount: 10,
      refundCurrency: "USD",
      refundReason: "duplicate",
      requiresEscalation: false,
    },
    usage: { inputTokens: 1, outputTokens: 1 },
  }) as never;
searchSupportKnowledgeTool.execute = async () =>
  ({
    sources: [
      {
        metadata: {
          title: "policy",
          source: "duplicate-charge-policy",
          text: "duplicate refund",
        },
        score: 1,
      },
    ],
  }) as never;

await caseStore.list();
const workflow = mastra.getWorkflow("resolveSupportCaseWorkflow");
const mode = process.argv[2];

if (mode === "init") {
  const createdAt = new Date().toISOString();
  await caseStore.acceptInbound(
    {
      id: "post-refund-recovery-case",
      externalId: "post-refund-recovery-event",
      source: "mock-email",
      status: "new",
      subject: "charged twice",
      customer: { email: "alex@example.com" },
      messages: [
        {
          id: "post-refund-recovery-message",
          author: "customer",
          body: "refund duplicate",
          createdAt,
        },
      ],
      createdAt,
      updatedAt: createdAt,
      metadata: {},
    },
    "post-refund-recovery-event",
    "post-refund-recovery-run",
  );
  await recoverLocalWorkflows(mastra);
  const original = issueRefundTool.execute!;
  issueRefundTool.execute = async (...args: any[]) => {
    const effect = await (original as any)(...args);
    console.log("POST_REFUND_EFFECT", JSON.stringify(effect));
    process.exit(71);
  };
  await caseStore.claimDispatchForResume(
    "post-refund-recovery-case",
    "post-refund-recovery-run",
  );
  await caseStore.update("post-refund-recovery-case", { status: "processing" });
  const run = await workflow.createRun({ runId: "post-refund-recovery-run" });
  await run.resume({
    step: "request-approval",
    resumeData: { approved: true, approverId: "recovery-reviewer" },
  });
} else if (mode === "recover") {
  await caseStore
    .getClientForTests()
    .execute(
      "UPDATE support_dispatch SET lease_until = '2000-01-01' WHERE case_id = 'post-refund-recovery-case'",
    );
  await recoverLocalWorkflows(mastra);
  const supportCase = await caseStore.get("post-refund-recovery-case");
  const counts = await caseStore
    .getClientForTests()
    .execute(
      "SELECT (SELECT COUNT(*) FROM local_refunds) refunds, (SELECT COUNT(*) FROM support_outbox) outbox, (SELECT COUNT(*) FROM local_deliveries) deliveries",
    );
  console.log(
    "POST_REFUND_RECOVERY_RESULT",
    JSON.stringify({
      case: supportCase,
      counts: counts.rows[0],
    }),
  );
  await mastra.shutdown();
} else {
  throw new Error("Expected init or recover mode.");
}
