import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const url = process.env.BACKEND_FIX_TEST_DATABASE_URL;
if (url) {
  const parsed = new URL(url);
  if (parsed.pathname !== "/cheaterfinder_backend_fix_test_20260907" || !["localhost", "127.0.0.1"].includes(parsed.hostname)
    || !parsed.port || parsed.port === "5432" || !process.env.STRESS_NONCE
    || !(process.env.STRESS_ALLOWED_PORTS ?? "").split(",").includes(parsed.port)) throw new Error("Isolated stress database required");
  process.env.DATABASE_URL = url;
  process.env.SESSION_DATA_KEY = randomBytes(32).toString("base64");
  process.env.BOT_CRED_KEY = randomBytes(32).toString("base64");
  process.env.BOT_AUTO_LOGIN_ENABLED = "true";
}
const mocks = vi.hoisted(() => ({ login: vi.fn() }));
vi.mock("../automation-client.js", () => ({ createAutomationClient: () => ({ startInstagramLogin: mocks.login }) }));

const identity = (id: string) => ({ identity_version: 1, client: "instagram-firefox-web", browser_family: "firefox",
  platform: "Windows", browser_seed: 123, bot_id: id, browser_version: "128", user_agent: "test-agent",
  http_impersonate: "firefox", ja3: "test-ja3", h2_fingerprint: "test-h2", locale: "en-US", timezone: "UTC" });
const authenticated = { status: "authenticated", storage_state: { cookies: [
  { name: "sessionid", value: "fixture-session", domain: ".instagram.com", path: "/" },
], origins: [] } };

(url ? describe : describe.skip)("bot recovery — real database ownership and persistence", () => {
  const ids = Array.from({ length: 4 }, () => randomUUID());
  let pool: typeof import("../../db.js").pool, db: typeof import("../../db.js").db;
  let recover: typeof import("../bot-runtime.js").reloginParkedBot;
  let candidates: typeof import("../../workers/relogin-sweeper.js").buildReloginCandidateSql;
  let decrypt: typeof import("../../crypto/session-envelope.js").decryptSessionData;
  beforeAll(async () => {
    ({ pool, db } = await import("../../db.js"));
    ({ reloginParkedBot: recover } = await import("../bot-runtime.js"));
    ({ buildReloginCandidateSql: candidates } = await import("../../workers/relogin-sweeper.js"));
    ({ decryptSessionData: decrypt } = await import("../../crypto/session-envelope.js"));
    const { encryptCredential } = await import("../../crypto/credentials.js");
    for (const id of ids) await pool.query(
      "INSERT INTO bot_accounts(id,ig_username,ig_password_encrypted,automation_identity) VALUES($1,$2,$3,$4::jsonb)",
      [id, `fixture_${id}`, encryptCredential("fixture-password"), JSON.stringify(identity(id))]);
  });
  beforeEach(async () => {
    mocks.login.mockReset().mockResolvedValue(authenticated);
    await pool.query("UPDATE bot_accounts SET status='session_expired',transport='web',tier='worker',role='scraper',session_data=NULL,totp_secret='fixture-totp',proxy_url='http://127.0.0.1:1',cooldown_until=now()-interval '1 hour',last_login_error=NULL,login_attempt_count=2,consecutive_hard_failures=6,last_hard_failure_at=now(),warm_failure_streak=3,updated_at=now() WHERE id=ANY($1::varchar[])", [ids]);
  });
  afterAll(async () => {
    if (!pool) return;
    await pool.query("DELETE FROM backend_operation_leases WHERE key=ANY($1::text[])", [ids.map(id => `bot:${id}`)]);
    await pool.query("DELETE FROM bot_accounts WHERE id=ANY($1::varchar[])", [ids]);
    await pool.end();
  });
  const saved = async () => (await pool.query("SELECT * FROM bot_accounts WHERE id=$1", [ids[0]])).rows[0];

  it("recovers an eligible parked session, retaining attempt history but clearing obsolete strikes", async () => {
    expect(await recover(ids[0])).toBe("recovered");
    const row = await saved();
    expect(row.status).toBe("available");
    expect(JSON.parse(decrypt(row.session_data))).toEqual(authenticated.storage_state);
    expect(row.login_attempt_count).toBe(3);
    expect(row.consecutive_hard_failures).toBe(0);
    expect(row.warm_failure_streak).toBe(0);
    expect(row.last_hard_failure_at).toBeNull();
    expect(row.cooldown_until).toBeNull();
    expect((await pool.query("SELECT 1 FROM backend_operation_leases WHERE key=$1", [`bot:${ids[0]}`])).rows).toHaveLength(0);
  });
  it("preserves an operator's suspension that arrives while login is in flight", async () => {
    mocks.login.mockImplementation(async () => {
      await pool.query("UPDATE bot_accounts SET status='banned',last_login_error='operator suspension',updated_at=clock_timestamp() WHERE id=$1", [ids[0]]);
      return authenticated;
    });
    await expect(recover(ids[0])).rejects.toThrow(/persisted safely/);
    const row = await saved();
    expect(row.status).toBe("banned");
    expect(row.session_data).toBeNull();
    expect(row.last_login_error).toBe("operator suspension");
  });
  it("allows only one concurrent recovery to reach the provider", async () => {
    let finish!: () => void, entered!: () => void;
    const waiting = new Promise<void>(resolve => { finish = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    mocks.login.mockImplementation(async () => { entered(); await waiting; return authenticated; });
    const first = recover(ids[0]);
    try {
      await started;
      expect(await recover(ids[0])).toBe("skipped");
      expect(mocks.login).toHaveBeenCalledTimes(1);
    } finally { finish(); }
    expect(await first).toBe("recovered");
  });
  it("executes the sweep predicate against actual held, terminal and credential-less rows", async () => {
    await pool.query("UPDATE bot_accounts SET ig_password_encrypted='' WHERE id=$1", [ids[1]]);
    await pool.query("UPDATE bot_accounts SET last_login_error='checkpoint_required' WHERE id=$1", [ids[2]]);
    await pool.query("UPDATE bot_accounts SET cooldown_until=now()+interval '1 hour' WHERE id=$1", [ids[3]]);
    const result = await db.execute(candidates(5));
    expect(result.rows.map(row => row.id)).toEqual([ids[0]]);
  });
  it("reports sticky gateway lifetime without removing it from existing admission", async () => {
    const { SHORT_LIVED_ACCOUNT_PROXY_SQL_REGEX, KNOWN_EPHEMERAL_ACCOUNT_PROXY_SQL_REGEX } = await import("../proxy-durability.js");
    const result = await pool.query("SELECT $1::text ~* $2::text short_lived,$1::text ~* $3::text rejected", [
      "http://fixture__sessttl.120:fixture@gw.dataimpulse.com:12000", SHORT_LIVED_ACCOUNT_PROXY_SQL_REGEX, KNOWN_EPHEMERAL_ACCOUNT_PROXY_SQL_REGEX]);
    expect(result.rows[0]).toEqual({ short_lived: true, rejected: false });
  });
});
