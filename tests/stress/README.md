# Backend stress and fault checks

These checks use actual application services and a **new PostgreSQL 16 cluster
and Redis instance for each run**, not mocks of persistence and not a scratch
database sharing the production PostgreSQL server. Fixtures are synthetic.
They are deliberately separate from `npm test`; a green unit-test count is not
a stress, coverage, upstream-accuracy or launch-readiness certificate.

## Run safely

Requires Node 22+, installed dependencies, PostgreSQL 16 binaries under
`/usr/lib/postgresql/16/bin`, `redis-server`, and Linux. Run as an ordinary OS
user, or as root with an existing `postgres` OS user (PG is never run as root).

Supply a trusted, current schema-only SQL dump matching the app migrations:

The runner applies additive migrations 0053 through 0057 inside its own private
cluster, including recent-roster clocks, trial history, engagement indexing,
transactional email and retention state. This does not migrate the source
database. The roster case adds five concurrent head writes beside ten deep
continuations and verifies that recent progress survives a full twin copy without
changing the deep cursor, epoch or full-verification clock.

```sh
npm run test:stress -- --schema=/path/to/schema-only.sql --label=baseline
npm run test:stress -- --schema=/path/to/schema-only.sql --label=repeat
```

On this host, an explicit read-only schema export is also supported:

```sh
npm run test:stress -- --schema-from-local=cheaterfinder_ai --label=baseline
```

That option only invokes `pg_dump --schema-only --no-owner --no-privileges`.
It does not copy customer/bot/session rows or give the app the source DB URL.
Later runs can reuse the saved `/tmp/cheaterfinder-stress-*/schema.sql`.

One scenario, or focused existing regressions:

```sh
npm run test:stress -- --schema=/path/to/schema-only.sql --cases=roster-pool
npm run test:stress -- --schema=/path/to/schema-only.sql --cases=regressions
node node_modules/typescript/bin/tsc --project tests/stress/tsconfig.json
```

`regressions` must run separately because the legacy suites require a fixed DB
name. It **still gets a new private cluster**, not the production-host scratch
DB. Missing, skipped or failed regression results fail the runner.

## What is actually exercised

| Case | Stress/fault | Independent invariant |
| --- | --- | --- |
| `billing` | 20 different customers hold locks before real DB reads; 100 same-user competitors; 20 local fixture deletions | Every independent operation completes; exactly one same-user owner, no leaked advisory locks; no accidental extra pool checkout |
| `credentials` | 100 reset/change races, real row-lock blocker, bcrypt, 500 web and 100 mobile sessions | One credential/version winner, all target sessions revoked, other customer unchanged, 50 reset tokens cannot replay |
| `roster-pool` | 20 follower and then 20 following persistence transactions all hold a connection before work continues | All 1,000 sightings persist per dimension; no extra pool borrowers waiting behind connections held by the same operations |
| `roster` | **335,609 actual DB members**; 10 overlapping/duplicate continuation deliveries, 20 concurrent reads, full epoch evaluation, large sibling copy | Generated identity set preserved, full serving-field equality, no fabricated baseline events; short/partial reads cannot advance full freshness |
| `crash` | Separate process `SIGKILL` after member/cursor/checkpoint SQL and before COMMIT; successor and stale owner in separate processes | Atomic rollback and resume: 500 → 500 after crash → 1,000 after resume; stale owner cannot write or erase successor lease |
| `bandwidth` | 128 interleaved producers, actual TCP outage, committed INSERT acknowledgement dropped, overflow, 100 concurrent flushes, 450 real synthetic customer/tracking records (one later deleted), concurrent report readers/writer | Exact independent bytes/requests/failures/resource sums; retained retry does not duplicate committed IDs; omitted top-N totals disclosed; missing customer distinguished from system; report snapshots reconcile |

