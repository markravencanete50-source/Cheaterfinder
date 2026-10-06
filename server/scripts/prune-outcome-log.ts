// Prune `scrape_outcome_log` and report its index bloat (audit 2026-09-02, D10).
//
// The table is append-only telemetry (scrape-metrics.ts persistOutcome; the
// 24h admin panel hydrates from it at boot). Nothing else reads rows older
// than a day, yet on 2026-09-03 the heap was 30 MB and the four indexes 314 MB
// for ~51k live rows — bloat that fills the disk that media-cache already
// competes for. Deletes run in small batches by `occurred_at` so autovacuum
// keeps up; the REINDEX statements that actually reclaim the index space are
// PRINTED for the operator, never executed here (each takes a lock window and
// transient disk ≈ the index size — run them one at a time, off-peak).
//
//   npx tsx server/scripts/prune-outcome-log.ts [--keep-days=30] [--batch=5000] [--dry-run]
//
// --dry-run reports counts/sizes and prints the statements without deleting.

import "dotenv/config";
import { sql } from "drizzle-orm";
import { db, pool } from "../db.js";

const TABLE = "scrape_outcome_log";
const DEFAULT_KEEP_DAYS = 30;
// scrape-metrics.ts hydrates the last 24h at boot; never prune inside that.
const MIN_KEEP_DAYS = 2;
const DEFAULT_BATCH = 5_000;
const MIN_BATCH = 100;
const MAX_BATCH = 50_000;
const BATCH_PAUSE_MS = 200;

interface Options {
  readonly keepDays: number;
  readonly batch: number;
  readonly dryRun: boolean;
}

interface TableStats {
  readonly rows: number;
  readonly oldest: string | null;
  readonly newest: string | null;
  readonly heapBytes: number;
  readonly totalBytes: number;
  readonly deadTuples: number;
}

interface IndexStats {
  readonly indexname: string;
  readonly sizeBytes: number;
  readonly idxScan: number;
  readonly indexdef: string;
}

const KNOWN_FLAGS = new Set(["--keep-days", "--batch", "--dry-run", "--help", "-h"]);

function usage(): string {
  return `usage: npx tsx server/scripts/prune-outcome-log.ts [--keep-days=${DEFAULT_KEEP_DAYS}] [--batch=${DEFAULT_BATCH}] [--dry-run]`;
}

function readNumberFlag(argv: ReadonlyArray<string>, name: string, fallback: number): number {
  const inline = argv.find((a) => a.startsWith(`${name}=`));
  if (inline) return Number(inline.slice(name.length + 1));
  const idx = argv.indexOf(name);
  if (idx >= 0 && idx + 1 < argv.length) return Number(argv[idx + 1]);
  return fallback;
}

function parseOptions(argv: ReadonlyArray<string>): Options {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("-")) continue; // value of a `--flag value` pair
    const name = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (!KNOWN_FLAGS.has(name)) throw new Error(`unknown flag ${arg}\n${usage()}`);
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    process.exit(0);
  }
  const keepDays = readNumberFlag(argv, "--keep-days", DEFAULT_KEEP_DAYS);
  const batch = readNumberFlag(argv, "--batch", DEFAULT_BATCH);
  if (!Number.isInteger(keepDays) || keepDays < MIN_KEEP_DAYS) {
    throw new Error(`--keep-days must be an integer >= ${MIN_KEEP_DAYS} (got ${keepDays})`);
  }
  if (!Number.isInteger(batch) || batch < MIN_BATCH || batch > MAX_BATCH) {
    throw new Error(`--batch must be an integer in [${MIN_BATCH}, ${MAX_BATCH}] (got ${batch})`);
  }
  return { keepDays, batch, dryRun: argv.includes("--dry-run") };
}

async function query<T>(q: ReturnType<typeof sql>): Promise<{ rows: T[]; rowCount: number }> {
  const result = (await db.execute(q)) as unknown as { rows?: T[]; rowCount?: number | null };
  return { rows: result.rows ?? [], rowCount: result.rowCount ?? 0 };
}

function fmtBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} kB`;
  return `${bytes} B`;
}

async function loadTableStats(): Promise<TableStats> {
  const { rows } = await query<{
    rows: string;
    oldest: string | null;
    newest: string | null;
    heap_bytes: string;
    total_bytes: string;
    dead_tuples: string | null;
  }>(sql`
    SELECT COUNT(*)::bigint AS rows,
           MIN(occurred_at)::text AS oldest,
           MAX(occurred_at)::text AS newest,
           pg_relation_size(${TABLE}::regclass) AS heap_bytes,
           pg_total_relation_size(${TABLE}::regclass) AS total_bytes,
           (SELECT n_dead_tup FROM pg_stat_user_tables WHERE relname = ${TABLE}) AS dead_tuples
      FROM scrape_outcome_log
  `);
  const r = rows[0];
  if (!r) throw new Error(`no stats row for ${TABLE}`);
  return {
    rows: Number(r.rows),
    oldest: r.oldest,
    newest: r.newest,
    heapBytes: Number(r.heap_bytes),
    totalBytes: Number(r.total_bytes),
    deadTuples: Number(r.dead_tuples ?? 0),
  };
}

async function loadIndexStats(): Promise<ReadonlyArray<IndexStats>> {
  const { rows } = await query<{
    indexname: string;
    size_bytes: string;
    idx_scan: string;
    indexdef: string;
  }>(sql`
    SELECT i.indexrelname AS indexname,
           pg_relation_size(i.indexrelid) AS size_bytes,
           i.idx_scan,
           pi.indexdef
      FROM pg_stat_user_indexes i
      JOIN pg_indexes pi
        ON pi.schemaname = i.schemaname AND pi.indexname = i.indexrelname
     WHERE i.relname = ${TABLE}
     ORDER BY pg_relation_size(i.indexrelid) DESC, i.indexrelname ASC
  `);
  return rows.map((r) => ({
    indexname: r.indexname,
    sizeBytes: Number(r.size_bytes),
    idxScan: Number(r.idx_scan),
    indexdef: r.indexdef,
  }));
}

/** Cutoff from the DB clock, fixed once so every batch prunes the same set. */
async function resolveCutoff(keepDays: number): Promise<string> {
  const { rows } = await query<{ cutoff: string }>(sql`
    SELECT (NOW() - make_interval(days => ${keepDays}::int))::text AS cutoff
  `);
  const cutoff = rows[0]?.cutoff;
  if (!cutoff) throw new Error("could not resolve prune cutoff");
  return cutoff;
}

async function countOlderThan(cutoff: string): Promise<number> {
  const { rows } = await query<{ n: string }>(sql`
    SELECT COUNT(*)::bigint AS n FROM scrape_outcome_log WHERE occurred_at < ${cutoff}::timestamptz
  `);
  return Number(rows[0]?.n ?? 0);
}

async function deleteBatch(cutoff: string, batch: number): Promise<number> {
  const { rowCount } = await query(sql`
    DELETE FROM scrape_outcome_log
     WHERE id IN (
       SELECT id FROM scrape_outcome_log
        WHERE occurred_at < ${cutoff}::timestamptz
        ORDER BY occurred_at ASC
        LIMIT ${batch}
     )
  `);
  return rowCount;
}

async function pruneInBatches(cutoff: string, batch: number, expected: number): Promise<number> {
  let deleted = 0;
  let round = 0;
  while (true) {
    const n = await deleteBatch(cutoff, batch);
    deleted += n;
    round += 1;
    console.log(`[prune] batch ${round}: deleted ${n} (total ${deleted}/${expected})`);
    if (n < batch) break;
    await new Promise((resolve) => setTimeout(resolve, BATCH_PAUSE_MS));
  }
  return deleted;
}

function printReport(stats: TableStats, indexes: ReadonlyArray<IndexStats>): void {
  console.log(`[prune] ${TABLE}: rows=${stats.rows} oldest=${stats.oldest ?? "-"} newest=${stats.newest ?? "-"}`);
  console.log(
    `[prune] heap=${fmtBytes(stats.heapBytes)} total(with indexes)=${fmtBytes(stats.totalBytes)} dead_tuples=${stats.deadTuples}`,
  );
  const indexBytes = indexes.reduce((sum, i) => sum + i.sizeBytes, 0);
  console.log(`[prune] indexes=${fmtBytes(indexBytes)} across ${indexes.length}:`);
  for (const i of indexes) {
    console.log(`[prune]   ${i.indexname.padEnd(48)} ${fmtBytes(i.sizeBytes).padStart(9)}  scans=${i.idxScan}`);
  }
}

function printOperatorStatements(indexes: ReadonlyArray<IndexStats>): void {
  console.log("[prune] --- operator statements (NOT executed by this script) ---");
  console.log("[prune] Run one at a time, off-peak; each needs transient disk about the size of the index it rebuilds.");
  for (const i of indexes) {
    console.log(`REINDEX INDEX CONCURRENTLY public.${i.indexname};`);
  }
  console.log(`VACUUM (VERBOSE, ANALYZE) public.${TABLE};`);
}

async function main(): Promise<void> {
  const opts = parseOptions(process.argv.slice(2));
  console.log(
    `[prune] keep-days=${opts.keepDays} batch=${opts.batch} mode=${opts.dryRun ? "DRY-RUN" : "DELETE"}`,
  );

  const before = await loadTableStats();
  const indexesBefore = await loadIndexStats();
  printReport(before, indexesBefore);

  const cutoff = await resolveCutoff(opts.keepDays);
  const doomed = await countOlderThan(cutoff);
  console.log(`[prune] cutoff=${cutoff} rows older than cutoff=${doomed}`);

  if (opts.dryRun) {
    console.log(`[prune] DRY-RUN — would delete ${doomed} row(s); nothing changed`);
  } else if (doomed === 0) {
    console.log("[prune] nothing to delete");
  } else {
    const deleted = await pruneInBatches(cutoff, opts.batch, doomed);
    const after = await loadTableStats();
    console.log(`[prune] deleted ${deleted} row(s); rows now=${after.rows} oldest=${after.oldest ?? "-"}`);
    console.log("[prune] heap/index sizes do not shrink until REINDEX/VACUUM below runs.");
  }

  printOperatorStatements(indexesBefore);
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("[prune] fatal:", err instanceof Error ? err.message : err);
    await pool.end().catch(() => undefined);
    process.exit(1);
  });
