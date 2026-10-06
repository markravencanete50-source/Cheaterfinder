// ─── Paid graph fallback for public accounts ───────────────────────────────
//
// Instagram sometimes withholds a public account's follower/following list
// from every session in our local pool (`special_empty_state`). The configured
// Apify actors use an independent, no-login collection fleet, so they are a
// useful last resort after distinct local sessions have all failed.
//
// This module deliberately uses the REST API instead of adding apify-client to
// the hot server bundle. It is disabled unless both APIFY_API_TOKEN and
// APIFY_GRAPH_FALLBACK_ENABLED=true are present, and every run has an explicit
// dollar cap.

import type { IGFollowUser } from "../ig-public-scraper.js";
import { logger as baseLogger } from "../observability/logger.js";

const logger = baseLogger.child({ module: "apify-graph-fallback" });
const APIFY_API = "https://api.apify.com/v2";
// Instaprism and browser/session-pool actors both return zero for profiles
// protected by Instagram's `special_empty_state` (including @tracked_user_1). These
// two actors use an independent provider and successfully produced the complete
// exports in verification runs.
const ACTORS = {
  followers: "datadoping~instagram-followers-scraper",
  following: "datadoping~instagram-following-scraper",
} as const;
const TERMINAL = new Set(["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"]);
const successfulResultCache = new Map<
  string,
  { at: number; users: ReadonlyArray<IGFollowUser> }
>();
const inFlightRuns = new Map<string, Promise<ReadonlyArray<IGFollowUser>>>();

export type ApifyGraphDimension = "followers" | "following";

interface ActorRun {
  id: string;
  status: string;
  statusMessage?: string;
  defaultDatasetId: string;
}

interface ApiEnvelope<T> {
  data: T;
}

function enabled(): boolean {
  return (
    process.env.APIFY_GRAPH_FALLBACK_ENABLED === "true" &&
    Boolean(process.env.APIFY_API_TOKEN?.trim())
  );
}

