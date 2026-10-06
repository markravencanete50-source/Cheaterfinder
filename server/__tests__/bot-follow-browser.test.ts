import { beforeEach,describe,expect,it,vi } from 'vitest';
import type { BotRuntimeContext } from '../services/bot-runtime.js';
const {followInstagramBrowser,recordBytes,select,update,where,encryptSessionData}=vi.hoisted(()=>({followInstagramBrowser:vi.fn(),recordBytes:vi.fn(),select:vi.fn(),update:vi.fn(),where:vi.fn(),encryptSessionData:vi.fn((s:string)=>'encrypted:'+s)}));
vi.mock('../db.js',()=>({db:{select,update}}));
vi.mock('../observability/logger.js',()=>({logger:{warn:vi.fn()}}));
vi.mock('../services/automation-client.js',()=>({createAutomationClient:()=>({followInstagramBrowser})}));
vi.mock('../services/bandwidth-meter.js',()=>({recordBytes}));
vi.mock('../crypto/session-envelope.js',()=>({decryptSessionData:(s:string)=>s,encryptSessionData}));
vi.mock('../services/proxy-provider.js',()=>({proxyAgentUriForEndpoint:()=> 'http://fixture-user:fixture-pass@fixed.example:10001'}));
import {sendBrowserFollow} from '../services/bot-follow-browser.js';
const runtime={botId:'bot-1',igUsername:'bot',automationIdentity:{bot_id:'bot-1',browser_family:'firefox'},sessionData:'{"cookies":[{"name":"sessionid","value":"fixture"}]}',proxyEndpoint:'fixed.example:10001:fixture-user:fixture-pass',transport:'web'} as BotRuntimeContext;
const pending={status:'pending',confirmed:true,following:false,outgoing_request:true,clicked:true,wire_bytes_in:1024,wire_bytes_out:512};
beforeEach(()=>{vi.clearAllMocks();followInstagramBrowser.mockResolvedValue(pending);select.mockReturnValue({from:()=>({where:()=>({limit:async()=>[{sessionData:runtime.sessionData}]})})});update.mockReturnValue({set:()=>({where})});where.mockResolvedValue(undefined)});
describe('private browser follow boundary',()=>{
 it('carries the same bot, cookie state, fixed proxy and exact target to the authenticated service',async()=>{
  expect(await sendBrowserFollow(runtime,'private.user','123')).toMatchObject({following:false,outgoingRequest:true});
  expect(followInstagramBrowser).toHaveBeenCalledExactlyOnceWith({identity:runtime.automationIdentity,storage_state:JSON.parse(runtime.sessionData),proxy:{server:'http://fixed.example:10001',username:'fixture-user',password:'fixture-pass'},target_username:'private.user',target_user_id:'123',deadline_ms:90000});
  expect(recordBytes).toHaveBeenCalledWith(expect.objectContaining({botId:'bot-1',transport:'browser',bytesIn:1024,bytesOut:512,failed:false}));
 });
 it.each([
  {status:'accepted',following:true,outgoing_request:false},
  {status:'pending',following:true,outgoing_request:true},
 ])('preserves confirmed flags %j',async flags=>{followInstagramBrowser.mockResolvedValue({...pending,...flags});expect(await sendBrowserFollow(runtime,'target','123')).toMatchObject({following:flags.following,outgoingRequest:flags.outgoing_request})});
 it.each([
  {...pending,confirmed:false},
  {...pending,status:'unknown'},
  {...pending,following:false,outgoing_request:false},
  {...pending,outgoing_request:'true'},
  {...pending,following:undefined},
  {...pending,status:'not_sent',clicked:false,reason:'fixture-sensitive-response'},
 ])('rejects uncertain or malformed responses without repeating the write %j',async result=>{
  followInstagramBrowser.mockResolvedValue(result);
  await expect(sendBrowserFollow(runtime,'target','123')).rejects.toThrow(/Browser follow/);
  expect(followInstagramBrowser).toHaveBeenCalledTimes(1);
  expect(recordBytes).toHaveBeenCalledWith(expect.objectContaining({failed:true}));
 });
 it.each([
  {...runtime,proxyEndpoint:''},
  {...runtime,automationIdentity:null},
  {...runtime,botId:'other'},
  {...runtime,transport:'mobile'},
 ])('refuses incompatible runtime before the service call',async r=>{
  await expect(sendBrowserFollow(r as BotRuntimeContext,'target','123')).rejects.toThrow(/requires/);expect(followInstagramBrowser).not.toHaveBeenCalled();
 });
 it.each([['../settings','123'],['valid','abc'],['valid',''],['valid?other','123']])('rejects invalid target %s %s',async (username,id)=>{
  await expect(sendBrowserFollow(runtime,username,id)).rejects.toThrow(/valid target/);expect(followInstagramBrowser).not.toHaveBeenCalled();
 });
 it('does not retry a service timeout',async()=>{followInstagramBrowser.mockRejectedValue(new Error('timeout'));await expect(sendBrowserFollow(runtime,'target','123')).rejects.toThrow('timeout');expect(followInstagramBrowser).toHaveBeenCalledTimes(1)});
 it('persists valid refreshed cookies encrypted with a compare-and-swap',async()=>{
  const state={cookies:[{name:'sessionid',value:'fresh',domain:'.instagram.com',path:'/'},{name:'csrftoken',value:'csrf',domain:'.instagram.com',path:'/'}],origins:[]};
  followInstagramBrowser.mockResolvedValue({...pending,storage_state:state});
  await sendBrowserFollow(runtime,'target','123');
  expect(encryptSessionData).toHaveBeenCalledExactlyOnceWith(JSON.stringify(state));expect(update).toHaveBeenCalledTimes(1);expect(where).toHaveBeenCalledTimes(1);
 });
 it.each(['newer-session',null])('never overwrites a changed or removed session %s',async sessionData=>{
  select.mockReturnValue({from:()=>({where:()=>({limit:async()=>[{sessionData}]})})});
  followInstagramBrowser.mockResolvedValue({...pending,storage_state:{cookies:[{name:'sessionid',value:'fresh',domain:'.instagram.com',path:'/'},{name:'csrftoken',value:'csrf',domain:'.instagram.com',path:'/'}]}});
  await sendBrowserFollow(runtime,'target','123');expect(update).not.toHaveBeenCalled();
 });
 it('rejects refreshed cookies for a different bot identity',async()=>{
  const r={...runtime,sessionData:JSON.stringify({cookies:[{name:'ds_user_id',value:'1'}]})};
  followInstagramBrowser.mockResolvedValue({...pending,storage_state:{cookies:[{name:'sessionid',value:'fresh',domain:'.instagram.com',path:'/'},{name:'csrftoken',value:'csrf',domain:'.instagram.com',path:'/'},{name:'ds_user_id',value:'2',domain:'.instagram.com',path:'/'}]}});
  await sendBrowserFollow(r,'target','123');expect(update).not.toHaveBeenCalled();
 });
 it('retains a same-account cookie renewal after an uncertain write without declaring the request confirmed',async()=>{
  const r={...runtime,sessionData:JSON.stringify({cookies:[{name:'sessionid',value:'old'},{name:'ds_user_id',value:'1'}]})};
  select.mockReturnValue({from:()=>({where:()=>({limit:async()=>[{sessionData:r.sessionData}]})})});
  const state={cookies:[{name:'sessionid',value:'fresh',domain:'.instagram.com',path:'/'},{name:'csrftoken',value:'csrf',domain:'.instagram.com',path:'/'},{name:'ds_user_id',value:'1',domain:'.instagram.com',path:'/'}]};
  followInstagramBrowser.mockResolvedValue({...pending,status:'unknown',confirmed:false,reason:'target_navigation_mismatch',storage_state:state});
  await expect(sendBrowserFollow(r,'target','123')).rejects.toMatchObject({name:'BrowserFollowUnconfirmedError',clicked:true,reason:'target_navigation_mismatch'});
  expect(encryptSessionData).toHaveBeenCalledExactlyOnceWith(JSON.stringify(state));
  expect(update).toHaveBeenCalledTimes(1);expect(followInstagramBrowser).toHaveBeenCalledTimes(1);
 });
 it.each(['login_required','challenge_required','untrusted-response'])('does not retain cookies from an unconfirmed %s response',async reason=>{
  followInstagramBrowser.mockResolvedValue({...pending,status:'not_sent',confirmed:false,clicked:false,reason,storage_state:{cookies:[{name:'sessionid',value:'fresh',domain:'.instagram.com',path:'/'},{name:'csrftoken',value:'csrf',domain:'.instagram.com',path:'/'}]}});
  await expect(sendBrowserFollow(runtime,'target','123')).rejects.toMatchObject({clicked:false,reason:reason==='untrusted-response'?null:reason});
  expect(update).not.toHaveBeenCalled();
 });
});
