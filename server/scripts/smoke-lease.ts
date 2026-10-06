// smoke-lease.ts — the post-deploy check CLAUDE.md lesson 22 demands for the
// lease/scrape path. Read-only: no bot row is touched, nothing is enqueued.
//
// What it does, in order:
//   1. For every production lease label (PRODUCTION_LEASE_LABELS) it builds the
//      EXACT candidate query `leaseBot` runs — the shared
//      buildLeaseCandidateQuery() in ig-public-scraper.ts, no copy — prints
//      `.toSQL().sql` + params, runs EXPLAIN through the live DB, then runs the
//      SELECT itself and prints the candidate (id / username / transport /
//      role) or "no candidate". The SELECT carries FOR UPDATE SKIP LOCKED like
//      the runtime; in autocommit the row lock is released at statement end.
//   2. Polls scrape_outcome_log for rows newer than the max id seen at start,
//      for up to --poll-sec seconds (default 120, 0 = skip), and prints counts
//      by endpoint and outcome.
//
// Exit codes: 0 ok · 1 a query failed to build / EXPLAIN / SELECT (a lesson-22
// regression — do NOT keep the deploy) · 2 the poll window closed with zero
// new outcome rows (collection is not flowing).
//
// Usage — the query's budget bounds come from the same env knobs the app
// reads, so take them from the RUNNING process, never from memory:
//
//   while IFS= read -r -d '' kv; do case "$kv" in
//     DATABASE_URL=*|REDIS_URL=*|LIKERS_DAILY_CAP=*|DAILY_CAP_MULTIPLIER=*|MOBILE_DAILY_CAP=*|BOT_AGE_FLOOR_DAYS=*|MOBILE_ROSTER_ENABLED=*|BOT_IMPORT_GRACE_HOURS=*|LIKERS_IMPORT_DAY_CAP=*|BOT_AUTO_LOGIN_ENABLED=*) export "$kv";;
//   esac; done < /proc/$(pgrep -f '^node dist/index.cjs' | head -1)/environ
//
//   npx tsx server/scripts/smoke-lease.ts                 # queries + 120 s poll
//   npx tsx server/scripts/smoke-lease.ts --poll-sec 0    # queries only
//   npx tsx server/scripts/smoke-lease.ts --poll-sec 300 --poll-interval-sec 15
//
// Pair it with `grep -c "Failed query" <pm2 error log>` after a boot: the two
// together are what "deployed" means for this path.

import "dotenv/config";

import { normalizeEndpoint } from "../behavior/daily-budget.js";
import { db, pool } from "../db.js";
import {
  PRODUCTION_LEASE_LABELS,
  buildLeaseCandidateQuery,
  maxEndpointDailyCap,
} from "../ig-public-scraper.js";

const DEFAULT_POLL_SEC = 120;
const DEFAULT_POLL_INTERVAL_SEC = 10;
const EXIT_QUERY_FAILED = 1;
const EXIT_NO_OUTCOMES = 2;

interface CliOptions {
  readonly pollSec: number;
  readonly pollIntervalSec: number;
}

interface CandidateRow {
  readonly id: string;
  readonly ig_username: string;
  readonly transport: string | null;
  readonly role: string;
  readonly tier: string;
}

interface OutcomeCount {
  readonly endpoint: string;
  readonly outcome: string;
  readonly n: number;
}

