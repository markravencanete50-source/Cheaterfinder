// Execute the production processors with external boundaries replaced. Importing
// workers.ts would also start unrelated queues; extraction keeps this test isolated.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { transformSync } from "esbuild";
import { describe, it, expect, vi } from "vitest";
const source=readFileSync(new URL('../workers.ts',import.meta.url),'utf8');
function extract(start:string,end:string) { return source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start))); }
function fixture(allowed:boolean) {
 const calls:string[]=[]; let access=allowed;
 const tracked={id:'track',userId:'user',isActive:allowed},bot={id:'bot',proxyEndpoint:null,sessionData:'stale-session'};
 const runtime={botId:'bot',igUsername:'botuser',proxyEndpoint:'fixed.example:9000',proxyUrl:'http://fixed.example:9000',sessionData:'current-session',automationIdentity:{bot_id:'bot',browser_family:'firefox'},transport:'web'};
 const request={id:'fr',status:'queued',botAccountId:'bot',trackedAccountId:'track'};
 const tables={botFollowRequests:{},botAccounts:{},trackedAccounts:{}};
 const rows=new Map([[tables.botFollowRequests,[request]],[tables.botAccounts,[bot]],[tables.trackedAccounts,[tracked]]]);
 const queue={add:vi.fn(async()=>{calls.push('enqueue')})};
 const ctx:any={...tables,Math,Date,Error,logger:{info(){},error(){},warn(){}},
  Worker:class{process:any;constructor(_name:string,process:any){this.process=process}},
  db:{select:()=>({from:(table:any)=>({where:()=>({limit:async()=>rows.get(table)})})})},
  eq:()=>true,withCorrelation:(_ctx:any,fn:any)=>fn(),createRedisConnection:()=>({}),BOT_FOLLOW_LIMITER:{},COLLECTION_IG_LIMITER:{},
  trackedAccountHasAccess:async()=>access,customerHasAccess:async()=>access,
  ensureBotReady:vi.fn(async()=>{calls.push('provision');return runtime}),sendFollowForRequest:vi.fn(async()=>{calls.push('send');return{kind:'accepted'}}),
  markFollowRequestFailed:vi.fn(async()=>{calls.push('cancel')}),cancelIneligibleFollowRequests:async()=>{calls.push('reconcile')},
  reconcilePrivateAccessCollections:vi.fn(async()=>0),
  reconcilePrivateFollowCoverage:vi.fn(async()=>0),
  getExpiredFollowRequests:async()=>[{...request,status:'pending'}],getPendingFollowRequests:async()=>[{...request,trackedUsername:'fixture',trackedUserId:'user'}],
  markFollowRequestExpired:async()=>{calls.push('expire');return true},transitionFollowRequest:async()=>({changed:true}),
  rotateBotForTrackedAccount:async()=>{calls.push('rotate');return'next'},
  probeFollowAcceptance:async()=>{calls.push('probe');return{kind:'accepted'}},markFollowRequestAccepted:async()=>{calls.push('accept')},
  collectionLikesQueue:queue,collectionFollowsQueue:queue,collectionProfileQueue:{add:vi.fn(async()=>{calls.push('profile-enqueue')})},botFollowRequestQueue:queue,
  IGRateLimitedError:class extends Error{},IGCircuitOpenError:class extends Error{},
 };
 vm.createContext(ctx);vm.runInContext(transformSync(extract('function createBotFollowRequestWorker()','// ─── Worker: bot-follow-check')+extract('function createBotFollowCheckWorker()','// ─── Worker: retention'),{loader:'ts',format:'cjs'}).code,ctx);
 vm.runInContext(transformSync(extract('function createFollowsWorker()', '// ─── Worker: report-generate'),{loader:'ts',format:'cjs'}).code,ctx);
 return{ctx,calls,bot,tracked,runtime,rows,tables,revoke:()=>{access=false}};
}
describe('private follow worker execution gates',()=>{
 it('routes approved private roster work into the full collector',async()=>{
  const f=fixture(true);Object.assign(f.tracked,{isPrivate:true,accessStatus:'has_access'});
  await f.ctx.createFollowsWorker().process({data:{trackedAccountId:'track'}});
  expect(f.ctx.collectionProfileQueue.add).toHaveBeenCalledExactlyOnceWith('collect-profile',{trackedAccountId:'track',force:true,source:'private-roster-refresh'});
 });
 it.each(['pending_access','access_denied'])('does not collect private rosters with %s',async accessStatus=>{
  const f=fixture(true);Object.assign(f.tracked,{isPrivate:true,accessStatus});
  await f.ctx.createFollowsWorker().process({data:{trackedAccountId:'track'}});
  expect(f.ctx.collectionProfileQueue.add).not.toHaveBeenCalled();
 });
 it('cancels a stale queued job before provisioning or follow traffic',async()=>{const f=fixture(false);await f.ctx.createBotFollowRequestWorker().process({data:{botFollowRequestId:'fr'}});expect(f.calls).toEqual(['cancel'])});
 it('cancels when access ends during provisioning',async()=>{const f=fixture(true);f.ctx.ensureBotReady=async()=>{f.calls.push('provision');f.revoke()};await f.ctx.createBotFollowRequestWorker().process({data:{botFollowRequestId:'fr'}});expect(f.calls).toEqual(['provision','cancel'])});
 it('does not probe or rotate ineligible pending requests',async()=>{const f=fixture(false);await f.ctx.createBotFollowCheckWorker().process({});expect(f.calls).toEqual(['reconcile','cancel','cancel'])});
 it('does not publish acceptance when access ends during the probe',async()=>{const f=fixture(true);f.ctx.getExpiredFollowRequests=async()=>[];f.ctx.probeFollowAcceptance=async()=>{f.revoke();return{kind:'accepted'}};await f.ctx.createBotFollowCheckWorker().process({});expect(f.calls).toEqual(['reconcile'])});
 it('allows eligible follow and acceptance work',async()=>{const f=fixture(true);await f.ctx.createBotFollowRequestWorker().process({data:{botFollowRequestId:'fr'}});expect(f.calls).toEqual(['provision','send','profile-enqueue']);f.calls.length=0;await f.ctx.createBotFollowCheckWorker().process({});expect(f.calls).toContain('rotate');expect(f.calls).toContain('probe');expect(f.calls).toContain('accept')});
 it.each(['direct','probe'])('starts full private content collection after %s acceptance even with a recent profile',async path=>{
  const f=fixture(true);f.ctx.getExpiredFollowRequests=async()=>[];
  if(path==='direct')await f.ctx.createBotFollowRequestWorker().process({data:{botFollowRequestId:'fr'}});
  else await f.ctx.createBotFollowCheckWorker().process({});
  expect(f.ctx.collectionProfileQueue.add).toHaveBeenCalledExactlyOnceWith('collect-profile',{trackedAccountId:'track',force:true,source:'private-access-granted'},{jobId:'private-access-fr'});
  expect(f.ctx.collectionFollowsQueue.add).not.toHaveBeenCalled();
 });
 it('does not collect private content while approval is still pending',async()=>{
  const f=fixture(true);f.ctx.sendFollowForRequest.mockResolvedValue({kind:'pending'});
  await f.ctx.createBotFollowRequestWorker().process({data:{botFollowRequestId:'fr'}});
  expect(f.ctx.collectionProfileQueue.add).not.toHaveBeenCalled();
 });
 it('passes the canonical runtime when the assigned bot has no proxy_endpoint',async()=>{
  const f=fixture(true);
  await f.ctx.createBotFollowRequestWorker().process({data:{botFollowRequestId:'fr'}});
  expect(f.ctx.ensureBotReady).toHaveBeenCalledWith('bot');
  expect(f.ctx.sendFollowForRequest).toHaveBeenCalledWith('fr',f.bot,f.tracked,f.runtime);
  expect(f.ctx.sendFollowForRequest.mock.calls[0][3]).toBe(f.runtime);
  expect(f.bot.proxyEndpoint).toBeNull();
 });
 it('uses refreshed bot pacing state without replacing the resolved runtime with stored fields',async()=>{
  const f=fixture(true);
  const readyBot={...f.bot,sessionData:'encrypted-row-session',proxyEndpoint:null};
  f.ctx.ensureBotReady.mockImplementation(async()=>{f.rows.set(f.tables.botAccounts,[readyBot]);return f.runtime});
  await f.ctx.createBotFollowRequestWorker().process({data:{botFollowRequestId:'fr'}});
  expect(f.ctx.sendFollowForRequest).toHaveBeenCalledWith('fr',readyBot,f.tracked,f.runtime);
  expect(f.ctx.sendFollowForRequest.mock.calls[0][1]).toBe(readyBot);
  expect(f.ctx.sendFollowForRequest.mock.calls[0][3]).toBe(f.runtime);
 });
 it('does not attempt follow traffic when runtime readiness fails',async()=>{
  const f=fixture(true);
  const failure=new Error('authenticated session has no fresh proxy lane');
  f.ctx.ensureBotReady.mockRejectedValue(failure);
  await expect(f.ctx.createBotFollowRequestWorker().process({data:{botFollowRequestId:'fr'}})).rejects.toBe(failure);
  expect(f.ctx.sendFollowForRequest).not.toHaveBeenCalled();
  expect(f.calls).toEqual(['cancel']);
 });
 it('does not rotate a request already resolved by another worker',async()=>{const f=fixture(true);f.ctx.getPendingFollowRequests=async()=>[];f.ctx.markFollowRequestExpired=async()=>false;await f.ctx.createBotFollowCheckWorker().process({});expect(f.calls).toEqual(['reconcile'])});
});

