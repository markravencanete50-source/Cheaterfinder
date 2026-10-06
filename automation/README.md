# Local automation service

This FastAPI process owns Instagram browser automation and fingerprinted HTTP
sessions for bots that have been explicitly migrated. It is not exposed publicly: its entrypoint binds
to `127.0.0.1:8787`, while Express is the only intended caller.

## Setup

```bash
python3 -m venv .venv
.venv/bin/python -m pip install pip==26.2.1
.venv/bin/python -m pip install -r requirements.lock.txt
AUTOMATION_API_TOKEN="$(openssl rand -hex 32)" .venv/bin/python run.py
```

Use that exact token as `AUTOMATION_API_TOKEN` in the Node application too.
`requirements.txt` records the supported dependency ranges; `requirements.lock.txt`
records the versions verified for deployment. Refresh and audit the lock before
updating the deployed environment.
The authenticated API currently exposes:

- `GET /v1/health` — dependency/readiness state;
- `POST /v1/identities` — creates a stable Firefox browser + HTTP identity for
  Express to persist with the bot; and
- `POST /v1/instagram/http` / `POST /v1/instagram/browser` — raw,
  Instagram-origin-only request envelopes. The existing TypeScript schema
  parsers consume their response bodies; and
- `POST /v1/instagram/follow` — one explicit browser follow action with relationship verification;
- `POST /v1/instagram/public-page` — native browser capture for supported public reads; and
- `POST /v1/instagram/login/start` / `probe` / `complete` — a Python-owned Firefox
  login with a short-lived code challenge hand-off. Node obtains email/TOTP
  codes through the existing mailbox integration; browser state never leaves
  FastAPI except as an encrypted Playwright storage-state blob.

The browser endpoint uses invisible-playwright; it needs its Firefox engine
downloaded before it can launch. Until then `/v1/health` reports `degraded`:

```bash
.venv/bin/python -m invisible_playwright fetch
```

The session model is intentionally stable per bot: proxy, cookies,
browser seed/fingerprint, locale/timezone, browser-derived Windows Firefox UA,
and the `httpz` JA3/H2 profile are created together and persisted as one
identity. They are not randomized per request. Express may provide only
endpoint-specific headers; FastAPI owns the UA, cookies, client-hint/fetch
shape, origin and referer so a legacy Chrome fingerprint cannot leak into the
Firefox session.

## Controlled rollout

Apply `migrations/0037_automation_identity.sql`, keep `WORKERS_DISABLED=1`,
then cut over and validate exactly one bot:

```bash
npx tsx server/scripts/migrate-bot-to-automation.ts --username bot@example.com
```

That command creates/persists the Python identity, invalidates the legacy
Chrome storage state, and performs the replacement Firefox login through the
bot's assigned proxy. Some legacy adapters remain for compatibility, but current private follow admission
requires a matching saved automation identity, a usable session/proxy and normal
health/capacity checks. Missing identity is not an implicit migration or a reason
to bypass admission. This migration command changes a bot session and performs a
login; it is a controlled operation, not a read-only health check.

Current private authorization, cooldown and deployment boundaries are documented
in the [platform guide](../docs/platform-guide.md). A healthy local automation
service does not prove that an Instagram session is accepted or content is fresh.
