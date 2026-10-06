import { describe, expect, it } from 'vitest';
import { DEFAULT_MOBILE_UA, parseMobileSessionLine, parseMobileEnvelope, serializeMobileSession } from '../mobile-session.js';

const id = '123456789';
const cookie = `${id}%3Afixture-cookie%3Acredential`;
const device = 'android-0123456789abcdef;11111111-2222-3333-4444-555555555555;66666666-7777-8888-9999-aaaaaaaaaaaa;bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
const ua = 'Instagram 400.1 Android (33/13; 420dpi; 1080x2400; Fixture; Device; fixture; arm64; en_US; 1)';
const bearer = (overrides: Record<string, unknown> = {}) => 'Bearer IGT:2:' + Buffer.from(JSON.stringify({ ds_user_id: id, sessionid: cookie, ...overrides })).toString('base64');
const line = (headers = `sessionid=${cookie};IG-U-DS-USER-ID=${id};X-MID=fixture-mid;Authorization=${bearer()}`, options: {ua?: string; device?: string; credentials?: string} = {}) => `${options.credentials ?? 'fixture_user:fixture-password:JBSWY3DPEHPK3PXP'}|${options.ua ?? ua}|${options.device ?? device}|${headers}|||`;

describe('supplied mobile session export parser', () => {
  it('accepts header-style ID and MID aliases and preserves the supplied app identity', () => {
    const parsed = parseMobileSessionLine(line());
    expect(parsed.session).toMatchObject({ dsUserId: id, sessionid: cookie, mid: 'fixture-mid', bearer: bearer(), userAgent: ua, androidId: 'android-0123456789abcdef', deviceUuid: '11111111-2222-3333-4444-555555555555', extraUuids: ['66666666-7777-8888-9999-aaaaaaaaaaaa','bbbbbbbb-cccc-dddd-eeee-ffffffffffff'] });
    expect(parsed.credentials).toEqual({username:'fixture_user',password:'fixture-password',totpSecret:'JBSWY3DPEHPK3PXP'});
  });
  it('reads both legacy cookies and mixed-case header names', () => {
    const parsed = parseMobileSessionLine(line(`SESSIONID=${cookie};dS_UsEr_Id=${id};x-MiD=fixture-mid;aUtHoRiZaTiOn=${bearer()};x-iG-wWw-ClAiM=fixture-claim;Ig-U-RuR=fixture-rur`));
    expect(parsed.session).toMatchObject({ dsUserId: id, mid:'fixture-mid', wwwClaim:'fixture-claim', rur:'fixture-rur' });
  });
  it('accepts matching duplicate aliases without overwriting their values', () => {
    const parsed = parseMobileSessionLine(line(`sessionid=${cookie};ds_user_id=${id};IG-U-DS-USER-ID=${id};mid=fixture-mid;X-MID=fixture-mid;Authorization=${bearer()}`));
    expect(parsed.session.dsUserId).toBe(id);
  });
  it('compares percent-encoded cookie values by their decoded value', () => {
    const parsed = parseMobileSessionLine(line(`sessionid=${cookie};ds_user_id=${id};mid=fixture-mid;Authorization=${bearer({sessionid:decodeURIComponent(cookie),ds_user_id:Number(id)})}`));
    expect(parsed.session.sessionid).toBe(cookie);
  });
  it('round-trips without altering the bearer, UA or device UUIDs', () => {
    const parsed = parseMobileSessionLine(line());
    expect(parseMobileEnvelope(serializeMobileSession(parsed.session))).toEqual(parsed.session);
  });
  it('uses a default UA only when the export omits it', () => {
    expect(parseMobileSessionLine(line(undefined,{ua:''})).session.userAgent).toBe(DEFAULT_MOBILE_UA);
  });
  it('normalizes whitespace in a TOTP secret while preserving a colon-containing password', () => {
    const parsed = parseMobileSessionLine(line(undefined,{credentials:'fixture_user:fixture:password:jbsw y3dp ehpk 3pxp'}));
    expect(parsed.credentials).toEqual({username:'fixture_user',password:'fixture:password',totpSecret:'JBSWY3DPEHPK3PXP'});
  });
  it.each([
    [`sessionid=${cookie};ds_user_id=999;Authorization=${bearer()}`, /cookie identity/],
    [`sessionid=${cookie};ds_user_id=${id};Authorization=${bearer({ds_user_id:'999'})}`, /bearer\/cookie identity/],
    [`sessionid=${cookie};ds_user_id=${id};Authorization=${bearer({sessionid:`${id}%3Adifferent`})}`, /bearer\/cookie identity/],
    [`sessionid=${cookie};ds_user_id=${id};IG-U-DS-USER-ID=999;Authorization=${bearer()}`, /conflicting aliased/],
    [`sessionid=${cookie};ds_user_id=${id};mid=one;X-MID=two;Authorization=${bearer()}`, /conflicting aliased/],
    [`sessionid=${cookie};SESSIONID=different;ds_user_id=${id};Authorization=${bearer()}`, /conflicting duplicate/],
    [`sessionid=${cookie};ds_user_id=${id};Authorization=Bearer IGT:2:bm90LWpzb24=`, /malformed bearer/],
    [`sessionid=bad%ZZ;ds_user_id=${id};Authorization=${bearer()}`, /cookie encoding/],
    [`sessionid=${id}%3Atoken%0Ainjected;ds_user_id=${id};Authorization=${bearer()}`, /cookie encoding/],
    [`sessionid=${cookie};ds_user_id=not-a-number;Authorization=${bearer()}`, /numeric account identity/],
  ])('rejects conflicting, malformed or injected identity material', (headers, expected) => {
    expect(() => parseMobileSessionLine(line(headers))).toThrow(expected);
  });
  it('rejects invalid device UUIDs without echoing credential material', () => {
    expect(() => parseMobileSessionLine(line(undefined,{device:'android-0123456789abcdef;fixture-secret'}))).toThrow('invalid device UUID');
  });
  it('does not include malformed credential input in an exception', () => {
    try { parseMobileSessionLine(line(undefined,{credentials:'fixture-password-only'})); throw new Error('expected rejection'); }
    catch (error) { expect((error as Error).message).not.toContain('fixture-password-only'); expect((error as Error).message).toMatch(/malformed credentials/); }
  });
});
