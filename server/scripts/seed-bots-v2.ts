// ─── Seed bot accounts (Pool v2) ────────────────────────────────────────────
//
// Wave 7+: idempotent loader for the v2 bot fixture at
// /tmp/ig-bots-v2/accounts.json. Replaces seed-bots.ts for the new 25-bot
// pool. Differences from v1:
//
//   * Two email providers: classic IMAP (onet.pl, rambler.ru, …) AND
//     tmailgg.site web inbox (no IMAP — tmailgg-fetcher polls the inbox URL).
//   * TOTP-based 2FA on tmailgg bots — `totp_secret` populated from the
//     fixture so server/services/totp.ts can issue codes during auto-login.
//   * Tier assignment is deterministic by fixture order so reruns are stable:
//       bots  1- 2 → canary  (smallest blast radius, take experimental traffic)
//       bots  3-10 → worker  (main pool, only after canary validates endpoint)
//       bots 11-25 → reserve (warmed but never picked until ops promotes)
//   * Idempotent UPSERT on `ig_username` so we can re-run after editing the
//     fixture (e.g. credential rotation) without duplicating rows.
//   * Does NOT delete stale bots — pool v2 coexists with any leftover v1
//     rows ops still wants to keep. Removal is an explicit, separate concern.
//
// Run with:
//   tsx server/scripts/seed-bots-v2.ts            # write to DB
//   tsx server/scripts/seed-bots-v2.ts --dry-run  # parse + log only
//
// Env required (live mode):
//   DATABASE_URL
//   BOT_CRED_KEY (or SESSION_DATA_KEY for dev)
// ────────────────────────────────────────────────────────────────────────────

import "dotenv/config";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db } from "../db.js";
import {
  encryptCredential,
  validateBotCredKey,
} from "../crypto/credentials.js";
import { imapHostFor } from "../services/imap-host.js";
import { logger as baseLogger } from "../observability/logger.js";

const logger = baseLogger.child({ module: "seed-bots-v2" });

// ─── Fixture types ───────────────────────────────────────────────────────────

interface FixtureBot {
  /** 1-indexed seat number from the fixture; drives tier assignment. */
  n: number;
  ig_username: string;
  ig_password: string;
  email: string;
  email_password: string | null;
  email_provider?: "imap" | "tmailgg_web";
  email_inbox_url?: string;
  totp_secret?: string;
  imap_host?: string;
  imap_port?: number;
  auth_method?: string;
}

interface Fixture {
  schema_version?: number;
  imap_host_default?: string;
  imap_port_default?: number;
  bots: FixtureBot[];
}

// ─── Tier strategy ───────────────────────────────────────────────────────────

export type Tier = "canary" | "worker" | "reserve";

const CANARY_THROUGH = 2; // bots 1..2
const WORKER_THROUGH = 10; // bots 3..10
// everything else (11..25 in this fixture) → reserve

/**
 * Deterministic tier assignment from the fixture seat number `n`.
 *
 * Exported so tests can pin the strategy without re-running the whole script.
 */
export function tierForSeat(n: number): Tier {
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`[seed-bots-v2] invalid seat number: ${n}`);
  }
  if (n <= CANARY_THROUGH) return "canary";
  if (n <= WORKER_THROUGH) return "worker";
  return "reserve";
}

// ─── Provider classification ─────────────────────────────────────────────────

/**
 * Resolve the IMAP host for a bot. tmailgg.site has no IMAP — return null so
 * the SQL INSERT writes NULL and the worker routes the bot to the
 * tmailgg-fetcher path instead of an IMAP poll.
 */
export function resolveImapHost(bot: FixtureBot): string | null {
  if (isTmailgg(bot)) return null;
  if (bot.imap_host && bot.imap_host.length > 0) return bot.imap_host;
  // Fall back to the central lookup (handles onet.pl, rambler.ru, gmail, …).
  return imapHostFor(bot.email);
}

export function resolveImapPort(bot: FixtureBot): number | null {
  if (isTmailgg(bot)) return null;
  if (typeof bot.imap_port === "number" && Number.isInteger(bot.imap_port)) {
    return bot.imap_port;
  }
  return 993;
}

function isTmailgg(bot: FixtureBot): boolean {
  if (bot.email_provider === "tmailgg_web") return true;
  return /@tmailgg\./i.test(bot.email);
}

