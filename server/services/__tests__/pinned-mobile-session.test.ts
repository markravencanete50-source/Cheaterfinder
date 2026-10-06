import {describe,expect,it} from 'vitest';
import {pinnedMobileSession} from '../pinned-mobile-session.js';
const state=(id='123',session='123%3Atest%3Acredential')=>JSON.stringify({cookies:[
  {name:'ds_user_id',value:id,domain:'.instagram.com'},
  {name:'sessionid',value:session,domain:'.instagram.com'},
  {name:'mid',value:'fixture-mid',domain:'.instagram.com'},
]});
describe('approved viewer mobile reads',()=>{
 it('uses only the same authenticated account and credential',()=>{
  const session=pinnedMobileSession(state(),'bot-primary');
  expect(session.dsUserId).toBe('123');expect(session.sessionid).toBe('123%3Atest%3Acredential');
  expect(JSON.parse(Buffer.from(session.bearer.slice('Bearer IGT:2:'.length),'base64').toString())).toMatchObject({ds_user_id:'123',sessionid:session.sessionid});
 });
 it('keeps stable device identifiers after a browser session is renewed',()=>{
  const before=pinnedMobileSession(state(),'bot-primary'),after=pinnedMobileSession(state('123','123%3Arenewed'),'bot-primary');
  expect(after.androidId).toBe(before.androidId);expect(after.deviceUuid).toBe(before.deviceUuid);
  expect(after.extraUuids).toEqual(before.extraUuids);expect(after.bearer).not.toBe(before.bearer);
 });
 it('keeps independent identities for the primary and backup',()=>{
  const primary=pinnedMobileSession(state(),'primary'),backup=pinnedMobileSession(state(),'backup');
  expect(primary.androidId).not.toBe(backup.androidId);expect(primary.deviceUuid).not.toBe(backup.deviceUuid);
 });
 it.each(['not-json','{}',state('456'),state('123','bad%ZZ'),state('123','123:\nsecret')])('rejects missing or mismatched credentials without returning their contents',value=>{
  expect(()=>pinnedMobileSession(value,'primary')).toThrow(/Pinned viewer/);
 });
 it('never imports a session cookie from another domain',()=>{
  const data=JSON.parse(state());data.cookies[1].domain='unrelated.invalid';
  expect(()=>pinnedMobileSession(JSON.stringify(data),'primary')).toThrow(/identity/);
 });
 it.each(['expired', 'different path', 'conflicting', 'encoded control', 'empty token'])('refuses %s session credentials before a private read',kind=>{
  const data=JSON.parse(state());
  if(kind==='expired') data.cookies[1].expires=1;
  if(kind==='different path') data.cookies[1].path='/accounts';
  if(kind==='conflicting') data.cookies.push({...data.cookies[1],value:'123%3Aother'});
  if(kind==='encoded control') data.cookies[1].value='123%3Atoken%0Ainjected';
  if(kind==='empty token') data.cookies[1].value='123%3A';
  expect(()=>pinnedMobileSession(JSON.stringify(data),'primary')).toThrow(/Pinned viewer/);
 });
 it('ignores malformed unrelated cookie entries without changing the approved identity',()=>{
  const data=JSON.parse(state());data.cookies.unshift(null);
  expect(pinnedMobileSession(JSON.stringify(data),'primary').dsUserId).toBe('123');
 });
});
