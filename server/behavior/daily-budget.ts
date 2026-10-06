// ─── Per-bot daily IG-call budget (Wave 6) ───────────────────────────────────
//
// Caps the number of reads per endpoint and UTC day. The optional warmup
// schedule uses our import date, not the account's age on Instagram. Operators
// can disable that waiting period without disabling daily request accounting,
// transport capability checks or provider-imposed holds.
//
// Storage: bot_daily_calls(bot_id, day, endpoint, count) — see
// migrations/0013_bot_daily_budgets.sql. The (bot_id, day, endpoint) PK gives
// us natural day-rollover: a new UTC date = a fresh row, no scheduler needed.
//
// Atomicity: checkAndIncrementBudget uses
//   INSERT ... ON CONFLICT (...) DO UPDATE SET count = count + 1
//                                          WHERE count < $cap
//                                    RETURNING count
// Postgres evaluates the WHERE on the conflicting row inside the same
// statement; if the predicate fails the UPDATE is skipped and zero rows are
// returned. We treat 0 rows as "cap hit". This serializes correctly under
// concurrent upserts on the same PK (the row lock is held until commit).
// ─────────────────────────────────────────────────────────────────────────────

import { sql, eq, and } from "drizzle-orm";
import { db as defaultDb } from "../db.js";
import { botDailyCalls, botAccounts } from "../../shared/schema.js";
import { IGDailyCapExceededError } from "./caps.js";

// ─── Canonical endpoint vocabulary ──────────────────────────────────────────
//
// The budget table is keyed by these short, normalized names — NOT by the
// raw scrape labels (which are like "profile:wire.fluid" or
// "followers-all:80264514554"). Use normalizeEndpoint(label) to translate.

export type BudgetEndpoint =
  | "profile"
  | "posts"
  | "followers"
  | "stories"
  | "highlights"
  | "likers"
  | "comments"
  | "reels";

const BUDGET_ENDPOINTS: ReadonlyArray<BudgetEndpoint> = [
  "profile",
  "posts",
  "followers",
  "stories",
  "highlights",
  "likers",
  "comments",
  "reels",
];

// Sentinel for "no cap" — used for the day-14+ profile/posts/followers tier
// in the schedule. We pick a value larger than any plausible per-day call
// volume so the WHERE count < cap predicate is effectively always true.
const UNLIMITED = 1_000_000;

// ─── Age-tier schedule ──────────────────────────────────────────────────────
//
// Each row is the per-endpoint cap at that age tier. ageDay >= the row's
// `minDay` (and < the next row's minDay) selects the tier. The order matters:
// LATEST tier first (binary lookup walks descending). The total/day column
// in the spec is informational; the per-endpoint sum may exceed it because
// not every endpoint is exercised every day.

interface BudgetTier {
  readonly minDay: number;
  readonly caps: Readonly<Record<BudgetEndpoint, number>>;
}

export const BUDGET_TABLE: ReadonlyArray<BudgetTier> = [
  {
    minDay: 14,
    caps: {
      profile: UNLIMITED,
      posts: UNLIMITED,
      followers: UNLIMITED,
      stories: 30,
      highlights: 30,
      likers: 30,
      comments: 30,
      reels: 20,
    },
  },
  {
    minDay: 6,
    caps: {
      profile: 50,
      posts: 50,
      followers: 50,
      stories: 10,
      highlights: 10,
      likers: 0, // gated to matured (day-14+) bots — see day-3 tier note
      comments: 10,
      reels: 8,
    },
  },
  {
    minDay: 3,
    caps: {
      profile: 30,
      posts: 25,
      followers: 20,
      stories: 5,
      highlights: 5,
      // likers gated to matured bots (day-14+): the endpoint is IG-trust-gated
      // and 0/77k on young sessions, and hammering it checkpoints fragile young
      // accounts BEFORE they can mature. Young bots build trust on the endpoints
      // they succeed at (posts/stories/rosters/highlights/comments); likers
      // switches on only once they reach the day-14 tier.
      likers: 0,
      comments: 5,
      reels: 3,
    },
  },
  {
    minDay: 2,
    caps: {
      profile: 20,
      posts: 15,
      followers: 10,
      stories: 3,
      highlights: 3,
      likers: 0, // gated to matured (day-14+) bots — see day-3 tier note
      comments: 1,
      reels: 0,
    },
  },
  {
    minDay: 1,
    caps: {
      profile: 10,
      posts: 5,
      followers: 5,
      stories: 1,
      highlights: 1,
      likers: 0,
      comments: 0,
      reels: 0,
    },
  },
  {
    minDay: 0,
    caps: {
      profile: 5,
      posts: 3,
      followers: 2,
      stories: 0,
      highlights: 0,
      likers: 0,
      comments: 0,
      reels: 0,
    },
  },
];

