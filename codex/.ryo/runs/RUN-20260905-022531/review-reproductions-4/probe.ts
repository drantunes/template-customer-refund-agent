import assert from 'node:assert/strict';
import {CaseStore} from '/Users/drantunes/Code/mastra-consulting-support-resolution/template-customer-refund-agent/src/mastra/lib/case-store';
import {LocalRuntime,deliverOutbox,recoverLocalWorkflows} from '/Users/drantunes/Code/mastra-consulting-support-resolution/template-customer-refund-agent/src/mastra/runtime/local-runtime';
const binding={tenantId:'ir4',providerKind:'local' as const,providerAccountId:'ir4',externalConversationId:'conv'};
const fresh=async(name:string)=>{const store=new CaseStore({url:`file:/private/tmp/ryo-ir4/${name}-${Date.now()}.db`});await store.list();return store};
const c=(id:string)=>({id,externalId:id,source:'mock-email' as const,status:'resolved' as const,customer:{email:'a@example.com'},subject:'s',messages:[],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),metadata:{providerBinding:binding}});
const enqueue=async(s:any,id:string)=>{await s.create(c(id));await s.enqueueDelivery({id,caseId:id,binding,body:id,status:'resolved'})};
const gate=()=>{let release!:()=>void;const promise=new Promise<void>(r=>release=r);return {release,promise}};
// Original archived schedule with extra claim required because fix no longer preclaims second.
{
const s=await fresh('stale');const local=new LocalRuntime(s.getClientForTests());await local.seed(binding);for(const id of ['first','second'])await enqueue(s,id);
const entered=gate(),blocked=gate();const calls:string[]=[];const provider={support:()=>({deliver:async(...args:any[])=>{calls.push(args[3]);if(args[3]==='first'){entered.release();await blocked.promise}return (local.support(binding).deliver as any)(...args)}})} as any;
const old=deliverOutbox(provider,10,s);await entered.promise;
assert.deepEqual((await s.getClientForTests().execute("SELECT state,attempts FROM support_outbox WHERE id='second'")).rows,[{state:'pending',attempts:0}]);
for(let i=0;i<4;i++){await s.getClientForTests().execute("UPDATE support_outbox SET lease_until='2000-01-01' WHERE id='second'");await s.claimOutbox(10)}
blocked.release();assert.equal(await old,1);assert.deepEqual(calls,['first']);const row=(await s.getClientForTests().execute("SELECT state,attempts,receipt FROM support_outbox WHERE id='second'")).rows[0];assert.deepEqual(row,{state:'failed',attempts:3,receipt:null});assert.equal((await s.getClientForTests().execute("SELECT COUNT(*) n FROM local_deliveries WHERE idempotency_key='second'")).rows[0].n,0);console.log('stale-terminal',row,'second local receipts 0');await s.close();
}
{
const s=await fresh('retry');for(const id of ['a','b','c'])await enqueue(s,id);const calls:string[]=[];const p={support:()=>({deliver:async(...args:any[])=>{calls.push(args[3]);throw Error('HTTP 500')}})} as any;
assert.equal(await deliverOutbox(p,2,s),2);assert.deepEqual(calls,['a','b']);assert.deepEqual((await s.getClientForTests().execute('SELECT attempts FROM support_outbox ORDER BY id')).rows,[{attempts:1},{attempts:1},{attempts:0}]);console.log('bounded retry',calls,'attempts 1/1/0');await s.close();
}
for(const scenario of ['outbox-false','outbox-error','lookup','create','projection']){
const s=await fresh(scenario);let calls=0;
if(scenario.startsWith('outbox')){await enqueue(s,'a');await enqueue(s,'b');s.renewOutboxLease=async()=>{if(scenario==='outbox-error')throw Error('storage failure');return false};assert.equal(await deliverOutbox({support:()=>({deliver:async()=>{calls++;return {id:'receipt'}}})} as any,2,s),1)}
else {await s.acceptInbound(c('a'),'event-a','run-a');await s.acceptInbound(c('b'),'event-b','run-b');const revoke=async()=>{await s.getClientForTests().execute("UPDATE support_dispatch SET lease_token='new-owner',lease_until='2099-01-01' WHERE case_id='a'")};if(scenario==='projection'){const original=s.update.bind(s);s.update=async(...args:any[])=>{const r=await (original as any)(...args);await revoke();return r}}const work={getWorkflow:()=>({getWorkflowRunById:async()=>{if(scenario==='lookup')await revoke();return {status:'running'}},createRun:async({runId}:any)=>{if(scenario==='create')await revoke();return {runId,start:async()=>{calls++;return {status:'success'}},restart:async()=>{calls++;return {status:'success'}}}}})};assert.equal(await recoverLocalWorkflows(work,2,s),1);if(scenario!=='projection')assert.equal((await s.get('a'))?.workflowRunId,undefined)}
assert.equal(calls,0);const table=scenario.startsWith('outbox')?'support_outbox':'support_dispatch';assert.equal((await s.getClientForTests().execute(`SELECT attempts FROM ${table} WHERE ${table==='support_outbox'?'id':'case_id'}='b'`)).rows[0].attempts,0);console.log(scenario,'effects 0; sweep stopped; second attempts 0');await s.close();
}
{
const s=await fresh('recovery-capacity');for(const id of ['a','b','c'])await s.acceptInbound(c(id),`e-${id}`,`r-${id}`);const entered=gate(),blocked=gate();const calls:string[]=[];
const worker={getWorkflow:()=>({getWorkflowRunById:async()=>undefined,createRun:async({runId}:any)=>({runId,start:async()=>{calls.push(runId);if(runId==='r-a'){entered.release();await blocked.promise}return {status:'success'}}})})};
const old=recoverLocalWorkflows(worker,1,s);await entered.promise;assert.deepEqual((await s.getClientForTests().execute("SELECT state,attempts FROM support_dispatch WHERE case_id='b'")).rows,[{state:'pending',attempts:0}]);assert.equal(await recoverLocalWorkflows(worker,1,s),1);blocked.release();assert.equal(await old,1);assert.deepEqual(calls,['r-a','r-b']);assert.equal((await s.getClientForTests().execute("SELECT attempts FROM support_dispatch WHERE case_id='c'")).rows[0].attempts,0);console.log('recovery capacity/bound','starts a/b once; c attempts 0');await s.close();
}
await Promise.all(['delivery','recovery'].map(async kind=>{
const s=await fresh(`heartbeat-${kind}`);let effects=0;const table=kind==='delivery'?'support_outbox':'support_dispatch';for(const id of ['a','b']){if(kind==='delivery')await enqueue(s,id);else await s.acceptInbound(c(id),`e-${id}`,`r-${id}`)}
const effect=async()=>{effects++;await s.getClientForTests().execute(`UPDATE ${table} SET lease_token='other-owner' WHERE ${kind==='delivery'?'id':'case_id'}='a'`);await new Promise(r=>setTimeout(r,10_500));return {status:'success',id:'r'}};
const count=kind==='delivery'?await deliverOutbox({support:()=>({deliver:effect})} as any,2,s):await recoverLocalWorkflows({getWorkflow:()=>({getWorkflowRunById:async()=>undefined,createRun:async({runId}:any)=>({runId,start:effect})})},2,s);
assert.equal(count,1);assert.equal(effects,1);assert.deepEqual((await s.getClientForTests().execute(`SELECT state,attempts FROM ${table} ORDER BY ${kind==='delivery'?'id':'case_id'}`)).rows,[{state:'claimed',attempts:1},{state:'pending',attempts:0}]);console.log(kind,'heartbeat observed lost owner; no terminal projection or next claim');await s.close();
}));
