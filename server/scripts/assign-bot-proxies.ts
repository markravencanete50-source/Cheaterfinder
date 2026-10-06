// ─── Assign dedicated sticky proxies to every bot in the pool ───────────────
//
// Wave 7: rotate-on-every-call proxy churn was an IG behavioral signal — the
// pool kept hopping IPs every 30 min even when a bot wasn't logged in. New
// design: each bot gets a provider sticky lane (`proxy_session_id`) for the
// provider's bounded session window. This is suitable only before login or
// during an explicit re-login; it is not a durable per-account proxy.
//
// Country stratification (60% US, 25% GB, 10% DE, 5% FR) is deterministic by
// bot order so reruns of this script produce the same distribution. That
// also makes the pool look like a believable mix of geographies rather than
// 100% US residentials.
//
// Sequential, 3 s gap between provider calls — Smartproxy throttles bursts.
//
// Run with:
//   npx tsx server/scripts/assign-bot-proxies.ts
//
// Env required:
//   DATABASE_URL plus either STATIC_PROXY_* or SMARTPROXY_API_URL
// ────────────────────────────────────────────────────────────────────────────

import "dotenv/config";
import { sql } from "drizzle-orm";
import { db } from "../db.js";
import {
  countryForBotIndex,
  getOrAssignBotProxy,
  isEndpointFresh,
  proxyEndpointLabel,
  type BotProxyState,
} from "../services/proxy-provider.js";
import { logger as baseLogger } from "../observability/logger.js";

const logger = baseLogger.child({ module: "assign-bot-proxies" });

const PROVIDER_GAP_MS = 3_000;

interface BotRow {
  id: string;
  ig_username: string;
  session_data: string | null;
  proxy_endpoint: string | null;
  proxy_session_id: string | null;
  proxy_expires_at: Date | null;
}

interface AssignmentOutcome {
  igUsername: string;
  country: string;
  ok: boolean;
  reason: string;
  /** "skip" when the bot already has a fresh sticky lane, "assigned" on success, "error" on failure. */
  action: "skip" | "assigned" | "error";
}

/** Sleep helper that respects an injected clock (test seam). */
async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Bot order is stable: by created_at, then ig_username as a tiebreaker. */
async function listBotsForAssignment(
  database: typeof db,
): Promise<readonly BotRow[]> {
  const result = (await database.execute(sql`
    SELECT id, ig_username, session_data,
           proxy_endpoint, proxy_session_id, proxy_expires_at
    FROM bot_accounts
    ORDER BY created_at ASC, ig_username ASC
  `)) as unknown as { rows: BotRow[] };
  return result.rows.map((row) => ({
    ...row,
    proxy_expires_at:
      row.proxy_expires_at == null
        ? null
        : row.proxy_expires_at instanceof Date
          ? row.proxy_expires_at
          : new Date(row.proxy_expires_at as unknown as string),
  }));
}

/** Persist the resolved proxy lane onto the bot row. */
async function persistAssignment(
  database: typeof db,
  botId: string,
  endpoint: string,
  sessionId: string,
  expiresAt: Date,
): Promise<void> {
  await database.execute(sql`
    UPDATE bot_accounts SET
      proxy_endpoint = ${endpoint},
      proxy_session_id = ${sessionId},
      proxy_expires_at = ${expiresAt.toISOString()},
      updated_at = NOW()
    WHERE id = ${botId}
  `);
}

interface AssignDeps {
  database: typeof db;
  /** Indirected so tests can mock without touching the network. */
  resolve: typeof getOrAssignBotProxy;
  /** Indirected so tests can run instantly. */
  delay: (ms: number) => Promise<void>;
}

const DEFAULT_DEPS: AssignDeps = {
  database: db,
  resolve: getOrAssignBotProxy,
  delay: sleep,
};

export interface AssignBotProxiesResult {
  outcomes: readonly AssignmentOutcome[];
  totals: {
    total: number;
    assigned: number;
    skipped: number;
    errored: number;
  };
}

/**
 * Walk every bot, ensuring each has a dedicated sticky lane. Skips bots that
 * already have a valid `proxy_session_id` within the sticky window — they
 * keep their existing lane (the whole point of "dedicated").
 *
 * Returns a structured result so callers (CLI, tests, ops dashboards) can
 * summarise the run without parsing logs.
 */
