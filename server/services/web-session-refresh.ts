import { sql } from 'drizzle-orm';
import { db } from '../db.js';
import { decryptSessionData, encryptSessionData } from '../crypto/session-envelope.js';

/** Only a complete, live web session with an unambiguous viewer can be saved. */
function viewerId(sessionData: string): string | null {
  try {
    const state = JSON.parse(sessionData);
    if (!Array.isArray(state?.cookies)) return null;
    const values = new Map<string, string>();
    for (const cookie of state.cookies) {
      if (!['sessionid', 'ds_user_id', 'csrftoken'].includes(cookie?.name)) continue;
      const domain = String(cookie.domain ?? '').toLowerCase().replace(/^\./, '');
      if (domain !== 'instagram.com' && domain !== 'www.instagram.com') continue;
      if (cookie.path && cookie.path !== '/') continue;
      if (typeof cookie.expires === 'number' && cookie.expires !== -1 && cookie.expires <= Date.now() / 1000) continue;
      if (typeof cookie.value !== 'string' || !cookie.value) continue;
      if (/[\r\n\0]/.test(cookie.value)) return null;
      if (values.has(cookie.name) && values.get(cookie.name) !== cookie.value) return null;
      values.set(cookie.name, cookie.value);
    }
    if (!values.get('csrftoken')) return null;
    const session = decodeURIComponent(values.get('sessionid') ?? '');
    const id = /^([1-9]\d*):/.exec(session)?.[1];
    if (!id || session.length <= id.length + 1 || /[\r\n\0]/.test(session)
        || (values.has('ds_user_id') && values.get('ds_user_id') !== id)) return null;
    return id;
  } catch { return null; }
}

/** Persist provider-refreshed cookies after a successful read, never an auth repair.
 * Compare both the viewer and the observed envelope so a concurrent login, pause,
 * or another refresh cannot be overwritten by an old read. Preserve row changes
 * committed between our database read and write as well.
 * The indexed UPDATE is short; no network work takes place inside a transaction.
 */
export async function persistRefreshedWebSession(
  botId: string,
  observed: string,
  refreshed: string,
): Promise<boolean> {
  if (!observed || !refreshed || observed === refreshed) return false;
  const id = viewerId(observed);
  if (!id || viewerId(refreshed) !== id) return false;
  const result = await db.execute(sql`
    SELECT session_data, status, transport, ig_user_id, updated_at::text AS updated_at
    FROM bot_accounts WHERE id = ${botId}
      AND (cooldown_until IS NULL OR cooldown_until <= NOW())
  `) as unknown as { rows: Array<{ session_data: string | null; status: string; transport: string; ig_user_id: string | null; updated_at: string }> };
  const row = result.rows[0];
  if (!row?.session_data || row.transport !== 'web' || !['available', 'in_use'].includes(row.status)) return false;
  if (row.ig_user_id && row.ig_user_id !== id) return false;
  try { if (decryptSessionData(row.session_data) !== observed) return false; }
  catch { return false; }
  const encrypted = encryptSessionData(refreshed);
  const saved = await db.execute(sql`
    UPDATE bot_accounts SET session_data = ${encrypted}, updated_at = NOW()
    WHERE id = ${botId} AND session_data = ${row.session_data}
      AND status = ${row.status} AND transport = 'web' AND updated_at = ${row.updated_at}::timestamptz
      AND (cooldown_until IS NULL OR cooldown_until <= NOW())
    RETURNING id
  `) as unknown as { rows: Array<{ id: string }> };
  return saved.rows.length === 1;
}
