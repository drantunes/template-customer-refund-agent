import { mastra } from "/Users/drantunes/Code/mastra-consulting-support-resolution/template-customer-refund-agent/src/mastra/index";
import { caseStore } from "/Users/drantunes/Code/mastra-consulting-support-resolution/template-customer-refund-agent/src/mastra/lib/case-store";
import { recoverLocalWorkflows } from "/Users/drantunes/Code/mastra-consulting-support-resolution/template-customer-refund-agent/src/mastra/runtime/local-runtime";
import { responseAgent } from "/Users/drantunes/Code/mastra-consulting-support-resolution/template-customer-refund-agent/src/mastra/agents/response-agent";
import { searchSupportKnowledgeTool } from "/Users/drantunes/Code/mastra-consulting-support-resolution/template-customer-refund-agent/src/mastra/tools/search-support-knowledge";
import { triageAgent } from "/Users/drantunes/Code/mastra-consulting-support-resolution/template-customer-refund-agent/src/mastra/agents/triage-agent";
import { issueRefundTool } from "/Users/drantunes/Code/mastra-consulting-support-resolution/template-customer-refund-agent/src/mastra/tools/issue-refund";

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
    const effect = { stoppedBeforeEffect: true };
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
  const c = (await caseStore.get("post-refund-recovery-case"))!;
  const command = c.metadata.refundCommand as any;
  const scenario = process.env.SR3_SCENARIO;
  if (scenario === 'bad-hash') command.amount = 20;
  if (scenario === 'replacement') {
    command.amount = 20;
    const {refundFingerprint,legacyAmountToMoney} = await import("/Users/drantunes/Code/mastra-consulting-support-resolution/template-customer-refund-agent/src/mastra/lib/money");
    const {bindingsForPersistedCase} = await import("/Users/drantunes/Code/mastra-consulting-support-resolution/template-customer-refund-agent/src/mastra/runtime/local-runtime");
    const {resolveConfiguredBinding} = await import("/Users/drantunes/Code/mastra-consulting-support-resolution/template-customer-refund-agent/src/mastra/providers/registry");
    command.fingerprint = refundFingerprint({binding:resolveConfiguredBinding(bindingsForPersistedCase(c).transactions),approvalCaseId:c.id,orderId:command.orderId,amount:legacyAmountToMoney(command.amount,command.currency),reason:command.reason,idempotencyKey:command.idempotencyKey});
  }
  if (scenario === 'missing-approver') c.approval!.approverId = '';
  if (scenario === 'wrong-case') command.approvalCaseId = 'other-case';
  await caseStore.update(c.id,{metadata:c.metadata,approval:c.approval});

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
  if (supportCase?.status !== 'failed' || Number(counts.rows[0].refunds)!==0 || Number(counts.rows[0].outbox)!==0 || Number(counts.rows[0].deliveries)!==0) throw Error('Tampered recovery did not fail closed');
  console.log('TAMPER_FAIL_CLOSED', process.env.SR3_SCENARIO);
  await mastra.shutdown();
} else {
  throw new Error("Expected init or recover mode.");
}
