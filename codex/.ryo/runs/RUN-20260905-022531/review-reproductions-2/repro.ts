import {CaseStore} from '/Users/drantunes/Code/mastra-consulting-support-resolution/template-customer-refund-agent/src/mastra/lib/case-store';
import {LocalRuntime} from '/Users/drantunes/Code/mastra-consulting-support-resolution/template-customer-refund-agent/src/mastra/runtime/local-runtime';
import {createLocalLoopbackFacade} from '/Users/drantunes/Code/mastra-consulting-support-resolution/template-customer-refund-agent/src/mastra/providers/loopback-http';
const store=new CaseStore({url:'file:/private/tmp/ryo-ir2/check.db'}); await store.list();
const binding={tenantId:'a',providerKind:'local' as const,providerAccountId:'a',externalConversationId:'conv'};
function item(id:string,b=binding){return {id,externalId:'same-event',source:'mock-email' as const,status:'new' as const,customer:{email:'alex@example.com'},subject:'s',messages:[],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),metadata:{providerBinding:b}};}
await store.acceptInbound(item('a'),'event_mock-email_same-event','run-a');
try {await store.acceptInbound(item('b',{...binding,tenantId:'b',providerAccountId:'b'}),'event_mock-email_same-event','run-b'); console.log('event accepted');}catch(e){console.log('R1-008',String(e));}
const local=new LocalRuntime(store.getClientForTests()); await local.seed(binding); await local.reset(binding); await local.seed(binding); console.log('seed-reset-seed order',await local.findOrder(binding,'','ORD-1001'));
const http=createLocalLoopbackFacade(local); const response=await http(new Request('http://loopback/support/deliver',{method:'POST',body:JSON.stringify({binding,body:{bad:true},status:17,idempotencyKey:'invalid-fields'})})); console.log('R1-011',response.status,await response.json());
await store.enqueueDelivery({id:'out',caseId:'a',binding,body:'body',status:'resolved'}); const [first]=await store.claimOutbox(); await store.getClientForTests().execute("UPDATE support_outbox SET lease_until='2000-01-01' WHERE id='out'"); const [second]=await store.claimOutbox(); await store.completeOutbox('out',{ok:true},second.leaseToken); await store.retryOutbox('out','stale failed',true,first.leaseToken); console.log('R1-005 stale', (await store.get('a'))?.metadata, (await store.getClientForTests().execute("SELECT state FROM support_outbox WHERE id='out'")).rows);
await store.close();
