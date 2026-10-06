import { sql } from "drizzle-orm";
import type { db } from "../db.js";
import type { MobileSession } from "./mobile-session.js";
import type { OperationLeaseGuard } from "./operation-lease.js";
import { accountProxyDurabilityIssue } from "./proxy-durability.js";
import { inspectInstagramAuthResponse } from "./instagram-auth-diagnostics.js";

/** Deliberately fixed: a public target profile cannot prove authentication. */
export const MOBILE_OWN_ACCOUNT_PATH = "/api/v1/accounts/current_user/?edit=true";
const NUMERIC_ID = /^[1-9][0-9]*$/;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export interface MobileRevalidationOptions {
  botId: string;
  expectedUserId: string;
  apply: boolean;
}

/** Private in-memory snapshot. Never serialize this object to logs or receipts. */
export interface MobileRevalidationBot {
  id: string;
  rowVersion: string;
  igUserId: string | null;
  igUsername: string;
  sessionData: string | null;
  proxyUrl: string | null;
  hasAutomationIdentity: boolean;
  transport: string;
  tier: string;
  role: string;
  status: string;
  cooldownUntil: Date | null;
  lastLoginError: string | null;
}

export type MobileRevalidationReason =
  | "invalid_arguments" | "not_found" | "not_unclassified_mobile_scraper"
  | "cooldown_active" | "fixed_proxy_required" | "identity_mismatch"
  | "invalid_saved_session" | "snapshot_changed" | "lease_busy" | "lease_lost"
  | "daily_cap" | "challenge_required" | "login_required" | "feedback_required"
  | "rate_limited" | "request_rejected" | "response_unverified" | "operation_failed"
  | "eligible_for_one_identity_check" | "same_identity_confirmed";

class RevalidationBlocked extends Error {
  constructor(readonly reason: MobileRevalidationReason) { super(reason); }
}

export interface MobileRevalidationReport {
  mode: "dry_run" | "apply";
  outcome: "eligible" | "recovered" | "blocked" | "unverified";
  reason: MobileRevalidationReason;
  requestAttempted: boolean;
  dailyBudgetReserved: boolean;
  botChanged: boolean;
}

export function parseMobileRevalidationArgs(argv: readonly string[]): MobileRevalidationOptions | null {
  if (argv.length === 1 && argv[0] === "--help") return null;
  const values = new Map<string, string>();
  let apply = false;
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply" && !apply) apply = true;
    else if (arg === "--dry-run" && !dryRun) dryRun = true;
    else if ((arg === "--bot-id" || arg === "--expected-user-id") && !values.has(arg)) {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new RevalidationBlocked("invalid_arguments");
      values.set(arg, value);
    } else throw new RevalidationBlocked("invalid_arguments");
  }
  const options = { botId: values.get("--bot-id") ?? "", expectedUserId: values.get("--expected-user-id") ?? "", apply };
  if (apply && dryRun || !UUID.test(options.botId) || !NUMERIC_ID.test(options.expectedUserId)) {
    throw new RevalidationBlocked("invalid_arguments");
  }
  return options;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function numericId(value: unknown): string | null {
  if (typeof value === "number" && !Number.isSafeInteger(value)) return null;
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value);
  return NUMERIC_ID.test(text) ? text : null;
}

/** Validate stored bytes without filling in a device identity or minting credentials. */
export function validateSavedMobileSession(decrypted: string, expectedUserId: string): MobileSession {
  try {
    const raw = object(JSON.parse(decrypted));
    if (!raw || raw.__marker !== "instagram-mobile-bearer" || raw.version !== 1
      || raw.dsUserId !== expectedUserId || !NUMERIC_ID.test(expectedUserId)) throw new Error();
    const strings = ["sessionid", "mid", "bearer", "wwwClaim", "userAgent", "androidId", "deviceUuid"] as const;
    if (strings.some(key => typeof raw[key] !== "string" || !raw[key] || /[\0\r\n]/.test(raw[key] as string))) throw new Error();
    if (raw.rur !== null && (typeof raw.rur !== "string" || /[\0\r\n]/.test(raw.rur))) throw new Error();
    if (!/^android-[0-9a-f]{8,}$/i.test(raw.androidId as string) || !UUID.test(raw.deviceUuid as string)
      || !Array.isArray(raw.extraUuids) || raw.extraUuids.some(value => typeof value !== "string" || !UUID.test(value))) throw new Error();
    const cookie = decodeURIComponent(raw.sessionid as string);
    if (!cookie.startsWith(`${expectedUserId}:`) || cookie.length <= expectedUserId.length + 1 || /[\0\r\n]/.test(cookie)) throw new Error();
    const bearer = /^Bearer[ \t]+IGT:2:([A-Za-z0-9+/_-]+={0,2})$/.exec(raw.bearer as string);
    if (!bearer) throw new Error();
    const token = object(JSON.parse(Buffer.from(bearer[1], "base64").toString("utf8")));
    if (!token || numericId(token.ds_user_id) !== expectedUserId || typeof token.sessionid !== "string"
      || decodeURIComponent(token.sessionid) !== cookie) throw new Error();
    return raw as unknown as MobileSession;
  } catch {
    throw new RevalidationBlocked("invalid_saved_session");
  }
}