function parseIntArg(argv: ReadonlyArray<string>, flag: string, fallback: number): number {
  const idx = argv.indexOf(flag);
  if (idx === -1) return fallback;
  const raw = argv[idx + 1];
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${flag} expects a non-negative number, got ${JSON.stringify(raw)}`);
  }
  return Math.trunc(n);
}

function parseArgs(argv: ReadonlyArray<string>): CliOptions {
  return {
    pollSec: parseIntArg(argv, "--poll-sec", DEFAULT_POLL_SEC),
    pollIntervalSec: Math.max(1, parseIntArg(argv, "--poll-interval-sec", DEFAULT_POLL_INTERVAL_SEC)),
  };
}

function describeBounds(label: string, now: Date): string {
  const endpoint = normalizeEndpoint(label);
  if (endpoint === null) return "budget gate: none (label not budgeted)";
  const web = maxEndpointDailyCap(endpoint, now, "web");
  const mobile = maxEndpointDailyCap(endpoint, now, "mobile");
  return `budget gate: endpoint=${endpoint} day=${now.toISOString().slice(0, 10)} bound web>=${web} mobile>=${mobile}`;
}

/** Build → print SQL → EXPLAIN → SELECT for one label. Throws on any failure. */
async function checkLabel(label: (typeof PRODUCTION_LEASE_LABELS)[number], now: Date): Promise<void> {
  console.log(`\n=== lease label: ${label} ===`);
  console.log(describeBounds(label, now));

  const query = buildLeaseCandidateQuery(db, { label, now });
  const { sql, params } = query.toSQL();
  console.log("--- sql ---");
  console.log(sql);
  console.log("--- params ---");
  console.log(JSON.stringify(params));

  const explain = await pool.query<{ "QUERY PLAN": string }>(`EXPLAIN ${sql}`, params);
  console.log("--- explain ---");
  for (const row of explain.rows) console.log(row["QUERY PLAN"]);

  const selected = await pool.query<CandidateRow>(sql, params);
  const candidate = selected.rows[0];
  console.log(
    candidate
      ? `--- select ok: candidate ${candidate.id} @${candidate.ig_username} transport=${candidate.transport ?? "web"} role=${candidate.role} tier=${candidate.tier}`
      : "--- select ok: no candidate (pool empty for this label right now)",
  );
}

async function currentMaxOutcomeId(): Promise<string> {
  const res = await pool.query<{ max_id: string }>(
    "SELECT COALESCE(max(id), 0)::text AS max_id FROM scrape_outcome_log",
  );
  return res.rows[0]?.max_id ?? "0";
}

async function outcomesSince(maxId: string): Promise<ReadonlyArray<OutcomeCount>> {
  const res = await pool.query<OutcomeCount>(
    `SELECT endpoint, outcome, count(*)::int AS n
       FROM scrape_outcome_log
      WHERE id > $1::bigint
      GROUP BY 1, 2
      ORDER BY 1, 2`,
    [maxId],
  );
  return res.rows;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printOutcomes(rows: ReadonlyArray<OutcomeCount>, elapsedSec: number): number {
  const total = rows.reduce((acc, r) => acc + r.n, 0);
  console.log(`[poll +${elapsedSec}s] new scrape_outcome_log rows: ${total}`);
  for (const r of rows) console.log(`  ${r.endpoint.padEnd(11)} ${r.outcome.padEnd(8)} ${r.n}`);
  return total;
}

/** Returns the total number of new outcome rows seen inside the poll window. */
async function pollOutcomes(opts: CliOptions): Promise<number> {
  const startMaxId = await currentMaxOutcomeId();
  console.log(`\n=== polling scrape_outcome_log for ${opts.pollSec}s (id > ${startMaxId}) ===`);
  const startedAt = Date.now();
  let total = 0;
  while (Date.now() - startedAt < opts.pollSec * 1000) {
    await sleep(opts.pollIntervalSec * 1000);
    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
    total = printOutcomes(await outcomesSince(startMaxId), elapsedSec);
  }
  return total;
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  const now = new Date();
  console.log(`smoke-lease: ${PRODUCTION_LEASE_LABELS.length} labels, poll ${opts.pollSec}s, now=${now.toISOString()}`);

  for (const label of PRODUCTION_LEASE_LABELS) {
    try {
      await checkLabel(label, now);
    } catch (err) {
      console.error(`\n!!! lease query FAILED for label "${label}":`);
      console.error(err instanceof Error ? err.stack ?? err.message : String(err));
      return EXIT_QUERY_FAILED;
    }
  }
  console.log(`\nall ${PRODUCTION_LEASE_LABELS.length} lease queries: EXPLAIN ok, SELECT ok`);

  if (opts.pollSec === 0) return 0;
  const total = await pollOutcomes(opts);
  if (total === 0) {
    console.error(`\n!!! no new scrape_outcome_log rows in ${opts.pollSec}s — collection is not flowing`);
    return EXIT_NO_OUTCOMES;
  }
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error("smoke-lease: unexpected failure");
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exitCode = EXIT_QUERY_FAILED;
  })
  .finally(async () => {
    await pool.end().catch(() => { process.exitCode = EXIT_QUERY_FAILED; });
    // Query-only diagnostic: imported app singletons must not keep an
    // otherwise-completed check alive indefinitely.
    process.exit(Number(process.exitCode ?? 0));
  });
