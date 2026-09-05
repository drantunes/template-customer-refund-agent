import assert from 'node:assert/strict';
import {CaseStore} from '/Users/drantunes/Code/mastra-consulting-support-resolution/template-customer-refund-agent/src/mastra/lib/case-store';
const store = new CaseStore({url:`file:/private/tmp/ryo-sr4/exclusion-${Date.now()}.db`});
const binding={tenantId:'sr4',providerKind:'local' as const,providerAccountId:'sr4',externalConversationId:'conv'};
const hostile="x') OR 1=1; DROP TABLE support_cases; --";
for (const id of [hostile,'safe']) {
 const stamp=new Date().toISOString();
 await store.create({id,externalId:id,source:'mock-email',status:'resolved',customer:{email:'a@example.com'},subject:'s',messages:[],createdAt:stamp,updatedAt:stamp,metadata:{providerBinding:binding}});
 await store.enqueueDelivery({id,caseId:id,binding,body:id,status:'resolved'});
}
const [first]=await store.claimOutbox(1,[hostile,"'",'?']);
assert.equal(first.id,'safe');
assert.equal((await store.getClientForTests().execute('SELECT count(*) n FROM support_cases')).rows[0].n,2);
await store.retryOutbox(first.id,'500',false,first.leaseToken);
assert.deepEqual(await store.claimOutbox(10,[hostile,'safe']),[]);
const [second]=await store.claimOutbox(1,['safe']);
assert.equal(second.id,hostile);
assert.equal(await store.renewOutboxLease(second.id,'wrong-owner'),false);
assert.equal(await store.renewOutboxLease(second.id,second.leaseToken!),true);
console.log('PASS: hostile IDs bound literally; multiple/empty-result exclusions correct; table intact; wrong ownership rejected.');
await store.close();