// ─── Plan (in-memory representation of every row we'd write) ─────────────────

export interface SeedPlanRow {
  seat: number;
  igUsername: string;
  igPasswordEncrypted: string;
  emailAddress: string;
  emailPasswordEncrypted: string | null;
  imapHost: string | null;
  imapPort: number | null;
  totpSecret: string | null;
  emailProvider: "imap" | "tmailgg_web";
  tier: Tier;
}

export function buildSeedPlan(fixture: Fixture): readonly SeedPlanRow[] {
  if (!Array.isArray(fixture.bots) || fixture.bots.length === 0) {
    throw new Error("[seed-bots-v2] fixture has no bots");
  }
  const seenSeats = new Set<number>();
  const seenUsernames = new Set<string>();

  return fixture.bots.map((bot) => {
    if (seenSeats.has(bot.n)) {
      throw new Error(`[seed-bots-v2] duplicate seat number n=${bot.n}`);
    }
    seenSeats.add(bot.n);

    const lowerUser = bot.ig_username.toLowerCase();
    if (seenUsernames.has(lowerUser)) {
      throw new Error(
        `[seed-bots-v2] duplicate ig_username ${bot.ig_username}`,
      );
    }
    seenUsernames.add(lowerUser);

    if (!bot.ig_password || bot.ig_password.length === 0) {
      throw new Error(
        `[seed-bots-v2] bot n=${bot.n} (${bot.ig_username}) has empty ig_password`,
      );
    }

    const provider: "imap" | "tmailgg_web" = isTmailgg(bot)
      ? "tmailgg_web"
      : "imap";

    return {
      seat: bot.n,
      igUsername: bot.ig_username,
      igPasswordEncrypted: encryptCredential(bot.ig_password),
      emailAddress: bot.email,
      emailPasswordEncrypted:
        bot.email_password && bot.email_password.length > 0
          ? encryptCredential(bot.email_password)
          : null,
      imapHost: resolveImapHost(bot),
      imapPort: resolveImapPort(bot),
      totpSecret: bot.totp_secret ?? null,
      emailProvider: provider,
      tier: tierForSeat(bot.n),
    };
  });
}

// ─── DB write ────────────────────────────────────────────────────────────────

interface SeedDeps {
  database: { execute: typeof db.execute };
}

const DEFAULT_DEPS: SeedDeps = { database: db };

/**
 * Upsert every planned row into bot_accounts. ON CONFLICT updates the
 * encrypted credentials, IMAP routing, TOTP secret, and tier so re-running
 * after credential rotation is safe.
 *
 * Note on schema: this seed deliberately does NOT write `email_provider` or
 * `email_inbox_url` columns — those are pending migrations from the
 * tmailgg-fetcher agent. The plan still computes them so the dry-run output
 * shows the intended provider routing for ops review.
 */
export async function applySeedPlan(
  plan: readonly SeedPlanRow[],
  deps: Partial<SeedDeps> = {},
): Promise<{ upserted: number }> {
  const { database } = { ...DEFAULT_DEPS, ...deps };

  for (const row of plan) {
    await database.execute(sql`
      INSERT INTO bot_accounts (
        ig_username,
        session_data,
        ig_password_encrypted,
        email_address,
        email_password_encrypted,
        imap_host,
        imap_port,
        totp_secret,
        tier,
        proxy_endpoint,
        proxy_session_id,
        proxy_expires_at,
        status,
        created_at,
        updated_at
      ) VALUES (
        ${row.igUsername},
        NULL,
        ${row.igPasswordEncrypted},
        ${row.emailAddress},
        ${row.emailPasswordEncrypted},
        ${row.imapHost},
        ${row.imapPort},
        ${row.totpSecret},
        ${row.tier}::bot_tier,
        NULL,
        NULL,
        NULL,
        'available',
        NOW(),
        NOW()
      )
      ON CONFLICT (ig_username) DO UPDATE SET
        ig_password_encrypted = EXCLUDED.ig_password_encrypted,
        email_address = EXCLUDED.email_address,
        email_password_encrypted = EXCLUDED.email_password_encrypted,
        imap_host = EXCLUDED.imap_host,
        imap_port = EXCLUDED.imap_port,
        totp_secret = EXCLUDED.totp_secret,
        tier = EXCLUDED.tier,
        updated_at = NOW()
    `);
    logger.info(
      {
        seat: row.seat,
        username: row.igUsername,
        tier: row.tier,
        provider: row.emailProvider,
      },
      "[seed-bots-v2] upserted bot",
    );
  }

  return { upserted: plan.length };
}