function boundedNumber(
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/** Effective actor/dataset cap after applying the configured safety ceiling. */
export function resolveApifyGraphLimit(requestedLimit: number): number {
  return Math.min(
    Math.max(1, Math.floor(requestedLimit)),
    Math.floor(boundedNumber("APIFY_GRAPH_MAX_ITEMS", 2_000, 1, 15_000)),
  );
}

async function apiJson<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const token = process.env.APIFY_API_TOKEN?.trim();
  if (!token) throw new Error("Apify graph fallback is not configured");
  const response = await fetch(`${APIFY_API}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
    signal: AbortSignal.timeout(70_000),
  });
  if (!response.ok) {
    const body = (await response.text()).slice(0, 500);
    throw new Error(`Apify API ${response.status}: ${body}`);
  }
  return (await response.json()) as T;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function bool(value: unknown): boolean {
  return value === true;
}

function mapUser(raw: Record<string, unknown>): IGFollowUser | null {
  const username = str(raw.username).trim();
  if (!username) return null;
  return {
    igUserId: str(raw.userId) || str(raw.id) || str(raw.pk),
    username,
    fullName: str(raw.fullName) || str(raw.full_name),
    profilePicUrl:
      str(raw.profilePicUrl) ||
      str(raw.profile_pic_url) ||
      str(raw.pfpUrl),
    isPrivate: bool(raw.isPrivate) || bool(raw.is_private),
    isVerified: bool(raw.isVerified) || bool(raw.is_verified),
  };
}

async function abortRun(runId: string): Promise<void> {
  await apiJson(`/actor-runs/${encodeURIComponent(runId)}/abort`, {
    method: "POST",
  }).catch((error) => {
    logger.warn({ runId, error }, "failed to abort timed-out Apify graph run");
  });
}

/**
 * Fetch one complete public follower/following list from an independent actor.
 * The actor is only invoked by the service after native distinct-bot rotation
 * has exhausted, so ordinary accounts never incur this paid fallback.
 */
async function fetchApifyGraphUncached(
  username: string,
  dimension: ApifyGraphDimension,
  requestedLimit: number,
): Promise<ReadonlyArray<IGFollowUser>> {
  if (!enabled()) {
    throw new Error("Apify graph fallback disabled");
  }

  const limit = resolveApifyGraphLimit(requestedLimit);
  const maxChargeUsd = boundedNumber(
    "APIFY_GRAPH_MAX_USD_PER_RUN",
    10,
    1,
    50,
  );
  const maxWaitMs = boundedNumber(
    "APIFY_GRAPH_MAX_WAIT_MS",
    20 * 60 * 1_000,
    60_000,
    60 * 60 * 1_000,
  );
  const startedAt = Date.now();

  logger.warn(
    { username, dimension, limit, maxChargeUsd },
    "native graph restricted; starting paid Apify fallback",
  );
  const actor = ACTORS[dimension];
  const started = await apiJson<ApiEnvelope<ActorRun>>(
    `/actors/${actor}/runs?waitForFinish=60&timeout=1200&maxTotalChargeUsd=${maxChargeUsd}`,
    {
      method: "POST",
      body: JSON.stringify({ usernames: [username], max_count: limit }),
    },
  );
  let run = started.data;

  while (!TERMINAL.has(run.status) && Date.now() - startedAt < maxWaitMs) {
    const polled = await apiJson<ApiEnvelope<ActorRun>>(
      `/actor-runs/${encodeURIComponent(run.id)}?waitForFinish=60`,
    );
    run = polled.data;
  }
  if (!TERMINAL.has(run.status)) {
    await abortRun(run.id);
    throw new Error(`Apify ${dimension} run timed out after ${maxWaitMs}ms`);
  }
  if (run.status !== "SUCCEEDED") {
    throw new Error(
      `Apify ${dimension} run ${run.status}: ${run.statusMessage ?? "no status message"}`,
    );
  }

  const raw = await apiJson<unknown[]>(
    `/datasets/${encodeURIComponent(run.defaultDatasetId)}/items?clean=true&format=json&limit=${limit}`,
  );
  const users: IGFollowUser[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const error = str(record.error) || str(record.message);
    if (error && !str(record.username)) {
      throw new Error(`Apify ${dimension} provider error: ${error}`);
    }
    const user = mapUser(record);
    if (!user || seen.has(user.username.toLowerCase())) continue;
    seen.add(user.username.toLowerCase());
    users.push(user);
  }

  if (users.length === 0) {
    throw new Error(`Apify ${dimension} run succeeded but returned no users`);
  }

  logger.info(
    {
      username,
      dimension,
      count: users.length,
      runId: run.id,
      elapsedMs: Date.now() - startedAt,
    },
    "Apify graph fallback completed",
  );
  return users;
}

/**
 * Coalesce and briefly cache successful exports by public username/dimension.
 * Two customers can track the same account (currently @tracked_user_1 has two
 * active tracking rows); purchasing the same public export twice in parallel
 * would add cost without adding information.
 */
export async function fetchApifyGraph(
  username: string,
  dimension: ApifyGraphDimension,
  requestedLimit: number,
): Promise<ReadonlyArray<IGFollowUser>> {
  if (!enabled()) {
    throw new Error("Apify graph fallback disabled");
  }
  const normalizedUsername = username.trim().toLowerCase().replace(/^@/, "");
  const limit = resolveApifyGraphLimit(requestedLimit);
  const key = `${normalizedUsername}:${dimension}:${limit}`;
  const ttlMs = Math.floor(
    boundedNumber(
      "APIFY_GRAPH_RESULT_TTL_MS",
      15 * 60 * 1_000,
      60_000,
      60 * 60 * 1_000,
    ),
  );
  const cached = successfulResultCache.get(key);
  if (cached && Date.now() - cached.at < ttlMs) {
    logger.info(
      { username: normalizedUsername, dimension, count: cached.users.length },
      "reusing recent Apify graph export",
    );
    return cached.users;
  }
  if (cached) successfulResultCache.delete(key);

  const active = inFlightRuns.get(key);
  if (active) {
    logger.info(
      { username: normalizedUsername, dimension },
      "joining in-flight Apify graph export",
    );
    return active;
  }

  const run = fetchApifyGraphUncached(normalizedUsername, dimension, limit)
    .then((users) => {
      successfulResultCache.set(key, { at: Date.now(), users });
      while (successfulResultCache.size > 100) {
        const oldest = successfulResultCache.keys().next().value;
        if (oldest === undefined) break;
        successfulResultCache.delete(oldest);
      }
      return users;
    })
    .finally(() => {
      inFlightRuns.delete(key);
    });
  inFlightRuns.set(key, run);
  return run;
}

export function isApifyGraphFallbackEnabled(): boolean {
  return enabled();
}
