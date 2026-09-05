import {mastra} from '/Users/drantunes/Code/mastra-consulting-support-resolution/template-customer-refund-agent/src/mastra/index';
import {caseStore} from '/Users/drantunes/Code/mastra-consulting-support-resolution/template-customer-refund-agent/src/mastra/lib/case-store';
import {recoverLocalWorkflows} from '/Users/drantunes/Code/mastra-consulting-support-resolution/template-customer-refund-agent/src/mastra/runtime/local-runtime';
import {triageAgent} from '/Users/drantunes/Code/mastra-consulting-support-resolution/template-customer-refund-agent/src/mastra/agents/triage-agent';
import {responseAgent} from '/Users/drantunes/Code/mastra-consulting-support-resolution/template-customer-refund-agent/src/mastra/agents/response-agent';
import {searchSupportKnowledgeTool} from '/Users/drantunes/Code/mastra-consulting-support-resolution/template-customer-refund-agent/src/mastra/tools/search-support-knowledge';
import {issueRefundTool} from '/Users/drantunes/Code/mastra-consulting-support-resolution/template-customer-refund-agent/src/mastra/tools/issue-refund';
triageAgent.generate=async()=>({object:{intent:'duplicate_charge',urgency:'normal',sentiment:'negative',requiresHumanReview:true,confidence:1,rationale:'test'},usage:{inputTokens:1,outputTokens:1}} as any);
responseAgent.generate=async()=>({object:{draftResponse:'Test refund',citedSources:['duplicate-charge-policy'],recommendRefund:true,refundAmount:10,refundCurrency:'USD',refundReason:'duplicate',requiresEscalation:false},usage:{inputTokens:1,outputTokens:1}} as any);
searchSupportKnowledgeTool.execute=async()=>({sources:[{metadata:{title:'policy',source:'duplicate-charge-policy',text:'duplicate refund'},score:1}]} as any);
await caseStore.list(); const workflow=mastra.getWorkflow('resolveSupportCaseWorkflow');
if(process.argv[2]==='init'){
const time=new Date().toISOString(); await caseStore.acceptInbound({id:'recovery-case',externalId:'recovery-event',source:'mock-email',status:'new',subject:'charged twice',customer:{email:'alex@example.com'},messages:[{id:'m1',author:'customer',body:'refund duplicate',createdAt:time}],createdAt:time,updatedAt:time,metadata:{}},'recovery-event','recovery-run');
await recoverLocalWorkflows(mastra); console.log('PRESTART',await caseStore.get('recovery-case'));
const original=issueRefundTool.execute!; issueRefundTool.execute=async(...args:any[])=>{const r=await (original as any)(...args); console.log('EFFECT BEFORE CRASH',r); process.exit(71);};
await caseStore.claimDispatchForResume('recovery-case','recovery-run'); await caseStore.update('recovery-case',{status:'processing'}); const run=await workflow.createRun({runId:'recovery-run'}); await run.resume({step:'request-approval',resumeData:{approved:true,approverId:'reviewer'}});
}else{
console.log('SNAPSHOT BEFORE',JSON.stringify(await workflow.getWorkflowRunById('recovery-run'))); await caseStore.getClientForTests().execute("UPDATE support_dispatch SET lease_until='2000-01-01' WHERE case_id='recovery-case'"); await recoverLocalWorkflows(mastra); console.log('RECOVERED CASE',JSON.stringify(await caseStore.get('recovery-case'))); console.log('DURABLE COUNTS',(await caseStore.getClientForTests().execute('SELECT (SELECT COUNT(*) FROM local_refunds) refunds,(SELECT COUNT(*) FROM support_outbox) outbox,(SELECT COUNT(*) FROM local_deliveries) deliveries')).rows);
}
await mastra.shutdown();