function checkCandidate(bot: MobileRevalidationBot | null, options: MobileRevalidationOptions, now: Date): asserts bot is MobileRevalidationBot {
  if (!bot) throw new RevalidationBlocked("not_found");
  if (bot.id !== options.botId || bot.igUserId !== options.expectedUserId) throw new RevalidationBlocked("identity_mismatch");
  // A known auth failure or challenge requires its own recovery, never this diagnostic.
  if (bot.transport !== "mobile" || bot.status !== "session_expired" || bot.role !== "scraper"
    || !["worker", "canary"].includes(bot.tier) || bot.hasAutomationIdentity
    || (bot.lastLoginError ?? "").trim() !== "") throw new RevalidationBlocked("not_unclassified_mobile_scraper");
  if (bot.cooldownUntil && (!Number.isFinite(bot.cooldownUntil.getTime()) || bot.cooldownUntil > now)) {
    throw new RevalidationBlocked("cooldown_active");
  }
  if (!bot.proxyUrl || bot.proxyUrl !== bot.proxyUrl.trim() || accountProxyDurabilityIssue(bot.proxyUrl)) {
    throw new RevalidationBlocked("fixed_proxy_required");
  }
  if (!bot.sessionData?.startsWith("v1:")) throw new RevalidationBlocked("invalid_saved_session");
}

function requireOwnIdentity(body: unknown, expectedUserId: string): void {
  const data = object(body);
  const diagnostics = inspectInstagramAuthResponse(200, JSON.stringify(data ?? {}));
  if (diagnostics) {
    throw new RevalidationBlocked(diagnostics.reason === "checkpoint_required" ? "challenge_required"
      : diagnostics.reason === "response_error" ? "response_unverified" : diagnostics.reason);
  }
  const user = object(data?.user);
  if (data?.status !== "ok" || !user || numericId(user.pk) !== expectedUserId
    || (user.pk_id !== undefined && numericId(user.pk_id) !== expectedUserId)) {
    throw new RevalidationBlocked("response_unverified");
  }
}

/** Allowlisted result only: raw upstream errors may contain credentials and usernames. */
export function mobileRevalidationFailureReason(error: unknown): MobileRevalidationReason {
  if (error instanceof RevalidationBlocked) return error.reason;
  const value = object(error);
  const reason = object(value?.authDiagnostics)?.reason;
  if (reason === "challenge_required" || reason === "checkpoint_required") return "challenge_required";
  if (reason === "login_required" || reason === "feedback_required" || reason === "rate_limited" || reason === "request_rejected") return reason;
  if (value?.name === "IGAuthExpiredError") return "login_required";
  if (value?.name === "IGRateLimitedError") return "rate_limited";
  if (value?.name === "IGDailyCapExceededError") return "daily_cap";
  if (value?.name === "OperationBusyError") return "lease_busy";
  return "operation_failed";
}

export interface MobileRevalidationDependencies {
  now(): Date;
  readBot(botId: string): Promise<MobileRevalidationBot | null>;
  decrypt(value: string): string;
  withLease<T>(key: string, work: (signal: AbortSignal, guard: OperationLeaseGuard) => Promise<T>): Promise<T>;
  reserveProfileBudget(botId: string): Promise<unknown>;
  createClient(bot: MobileRevalidationBot, session: MobileSession): {
    fetchRaw(path: string, options: { method: "GET" }): Promise<unknown>;
    close(): Promise<void>;
  };
  commitRecovered(bot: MobileRevalidationBot, guard: OperationLeaseGuard): Promise<boolean>;
}

