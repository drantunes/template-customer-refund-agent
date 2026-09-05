import assert from 'node:assert/strict';
import {CaseStore} from '/Users/drantunes/Code/mastra-consulting-support-resolution/template-customer-refund-agent/src/mastra/lib/case-store';
import {LocalRuntime} from '/Users/drantunes/Code/mastra-consulting-support-resolution/template-customer-refund-agent/src/mastra/runtime/local-runtime';
import {createLocalLoopbackFacade,LoopbackHttpProviderRegistry} from '/Users/drantunes/Code/mastra-consulting-support-resolution/template-customer-refund-agent/src/mastra/providers/loopback-http';
const binding={tenantId:'a',providerKind:'local' as const,providerAccountId:'a',externalConversationId:'conv'};
const store=new CaseStore({url:'file:/private/tmp/ryo-sr3/http-'+crypto.randomUUID()+'.db'});await store.list();const local=new LocalRuntime(store.getClientForTests());await local.seed(binding);
const facade=createLocalLoopbackFacade(local);
for(const payload of [{body:{bad:1},status:'resolved'},{body:'ok',status:17}]){const response=await facade(new Request('http://loopback/support/deliver',{method:'POST',body:JSON.stringify({binding,...payload,idempotencyKey:'bad'})}));assert.equal(response.status,400)}
assert.equal((await store.getClientForTests().execute('SELECT COUNT(*) n FROM local_deliveries')).rows[0].n,0);
const registry=new LoopbackHttpProviderRegistry(async()=>Response.json({invalid:true}));
await assert.rejects(()=>registry.support(binding).normalizeInbound({externalId:'event'}));await assert.rejects(()=>registry.knowledge(binding).listChanged(binding));

for (const path of ['/commerce/orders','/commerce/subscriptions','/commerce/refunds','/transactions/quote-refund','/transactions/issue-refund','/knowledge/search','/knowledge/fetch-document']) {
 const response=await facade(new Request('http://loopback'+path,{method:'POST',body:JSON.stringify({binding})}));assert.equal(response.status,400,path);
}
const malformedCalls=[()=>registry.commerce(binding).findOrder(binding,'x'),()=>registry.commerce(binding).findSubscription(binding,'x'),()=>registry.commerce(binding).refunds(binding,'x'),()=>registry.knowledge(binding).search(binding,'x',1),()=>registry.knowledge(binding).fetchDocument(binding,'x'),()=>registry.support(binding).deliver(binding,'x','resolved','x'),()=>registry.transactions(binding).quoteRefund({binding} as any),()=>registry.transactions(binding).issueRefund({binding} as any)];
for(const call of malformedCalls) await assert.rejects(call);
assert.equal((await store.getClientForTests().execute('SELECT COUNT(*) n FROM local_refunds')).rows[0].n,0);
console.log('ALL_HTTP_RESPONSES_REJECT_INVALID');
console.log('CONTRACTS_OK malformed deliveries400/no receipts, normalize/list-changed malformed results rejected');await store.close();