describe('private follow worker retry boundaries',()=>{
 it('retries only collection scheduling after a committed acceptance',async()=>{
  const f=fixture(true);f.rows.set(f.tables.botFollowRequests,[{id:'fr',status:'accepted',trackedAccountId:'track',botAccountId:'bot'}]);
  await f.ctx.createBotFollowRequestWorker().process({data:{botFollowRequestId:'fr'}});
  expect(f.calls).toEqual(['profile-enqueue']);expect(f.ctx.sendFollowForRequest).not.toHaveBeenCalled();
 });
 it('reconciles accepted collections during the periodic check without another follow',async()=>{
  const f=fixture(true);f.ctx.getExpiredFollowRequests=async()=>[];f.ctx.getPendingFollowRequests=async()=>[];
  await f.ctx.createBotFollowCheckWorker().process({});
  expect(f.ctx.reconcilePrivateAccessCollections).toHaveBeenCalledExactlyOnceWith(f.ctx.collectionProfileQueue);
  expect(f.ctx.sendFollowForRequest).not.toHaveBeenCalled();
 });
 it.each(['IGRateLimitedError','IGCircuitOpenError'])('keeps %s retryable while queue attempts remain',async(errorType)=>{
  const f=fixture(true);
  const failure=new f.ctx[errorType]('upstream unavailable');
  f.ctx.sendFollowForRequest.mockRejectedValue(failure);
  await expect(f.ctx.createBotFollowRequestWorker().process({data:{botFollowRequestId:'fr'},opts:{attempts:3},attemptsMade:1})).rejects.toBe(failure);
  expect(f.ctx.markFollowRequestFailed).not.toHaveBeenCalled();
  expect(f.ctx.botFollowRequestQueue.add).not.toHaveBeenCalled();
 });
 it.each([
  ['IGRateLimitedError','Instagram rate limit; follow retries exhausted'],
  ['IGCircuitOpenError','Instagram temporarily unavailable; follow retries exhausted'],
 ])('marks exhausted %s requests failed so customer retry becomes available',async(errorType,message)=>{
  const f=fixture(true);
  const failure=new f.ctx[errorType]('upstream unavailable');
  f.ctx.sendFollowForRequest.mockRejectedValue(failure);
  await expect(f.ctx.createBotFollowRequestWorker().process({data:{botFollowRequestId:'fr'},opts:{attempts:3},attemptsMade:2})).rejects.toBe(failure);
  expect(f.ctx.markFollowRequestFailed).toHaveBeenCalledExactlyOnceWith('fr',message);
  expect(f.ctx.botFollowRequestQueue.add).not.toHaveBeenCalled();
 });
 it.each(['IGRateLimitedError','IGCircuitOpenError'])('treats an unconfigured %s job as a single attempt',async(errorType)=>{
  const f=fixture(true);
  const failure=new f.ctx[errorType]('upstream unavailable');
  f.ctx.sendFollowForRequest.mockRejectedValue(failure);
  await expect(f.ctx.createBotFollowRequestWorker().process({data:{botFollowRequestId:'fr'}})).rejects.toBe(failure);
  expect(f.ctx.markFollowRequestFailed).toHaveBeenCalledWith('fr',expect.stringContaining('retries exhausted'));
 });
 it('defers a stored cooldown before runtime provisioning and preserves remaining attempts',async()=>{
  const f=fixture(true);
  Object.assign(f.bot,{cooldownUntil:new Date(Date.now()+60_000)});
  const backoff={type:'exponential',delay:5_000};
  await f.ctx.createBotFollowRequestWorker().process({data:{botFollowRequestId:'fr'},opts:{attempts:3,backoff},attemptsMade:2});
  expect(f.ctx.ensureBotReady).not.toHaveBeenCalled();
  expect(f.ctx.sendFollowForRequest).not.toHaveBeenCalled();
  expect(f.ctx.markFollowRequestFailed).not.toHaveBeenCalled();
  expect(f.ctx.botFollowRequestQueue.add).toHaveBeenCalledExactlyOnceWith('send-follow',{botFollowRequestId:'fr'},expect.objectContaining({delay:expect.any(Number),attempts:1,backoff}));
  const options=f.ctx.botFollowRequestQueue.add.mock.calls[0][2];
  expect(options.delay).toBeGreaterThan(55_000);
  expect(options.delay).toBeLessThanOrEqual(60_000);
 });
 it.each([
  {attempts:3,attemptsMade:1,remaining:2},
  {attempts:2,attemptsMade:1,remaining:1},
  {attempts:undefined,attemptsMade:0,remaining:2},
 ])('retains $remaining attempts when a collector defers a job',async({attempts,attemptsMade,remaining})=>{
  const f=fixture(true);
  const backoff={type:'exponential',delay:8_000};
  f.ctx.sendFollowForRequest.mockResolvedValue({kind:'deferred',reason:'cooldown',retryAfterMs:90_000});
  await f.ctx.createBotFollowRequestWorker().process({data:{botFollowRequestId:'fr'},opts:{attempts,backoff},attemptsMade});
  expect(f.ctx.botFollowRequestQueue.add).toHaveBeenCalledExactlyOnceWith('send-follow',{botFollowRequestId:'fr'},expect.objectContaining({delay:90_000,attempts:remaining,backoff}));
  expect(f.ctx.markFollowRequestFailed).not.toHaveBeenCalled();
 });
 it('does not requeue a deferred follow after tracking access ends',async()=>{
  const f=fixture(true);
  f.ctx.sendFollowForRequest.mockImplementation(async()=>{f.revoke();return{kind:'deferred',reason:'cooldown',retryAfterMs:60_000}});
  await f.ctx.createBotFollowRequestWorker().process({data:{botFollowRequestId:'fr'},opts:{attempts:2},attemptsMade:1});
  expect(f.ctx.botFollowRequestQueue.add).not.toHaveBeenCalled();
 });
});

