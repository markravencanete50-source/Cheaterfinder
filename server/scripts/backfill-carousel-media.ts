// ─── Backfill NULL carousel_media for older carousel posts ──────────────────
//
// Fix #7d (one-off, incremental, idempotent).
//
// PROBLEM
//   Carousel posts (IG media_type = 8) store their ordered children in
//   posts_cache.carousel_media (jsonb). The background collector only
//   feed-scrapes the most-recent ~12 posts, so older carousel rows that
//   predate the carousel feature landed with carousel_media = NULL. The
//   viewer modal then has no children to render for those posts.
//
//   This script re-scrapes each affected owner's feed deeply enough to cover
//   their NULL-carousel posts and re-persists them. The fixed persistPosts
//   (Fix #7b) now writes carousel children through and COALESCEs incoming
//   NULLs, so a deep feed scrape that DOES return children will fill the gap
//   without clobbering anything already populated.
//
// ⚠️  DEPENDS ON A HEALTHY BOT POOL.
//   Every owner re-scrape leases a bot via scrapeUserPosts(). If the pool is
//   degraded (no available bot, all in cooldown), the lease throws and this
//   script SKIPS that owner gracefully rather than crashing. Re-run it once
//   the pool recovers; already-filled rows are skipped on the next pass, so
//   repeated runs converge.
//
// SAFE TO RUN INCREMENTALLY
//   - Reads the current set of NULL-carousel posts on each run, so progress
//     from a prior (partial) run is naturally respected.
//   - Per-owner failures are isolated; one bad owner never aborts the batch.
//   - --dry-run reports what WOULD be scraped without leasing a bot.
//   - --limit caps the number of OWNERS processed in a single run.
//   - --depth overrides the per-owner feed scrape depth (default: derived).
//
// USAGE
//   npx tsx server/scripts/backfill-carousel-media.ts [--dry-run] [--limit=N] [--depth=N]
//
// ENV REQUIRED
//   DATABASE_URL  (and the usual bot-pool / proxy / session env for real runs)
// ────────────────────────────────────────────────────────────────────────────

import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db.js";
import { postsCache, trackedAccounts } from "../../shared/schema.js";
import { persistPosts } from "../services/public-data-persistence.js";
import { scrapeUserPosts, type IGPostSummary } from "../ig-public-scraper.js";
import { logger as baseLogger } from "../observability/logger.js";

const logger = baseLogger.child({ module: "backfill-carousel-media" });

// Hard ceiling on per-owner feed scrape depth so a single owner with hundreds
// of stale carousels can't make us page IG's feed unboundedly in one shot.
const MAX_SCRAPE_DEPTH = 200;
// Headroom over the NULL-carousel count: the feed is ordered newest-first and
// the missing carousels can be interleaved with non-carousel posts, so we must
// fetch deeper than the raw missing count to actually reach the oldest ones.
const DEPTH_HEADROOM = 12;

interface CliArgs {
  readonly dryRun: boolean;
  readonly limit: number | null;
  readonly depthOverride: number | null;
}

// A single IG owner (ig_user_id) plus every tracked_account row that points at
// it and currently holds at least one NULL-carousel carousel post. We persist
// per tracked_account because posts_cache is keyed by (tracked_account_id,
// shortcode) — two users tracking the same profile each have their own rows.
interface OwnerBackfillTarget {
  readonly igUserId: string;
  readonly trackedAccountIds: ReadonlyArray<string>;
  readonly usernames: ReadonlyArray<string>;
  readonly missingCount: number;
}

interface OwnerBackfillResult {
  readonly igUserId: string;
  readonly status: "filled" | "skipped_no_bot" | "skipped_no_children" | "error";
  readonly scraped: number;
  readonly persisted: number;
  readonly detail?: string;
}

function parseArgs(argv: ReadonlyArray<string>): CliArgs {
  let dryRun = false;
  let limit: number | null = null;
  let depthOverride: number | null = null;

  for (const arg of argv) {
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    const limitMatch = /^--limit=(\d+)$/.exec(arg);
    if (limitMatch) {
      const parsed = Number.parseInt(limitMatch[1], 10);
      if (Number.isFinite(parsed) && parsed > 0) limit = parsed;
      continue;
    }
    const depthMatch = /^--depth=(\d+)$/.exec(arg);
    if (depthMatch) {
      const parsed = Number.parseInt(depthMatch[1], 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        depthOverride = Math.min(parsed, MAX_SCRAPE_DEPTH);
      }
      continue;
    }
    logger.warn({ arg }, "[backfill] ignoring unrecognized argument");
  }

  return { dryRun, limit, depthOverride };
}

