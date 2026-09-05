import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {Hono} from 'hono';
import {caseStore} from '/Users/drantunes/Code/mastra-consulting-support-resolution/template-customer-refund-agent/src/mastra/lib/case-store';
import {supportCaseApproveRoute} from '/Users/drantunes/Code/mastra-consulting-support-resolution/template-customer-refund-agent/src/mastra/server/routes';
async function run(id:string, lose:boolean){
 const at=new Date().toISOString();
 await caseStore.create({id,externalId:id,source:'mock-email',status:'waiting_approval',workflowRunId:'run-'+id,subject:'s',customer:{email:'alex@example.com'},messages:[],createdAt:at,updatedAt:at,metadata:{}});
 let started!:()=>void, release!:(value:any)=>void;
 const start=new Promise<void>(r=>started=r), result=new Promise(r=>release=r);
 const app=new Hono(); app.use('*',async(c,next)=>{c.set('mastra',{getWorkflow:()=>({createRun:async()=>({resume:async()=>{started();return result}})})} as never);await next()});
 app.post('/support/cases/:caseId/approve',supportCaseApproveRoute.handler);
 const pending=app.request('http://test/support/cases/'+id+'/approve',{method:'POST'});
 await start;
 if(lose){caseStore.renewDispatchLease=async()=>{throw new Error('injected renewal IO error')};await delay(10500)}
 else {await delay(31000);const rows=await caseStore.getClientForTests().execute({sql:'SELECT lease_until FROM support_dispatch WHERE case_id=?',args:[id]});assert(Date.parse(String(rows.rows[0].lease_until))>Date.now());assert.deepEqual(await caseStore.claimDispatch(),[])}
 release({status:lose?'failed':'success'}); const response=await pending; assert.equal(response.status,lose?409:200);
 if(lose) assert.equal((await caseStore.get(id))?.status,'processing');
 console.log('HEARTBEAT_OK',id,response.status);
}
await run('healthy',false); await run('renewal-error',true); await caseStore.close();
