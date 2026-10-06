import {beforeEach,describe,expect,it,vi} from 'vitest';
import {PgDialect} from 'drizzle-orm/pg-core';
const f=vi.hoisted(()=>({rows:[] as Array<{id:string}>,condition:null as any,assign:vi.fn(),add:vi.fn()}));
vi.mock('../../db.js',()=>({db:{select:()=>{const q:any={from:()=>q,where:(condition:any)=>{f.condition=condition;return q},orderBy:()=>q,limit:async()=>f.rows};return q}}}));
vi.mock('../../bot-manager.js',()=>({assignBotToTrackedAccount:f.assign}));
import {reconcilePrivateFollowCoverage} from '../private-follow-coverage.js';
beforeEach(()=>{f.rows=[];f.condition=null;f.assign.mockReset();f.add.mockReset().mockResolvedValue({})});
describe('private backup dispatch',()=>{
 it('recovers interrupted queue dispatch without allocating another request',async()=>{
  f.rows=[{id:'tracked'}];f.assign.mockResolvedValue('backup-request');f.add.mockRejectedValueOnce(new Error('Redis unavailable'));
  await expect(reconcilePrivateFollowCoverage({add:f.add})).rejects.toThrow('Redis unavailable');
  await expect(reconcilePrivateFollowCoverage({add:f.add})).resolves.toBe(1);
  expect(f.assign).toHaveBeenCalledWith('tracked',{backup:true});
  expect(f.add.mock.calls).toEqual(Array(2).fill(['send-follow',{botFollowRequestId:'backup-request'},{jobId:'private-backup-backup-request',delay:60_000}]));
 });
 it('does not schedule follow work when coverage is already complete',async()=>{
  f.rows=[{id:'tracked'}];f.assign.mockResolvedValue(null);
  expect(await reconcilePrivateFollowCoverage({add:f.add})).toBe(0);expect(f.add).not.toHaveBeenCalled();
 });
 it('queries only entitled private targets with sent primary requests and incomplete or interrupted coverage',async()=>{
  await reconcilePrivateFollowCoverage({add:f.add});const query=new PgDialect().sqlToQuery(f.condition);
  expect(query.sql).toContain('stripe_subscription_id');expect(query.sql).toContain('trial_end');
  expect(query.sql).toContain('is_private');expect(query.sql).toContain("'pending','accepted'");
  expect(query.sql).toContain("'failed','expired','rejected'");expect(query.sql).toContain('< 2');
 });
});
