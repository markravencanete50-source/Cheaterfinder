import { customerAccessSql } from "./subscription-access.js";
// ─── Credential-free Tier-1 background refresh monitor ─────────────────────
//
// Keeps the safe public slice (profile counts/metadata and recent post
// previews) fresh even while authenticated BullMQ collection is paused.
// Every Instagram request is unauthenticated and crosses the loopback
// Firefox/pyhttpz automation boundary; this service never leases a bot and
// never reads or sends bot session_data.

import { and, eq, isNull, lt, or, sql } from "drizzle-orm";

import { db } from "../db.js";
import { trackedAccounts } from "../../shared/schema.js";
import {
  refreshPublicProfileTier1,
  type RevalidatableAccount,
  type Tier1RefreshOutcome,
} from "./public-read-client.js";
import { logger as baseLogger } from "../observability/logger.js";

const logger = baseLogger.child({ module: "tier1-refresh-monitor" });

function readBoundedInt(
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function monitorConfig(): Tier1RefreshSweepConfig & { intervalMs: number } {
  return {
    intervalMs:
      readBoundedInt("TIER1_REFRESH_MONITOR_INTERVAL_SEC", 1800, 300, 86_400) *
      1000,
    staleMs:
      readBoundedInt("TIER1_REFRESH_MONITOR_STALE_SEC", 1800, 900, 86_400) *
      1000,
    batchSize: readBoundedInt("TIER1_REFRESH_MONITOR_BATCH_SIZE", 20, 1, 50),
    gapMs: readBoundedInt("TIER1_REFRESH_MONITOR_GAP_MS", 10_000, 2_000, 60_000),
    maxConsecutiveFailures: readBoundedInt(
      "TIER1_REFRESH_MONITOR_MAX_FAILURES",
      3,
      1,
      10,
    ),
  };
}

export interface Tier1RefreshCandidate extends RevalidatableAccount {
  readonly lastProfileRefreshAt: Date | null;
}

export interface Tier1RefreshSweepConfig {
  readonly staleMs: number;
  readonly batchSize: number;
  readonly gapMs: number;
  readonly maxConsecutiveFailures: number;
}

export interface Tier1RefreshSweepResult {
  readonly considered: number;
  readonly refreshed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly stoppedEarly: boolean;
  readonly failureReasons: Readonly<Record<string, number>>;
}

interface Tier1RefreshSweepDeps {
  listCandidates(cutoff: Date, limit: number): Promise<Tier1RefreshCandidate[]>;
  refresh(account: RevalidatableAccount): Promise<Tier1RefreshOutcome>;
  delay(ms: number): Promise<void>;
  now(): number;
  random(): number;
  shouldStop(): boolean;
}

async function listCandidates(
  cutoff: Date,
  limit: number,
): Promise<Tier1RefreshCandidate[]> {
  return db
    .select({
      id: trackedAccounts.id,
      userId: trackedAccounts.userId,
      igUsername: trackedAccounts.igUsername,
      isActive: trackedAccounts.isActive,
      lastProfileRefreshAt: trackedAccounts.lastProfileRefreshAt,
    })
    .from(trackedAccounts)
    .where(
      and(
        eq(trackedAccounts.isActive, true),
        customerAccessSql(trackedAccounts.userId),
        or(
          isNull(trackedAccounts.lastProfileRefreshAt),
          lt(trackedAccounts.lastProfileRefreshAt, cutoff),
        ),
      ),
    )
    .orderBy(sql`${trackedAccounts.lastProfileRefreshAt} ASC NULLS FIRST`)
    .limit(limit);
}

let cancelPendingDelay: (() => void) | null = null;

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      if (cancelPendingDelay === finish) cancelPendingDelay = null;
      resolve();
    }
    cancelPendingDelay = finish;
  });
}

let stopping = false;

interface RetryBackoffEntry {
  readonly failures: number;
  readonly nextAttemptAt: number;
  readonly lastFailureAt: number;
}

const RETRY_BACKOFF_BASE_MS = 30 * 60 * 1000;
const RETRY_BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;
const RETRY_BACKOFF_MAX_ENTRIES = 1_000;
const retryBackoff = new Map<string, RetryBackoffEntry>();

function retryIsDue(accountId: string, now: number): boolean {
  return (retryBackoff.get(accountId)?.nextAttemptAt ?? 0) <= now;
}

function clearRetryBackoff(accountId: string): void {
  retryBackoff.delete(accountId);
}