// Fixed daily budgets when import-date waiting is disabled. All supported web
// reads are immediately eligible, with finite caps even for long-lived imports.
// These are application limits, not a promise of Instagram endpoint access.
export const READ_DAILY_CAPS: Readonly<Record<BudgetEndpoint, number>> = {
  profile: 50,
  posts: 50,
  followers: 50,
  stories: 30,
  highlights: 30,
  likers: 30,
  comments: 30,
  reels: 20,
};

export function readWarmupEnabled(): boolean {
  return process.env.BOT_READ_WARMUP_ENABLED?.trim().toLowerCase() !== "false";
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Per-bot LIKERS velocity override. Likers is the single most ban-prone
// endpoint (13 accounts burned in 18h at 30/bot/day). Lowering per-account
// velocity and spreading the same work across more bots is the standard
// mitigation: total throughput is set by pool size, but per-account risk drops
// sharply. Empty/0 = use the age-tier default. Clamped to [1, 100].
function likersDailyCapOverride(): number | null {
  const raw = process.env.LIKERS_DAILY_CAP;
  if (raw === undefined || raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(Math.max(Math.trunc(n), 1), 100);
}

// Every account in this pool is BOUGHT PRE-AGED — we never register fresh IG
// accounts, we import ones with real history. So `created_at` (our onboarding
// timestamp) badly understates the account's true IG age: a 1-month-old account
// imported today looks like day-0 and gets the likers endpoint hard-gated to 0,
// which is exactly why liked-post evidence dried up. BOT_AGE_FLOOR_DAYS sets the
// minimum effective age applied to the warming ramp so pre-aged accounts get the
// caps their real trust supports. Clamped to [0, 60]. Mobile bots are unaffected
// for the gated endpoints — endpointDailyCap forces those to 0 by transport.
function botAgeFloorDays(): number {
  const raw = Number(process.env.BOT_AGE_FLOOR_DAYS ?? "0");
  if (!Number.isFinite(raw) || raw < 0) return 0;
  return Math.min(Math.trunc(raw), 60);
}

function ageInDays(createdAt: Date, now: Date): number {
  const diff = now.getTime() - createdAt.getTime();
  const raw = diff <= 0 ? 0 : Math.floor(diff / MS_PER_DAY);
  return Math.max(raw, botAgeFloorDays());
}

function tierForAge(ageDays: number): BudgetTier {
  for (const tier of BUDGET_TABLE) {
    if (ageDays >= tier.minDay) return tier;
  }
  // BUDGET_TABLE always contains a minDay=0 entry, so this is unreachable.
  return BUDGET_TABLE[BUDGET_TABLE.length - 1]!;
}

// Ops lever: scale the per-bot daily caps when the pool exhausts itself (bots
// benched on daily-budget cooldown before the collection cycle finishes).
// DAILY_CAP_MULTIPLIER=1 keeps the warming-ramp defaults; higher values trade
// anti-detection headroom for throughput. Clamped to [1, 10].
function dailyCapMultiplier(): number {
  const raw = Number(process.env.DAILY_CAP_MULTIPLIER ?? "1");
  if (!Number.isFinite(raw) || raw < 1) return 1;
  return Math.min(raw, 10);
}

// Mobile (Bearer IGT:2) bots are PRE-AUTHENTICATED, established accounts — not
// the fresh signups the age-ramp is built to protect — and they are capability-
// gated to profile+posts only. Treating them as day-0 (posts cap 3) starves the
// pool and makes burst repairs (liked-post thumbnail re-sign) fail with false
// "daily cap" errors. Give them a flat, generous-but-bounded cap for the two
// endpoints they serve. Bounded (not UNLIMITED) so a runaway loop still can't
// hammer a bought session into a ban. Tunable via env; clamped to [3, 500].
function mobileProfilePostsCap(): number {
  const raw = Number(process.env.MOBILE_DAILY_CAP ?? "60");
  if (!Number.isFinite(raw)) return 60;
  return Math.min(Math.max(Math.round(raw), 3), 500);
}

/**
 * Returns the daily cap for a bot+endpoint based on the bot's account age.
 * `endpoint` may be a raw scrape label (e.g. "profile:wire.fluid") or an
 * already-normalized BudgetEndpoint — the function normalizes either way.
 */
const IMPORT_GRACE_HOURS_DEFAULT = 24;
const IMPORT_DAY_LIKERS_CAP_DEFAULT = 15;

function importGraceMs(): number {
  const raw = Number(process.env.BOT_IMPORT_GRACE_HOURS ?? String(IMPORT_GRACE_HOURS_DEFAULT));
  const hours = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 168) : IMPORT_GRACE_HOURS_DEFAULT;
  return hours * 3_600_000;
}

/** Likers cap for a bot still inside its import grace window; `cap` otherwise. */
export function importDayLikersCap(botCreatedAt: Date, now: Date, cap: number): number {
  const graceMs = importGraceMs();
  if (graceMs <= 0) return cap;
  if (now.getTime() - botCreatedAt.getTime() >= graceMs) return cap;
  const raw = Number(process.env.LIKERS_IMPORT_DAY_CAP ?? String(IMPORT_DAY_LIKERS_CAP_DEFAULT));
  const dayCap = Number.isFinite(raw) ? Math.max(Math.trunc(raw), 0) : IMPORT_DAY_LIKERS_CAP_DEFAULT;
  return Math.min(cap, dayCap);
}

export function endpointDailyCap(
  botCreatedAt: Date,
  endpoint: string,
  now: Date = new Date(),
  transport: "web" | "mobile" | null | undefined = "web",
): number {
  const normalized = normalizeEndpoint(endpoint);
  if (normalized === null) return 0;
  // Mobile bots: flat pre-auth cap for their two allowed endpoints; every other
  // endpoint stays 0 (they cannot serve them anyway — capability-gated).
  if (transport === "mobile") {
    if (normalized === "profile" || normalized === "posts") {
      return Math.round(mobileProfilePostsCap() * dailyCapMultiplier());
    }
    // Roster reads: verified working on mobile sessions (HTTP 200 with full
    // user pages), unlike likers/stories which stay 403 login_required. Serving
    // them here takes ~1,400 reads/day off the ban-prone web pool so its budget
    // can go to likers, which only web can do. Same flat pre-auth cap — these
    // are established accounts, not the fresh signups the age ramp protects.
    // "following" normalizes to "followers" (see ENDPOINT_SYNONYMS), so this
    // single branch covers both roster directions.
    if (
      normalized === "followers" &&
      (process.env.MOBILE_ROSTER_ENABLED ?? "true") !== "false"
    ) {
      return Math.round(mobileProfilePostsCap() * dailyCapMultiplier());
    }
    return 0;
  }
  const warmupEnabled = readWarmupEnabled();
  let cap = warmupEnabled
    ? tierForAge(ageInDays(botCreatedAt, now)).caps[normalized]
    : READ_DAILY_CAPS[normalized];
  // An explicit daily override still applies. In warmup mode it cannot enable
  // an endpoint before the configured schedule allows it.
  if (normalized === "likers" && cap > 0) {
    const override = likersDailyCapOverride();
    if (override !== null) cap = override;
  }
  // Leave the UNLIMITED sentinel and a structural 0 (endpoint not yet allowed
  // at this bot's age) unscaled — only finite, positive caps are multiplied.
  if (cap <= 0 || cap >= UNLIMITED) return cap;
  // Import-day ramp (2026-09-02). BOT_AGE_FLOOR_DAYS floors a bought account's
  // age so it gets the matured tier at once — which also hands a session
  // imported an hour ago the full likers cap as its very first traffic. Of the
  // first 55 fresh bots leased that day, 4 were checkpointed on that first
  // liker read. For BOT_IMPORT_GRACE_HOURS (default 24) after the row is
  // created, likers is capped at LIKERS_IMPORT_DAY_CAP (default 15); every
  // other endpoint keeps its tier cap so the bot still works.
  if (warmupEnabled && normalized === "likers") {
    cap = Math.min(cap, importDayLikersCap(botCreatedAt, now, cap));
  }
  return Math.round(cap * dailyCapMultiplier());
}

// ─── Endpoint normalization ────────────────────────────────────────────────
//
// Scrape labels carry a username/userId suffix after a colon (e.g.
// "profile:wire.fluid", "followers-all:80264514554"). We strip that suffix,
// then collapse a few synonyms to canonical buckets:
//   - clips, reels   → reels
//   - tagged, posts  → posts        (tagged-of is content discovery, same risk)
//   - following      → followers    (same endpoint family from IG's POV)
//   - followers-all  → followers    (paginated wrapper)
//   - following-all  → followers
//   - login          → null         (login is not subject to per-bot budgets;
//                                    it's tracked separately in caps.ts)
//
// Returns null when the label cannot be mapped — callers should treat null as
// "no budget enforcement" (e.g. login).

const ENDPOINT_SYNONYMS: Readonly<Record<string, BudgetEndpoint>> = {
  profile: "profile",
  posts: "posts",
  tagged: "posts",
  clips: "reels",
  reels: "reels",
  followers: "followers",
  "followers-all": "followers",
  following: "followers",
  "following-all": "followers",
  stories: "stories",
  highlights: "highlights",
  likers: "likers",
  comments: "comments",
};

export function normalizeEndpoint(label: string): BudgetEndpoint | null {
  if (typeof label !== "string" || label.length === 0) return null;
  const head = label.split(":", 1)[0]!.trim().toLowerCase();
  if (head.length === 0) return null;
  const mapped = ENDPOINT_SYNONYMS[head];
  return mapped ?? null;
}

// ─── Atomic check-and-increment ─────────────────────────────────────────────

export interface BudgetCheckResult {
  readonly allowed: boolean;
  readonly used: number;
  readonly cap: number;
  readonly endpoint: BudgetEndpoint | null;
}

/** UTC date in YYYY-MM-DD form, the natural-key shape for the day column. */
function utcDayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

type DbLike = typeof defaultDb;

/**
 * Atomically reserve one unit of budget for the bot+endpoint for today.
 *
 * On success returns { allowed: true, used: postIncrementCount, cap }. When
 * the cap would be exceeded returns { allowed: false, used: cap, cap } with
 * NO mutation to the row.
 *
 * Implementation: a single INSERT ... ON CONFLICT ... DO UPDATE WHERE
 * count < cap RETURNING count. Postgres holds the row lock for the duration
 * of the statement so concurrent callers serialize on the PK. If the WHERE
 * predicate fails the update is skipped and 0 rows are returned — that's our
 * "cap exceeded" signal.
 *
 * Endpoints we don't budget (login, unknown) return allowed=true with cap=∞
 * so callers can use this as the single gate without special-casing.
 */
export async function checkAndIncrementBudget(
  botId: string,
  endpointLabel: string,
  now: Date = new Date(),
  db: DbLike = defaultDb,
): Promise<BudgetCheckResult> {
  const endpoint = normalizeEndpoint(endpointLabel);
  if (endpoint === null) {
    // Not a budgeted endpoint (e.g. "login"). Always allow.
    return { allowed: true, used: 0, cap: UNLIMITED, endpoint: null };
  }

  // Look up the bot's age to compute today's cap. We do this in the same
  // call rather than caching because the cap can change midnight-to-midnight
  // (age tier rollover) and the cost is a single PK lookup.
  const [botRow] = await db
    .select({
      createdAt: botAccounts.createdAt,
      transport: botAccounts.transport,
    })
    .from(botAccounts)
    .where(eq(botAccounts.id, botId))
    .limit(1);
  if (!botRow) {
    throw new Error(`[daily-budget] bot ${botId} not found`);
  }

  const cap = endpointDailyCap(
    botRow.createdAt,
    endpoint,
    now,
    botRow.transport === "mobile" ? "mobile" : "web",
  );
  const day = utcDayKey(now);

  if (cap <= 0) {
    // Hard zero (e.g. day-0 stories) — short-circuit before touching the
    // table so we don't dirty an unused row.
    return { allowed: false, used: 0, cap: 0, endpoint };
  }

  // Atomic upsert. Drizzle's onConflictDoUpdate doesn't yet take a `where`
  // clause that gates the UPDATE side, so we drop to raw SQL. The query
  // returns the post-increment count when the update fired, or zero rows
  // when the cap-gate prevented it.
  const result = await db.execute<{ count: number }>(sql`
    INSERT INTO bot_daily_calls (bot_id, day, endpoint, count)
    VALUES (${botId}, ${day}::date, ${endpoint}, 1)
    ON CONFLICT (bot_id, day, endpoint)
    DO UPDATE SET count = bot_daily_calls.count + 1
    WHERE bot_daily_calls.count < ${cap}
    RETURNING count
  `);

  // pg driver returns { rows: [...] }; node-postgres + drizzle/node-postgres
  // both expose .rows. Defensive access for either shape.
  const rows: Array<{ count: number }> = Array.isArray(result)
    ? (result as Array<{ count: number }>)
    : ((result as { rows?: Array<{ count: number }> }).rows ?? []);

  if (rows.length === 0) {
    // Cap was hit — no insert (PK collision) AND no update (count >= cap).
    return { allowed: false, used: cap, cap, endpoint };
  }
  const newCount = Number(rows[0]!.count);
  return { allowed: true, used: newCount, cap, endpoint };
}

/**
 * Same as checkAndIncrementBudget but throws IGDailyCapExceededError when
 * the cap is hit so callers in the scrape-retry path can rely on the
 * existing IGDailyCapExceededError handling.
 */
export async function reserveOrThrow(
  botId: string,
  endpointLabel: string,
  now: Date = new Date(),
  db: DbLike = defaultDb,
): Promise<BudgetCheckResult> {
  const result = await checkAndIncrementBudget(botId, endpointLabel, now, db);
  if (!result.allowed) {
    // Reuse the existing daily-cap error so retry/cooldown layers don't need
    // to learn a new error type. We piggyback on the "follows" action label
    // because that's the closest semantic in caps.ts; the message carries
    // the real endpoint and budget numbers for ops.
    const err = new IGDailyCapExceededError(
      "follows",
      new Date(Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() + 1,
      )),
    );
    (err as unknown as { budgetEndpoint: string }).budgetEndpoint =
      result.endpoint ?? "unknown";
    (err as unknown as { used: number }).used = result.used;
    (err as unknown as { cap: number }).cap = result.cap;
    err.message = `[daily-budget] bot ${botId} hit daily cap for ${result.endpoint} (used=${result.used}, cap=${result.cap})`;
    throw err;
  }
  return result;
}

