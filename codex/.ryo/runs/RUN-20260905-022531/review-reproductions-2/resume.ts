import {CaseStore} from '/Users/drantunes/Code/mastra-consulting-support-resolution/template-customer-refund-agent/src/mastra/lib/case-store';
const store=new CaseStore({url:'file:/private/tmp/ryo-ir2/resume.db'}); await store.list();
const t=new Date().toISOString(); await store.acceptInbound({id:'c',externalId:'e',source:'mock-email',status:'waiting_approval',customer:{email:'e@e.test'},subject:'s',messages:[],createdAt:t,updatedAt:t,metadata:{}},'e','run');
await store.completeDispatch('dispatch_e','suspended'); await store.claimDispatchForResume('c','run');
console.log('First claim acquired; second should immediately return undefined');
await store.claimDispatchForResume('c','run'); console.log('SECOND RETURNED');