// Find carousel-type posts with NULL carousel_media, grouped by the owning IG
// user id. Rows whose tracked_account has no ig_user_id can't be re-scraped
// (the feed endpoint needs the numeric PK), so they're excluded here.
async function findOwnersNeedingBackfill(
  limit: number | null,
): Promise<ReadonlyArray<OwnerBackfillTarget>> {
  const rows = await db
    .select({
      igUserId: trackedAccounts.igUserId,
      trackedAccountId: postsCache.trackedAccountId,
      igUsername: trackedAccounts.igUsername,
    })
    .from(postsCache)
    .innerJoin(
      trackedAccounts,
      eq(postsCache.trackedAccountId, trackedAccounts.id),
    )
    .where(
      and(
        eq(postsCache.postType, "carousel"),
        isNull(postsCache.carouselMedia),
        sql`${trackedAccounts.igUserId} IS NOT NULL`,
      ),
    );

  // Fold the flat rows into one target per ig_user_id. Immutable accumulation:
  // build a fresh Map keyed by igUserId, never mutate prior target objects.
  const byOwner = new Map<
    string,
    {
      readonly igUserId: string;
      readonly trackedAccountIds: Set<string>;
      readonly usernames: Set<string>;
      missingCount: number;
    }
  >();

  for (const row of rows) {
    if (!row.igUserId) continue;
    const existing = byOwner.get(row.igUserId);
    if (existing) {
      existing.trackedAccountIds.add(row.trackedAccountId);
      existing.usernames.add(row.igUsername);
      existing.missingCount += 1;
    } else {
      byOwner.set(row.igUserId, {
        igUserId: row.igUserId,
        trackedAccountIds: new Set([row.trackedAccountId]),
        usernames: new Set([row.igUsername]),
        missingCount: 1,
      });
    }
  }

  const targets: OwnerBackfillTarget[] = [...byOwner.values()].map((o) => ({
    igUserId: o.igUserId,
    trackedAccountIds: [...o.trackedAccountIds],
    usernames: [...o.usernames],
    missingCount: o.missingCount,
  }));

  // Deterministic order (most-missing first) so partial runs chip away at the
  // biggest gaps first and --limit is reproducible across runs.
  const ordered = targets
    .slice()
    .sort((a, b) => b.missingCount - a.missingCount);

  return limit === null ? ordered : ordered.slice(0, limit);
}

function deriveDepth(missingCount: number, override: number | null): number {
  if (override !== null) return override;
  return Math.min(MAX_SCRAPE_DEPTH, missingCount + DEPTH_HEADROOM);
}

// True when an error is the bot-pool-degraded lease failure (so we skip the
// owner gracefully instead of treating it as a hard error). Matches the
// message scrapeUserPosts → withBot → leaseBot throws on an empty pool.
function isNoBotAvailable(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /no available bot/i.test(message);
}

