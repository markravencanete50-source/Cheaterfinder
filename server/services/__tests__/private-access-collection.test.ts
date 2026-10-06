import {beforeEach,describe,expect,it,vi} from 'vitest';
import {PgDialect} from 'drizzle-orm/pg-core';
const f=vi.hoisted(()=>({rows:[] as any[],condition:null as any,add:vi.fn(),accept:vi.fn()}));
vi.mock('../../db.js',()=>({db:{select:()=>{const q:any={from:()=>q,innerJoin:()=>q,where:(condition:any)=>{f.condition=condition;return q},orderBy:()=>q,limit:async()=>f.rows};return q}}}));
vi.mock('../../bot-manager.js',()=>({markFollowRequestAccepted:f.accept}));
import {reconcilePrivateAccessCollections} from '../private-access-collection.js';
beforeEach(()=>{f.rows=[];f.condition=null;f.add.mockReset().mockResolvedValue({});f.accept.mockReset().mockResolvedValue(undefined)});
describe('recover private collection after approval',()=>{
 it('retries interrupted scheduling with the same job identity and forces full collection',async()=>{
  f.rows=[{id:'grant-1',trackedAccountId:'track-1',accessStatus:'has_access',userId:'user-1'}];f.add.mockRejectedValueOnce(new Error('Redis unavailable'));
  await expect(reconcilePrivateAccessCollections({add:f.add})).rejects.toThrow('Redis unavailable');
  expect(await reconcilePrivateAccessCollections({add:f.add})).toBe(1);
  expect(f.add.mock.calls).toEqual(Array(2).fill(['collect-profile',{trackedAccountId:'track-1',force:true,source:'private-access-granted'},{jobId:'private-access-grant-1'}]));
 });
 it('repairs an interrupted accepted grant before scheduling its collection',async()=>{
  f.rows=[{id:'grant-1',trackedAccountId:'track-1',accessStatus:'pending_access',userId:'user-1'}];
  f.add.mockImplementation(async()=>{expect(f.accept).toHaveBeenCalledExactlyOnceWith('grant-1','user-1');return {}});
  expect(await reconcilePrivateAccessCollections({add:f.add})).toBe(1);
 });
 it('does not enqueue when interrupted-grant reconciliation fails',async()=>{
  f.rows=[{id:'grant-1',trackedAccountId:'track-1',accessStatus:'pending_access',userId:'user-1'}];
  f.accept.mockRejectedValue(new Error('database unavailable'));
  await expect(reconcilePrivateAccessCollections({add:f.add})).rejects.toThrow('database unavailable');
  expect(f.add).not.toHaveBeenCalled();
 });
 it('selects active approved private paid tracks with a profile older than approval',async()=>{
  await reconcilePrivateAccessCollections({add:f.add});
  const query=new PgDialect().sqlToQuery(f.condition);
  expect(query.params).toEqual(expect.arrayContaining(['accepted',true,'has_access']));
  expect(query.sql).toContain('last_profile_refresh_at');expect(query.sql).toContain('resolved_at');
  expect(query.sql).toContain('stripe_subscription_id');expect(query.sql).toContain('trial_end');
  expect(f.add).not.toHaveBeenCalled();
 });
});