// ─── Fixture loader ──────────────────────────────────────────────────────────

const DEFAULT_FIXTURE_PATH = "/tmp/ig-bots-v2/accounts.json";

export function loadFixture(path: string = DEFAULT_FIXTURE_PATH): Fixture {
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as Fixture;
  if (!parsed || !Array.isArray(parsed.bots)) {
    throw new Error(`[seed-bots-v2] malformed fixture at ${path}`);
  }
  return parsed;
}

// ─── Tier-breakdown summariser (for dry-run + ops dashboards) ────────────────

export interface TierBreakdown {
  canary: number;
  worker: number;
  reserve: number;
  total: number;
  byProvider: Record<"imap" | "tmailgg_web", number>;
}

export function summariseTiers(
  plan: readonly SeedPlanRow[],
): TierBreakdown {
  const counts: TierBreakdown = {
    canary: 0,
    worker: 0,
    reserve: 0,
    total: plan.length,
    byProvider: { imap: 0, tmailgg_web: 0 },
  };
  for (const row of plan) {
    counts[row.tier] += 1;
    counts.byProvider[row.emailProvider] += 1;
  }
  return counts;
}

// ─── CLI entry point ─────────────────────────────────────────────────────────

interface CliOptions {
  dryRun: boolean;
  fixturePath: string;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const dryRun = argv.includes("--dry-run");
  const pathFlag = argv.findIndex((a) => a === "--fixture");
  const fixturePath =
    pathFlag >= 0 && argv[pathFlag + 1]
      ? argv[pathFlag + 1]
      : process.env.BOT_FIXTURE_PATH ?? DEFAULT_FIXTURE_PATH;
  return { dryRun, fixturePath };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const fixture = loadFixture(opts.fixturePath);

  // Encryption requires the key in both modes (dry-run still proves the
  // ciphertext envelope is well-formed before the real run).
  validateBotCredKey();

  const plan = buildSeedPlan(fixture);
  const breakdown = summariseTiers(plan);

  // Per-bot dry-run preview, redacted to first 24 chars of ciphertext.
  for (const row of plan) {
    const ctPreview = `${row.igPasswordEncrypted.slice(0, 24)}…`;
    // eslint-disable-next-line no-console
    console.log(
      `[seed-bots-v2] seat=${row.seat.toString().padStart(2, "0")} ` +
        `tier=${row.tier.padEnd(7)} provider=${row.emailProvider.padEnd(11)} ` +
        `@${row.igUsername} ig_pw=${ctPreview} ` +
        `imap=${row.imapHost ?? "NULL"}:${row.imapPort ?? "NULL"} ` +
        `totp=${row.totpSecret ? "yes" : "no"}`,
    );
  }

  // eslint-disable-next-line no-console
  console.log(
    `[seed-bots-v2] tier breakdown: ` +
      `canary=${breakdown.canary} worker=${breakdown.worker} ` +
      `reserve=${breakdown.reserve} total=${breakdown.total} ` +
      `(imap=${breakdown.byProvider.imap}, tmailgg_web=${breakdown.byProvider.tmailgg_web})`,
  );

  if (opts.dryRun) {
    logger.info(breakdown, "[seed-bots-v2] dry-run complete — no DB writes");
    return;
  }

  const result = await applySeedPlan(plan);
  logger.info(
    { ...breakdown, upserted: result.upserted },
    "[seed-bots-v2] seed complete",
  );
}

const isEntryPoint = (() => {
  try {
    const entry = process.argv[1] ?? "";
    return (
      entry.endsWith("seed-bots-v2.ts") || entry.endsWith("seed-bots-v2.js")
    );
  } catch {
    return false;
  }
})();

if (isEntryPoint) {
  main().then(
    () => process.exit(0),
    (err) => {
      logger.error(
        { err: err instanceof Error ? err.message : err },
        "[seed-bots-v2] FAILED",
      );
      process.exit(1);
    },
  );
}