function probeFixture(igUserId: string | null = '9007199254740993') {
 const f=fixture(true);
 Object.assign(f.tracked,{igUserId});
 const network=vi.fn(async()=>({following:true,outgoingRequest:false}));
 f.ctx.privateFollowRequestCanProbe=vi.fn(async()=>f.tracked.isActive && await f.ctx.trackedAccountHasAccess('track'));
 f.ctx.scrapeProfile=vi.fn();
 f.ctx.scrapeProfileWithBot=vi.fn(async()=>({isPrivate:true,igUserId:'123456'}));
 f.ctx.scrapeFriendshipStatusWithBot=vi.fn(async(_bot:string,_pk:string,beforeRead:()=>Promise<void>)=>{
  await beforeRead();return network();
 });
 vm.runInContext(transformSync(extract('async function probeFollowAcceptance(','function createBotFollowCheckWorker()'),{loader:'ts',format:'cjs'}).code,f.ctx);
 const probe=()=>f.ctx.probeFollowAcceptance({id:'fr',trackedUsername:'target',botAccountId:'bot',trackedAccountId:'track'});
 return{...f,network,probe};
}

describe('private follow acceptance probe runtime',()=>{
 it('reads the exact requester relationship through the shared pinned lease and budget',async()=>{
  const f=probeFixture();
  await expect(f.probe()).resolves.toEqual({kind:'accepted'});
  expect(f.ctx.scrapeFriendshipStatusWithBot).toHaveBeenCalledExactlyOnceWith('bot','9007199254740993',expect.any(Function));
  expect(f.ctx.privateFollowRequestCanProbe).toHaveBeenCalledWith('fr','track','bot');
  expect(f.ctx.scrapeProfile).not.toHaveBeenCalled();
  expect(f.ctx.scrapeProfileWithBot).not.toHaveBeenCalled();
  expect(f.ctx.ensureBotReady).not.toHaveBeenCalled();
 });
 it('does no readiness or network work when tracking access is revoked',async()=>{
  const f=probeFixture();f.revoke();
  await expect(f.probe()).resolves.toEqual({kind:'not_yet'});
  expect(f.ctx.scrapeFriendshipStatusWithBot).not.toHaveBeenCalled();
  expect(f.ctx.scrapeProfileWithBot).not.toHaveBeenCalled();
  expect(f.ctx.ensureBotReady).not.toHaveBeenCalled();
 });
 it.each([null,'','not-numeric'])('resolves legacy target ID %s only through the requesting viewer',async igUserId=>{
  const f=probeFixture(igUserId);
  await expect(f.probe()).resolves.toEqual({kind:'accepted'});
  expect(f.ctx.scrapeProfileWithBot).toHaveBeenCalledExactlyOnceWith('bot','target');
  expect(f.ctx.scrapeFriendshipStatusWithBot).toHaveBeenCalledWith('bot','123456',expect.any(Function));
  expect(f.ctx.scrapeProfile).not.toHaveBeenCalled();
 });
 it('does not mistake a now-public profile for an accepted follow',async()=>{
  const f=probeFixture(null);f.ctx.scrapeProfileWithBot.mockResolvedValue({isPrivate:false,igUserId:'123456'});
  f.network.mockResolvedValue({following:false,outgoingRequest:true});
  await expect(f.probe()).resolves.toEqual({kind:'not_yet'});
  expect(f.network).toHaveBeenCalledOnce();
 });
 it.each(['saved session unavailable','bot is cooling down','daily cap reached'])('preserves pending state when the pinned reader rejects %s',async error=>{
  const f=probeFixture();f.ctx.scrapeFriendshipStatusWithBot.mockRejectedValue(new Error(error));
  await expect(f.probe()).resolves.toEqual({kind:'error',error});
  expect(f.network).not.toHaveBeenCalled();
 });
 it('does not issue a friendship read if access ends while acquiring the lease',async()=>{
  const f=probeFixture();
  f.ctx.scrapeFriendshipStatusWithBot.mockImplementation(async(_bot:string,_pk:string,beforeRead:()=>Promise<void>)=>{
   f.revoke();await beforeRead();return f.network();
  });
  await expect(f.probe()).resolves.toEqual({kind:'not_yet'});
  expect(f.network).not.toHaveBeenCalled();
 });
 it('does not publish approval when the request is canceled during the read',async()=>{
  const f=probeFixture();f.network.mockImplementation(async()=>{
   f.ctx.privateFollowRequestCanProbe.mockResolvedValue(false);return {following:true,outgoingRequest:false};
  });
  await expect(f.probe()).resolves.toEqual({kind:'not_yet'});
 });
 it.each([
  {following:false,outgoingRequest:true},
  {following:false,outgoingRequest:false},
  {following:true,outgoingRequest:true},
 ])('preserves pending state for unaccepted friendship $following/$outgoingRequest',async status=>{
  const f=probeFixture();f.network.mockResolvedValue(status);
  await expect(f.probe()).resolves.toEqual({kind:'not_yet'});
 });
});
