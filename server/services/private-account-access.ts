import { and, asc, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "../db.js";
import { botAccounts, botFollowRequests, trackedAccounts } from "../../shared/schema.js";
import { customerAccessSql } from "./subscription-access.js";
import { accountProxyDurabilityIssue, KNOWN_EPHEMERAL_ACCOUNT_PROXY_SQL_REGEX } from "./proxy-durability.js";
import { BAN_REASON_SQL_REGEX, COOLDOWN_REASON_PREFIX } from "./bot-cooldown.js";
import { parseAutomationIdentity } from "./automation-identity.js";
import { proxyAgentUriForEndpoint } from "./proxy-provider.js";

/** Cheap candidate gates; persisted identity and proxy syntax are validated below. */
export function healthyPrivateReaderSql(options: { ignoreCooldown?: boolean; now?: Date } = {}) {
  return and(
    eq(botAccounts.transport, "web"),
    inArray(botAccounts.tier, ["worker", "canary"]),
    inArray(botAccounts.status, ["available", "in_use"]),
    isNotNull(botAccounts.sessionData), isNotNull(botAccounts.automationIdentity),
    sql`length(trim(${botAccounts.sessionData})) > 0`,
    sql`${botAccounts.automationIdentity}->>'bot_id' = ${botAccounts.id}`,
    options.ignoreCooldown ? undefined : or(isNull(botAccounts.cooldownUntil), lt(botAccounts.cooldownUntil, options.now ?? new Date())),
    sql`(COALESCE(${botAccounts.lastLoginError}, '') LIKE ${COOLDOWN_REASON_PREFIX + "%"}
      OR COALESCE(${botAccounts.lastLoginError}, '') !~* ${BAN_REASON_SQL_REGEX})`,
    sql`((${botAccounts.proxyUrl} IS NOT NULL
        AND ${botAccounts.proxyUrl} !~* ${KNOWN_EPHEMERAL_ACCOUNT_PROXY_SQL_REGEX})
      OR (${botAccounts.proxyUrl} IS NULL AND ${botAccounts.proxyEndpoint} IS NOT NULL
        AND ${botAccounts.proxyExpiresAt} > NOW() + INTERVAL '2 minutes'))`,
  )!;
}

type PrivateReaderMetadata = Pick<typeof botAccounts.$inferSelect,
  "id" | "automationIdentity" | "proxyUrl" | "proxyEndpoint" | "proxyExpiresAt" | "cooldownUntil">;

function validPrivateReaderMetadata(bot: PrivateReaderMetadata): boolean {
  if (!parseAutomationIdentity(bot.automationIdentity, bot.id)) return false;
  try {
    const proxy = bot.proxyUrl ?? (bot.proxyEndpoint ? proxyAgentUriForEndpoint(bot.proxyEndpoint) : null);
    return proxy !== null && accountProxyDurabilityIssue(proxy) === null;
  } catch { return false; }
}

async function privateReaderCandidates(trackedAccountId: string | undefined, now: Date, ignoreCooldown = false) {
  const rows = await db.select({ trackedAccountId: trackedAccounts.id, bot: {
    id: botAccounts.id, automationIdentity: botAccounts.automationIdentity,
    proxyUrl: botAccounts.proxyUrl, proxyEndpoint: botAccounts.proxyEndpoint,
    proxyExpiresAt: botAccounts.proxyExpiresAt, cooldownUntil: botAccounts.cooldownUntil,
  } })
    .from(botFollowRequests).innerJoin(botAccounts, eq(botFollowRequests.botAccountId, botAccounts.id))
    .innerJoin(trackedAccounts, eq(botFollowRequests.trackedAccountId, trackedAccounts.id))
    .where(and(trackedAccountId ? eq(trackedAccounts.id, trackedAccountId) : undefined,
      eq(trackedAccounts.isActive, true), eq(trackedAccounts.isPrivate, true), eq(trackedAccounts.accessStatus, "has_access"),
      customerAccessSql(trackedAccounts.userId), eq(botFollowRequests.status, "accepted"),
      healthyPrivateReaderSql({ ignoreCooldown, now })))
    .orderBy(asc(botFollowRequests.resolvedAt), asc(botFollowRequests.id));
  return rows.filter(row => validPrivateReaderMetadata(row.bot));
}

/** Bulk health lookup avoids one query per private profile and uses runtime validators. */
export async function healthyPrivateReaderTargetIds(): Promise<string[]> {
  return [...new Set((await privateReaderCandidates(undefined, new Date())).map(row => row.trackedAccountId))];
}

/** Earliest safe wake-up for this customer's independently approved readers.
 * A broken session/proxy is never treated as recoverable merely by waiting. */
export async function getPrivateReaderRetryAt(trackedAccountId: string, now = new Date()): Promise<Date | null> {
  const rows = await privateReaderCandidates(trackedAccountId, now, true);
  const viable = rows.filter(({bot}) => bot.proxyUrl !== null || (bot.proxyExpiresAt !== null &&
    bot.proxyExpiresAt.getTime() > Math.max(now.getTime(), bot.cooldownUntil?.getTime() ?? 0) + 120_000));
  if (viable.some(({bot}) => !bot.cooldownUntil || bot.cooldownUntil <= now)) return null;
  const earliest = Math.min(...viable.map(({bot}) => bot.cooldownUntil!.getTime()));
  return Number.isFinite(earliest) ? new Date(earliest) : null;
}

/** Keep the original approved viewer while healthy, then an approved backup.
 * A shared public cache/twin never supplies authorization for a private read. */
export async function findGrantedBotIds(trackedAccountId: string): Promise<string[]> {
  const rows = await privateReaderCandidates(trackedAccountId, new Date());
  return [...new Set(rows.map(row => row.bot.id))].slice(0, 2);
}

export async function findGrantedBotId(trackedAccountId: string): Promise<string | null> {
  return (await findGrantedBotIds(trackedAccountId))[0] ?? null;
}

/** Recheck authorization between collection steps without confusing a
 * transient bot cooldown with the target withdrawing its approval. */
export async function privateBotHasAccess(trackedAccountId: string, botAccountId: string): Promise<boolean> {
  const [row] = await db.select({ id: botFollowRequests.id })
    .from(botFollowRequests)
    .innerJoin(trackedAccounts, eq(botFollowRequests.trackedAccountId, trackedAccounts.id))
    .where(and(eq(trackedAccounts.id, trackedAccountId), eq(botFollowRequests.botAccountId, botAccountId),
      eq(botFollowRequests.status, "accepted"), eq(trackedAccounts.isActive, true),
      eq(trackedAccounts.isPrivate, true), eq(trackedAccounts.accessStatus, "has_access"),
      customerAccessSql(trackedAccounts.userId)))
    .limit(1);
  return Boolean(row);
}

/** Approval polling belongs to the original pending request, not any other
 * viewer or a request canceled while the reader was obtaining its lease. */
export async function privateFollowRequestCanProbe(requestId: string, trackedAccountId: string, botAccountId: string): Promise<boolean> {
  const [row] = await db.select({ id: botFollowRequests.id }).from(botFollowRequests)
    .innerJoin(trackedAccounts, eq(botFollowRequests.trackedAccountId, trackedAccounts.id))
    .where(and(eq(botFollowRequests.id, requestId), eq(botFollowRequests.trackedAccountId, trackedAccountId),
      eq(botFollowRequests.botAccountId, botAccountId), eq(botFollowRequests.status, "pending"),
      eq(trackedAccounts.isActive, true), eq(trackedAccounts.isPrivate, true),
      customerAccessSql(trackedAccounts.userId)))
    .limit(1);
  return Boolean(row);
}
