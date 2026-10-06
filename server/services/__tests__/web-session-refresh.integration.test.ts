import { randomBytes, randomUUID } from 'node:crypto';
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';

const url = process.env.BACKEND_FIX_TEST_DATABASE_URL;
if (url) {
  const parsed = new URL(url);
  const runnerDatabase = Boolean(process.env.STRESS_NONCE)
    && (process.env.STRESS_ALLOWED_PORTS ?? '').split(',').includes(parsed.port)
    && /^\/[a-z0-9_]+_backend_fix_test_20260907$/.test(parsed.pathname);
  if ((parsed.pathname !== '/backend_reliability_test' && !runnerDatabase) || !['127.0.0.1', 'localhost'].includes(parsed.hostname)
      || !parsed.port || parsed.port === '5432') throw new Error('Guarded scratch database required');
  process.env.DATABASE_URL = url;
  process.env.SESSION_DATA_KEY = randomBytes(32).toString('base64');
}

function session(csrf: string, id = '123') {
  return JSON.stringify({ cookies: [
    { name: 'sessionid', value: `${id}%3Afixture-token`, domain: '.instagram.com', path: '/', expires: 4102444800, httpOnly: true },
    { name: 'ds_user_id', value: id, domain: '.instagram.com', path: '/', expires: 4102444800 },
    { name: 'csrftoken', value: csrf, domain: '.instagram.com', path: '/', expires: 4102444800 },
  ], origins: [{ origin: 'https://www.instagram.com', localStorage: [{ name: 'fixture', value: 'kept' }] }] });
}
const initial = session('initial-csrf'), refreshed = session('fresh-csrf');

(url ? describe : describe.skip)('web session refresh — encrypted storage and real concurrent writes', () => {
  const botId = randomUUID();
  let pool: typeof import('../../db.js').pool;
  let refresh: typeof import('../web-session-refresh.js').persistRefreshedWebSession;
  let encrypt: typeof import('../../crypto/session-envelope.js').encryptSessionData;
  let decrypt: typeof import('../../crypto/session-envelope.js').decryptSessionData;
  beforeAll(async () => {
    ({ pool } = await import('../../db.js'));
    ({ persistRefreshedWebSession: refresh } = await import('../web-session-refresh.js'));
    ({ encryptSessionData: encrypt, decryptSessionData: decrypt } = await import('../../crypto/session-envelope.js'));
    await pool.query('INSERT INTO bot_accounts(id,ig_username,ig_user_id) VALUES($1,$2,$3)', [botId, `fixture_${botId}`, '123']);
  });
  beforeEach(async () => {
    await pool.query("UPDATE bot_accounts SET session_data=$2,status='available',transport='web',cooldown_until=NULL,ig_user_id='123',updated_at=NOW() WHERE id=$1", [botId, encrypt(initial)]);
  });
  afterAll(async () => {
    await pool.query('DELETE FROM bot_accounts WHERE id=$1', [botId]);
    await pool.end();
  });
  async function saved() { return (await pool.query('SELECT session_data,status,transport FROM bot_accounts WHERE id=$1', [botId])).rows[0]; }

  it('encrypts the refreshed cookies, preserving storage and bot state', async () => {
    expect(await refresh(botId, initial, refreshed)).toBe(true);
    const row = await saved();
    expect(row.session_data).toMatch(/^v1:/);
    expect(row.session_data).not.toContain('fresh-csrf');
    expect(decrypt(row.session_data)).toBe(refreshed);
    expect(row).toMatchObject({ status: 'available', transport: 'web' });
  });

  it.each(['another viewer', 'missing session', 'expired session', 'missing csrf', 'mismatched viewer cookie', 'lookalike cookie domain', 'conflicting session cookies', 'encoded control', 'empty credential', 'csrf control', 'malformed'])('rejects %s without overwriting the last saved session', async kind => {
    const state = JSON.parse(refreshed);
    if (kind === 'missing session') state.cookies = state.cookies.filter((c: any) => c.name !== 'sessionid');
    if (kind === 'expired session') state.cookies[0].expires = 1;
    if (kind === 'missing csrf') state.cookies = state.cookies.filter((c: any) => c.name !== 'csrftoken');
    if (kind === 'mismatched viewer cookie') state.cookies[1].value = '456';
    if (kind === 'lookalike cookie domain') state.cookies.forEach((c: any) => { c.domain = '.notinstagram.com'; });
    if (kind === 'conflicting session cookies') state.cookies.push({ ...state.cookies[0], value: '456%3Aother-session' });
    if (kind === 'encoded control') state.cookies[0].value = '123%3Acredential%0Ainjected';
    if (kind === 'empty credential') state.cookies[0].value = '123%3A';
    if (kind === 'csrf control') state.cookies[2].value = 'csrf\r\ninjected';
    const candidate = kind === 'another viewer' ? session('other-csrf', '456') : kind === 'malformed' ? '{' : JSON.stringify(state);
    expect(await refresh(botId, initial, candidate)).toBe(false);
    expect(decrypt((await saved()).session_data)).toBe(initial);
  });

  it('does not overwrite a more recent login', async () => {
    const newer = session('new-login');
    await pool.query('UPDATE bot_accounts SET session_data=$2 WHERE id=$1', [botId, encrypt(newer)]);
    expect(await refresh(botId, initial, refreshed)).toBe(false);
    expect(decrypt((await saved()).session_data)).toBe(newer);
  });

  it.each(['disabled', 'mobile', 'cooldown', 'mismatched database viewer'])('does not refresh a bot with %s state', async kind => {
    if (kind === 'disabled') await pool.query("UPDATE bot_accounts SET status='disabled' WHERE id=$1", [botId]);
    if (kind === 'mobile') await pool.query("UPDATE bot_accounts SET transport='mobile' WHERE id=$1", [botId]);
    if (kind === 'cooldown') await pool.query("UPDATE bot_accounts SET cooldown_until=NOW()+interval '1 hour' WHERE id=$1", [botId]);
    if (kind === 'mismatched database viewer') await pool.query("UPDATE bot_accounts SET ig_user_id='456' WHERE id=$1", [botId]);
    expect(await refresh(botId, initial, refreshed)).toBe(false);
    expect(decrypt((await saved()).session_data)).toBe(initial);
  });

  it('allows only one concurrent refresh of the same observed session', async () => {
    const other = session('other-refresh');
    const outcomes = await Promise.all([refresh(botId, initial, refreshed), refresh(botId, initial, other)]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(decrypt((await saved()).session_data)).toBe(outcomes[0] ? refreshed : other);
  });

  it('does not overwrite an administrative change committed while its update waits', async () => {
    const admin = await pool.connect();
    let saving: Promise<boolean> | undefined;
    try {
      await admin.query('BEGIN');
      await admin.query("UPDATE bot_accounts SET updated_at=NOW(),proxy_url='http://127.0.0.1:9999' WHERE id=$1", [botId]);
      saving = refresh(botId, initial, refreshed);
      let waiting = false;
      for (let i = 0; i < 100 && !waiting; i++) {
        waiting = (await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%UPDATE bot_accounts SET session_data =%' AND pid<>pg_backend_pid()" )).rowCount! > 0;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await admin.query('COMMIT');
      expect(await saving).toBe(false);
      expect(decrypt((await saved()).session_data)).toBe(initial);
    } finally {
      await admin.query('ROLLBACK');
      await saving?.catch(() => undefined);
      admin.release();
    }
  });
});