export async function revalidateMobileSession(options: MobileRevalidationOptions, deps: MobileRevalidationDependencies): Promise<MobileRevalidationReport> {
  const report: MobileRevalidationReport = {
    mode: options.apply ? "apply" : "dry_run", outcome: "blocked", reason: "operation_failed",
    requestAttempted: false, dailyBudgetReserved: false, botChanged: false,
  };
  try {
    if (!UUID.test(options.botId) || !NUMERIC_ID.test(options.expectedUserId)) throw new RevalidationBlocked("invalid_arguments");
    const original = await deps.readBot(options.botId);
    checkCandidate(original, options, deps.now());
    validateSavedMobileSession(deps.decrypt(original.sessionData!), options.expectedUserId);
    if (!options.apply) return { ...report, outcome: "eligible", reason: "eligible_for_one_identity_check" };
    await deps.withLease(`bot:${options.botId}`, async (signal, guard) => {
      const assertOwnedSignal = () => { if (signal.aborted) throw new RevalidationBlocked("lease_lost"); };
      assertOwnedSignal();
      const bot = await deps.readBot(options.botId);
      checkCandidate(bot, options, deps.now());
      if (bot.rowVersion !== original.rowVersion) throw new RevalidationBlocked("snapshot_changed");
      const session = validateSavedMobileSession(deps.decrypt(bot.sessionData!), options.expectedUserId);
      const client = deps.createClient(bot, session);
      try {
        await deps.reserveProfileBudget(bot.id);
        report.dailyBudgetReserved = true;
        assertOwnedSignal();
        // Re-read after quota I/O too; operators do not necessarily share the bot lease.
        const current = await deps.readBot(bot.id);
        checkCandidate(current, options, deps.now());
        if (current.rowVersion !== bot.rowVersion) throw new RevalidationBlocked("snapshot_changed");
        assertOwnedSignal();
        report.requestAttempted = true;
        const response = await client.fetchRaw(MOBILE_OWN_ACCOUNT_PATH, { method: "GET" });
        assertOwnedSignal();
        requireOwnIdentity(response, options.expectedUserId);
        if (!await deps.commitRecovered(bot, guard)) throw new RevalidationBlocked("snapshot_changed");
        report.botChanged = true;
        report.outcome = "recovered";
        report.reason = "same_identity_confirmed";
      } finally {
        // Cleanup failure cannot turn a committed recovery into a false "unchanged" receipt.
        await client.close().catch(() => undefined);
      }
    });
  } catch (error) {
    if (!report.botChanged) {
      report.outcome = report.requestAttempted ? "unverified" : "blocked";
      report.reason = mobileRevalidationFailureReason(error);
    }
  }
  return report;
}

function rows<T>(result: unknown): T[] {
  return Array.isArray(result) ? result : (result as { rows?: T[] })?.rows ?? [];
}

export async function readMobileRevalidationBot(executor: Pick<typeof db, "execute">, id: string): Promise<MobileRevalidationBot | null> {
  const bot = rows<Omit<MobileRevalidationBot, "cooldownUntil"> & { cooldownUntil: string | Date | null }>(await executor.execute(sql`
    SELECT id, xmin::text AS "rowVersion", ig_user_id AS "igUserId", ig_username AS "igUsername",
      session_data AS "sessionData", proxy_url AS "proxyUrl", automation_identity IS NOT NULL AS "hasAutomationIdentity",
      transport, tier, role, status, cooldown_until AS "cooldownUntil", last_login_error AS "lastLoginError"
    FROM bot_accounts WHERE id = ${id}
  `))[0] ?? null;
  // Raw Drizzle execute() leaves timestamptz values as strings, unlike its
  // schema-aware selects. Normalize before evaluating the cooldown guard.
  return bot ? { ...bot, cooldownUntil: bot.cooldownUntil === null ? null : new Date(bot.cooldownUntil) } : null;
}

export async function commitMobileRevalidation(database: Pick<typeof db, "transaction">, bot: MobileRevalidationBot, guard: OperationLeaseGuard): Promise<boolean> {
  // The upstream request has finished. This short transaction locks the lease
  // and uses PostgreSQL's row version to fence every concurrent bot edit.
  return database.transaction(async tx => {
    try { await guard.assertOwned(tx); } catch { throw new RevalidationBlocked("lease_lost"); }
    return rows(await tx.execute(sql`
      UPDATE bot_accounts SET status = 'available', consecutive_hard_failures = 0,
        last_hard_failure_at = NULL, updated_at = clock_timestamp()
      WHERE id = ${bot.id} AND xmin::text = ${bot.rowVersion}
        AND ig_user_id = ${bot.igUserId} AND session_data = ${bot.sessionData} AND proxy_url = ${bot.proxyUrl}
        AND transport = 'mobile' AND role = 'scraper' AND tier IN ('worker', 'canary')
        AND status = 'session_expired' AND automation_identity IS NULL
        AND (last_login_error IS NULL OR btrim(last_login_error) = '')
        AND (cooldown_until IS NULL OR cooldown_until <= clock_timestamp())
      RETURNING id
    `)).length === 1;
  });
}
