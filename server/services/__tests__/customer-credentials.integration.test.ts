import { createHash, randomUUID } from "node:crypto";
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
const url = process.env.BACKEND_FIX_TEST_DATABASE_URL;
if (url) {
  if (new URL(url).pathname !== "/cheaterfinder_backend_fix_test_20260907") throw new Error("Guarded scratch database required");
  process.env.DATABASE_URL = url;
}
const userId = randomUUID(), otherId = randomUUID();
const digest = createHash("sha256").update(randomUUID()).digest("hex");
const otherDigest = createHash("sha256").update(randomUUID()).digest("hex");
const oldHash = "fixture-old-bcrypt-hash";
(url ? describe : describe.skip)("atomic customer credential updates", () => {
  let pool: typeof import("../../db.js").pool;
  let reset: typeof import("../customer-credentials.js").applyCustomerPasswordReset;
  let change: typeof import("../customer-credentials.js").changeCustomerPassword;
  beforeAll(async () => {
    pool = (await import("../../db.js")).pool;
    ({ applyCustomerPasswordReset: reset, changeCustomerPassword: change } = await import("../customer-credentials.js"));
    await pool.query("INSERT INTO users(id,email,name,hashed_password) VALUES($1,$2,'Credential fixture',$3),($4,$5,'Other fixture',$3)",
      [userId,userId+"@example.invalid",oldHash,otherId,otherId+"@example.invalid"]);
  });
  const cleanupSessions = () => pool.query("DELETE FROM session WHERE sess::jsonb #>> '{passport,user}'=ANY($1::text[]) OR sess::jsonb #>> '{passport,user,id}'=ANY($1::text[])", [[userId,otherId]]);
  beforeEach(async () => {
    await cleanupSessions();
    await pool.query("DELETE FROM password_reset_tokens WHERE user_id=ANY($1::varchar[])",[[userId,otherId]]);
    await pool.query("DELETE FROM mobile_auth_sessions WHERE user_id=ANY($1::varchar[])",[[userId,otherId]]);
    await pool.query("UPDATE users SET hashed_password=$1,session_version=0 WHERE id=ANY($2::varchar[])",[oldHash,[userId,otherId]]);
    await pool.query("INSERT INTO password_reset_tokens(id,user_id,token,expires_at) VALUES($1,$2,$3,now()+interval '1 hour'),($4,$2,$5,now()+interval '1 hour')",
      [randomUUID(),userId,digest,randomUUID(),otherDigest]);
    for (const [id, identity] of [[userId,userId],[userId,{id:userId,version:0,passwordVersion:"0".repeat(64)}],[otherId,otherId]] as const) {
      await pool.query("INSERT INTO session(sid,sess,expire) VALUES($1,$2,now()+interval '1 day')",[randomUUID(),JSON.stringify({passport:{user:identity}})]);
    }
    for (const id of [userId,otherId]) await pool.query("INSERT INTO mobile_auth_sessions(id,user_id,refresh_digest,expires_at) VALUES($1,$2,'fixture',now()+interval '1 day')",[randomUUID(),id]);
  });
  afterAll(async () => {
    if (!pool) return;
    await cleanupSessions();
    await pool.query("DELETE FROM users WHERE id=ANY($1::varchar[])",[[userId,otherId]]);
    await pool.end();
  });
  const state = async () => (await pool.query("SELECT hashed_password,session_version FROM users WHERE id=$1",[userId])).rows[0];
  it("consumes one reset token, updates credentials and revokes only this customer's sessions", async () => {
    expect(await reset(digest,"new-hash")).toBe(true);
    expect(await state()).toEqual({hashed_password:"new-hash",session_version:1});
    expect((await pool.query("SELECT used_at FROM password_reset_tokens WHERE token=$1",[digest])).rows[0].used_at).not.toBeNull();
    expect((await pool.query("SELECT token FROM password_reset_tokens WHERE token=$1",[otherDigest])).rowCount).toBe(0);
    expect((await pool.query("SELECT sid FROM session WHERE sess::jsonb #>> '{passport,user}'=$1 OR sess::jsonb #>> '{passport,user,id}'=$1",[userId])).rowCount).toBe(0);
    expect((await pool.query("SELECT sid FROM session WHERE sess::jsonb #>> '{passport,user}'=$1",[otherId])).rowCount).toBe(1);
    const mobile=(await pool.query("SELECT user_id,revoked_at FROM mobile_auth_sessions WHERE user_id=ANY($1::varchar[])",[[userId,otherId]])).rows;
    expect(mobile.find(r=>r.user_id===userId).revoked_at).not.toBeNull();
    expect(mobile.find(r=>r.user_id===otherId).revoked_at).toBeNull();
  });
  it("permits exactly one winner for concurrent reset requests", async () => {
    const result = await Promise.all([reset(digest,"first"),reset(digest,"second")]);
    expect(result.filter(Boolean)).toHaveLength(1);
    expect((await state()).session_version).toBe(1);
    expect(await reset(digest,"replay")).toBe(false);
  });
  it("rejects an expired token without changing credentials or sessions", async () => {
    await pool.query("UPDATE password_reset_tokens SET expires_at=now()-interval '1 second' WHERE token=$1",[digest]);
    expect(await reset(digest,"invalid")).toBe(false);
    expect(await state()).toEqual({hashed_password:oldHash,session_version:0});
    expect((await pool.query("SELECT sid FROM session WHERE sess::jsonb #>> '{passport,user}'=$1",[userId])).rowCount).toBe(1);
  });
  it("rolls token consumption back if the credential write fails", async () => {
    // Integer overflow occurs AFTER token claim, inside the same transaction.
    await pool.query("UPDATE users SET session_version=2147483647 WHERE id=$1",[userId]);
    await expect(reset(digest,"must-roll-back")).rejects.toThrow();
    expect((await state()).hashed_password).toBe(oldHash);
    expect((await pool.query("SELECT used_at FROM password_reset_tokens WHERE token=$1",[digest])).rows[0].used_at).toBeNull();
    expect((await pool.query("SELECT sid FROM session WHERE sess::jsonb #>> '{passport,user}'=$1",[userId])).rowCount).toBe(1);
  });
  it("uses compare-and-swap for authenticated password changes", async () => {
    expect(await change(userId,oldHash,"new-password")).toBe(1);
    expect(await change(userId,oldHash,"stale-overwrite")).toBeNull();
    expect(await state()).toEqual({hashed_password:"new-password",session_version:1});
    expect((await pool.query("SELECT token FROM password_reset_tokens WHERE user_id=$1",[userId])).rowCount).toBe(0);
  });
  it("serializes a reset racing an authenticated change without blind overwrites", async () => {
    const result=await Promise.all([reset(digest,"reset-winner"),change(userId,oldHash,"change-winner")]);
    expect(Number(result[0])+Number(result[1]!==null)).toBe(1);
    expect((await state()).session_version).toBe(1);
  });
});