function recordRetryFailure(accountId: string, now: number): number {
  const failures = (retryBackoff.get(accountId)?.failures ?? 0) + 1;
  const delayMs = Math.min(
    RETRY_BACKOFF_MAX_MS,
    RETRY_BACKOFF_BASE_MS * 2 ** Math.min(failures - 1, 10),
  );
  retryBackoff.set(accountId, {
    failures,
    nextAttemptAt: now + delayMs,
    lastFailureAt: now,
  });

  // Keep process memory bounded if the platform ever tracks a very large
  // number of accounts that later become inactive before their next attempt.
  while (retryBackoff.size > RETRY_BACKOFF_MAX_ENTRIES) {
    let oldestId: string | null = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [id, entry] of retryBackoff) {
      if (entry.lastFailureAt < oldestAt) {
        oldestAt = entry.lastFailureAt;
        oldestId = id;
      }
    }
    if (!oldestId) break;
    retryBackoff.delete(oldestId);
  }
  return delayMs;
}

const DEFAULT_DEPS: Tier1RefreshSweepDeps = {
  listCandidates,
  refresh: refreshPublicProfileTier1,
  delay,
  now: Date.now,
  random: Math.random,
  shouldStop: () => stopping,
};

export async function runTier1RefreshSweep(
  config: Tier1RefreshSweepConfig = monitorConfig(),
  deps: Partial<Tier1RefreshSweepDeps> = {},
): Promise<Tier1RefreshSweepResult> {
  const runtime = { ...DEFAULT_DEPS, ...deps };
  const cutoff = new Date(runtime.now() - config.staleMs);
  const candidates = await runtime.listCandidates(cutoff, config.batchSize);
  let refreshed = 0;
  let failed = 0;
  let skipped = 0;
  let consecutiveFailures = 0;
  let stoppedEarly = false;
  const failureReasons: Record<string, number> = {};

  for (let index = 0; index < candidates.length; index += 1) {
    if (runtime.shouldStop()) {
      stoppedEarly = true;
      break;
    }

    const account = candidates[index]!;
    if (!retryIsDue(account.id, runtime.now())) {
      skipped += 1;
      continue;
    }

    const outcome = await runtime.refresh(account);
    if (outcome.ok) {
      refreshed += 1;
      consecutiveFailures = 0;
      clearRetryBackoff(account.id);
    } else if (outcome.reason === "inactive" || outcome.reason === "in_flight") {
      skipped += 1;
    } else {
      failed += 1;
      consecutiveFailures += 1;
      failureReasons[outcome.reason] = (failureReasons[outcome.reason] ?? 0) + 1;
      recordRetryFailure(account.id, runtime.now());
      if (consecutiveFailures >= config.maxConsecutiveFailures) {
        stoppedEarly = index < candidates.length - 1;
        break;
      }
    }

    if (index < candidates.length - 1 && !runtime.shouldStop()) {
      // Small jitter avoids a perfectly periodic public endpoint signature.
      const jitter = Math.floor(config.gapMs * Math.max(0, runtime.random()));
      await runtime.delay(config.gapMs + jitter);
    }
  }

  return {
    considered: candidates.length,
    refreshed,
    failed,
    skipped,
    stoppedEarly,
    failureReasons,
  };
}

let interval: ReturnType<typeof setInterval> | null = null;
let activeSweep: Promise<void> | null = null;

function triggerSweep(config: ReturnType<typeof monitorConfig>): void {
  if (activeSweep) {
    logger.warn("credential-free refresh sweep still running; skipping overlap");
    return;
  }
  activeSweep = runTier1RefreshSweep(config)
    .then((result) => {
      logger.info(result, "credential-free Tier-1 refresh sweep complete");
    })
    .catch((err) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "credential-free Tier-1 refresh sweep failed",
      );
    })
    .finally(() => {
      activeSweep = null;
    });
}

export function startTier1RefreshMonitor(): void {
  if (process.env.TIER1_REFRESH_MONITOR_ENABLED === "false") {
    logger.info("credential-free Tier-1 refresh monitor disabled");
    return;
  }
  if (interval) return;
  stopping = false;
  const config = monitorConfig();
  triggerSweep(config);
  interval = setInterval(() => triggerSweep(config), config.intervalMs);
  interval.unref?.();
  logger.info(
    {
      intervalMs: config.intervalMs,
      staleMs: config.staleMs,
      batchSize: config.batchSize,
      gapMs: config.gapMs,
    },
    "credential-free Tier-1 refresh monitor started",
  );
}

export async function stopTier1RefreshMonitor(): Promise<void> {
  stopping = true;
  if (interval) clearInterval(interval);
  interval = null;
  cancelPendingDelay?.();
  await activeSweep;
}

export const __testing = {
  monitorConfig,
  retryIsDue,
  recordRetryFailure,
  resetRetryBackoff(): void {
    retryBackoff.clear();
  },
};
