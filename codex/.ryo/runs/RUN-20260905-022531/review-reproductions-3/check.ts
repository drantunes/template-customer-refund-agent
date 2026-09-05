import {CaseStore} from '/Users/drantunes/Code/mastra-consulting-support-resolution/template-customer-refund-agent/src/mastra/lib/case-store';
import {LocalRuntime} from '/Users/drantunes/Code/mastra-consulting-support-resolution/template-customer-refund-agent/src/mastra/runtime/local-runtime';
import {createLocalLoopbackFacade} from '/Users/drantunes/Code/mastra-consulting-support-resolution/template-customer-refund-agent/src/mastra/providers/loopback-http';
const store=new CaseStore({url:'file:/private/tmp/ryo-ir3/check-1.db'}); await store.list();
const binding={tenantId:'a',providerKind:'local' as const,providerAccountId:'a',externalConversationId:'conv'};
function item(id:string,b=binding){return {id,externalId:'same-event',source:'mock-email' as const,status:'new' as const,customer:{email:'alex@example.com'},subject:'s',messages:[],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),metadata:{providerBinding:b}};}
await store.acceptInbound(item('a'),'event_mock-email_same-event','run-a');
try {await store.acceptInbound(item('b',{...binding,tenantId:'b',providerAccountId:'b'}),'event_mock-email_same-event','run-b'); console.log('event accepted');}catch(e){console.log('R1-008',String(e));}
const local=new LocalRuntime(store.getClientForTests()); await local.seed(binding); await local.reset(binding); await local.seed(binding); console.log('seed-reset-seed order',await local.findOrder(binding,'','ORD-1001'));
const http=createLocalLoopbackFacade(local); const response=await http(new Request('http://loopback/support/deliver',{method:'POST',body:JSON.stringify({binding,body:{bad:true},status:17,idempotencyKey:'invalid-fields'})})); console.log('R1-011',response.status,await response.json());
await store.enqueueDelivery({id:'out',caseId:'a',binding,body:'body',status:'resolved'}); const [first]=await store.claimOutbox(); await store.getClientForTests().execute("UPDATE support_outbox SET lease_until='2000-01-01' WHERE id='out'"); const [second]=await store.claimOutbox(); await store.completeOutbox('out',{ok:true},second.leaseToken); await store.retryOutbox('out','stale failed',true,first.leaseToken); console.log('R1-005 stale', (await store.get('a'))?.metadata, (await store.getClientForTests().execute("SELECT state FROM support_outbox WHERE id='out'")).rows);

const claims=await Promise.all(Array.from({length:12},()=>store.claimDispatchForResume('a','run-a')));
if(claims.some(Boolean)) throw Error('pending dispatch unexpectedly resumable');
await store.getClientForTests().execute("UPDATE support_dispatch SET state='suspended' WHERE case_id='a'");
const resumed=await Promise.all(Array.from({length:12},()=>store.claimDispatchForResume('a','run-a')));
if(resumed.filter(Boolean).length!==1) throw Error('multiple resume owners');
const old=resumed.find(Boolean)!;
await store.getClientForTests().execute("UPDATE support_dispatch SET lease_until='2000-01-01' WHERE case_id='a'");
const recovered=await store.claimDispatch();
await store.update('a',{status:'resolved'});
if(await store.failDispatchAndCase(old.id,'a','STALEFAIL',old.leaseToken)) throw Error('stale failure accepted');
if((await store.get('a'))?.status!=='resolved') throw Error('stale projection');
await Promise.all([local.reset(binding),local.seed(binding)]);
if(!await local.findOrder(binding,'','ORD-1001')) throw Error('queued seed failed');
console.log('EXTRA_ASSERTIONS_OK bounded12 conflict, one resume owner, stale dispatch fenced, queued reset seed');
await store.close();
