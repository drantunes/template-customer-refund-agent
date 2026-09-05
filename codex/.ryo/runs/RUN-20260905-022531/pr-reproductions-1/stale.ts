import assert from 'node:assert/strict';
import {CaseStore} from './src/mastra/lib/case-store';
import {LocalRuntime,deliverOutbox} from './src/mastra/runtime/local-runtime';
const store=new CaseStore({url:'file:/private/tmp/ryo-pr2-review/stale.db'});await store.list();
const local=new LocalRuntime(store.getClientForTests());
const binding={tenantId:'a',providerKind:'local' as const,providerAccountId:'a',externalConversationId:'conv'};
await local.seed(binding);
for(const id of ['first','second']) {await store.create({id,externalId:id,source:'mock-email',status:'resolved',customer:{email:'a@example.com'},subject:'s',messages:[],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),metadata:{providerBinding:binding}});await store.enqueueDelivery({id,caseId:id,binding,body:id,status:'resolved'});}
let started!:()=>void; const firstStarted=new Promise<void>(r=>started=r);let unblock!:()=>void;const blocked=new Promise<void>(r=>unblock=r); const calls:string[]=[];
const provider={support:(b:any)=>({deliver:async(binding:any,body:string,status:string,key:string)=>{calls.push(key);if(key==='first'){started();await blocked;}return local.support(binding).deliver(binding,body,status,key);}})} as any;
const original=deliverOutbox(provider,10,store);await firstStarted;
// Advance only second queued item's persisted deadline, exactly modeling elapsed lease time while first hangs.
for(let i=0;i<3;i++){await store.getClientForTests().execute("UPDATE support_outbox SET lease_until='2000-01-01' WHERE id='second'");await store.claimOutbox(10);}
assert.equal((await store.getClientForTests().execute("SELECT state FROM support_outbox WHERE id='second'")).rows[0].state,'failed');
assert.equal((await store.getClientForTests().execute("SELECT COUNT(*) n FROM local_deliveries WHERE idempotency_key='second'")).rows[0].n,0);
unblock();await original;
const outbox=(await store.getClientForTests().execute("SELECT id,state,attempts,receipt FROM support_outbox ORDER BY id")).rows;const receipts=(await store.getClientForTests().execute("SELECT idempotency_key FROM local_deliveries ORDER BY idempotency_key")).rows;
console.log(JSON.stringify({calls,outbox,receipts,caseMetadata:(await store.get('second'))?.metadata},null,2));
assert.equal(receipts.length,2);assert.equal(outbox[1].state,'failed');assert.equal(outbox[1].receipt,null);console.log('REPRODUCED_STALE_WORKER_DELIVERS_AFTER_TERMINAL_FAILURE');await store.close();
