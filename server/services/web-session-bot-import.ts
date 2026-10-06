export interface WebSessionBotInput {
  username: string;
  password: string;
  totp: string | null;
  cookies: Record<string, string>;
  email: string | null;
}

/** Accept both seller exports, without putting credentials in parse errors:
 * username|password|cookies|email
 * username|password|TOTP|cookies|email|optional-phone
 */
export function parseWebSessionBotInput(contents: string): WebSessionBotInput[] {
  const rows: WebSessionBotInput[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of contents.replace(/^\uFEFF/, "").split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const fail = (reason: string): never => { throw new Error(`line ${index + 1}: ${reason}`); };
    const fields = line.split("|");
    if (fields.length < 4) fail("expected username, password, cookies and email fields");
    const username = fields[0].trim().toLowerCase();
    const password = fields[1].trim();
    if (!/^[a-z0-9._]{1,30}$/.test(username)) fail("invalid Instagram username");
    if (!password) fail("missing password");
    if (seen.has(username)) fail("duplicate username");
    seen.add(username);
    const cookieIndex = /(?:^|;)\s*sessionid=/.test(fields[2]) ? 2 : 3;
    const cookies: Record<string, string> = Object.create(null);
    for (const pair of fields[cookieIndex].split(";")) {
      const value = pair.trim();
      const equals = value.indexOf("=");
      if (equals <= 0) continue;
      cookies[value.slice(0, equals).trim()] = value.slice(equals + 1);
    }
    if (!cookies.sessionid) fail("missing sessionid cookie");
    if (!cookies.csrftoken) fail("missing csrftoken cookie");
    const seed = cookieIndex === 3 ? fields[2].replace(/\s+/g, "").toUpperCase() : "";
    if (seed && !/^[A-Z2-7]{16,}$/.test(seed)) fail("invalid Base32 TOTP secret");
    const email = fields[cookieIndex + 1]?.trim() || null;
    if (email && !email.includes("@")) fail("invalid email field");
    rows.push({ username, password, cookies, totp: seed || null, email });
  }
  if (!rows.length) throw new Error("credential file contains no bot rows");
  return rows;
}
