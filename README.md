# CheaterFinder

CheaterFinder tracks observed Instagram activity and presents account profiles, posts, stories, highlights, follower changes and reports in a customer workspace. Collection runs in the background; the dashboard reads stored results and shows their freshness.

Private content requires an accepted follow relationship for the specific service account used to read it. Follow requests are visible to the account owner. Approval, a healthy saved session and successful collection are separate requirements. Observed likes are sampled evidence, not a complete history of everything an account has liked.

## Documentation

- [Platform guide](docs/platform-guide.md): architecture, features, access, billing, private collection, reports, email, deployment and operations.
- [Observability](docs/observability.md): logging, metrics and health signals.
- [Rate limits](docs/rate-limits.md): provider pacing and collection budgets.
- [Proxy and bot architecture](docs/technical/proxy-and-bot-architecture.md): transport lanes and session handling.
- [Isolated test runner](tests/stress/README.md): PostgreSQL/Redis fixtures, fault tests and browser checks.
- [Automation service](automation/README.md): local Python service and transport setup.
- [Session encryption](ops/session-encryption.md).

New subscriptions use monthly Starter, Standard and Pro plans with a Stripe-backed trial for eligible first-time subscribers. Configure the live catalog, prices, coupons and webhook subscriptions through the project's own Stripe account before enabling billing; nothing in this repository carries live payment credentials.

## Current capabilities

| Area | Behavior |
| --- | --- |
| Workspace | Track accounts within the subscribed plan, view cached content, inspect freshness and observed activity. |
| Private accounts | Queue a follow, await owner approval, read through the approved viewer and use a separately approved backup when available. |
| Followers/following | Maintain resumable rosters; incomplete reads retain saved members and cannot independently establish an unfollow. |
| Likes and engagement | Collect available positive evidence, post likers and comments; these are different datasets with different coverage. |
| Reports | Weekly scheduling and requested weekly/monthly reports, with HTML views, PDF and CSV exports. |
| Notifications | In-app updates, optional device push, and durable transactional email intents. |
| Billing | Stripe Checkout, customer portal, verified paid/trial access and an eligible one-time cancellation offer. |
| Operations | Admin health, jobs, users, accounts, bots, activity and bandwidth; guarded retries and recovery. |
| Clients | React web app with English, Spanish, Portuguese and Russian; additive mobile bearer authentication. |

New subscriptions use monthly Starter, Standard and Pro plans. The current catalog is **$11.99 / 1 account**, **$19.99 / 3 accounts**, and **$34.99 / 6 accounts**, with configured founders discounts. Eligible first-time subscribers receive a three-day trial through Stripe. There is no unpaid tracking allowance. See the [catalog](shared/billing-plans.ts) and [billing guide](docs/platform-guide.md#billing-and-the-cancellation-offer) for limits and legacy plans.

## Development

Use **Node 22.19 or newer**, PostgreSQL, Redis and the locked npm dependencies. The isolated test runner specifically requires local PostgreSQL 16 binaries and Redis on Linux.

```sh
npm ci
cp .env.example .env
```

Configure a dedicated development database and integration credentials in `.env`; never reuse production customer data for tests. Apply the required reviewed SQL migrations with a migration role, as described in the [deployment guide](docs/platform-guide.md#deployment-migrations-and-rollback).

```sh
WORKERS_DISABLED=1 npm run dev
npm run check
npm run build
npm start
```

`WORKERS_DISABLED=1` disables authenticated background collection. It is not a network sandbox: routes and other enabled integrations can still perform work. Use the isolated runner for tests that must not contact providers. Missing Stripe configuration fails closed; no fake checkout or fake collection success is supplied.

`npm run build` replaces `dist/` and prerenders public pages. Run it in an inactive checkout or release staging directory, never over the active production artifacts. Production also needs the separately managed local automation service and external Node dependencies used by the bundle.

## Verification

```sh
npm run check
npm test
npm run test:stress -- --schema=/path/to/schema-only.sql --cases=backend-all
npm run test:stress -- --schema=/path/to/schema-only.sql --cases=customer-flows --build-dir=/path/to/staged/dist
```

Some integration suites intentionally require their own isolated services and are run separately. Do not interpret skipped tests as coverage. See the [test guide](tests/stress/README.md) and [verification boundaries](docs/platform-guide.md#verification-and-evidence) before running a release gate or interpreting a pass count.

## Repository map

| Path | Responsibility |
| --- | --- |
| `client/src/` | Customer and admin web UI, authentication/payment navigation, translations. |
| `server/auth.ts`, `server/mobile-auth.ts` | Browser sessions, mobile tokens and credential flows. |
| `server/routes.ts`, `server/admin-routes.ts` | Customer and operations HTTP boundaries. |
| `server/workers.ts`, `server/workers/` | Queue processors, periodic scheduling and recovery. |
| `server/services/` | Collection, private authorization, rosters, billing, reports, email and media. |
| `server/ig-public-scraper.ts`, `server/domain/` | Leases, transport adapters, provider schemas and follow state transitions. |
| `automation/` | Loopback FastAPI service for browser identities and authenticated transport. |
| `shared/schema.ts`, `shared/billing-plans.ts` | Database model and shared entitlement catalog. |
| `migrations/` | Reviewed database changes. |
| `scripts/`, `tests/stress/` | Operational tooling, isolated verification and sanitized evidence. |

Keep credentials, cookies, customer identifiers, provider object IDs and raw private content out of documentation and committed diagnostics. Preserve the existing configured encryption keys, provider accounts, proxy bindings and first-party identity during deployment.