The PostgreSQL fault proxy withholds `CommandComplete` for an INSERT and drops
the connection after `ReadyForQuery` reports idle. A **separate direct DB
connection also proves the 1,000 rows committed** before retry. This is not a
method spy that throws after pretending a query succeeded. See PostgreSQL's
[message flow](https://www.postgresql.org/docs/16/protocol-flow.html) and
[message formats](https://www.postgresql.org/docs/16/protocol-message-formats.html).

## Evidence and limits

Every run prints its `/tmp/cheaterfinder-stress-<nonce>/report.json`. It includes exact
selected source SHA-256s, schema hash, Node version, isolated service settings,
individual case errors, contention/latency/RSS measurements and cleanup status.
The roster `copy.ms` measurement includes the subsequent independent SQL
set/field comparisons; it is not the copy statement's latency alone.
Failures are retained, not overwritten with a later pass. Cases have a
180-second watchdog and progress output; the full backend case allows ten minutes. Case processes use a 512MiB V8 heap;
PG has max32 connections,32MiB shared buffers,2MiB work memory, fsync and
synchronous commit enabled; Redis is64MiB/noeviction. Processes run at lower
CPU priority on the shared host. Test services stop; synthetic data directories
remain for diagnosis. Delete only explicit verified test directories if needed.

Network preload rejects production ports5432/6379 and non-allowlisted network
destinations before socket creation. Test cases assert that the guard is active.
Only the three newly allocated test ports are accepted, and DB nonce + actual
data-directory identity must match. Provider credentials are not inherited.
This protects accidental test connections; it is not a security boundary
against intentionally malicious code or local OS users.

Important limitations:

- The large-roster fixture seeds earlier history using SQL, then exercises real
  continuation/finalisation/copy code. It is **not** a 672-page live Instagram
  walk and cannot prove upstream enumeration completeness or browser/HTTP parity.
- These are bounded bursts/faults on a shared host, **not** a multi-hour soak,
  multi-host production capacity measurement or production latency SLA.
- No live Stripe charge/webhook, email inbox, bot recovery, provider throttling
  or authenticated customer end-to-end journey is performed. Slow provider I/O
  plus full web traffic/backpressure remains a separate staging load-test gate.
- Redis is real for app module connections, but this suite does **not** prove
  BullMQ job recovery, Redis durability or scheduler fairness under sustained load.
- Roster lease expiry is accelerated by changing **only the fixture row**; no
  production TTL, scheduling cadence or data-completeness threshold is relaxed.
- Meter retry identity is not a write-ahead log. Killing the process **before**
  pending in-memory traffic is flushed can still lose that unjournaled tail.
  Overflow preserves totals but loses per-key attribution for excess keys.
- Raw backend/shared coverage now has a broad denominator in `vitest.config.ts`.
  Stress completion is not a statement-coverage percentage, and no threshold
  has been reduced to make this suite pass.

## Browser check for large bandwidth results

After a successful stress run, replay its actual synthetic API output through
the current **newly compiled** UI (all build outputs stay in a new temp folder):

```sh
node scripts/test-bandwidth-stress-browser.mjs /tmp/cheaterfinder-stress-RUN/bandwidth-api.json
```

This tests the two200-row tables,451-group disclosure,450-customer/profile
counters, deleted-customer/system distinction, share denominator,20 rapid window changes,500/recovery/403 states and
mobile layout. Screenshots and report are saved under a new
`/tmp/cheaterfinder-stress-browser-*` directory. Authentication is a fixture and the
DB report is replayed, so this is **UI integration evidence**, not live
admin/backend authentication or provider end-to-end proof.

Current release evidence is summarized in the
[cross-flow audit](../../docs/flow-audit-2026-09-23.md), with operational boundaries
in the [platform guide](../../docs/platform-guide.md). The older
[roster/system audit](../../docs/features-roster-system-health-2026-09-07.md)
retains historical stress checkpoints.

## Full backend regressions

`--cases=backend-all` runs backend and shared tests serially in the isolated
cluster, with all three scratch-database variables configured. It has a ten
minute watchdog because the bot warmer regression tests exercise real pacing.
The self-contained private-twin PostgreSQL and media-cache Redis suites must
run separately; they create their own services outside this runner's network
allowlist. Browser customer flows also run separately:

```sh
npm run test:stress -- --schema=/path/to/schema-only.sql --cases=backend-all
npm run test:stress -- --schema=/path/to/schema-only.sql --cases=customer-flows --build-dir=/path/to/staged/dist
```

The runner applies migrations 0053 through 0057 to its private cluster.
`PLAYWRIGHT_BROWSERS_PATH`, when set, selects a preinstalled browser cache;
provider credentials are still excluded. Node 22.19 or newer is required.

For a focused follow-up after a failed backend test, pass
`--cases=backend-all --test-file=server/services/__tests__/private-media-http.integration.test.ts`.
The report records `selectedTestFile` so this is not mistaken for a full run.
Set `PLAYWRIGHT_BROWSERS_PATH` to the installed browser directory for suites
that launch Chromium.
