// One-off: force an immediate profile collection for tracked accounts.
//
// Enqueues a `profile` job (force=true → bypasses the freshness gate) onto the
// same `collection-profile` queue the running app consumes, so the live worker
// fleet picks it up with the current bot pool. Use after a pool recovery to
// repopulate accounts without waiting for the refresh sweep.
//
//   npx tsx server/scripts/enqueue-refresh.ts <trackedAccountId> [<id> ...]
//   npx tsx server/scripts/enqueue-refresh.ts --all
//
// `--all` enqueues every ACTIVE tracked account collapsed to canonical twins:
// two rows tracking the same IG user share one roster and only the canonical
// (oldest active) row walks it — see services/tracked-account-twins.ts. Any
// other `-`-prefixed token is rejected up front: on 2026-09-02 `--all` was
// taken as an account id, a `manual_--all_…` job was queued and failed (C11b).
//
// NOTE: BullMQ v5 rejects ':' in custom job ids — use '_' separators.

import "dotenv/config";
import { pathToFileURL } from "node:url";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { asc, eq } from "drizzle-orm";

export const USAGE =
  "usage: enqueue-refresh <tracked_account_id> [<id> ...] | --all";

export type EnqueueRefreshArgs =
  | { readonly ok: true; readonly mode: "all" }
  | { readonly ok: true; readonly mode: "ids"; readonly ids: readonly string[] }
  | { readonly ok: false; readonly error: string };

/**
 * Pure argv parser. `--all` is the only flag; any other `-`-prefixed token is
 * an error (never an account id), and `--all` cannot be mixed with ids.
 * Duplicate ids collapse to one job.
 */
export function parseEnqueueRefreshArgs(
  argv: readonly string[],
): EnqueueRefreshArgs {
  const tokens = argv.map((t) => t.trim()).filter((t) => t.length > 0);
  const flags = tokens.filter((t) => t.startsWith("-"));
  const ids = tokens.filter((t) => !t.startsWith("-"));
  const unknown = flags.filter((f) => f !== "--all");
  if (unknown.length > 0) {
    return { ok: false, error: `unknown flag(s): ${unknown.join(", ")}. ${USAGE}` };
  }
  const all = flags.length > 0;
  if (all && ids.length > 0) {
    return { ok: false, error: `--all cannot be combined with account ids. ${USAGE}` };
  }
  if (all) return { ok: true, mode: "all" };
  if (ids.length === 0) return { ok: false, error: USAGE };
  return { ok: true, mode: "ids", ids: Array.from(new Set(ids)) };
}

/** Stable, ':'-free job id for a manual refresh. */
export function buildManualRefreshJobId(trackedAccountId: string, nowMs: number): string {
  return `manual_${trackedAccountId}_${nowMs}`;
}

/**
 * Every active tracked account, one job per IG user (canonical twin only).
 * Imported lazily so the pure parser above stays importable without a DB.
 */
async function loadCanonicalActiveIds(): Promise<readonly string[]> {
  const [{ db, pool }, { trackedAccounts }, { canonicalTwinId }, { collapseToCanonical }] =
    await Promise.all([
      import("../db.js"),
      import("../../shared/schema.js"),
      import("../services/tracked-account-twins.js"),
      import("../workers/likes-sweeper.js"),
    ]);
  try {
    const rows = await db
      .select({ id: trackedAccounts.id })
      .from(trackedAccounts)
      .where(eq(trackedAccounts.isActive, true))
      .orderBy(asc(trackedAccounts.trackingStarted), asc(trackedAccounts.id));
    const ids = rows.map((r) => r.id);
    // canonicalTwinId fails open (returns the id itself on error), so a lookup
    // failure can never drop an account from the batch.
    const entries = await Promise.all(
      ids.map(async (id): Promise<readonly [string, string]> => [id, await canonicalTwinId(id)]),
    );
    return collapseToCanonical(ids, new Map(entries));
  } finally {
    await pool.end().catch(() => undefined);
  }
}

async function resolveTargetIds(args: EnqueueRefreshArgs & { ok: true }): Promise<readonly string[]> {
  if (args.mode === "ids") return args.ids;
  const ids = await loadCanonicalActiveIds();
  console.log(`[enqueue-refresh] --all → ${ids.length} active canonical account(s)`);
  return ids;
}

async function main(): Promise<void> {
  const args = parseEnqueueRefreshArgs(process.argv.slice(2));
  if (!args.ok) {
    console.error(args.error);
    process.exit(1);
  }
  const ids = await resolveTargetIds(args);
  if (ids.length === 0) {
    console.error("[enqueue-refresh] nothing to enqueue (no active tracked accounts)");
    process.exit(1);
  }

  const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379";
  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue("collection-profile", { connection });

  try {
    for (const id of ids) {
      const jobId = buildManualRefreshJobId(id, Date.now());
      await queue.add(
        "profile",
        { trackedAccountId: id, force: true, source: "manual-refresh" },
        { jobId, removeOnComplete: 100, removeOnFail: 50 },
      );
      console.log(`[enqueue-refresh] queued ${id} (jobId=${jobId})`);
    }
  } finally {
    await queue.close();
    await connection.quit();
  }
}

// Run only when executed directly (`npx tsx server/scripts/enqueue-refresh.ts`),
// not when the parser is imported by tests.
const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
