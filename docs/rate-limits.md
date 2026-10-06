# IG Rate Limits (Wave 2 task D)

Each BullMQ queue that calls Instagram has a global rate limiter enforced at
the Worker level (BullMQ v5 removed Queue-level limiters). These caps apply
across ALL bots — with 60 bots at scale the caps will be hit quickly and
jobs will wait in Redis rather than slamming IG.

## Current values

| Worker                | Limiter             | Rationale                                                                 |
|-----------------------|---------------------|---------------------------------------------------------------------------|
| `bot-follow-request`  | `5 / 60_000 ms`     | Sending follow requests is the most sensitive signal to IG's anti-bot.    |
| `collection-likes`    | `30 / 60_000 ms`    | Profile + feed reads, moderate cost. 30/min aligns with IG sampling rate. |
| `collection-follows`  | `30 / 60_000 ms`    | Following list pagination is heavy; same cap as likes.                    |

Profile collection (`collection-profile`) is NOT rate-limited — it uses
Apify or mock first, only falling through to bot sessions on private
accounts, which then re-enqueue `collection-likes`/`collection-follows`
jobs that ARE capped.

## Tuning

Bump the caps in `server/workers.ts`:

```ts
export const BOT_FOLLOW_LIMITER = { max: 5, duration: 60_000 } as const;
export const COLLECTION_IG_LIMITER = { max: 30, duration: 60_000 } as const;
```

Guidelines:

- Target utilization: 60-70% of IG's observed rate limit (stay well below).
- If the circuit breaker (`GET /api/admin/ig-breaker`) opens often, the
  cap is too high.
- If the follow-accept latency grows or backlog persists, the cap is too
  low — consider increasing `duration` instead of `max`.

## Interaction with the circuit breaker

The BullMQ limiter spaces jobs out; the circuit breaker stops jobs entirely
when IG is broken. Together they replace the old "blast IG until a bot
gets banned" behavior.

When the breaker is OPEN, rate-limited workers still pick up the job but
the port call throws `IGCircuitOpenError` — the job is requeued by BullMQ
with its backoff, so throughput naturally drops to zero until the breaker
closes. No special job-level handling is needed.