// ─── Admin: snapshot + reset ───────────────────────────────────────────────

export interface BudgetStatusEntry {
  readonly endpoint: BudgetEndpoint;
  readonly used: number;
  readonly cap: number;
}

export interface BudgetStatus {
  readonly today: ReadonlyArray<BudgetStatusEntry>;
}

/**
 * Returns one entry per known endpoint with today's used count and the
 * age-aware cap. Endpoints with no row yet get used=0.
 */
export async function getBudgetStatus(
  botId: string,
  now: Date = new Date(),
  db: DbLike = defaultDb,
): Promise<BudgetStatus> {
  const [botRow] = await db
    .select({
      createdAt: botAccounts.createdAt,
      transport: botAccounts.transport,
    })
    .from(botAccounts)
    .where(eq(botAccounts.id, botId))
    .limit(1);
  if (!botRow) {
    throw new Error(`[daily-budget] bot ${botId} not found`);
  }
  const botTransport = botRow.transport === "mobile" ? "mobile" : "web";

  const day = utcDayKey(now);
  const rows = await db
    .select({
      endpoint: botDailyCalls.endpoint,
      count: botDailyCalls.count,
    })
    .from(botDailyCalls)
    .where(
      and(eq(botDailyCalls.botId, botId), eq(botDailyCalls.day, day)),
    );

  const usedByEndpoint = new Map<string, number>();
  for (const r of rows) {
    usedByEndpoint.set(r.endpoint, r.count);
  }

  const today: BudgetStatusEntry[] = BUDGET_ENDPOINTS.map((ep) => ({
    endpoint: ep,
    used: usedByEndpoint.get(ep) ?? 0,
    cap: endpointDailyCap(botRow.createdAt, ep, now, botTransport),
  }));

  return { today };
}

/**
 * Clears today's budget rows for one bot. Admin-only emergency override.
 * Returns the number of rows deleted.
 */
export async function resetTodayBudget(
  botId: string,
  now: Date = new Date(),
  db: DbLike = defaultDb,
): Promise<number> {
  const day = utcDayKey(now);
  const deleted = await db
    .delete(botDailyCalls)
    .where(
      and(eq(botDailyCalls.botId, botId), eq(botDailyCalls.day, day)),
    )
    .returning({ endpoint: botDailyCalls.endpoint });
  return deleted.length;
}