export async function assignBotProxies(
  deps: Partial<AssignDeps> = {},
): Promise<AssignBotProxiesResult> {
  const { database, resolve, delay } = { ...DEFAULT_DEPS, ...deps };

  const bots = await listBotsForAssignment(database);
  const outcomes: AssignmentOutcome[] = [];

  if (bots.length === 0) {
    logger.warn("[assign-bot-proxies] no bots in bot_accounts");
    return {
      outcomes,
      totals: { total: 0, assigned: 0, skipped: 0, errored: 0 },
    };
  }

  logger.info(
    { count: bots.length },
    "[assign-bot-proxies] starting sequential assignment",
  );

  for (let index = 0; index < bots.length; index += 1) {
    const bot = bots[index];
    const country = countryForBotIndex(index, bots.length);

    // Skip when the bot already holds a valid sticky lane: that *is* the
    // dedicated assignment. Re-fetching would defeat the purpose.
    if (
      bot.proxy_session_id &&
      bot.proxy_endpoint &&
      isEndpointFresh(bot.proxy_expires_at)
    ) {
      outcomes.push({
        igUsername: bot.ig_username,
        country,
        ok: true,
        action: "skip",
        reason: `already has sticky lane ${bot.proxy_session_id}`,
      });
      logger.info(
        {
          botId: bot.id,
          username: bot.ig_username,
          sessionId: bot.proxy_session_id,
        },
        "[assign-bot-proxies] skip — bot already has fresh sticky lane",
      );
      continue;
    }

    // Never transplant an authenticated cookie jar onto a replacement IP.
    // Operators must invalidate/re-authenticate the session after assigning a
    // durable per-account proxy instead of letting this provider script rotate
    // it invisibly.
    if (bot.session_data?.trim()) {
      const reason = "authenticated session has no fresh proxy lane; refusing IP rotation";
      outcomes.push({
        igUsername: bot.ig_username,
        country,
        ok: false,
        action: "error",
        reason,
      });
      logger.warn(
        { botId: bot.id, username: bot.ig_username },
        `[assign-bot-proxies] ${reason}`,
      );
      continue;
    }

    const state: BotProxyState = {
      proxyEndpoint: bot.proxy_endpoint,
      proxySessionId: bot.proxy_session_id,
      proxyExpiresAt: bot.proxy_expires_at,
    };

    try {
      const resolved = await resolve(state, { country });
      await persistAssignment(
        database,
        bot.id,
        resolved.endpoint.endpoint,
        resolved.endpoint.sessionId,
        resolved.endpoint.expiresAt,
      );
      outcomes.push({
        igUsername: bot.ig_username,
        country,
        ok: true,
        action: "assigned",
        reason: `lane=${resolved.endpoint.sessionId} via ${proxyEndpointLabel(resolved.endpoint.endpoint)}`,
      });
      logger.info(
        {
          botId: bot.id,
          username: bot.ig_username,
          country,
          endpoint: proxyEndpointLabel(resolved.endpoint.endpoint),
          sessionId: resolved.endpoint.sessionId,
        },
        "[assign-bot-proxies] assigned dedicated sticky lane",
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      outcomes.push({
        igUsername: bot.ig_username,
        country,
        ok: false,
        action: "error",
        reason: reason.slice(0, 200),
      });
      logger.warn(
        {
          botId: bot.id,
          username: bot.ig_username,
          country,
          err: reason,
        },
        "[assign-bot-proxies] assignment failed",
      );
    }

    // Provider-friendly pacing — Smartproxy throttles bursty calls. Skip
    // the gap after the very last bot.
    if (index < bots.length - 1) {
      await delay(PROVIDER_GAP_MS);
    }
  }

  const totals = {
    total: outcomes.length,
    assigned: outcomes.filter((o) => o.action === "assigned").length,
    skipped: outcomes.filter((o) => o.action === "skip").length,
    errored: outcomes.filter((o) => o.action === "error").length,
  };

  logger.info(totals, "[assign-bot-proxies] pass complete");
  return { outcomes, totals };
}

async function main(): Promise<void> {
  const result = await assignBotProxies();

  // Print a per-bot summary for the operator.
  for (const o of result.outcomes) {
    const tag = o.action === "assigned"
      ? "ASSIGNED"
      : o.action === "skip"
      ? "SKIP"
      : "ERROR";
    // eslint-disable-next-line no-console
    console.log(
      `[assign-bot-proxies] ${tag} @${o.igUsername} (${o.country}) — ${o.reason}`,
    );
  }
}

// Only invoke main() when this file is the entry point, not when imported by tests.
const isEntryPoint = (() => {
  try {
    const entry = process.argv[1] ?? "";
    return entry.endsWith("assign-bot-proxies.ts") ||
      entry.endsWith("assign-bot-proxies.js");
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
        "[assign-bot-proxies] FAILED",
      );
      process.exit(1);
    },
  );
}
