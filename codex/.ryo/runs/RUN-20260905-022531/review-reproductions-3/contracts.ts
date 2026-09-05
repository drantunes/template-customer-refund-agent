import assert from 'node:assert/strict';
import {CaseStore} from '/Users/drantunes/Code/mastra-consulting-support-resolution/template-customer-refund-agent/src/mastra/lib/case-store';
import {LocalRuntime} from '/Users/drantunes/Code/mastra-consulting-support-resolution/template-customer-refund-agent/src/mastra/runtime/local-runtime';
import {createLocalLoopbackFacade,LoopbackHttpProviderRegistry} from '/Users/drantunes/Code/mastra-consulting-support-resolution/template-customer-refund-agent/src/mastra/providers/loopback-http';
const binding={tenantId:'a',providerKind:'local' as const,providerAccountId:'a',externalConversationId:'conv'};
const store=new CaseStore({url:'file:/private/tmp/ryo-ir3/contracts-1.db'});await store.list();const local=new LocalRuntime(store.getClientForTests());await local.seed(binding);
const facade=createLocalLoopbackFacade(local);
for(const payload of [{body:{bad:1},status:'resolved'},{body:'ok',status:17}]){const response=await facade(new Request('http://loopback/support/deliver',{method:'POST',body:JSON.stringify({binding,...payload,idempotencyKey:'bad'})}));assert.equal(response.status,400)}
assert.equal((await store.getClientForTests().execute('SELECT COUNT(*) n FROM local_deliveries')).rows[0].n,0);
const registry=new LoopbackHttpProviderRegistry(async()=>Response.json({invalid:true}));
await assert.rejects(()=>registry.support(binding).normalizeInbound({externalId:'event'}));await assert.rejects(()=>registry.knowledge(binding).listChanged(binding));
console.log('CONTRACTS_OK malformed deliveries400/no receipts, normalize/list-changed malformed results rejected');await store.close();
