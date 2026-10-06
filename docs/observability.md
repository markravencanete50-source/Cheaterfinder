# Observability (Wave 2)

CheaterFinder emits structured JSON logs via [pino](https://getpino.io). Every
log line is a single JSON object with a `time`, `level`, `msg`, and whichever
correlation fields are in scope at the time of emission.

## Correlation fields

The `server/observability/logger.ts` module wires an `AsyncLocalStorage`-backed
context so every worker job, every HTTP request, and every nested call gets
merged correlation fields automatically.

Common fields you will see:

- `reqId` — per-HTTP-request ID (also echoed as the `X-Request-Id` response header).
- `module` — logical subsystem: `worker:profile`, `worker:likes`, `worker:follows`,
  `worker:bot-follow`, `worker:bot-check`, `worker:email`, `worker:report`,
  `worker:retention`, `bot-manager`, `admin-routes`, `server`, `csrf`.
- `trackedAccountId` — present in every log line inside a worker handling
  a specific tracked account.
- `botAccountId`, `botFollowRequestId` — present inside the bot-follow worker.
- `jobId` — BullMQ job identifier.

## Tailing and filtering

Follow all logs:

```bash
pm2 logs cheaterfinder --raw | tee /tmp/cheaterfinder.log
```

Filter by tracked account:

```bash
pm2 logs cheaterfinder --raw --lines 1000 \
  | jq -c 'select(.trackedAccountId == "<uuid>")'
```

Only errors and warnings from a single module:

```bash
pm2 logs cheaterfinder --raw \
  | jq -c 'select(.module == "worker:bot-follow" and .level >= 40)'
```

Follow a single HTTP request end-to-end:

```bash
# Capture the X-Request-Id response header on the client, then filter:
pm2 logs cheaterfinder --raw | jq -c 'select(.reqId == "<hex>")'
```

## Log level

Set the log level via `LOG_LEVEL` in `.env`. Defaults to `info`. Use `debug`
when investigating issues locally; drop back to `info` in production.

## Redaction

The following fields are automatically redacted in log output:

- `sessionid`, `csrftoken`
- `sessionData`, `session_data`, `*.sessionData`, `*.session_data`
- `password`, `hashedPassword`, `hashed_password`
- `headers.cookie`, `headers.authorization`
- `req.headers.cookie`, `req.headers.authorization`

Never pass plaintext IG cookies, user passwords, or auth tokens as bare fields
outside of those redaction paths. If you need to add a new sensitive field,
extend the `redact.paths` list in `server/observability/logger.ts`.

## Retention

Event tables (`like_events`, `follow_events`, `unfollow_events`,
`profile_snapshots`) are pruned daily by the `retention` BullMQ worker. The
cutoff is `NOW() - RETENTION_DAYS_EVENTS days` (default 90). Rows older than
the cutoff are deleted. The worker emits a summary log line per run:

```json
{"level":30,"msg":"prune complete","module":"retention","retentionDays":90,"likeEvents":0,"followEvents":0,"unfollowEvents":0,"profileSnapshots":0}
```

The session table (`connect-pg-simple`) prunes expired session rows every
15 minutes independently.

## Running retention on-demand

```bash
cd /root/instaapp/ROB-APP/ROB-APP
node --input-type=module -e "
  import('./dist/index.cjs').catch(() => {});
  import('./server/workers/retention-worker.ts').then(m => m.pruneOldEvents())
    .then(s => { console.log(JSON.stringify(s)); process.exit(0); });
"
```

Or in production via the bundled output:

```bash
node -e "require('./dist/index.cjs'); /* retention runs on schedule */"
```

The scheduler uses a stable `repeat.jobId`, so duplicate repeatables never
accumulate on restart.
