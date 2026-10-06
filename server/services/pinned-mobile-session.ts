import { createHash } from 'node:crypto';
import { DEFAULT_MOBILE_UA, type MobileSession } from './mobile-session.js';

/** Reuse this viewer's authenticated cookie for the mobile read endpoints.
 * The account, proxy and browser login stay unchanged. Device identifiers are
 * stable across workers/restarts; a renewed browser session supplies its new
 * credential on the next read. Never borrow another bot's mobile session. */
export function pinnedMobileSession(webState: string, botId: string): MobileSession {
  let state: {cookies?: Array<{name:string;value:string;domain?:string;path?:string;expires?:number} | null>};
  try { state = JSON.parse(webState); } catch { throw new Error('Pinned viewer has invalid saved storage state'); }
  if (!botId || !Array.isArray(state?.cookies)) throw new Error('Pinned viewer is missing its saved cookies');
  const cookies = new Map<string, string>();
  for (const cookie of state.cookies) {
    if (!cookie || typeof cookie.name !== 'string' || typeof cookie.value !== 'string') continue;
    const domain = String(cookie.domain ?? '').toLowerCase().replace(/^\./, '');
    if (domain !== 'instagram.com' && domain !== 'www.instagram.com') continue;
    if (cookie.path && cookie.path !== '/') continue;
    if (typeof cookie.expires === 'number' && cookie.expires !== -1 && cookie.expires <= Date.now() / 1000) continue;
    if (/[\r\n\0]/.test(cookie.value) || (cookies.has(cookie.name) && cookies.get(cookie.name) !== cookie.value)) {
      throw new Error('Pinned viewer has conflicting or invalid saved cookies');
    }
    cookies.set(cookie.name, cookie.value);
  }
  const dsUserId = cookies.get('ds_user_id') ?? '';
  const sessionid = cookies.get('sessionid') ?? '';
  let decoded: string;
  try { decoded = decodeURIComponent(sessionid); } catch { throw new Error('Pinned viewer has an invalid session credential'); }
  if (!/^[1-9]\d*$/.test(dsUserId) || !decoded.startsWith(dsUserId + ':')
      || decoded.length <= dsUserId.length + 1 || /[\r\n\0]/.test(decoded)) {
    throw new Error('Pinned viewer session does not match its account identity');
  }
  const digest = (purpose:string) => createHash('sha256').update(`pinned-viewer-mobile:v1:${botId}:${purpose}`).digest('hex');
  const uuid = (purpose:string) => {
    const hex=digest(purpose); return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
  };
  return {
    __marker:'instagram-mobile-bearer',version:1,dsUserId,sessionid,
    mid:cookies.get('mid')??'',rur:cookies.get('rur')??null,wwwClaim:'0',
    bearer:'Bearer IGT:2:'+Buffer.from(JSON.stringify({ds_user_id:dsUserId,sessionid,should_use_header_over_cookies:true})).toString('base64'),
    userAgent:DEFAULT_MOBILE_UA,androidId:'android-'+digest('android').slice(0,16),
    deviceUuid:uuid('device'),extraUuids:[uuid('family'),uuid('advertising')],
  };
}