async function backfillOwner(
  target: OwnerBackfillTarget,
  depth: number,
  dryRun: boolean,
): Promise<OwnerBackfillResult> {
  const base = {
    igUserId: target.igUserId,
    scraped: 0,
    persisted: 0,
  };

  if (dryRun) {
    logger.info(
      {
        igUserId: target.igUserId,
        usernames: target.usernames,
        missingCount: target.missingCount,
        plannedDepth: depth,
        trackedAccounts: target.trackedAccountIds.length,
      },
      "[backfill] (dry-run) would re-scrape feed and re-persist",
    );
    return { ...base, status: "filled", detail: "dry-run" };
  }

  let scraped: ReadonlyArray<IGPostSummary>;
  try {
    scraped = await scrapeUserPosts(target.igUserId, depth);
  } catch (err: unknown) {
    if (isNoBotAvailable(err)) {
      logger.warn(
        { igUserId: target.igUserId, usernames: target.usernames },
        "[backfill] no bot available — skipping owner (re-run when pool recovers)",
      );
      return { ...base, status: "skipped_no_bot" };
    }
    logger.error(
      {
        igUserId: target.igUserId,
        usernames: target.usernames,
        err: err instanceof Error ? err.message : String(err),
      },
      "[backfill] scrape failed for owner",
    );
    return {
      ...base,
      status: "error",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  // Only the carousel posts that actually came back WITH children can fill a
  // gap; a deep scrape that returns no carousel children for this owner is a
  // no-op (private account, deleted posts, or carousels beyond reach).
  const carouselsWithChildren = scraped.filter(
    (p) =>
      p.postType === "carousel" &&
      p.carouselMedia !== null &&
      p.carouselMedia.length > 0,
  );

  if (carouselsWithChildren.length === 0) {
    logger.info(
      {
        igUserId: target.igUserId,
        usernames: target.usernames,
        scraped: scraped.length,
        depth,
      },
      "[backfill] scrape returned no carousel children — nothing to fill",
    );
    return { ...base, status: "skipped_no_children", scraped: scraped.length };
  }

  // Re-persist the full scraped page for every tracked_account that points at
  // this owner. persistPosts (Fix #7b) writes children and COALESCEs NULLs, so
  // this fills the gaps without clobbering already-populated rows.
  let persisted = 0;
  for (const trackedAccountId of target.trackedAccountIds) {
    try {
      persisted += await persistPosts(trackedAccountId, scraped);
    } catch (err: unknown) {
      logger.error(
        {
          igUserId: target.igUserId,
          trackedAccountId,
          err: err instanceof Error ? err.message : String(err),
        },
        "[backfill] persist failed for tracked account",
      );
    }
  }

  logger.info(
    {
      igUserId: target.igUserId,
      usernames: target.usernames,
      scraped: scraped.length,
      carouselsWithChildren: carouselsWithChildren.length,
      persistedRows: persisted,
      trackedAccounts: target.trackedAccountIds.length,
    },
    "[backfill] re-persisted owner feed with carousel children",
  );

  return {
    ...base,
    status: "filled",
    scraped: scraped.length,
    persisted,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  logger.info(
    { dryRun: args.dryRun, limit: args.limit, depthOverride: args.depthOverride },
    "[backfill] starting carousel_media backfill",
  );

  const targets = await findOwnersNeedingBackfill(args.limit);

  if (targets.length === 0) {
    logger.info({}, "[backfill] no owners with NULL carousel_media — done");
    process.stdout.write(
      "[backfill-carousel-media] nothing to do (no NULL carousel_media carousel posts)\n",
    );
    return;
  }

  const totalMissing = targets.reduce((sum, t) => sum + t.missingCount, 0);
  logger.info(
    { owners: targets.length, totalMissing },
    "[backfill] owners needing backfill",
  );

  const results: OwnerBackfillResult[] = [];
  for (const target of targets) {
    const depth = deriveDepth(target.missingCount, args.depthOverride);
    // Per-owner isolation: backfillOwner already catches scrape/persist
    // failures, but wrap defensively so an unexpected throw can never abort
    // the remaining owners in the batch.
    try {
      results.push(await backfillOwner(target, depth, args.dryRun));
    } catch (err: unknown) {
      logger.error(
        {
          igUserId: target.igUserId,
          err: err instanceof Error ? err.message : String(err),
        },
        "[backfill] unexpected owner failure",
      );
      results.push({
        igUserId: target.igUserId,
        status: "error",
        scraped: 0,
        persisted: 0,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const tally = (status: OwnerBackfillResult["status"]): number =>
    results.filter((r) => r.status === status).length;

  const summary = {
    owners: results.length,
    filled: tally("filled"),
    skippedNoBot: tally("skipped_no_bot"),
    skippedNoChildren: tally("skipped_no_children"),
    errors: tally("error"),
    persistedRows: results.reduce((sum, r) => sum + r.persisted, 0),
  };

  logger.info(summary, "[backfill] done");
  process.stdout.write(
    `[backfill-carousel-media] owners=${summary.owners} ` +
      `filled=${summary.filled} skippedNoBot=${summary.skippedNoBot} ` +
      `skippedNoChildren=${summary.skippedNoChildren} errors=${summary.errors} ` +
      `persistedRows=${summary.persistedRows}` +
      (args.dryRun ? " (dry-run)" : "") +
      "\n",
  );
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "[backfill] fatal",
    );
    process.exit(1);
  });
