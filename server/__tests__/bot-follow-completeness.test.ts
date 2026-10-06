// Unit tests for Audit B12 — completeness gating of the private-roster
// unfollow diff in fetchAllFollowing / collectFollowsViaBotSession.
//
// Bug class: a hardcoded page cap (maxPages=10 × 50/page = 500) with no
// completeness check meant any private account with >500 followings — or a
// page failure mid-walk — marked every prior-known following outside the
// captured window as unfollowed: false mass-unfollow events. Mirrors the
// public-path wire.fluid incident (see services/diff-completeness.ts).
//
// All external I/O is mocked. No real DB, no real network.

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type MockInstance,
} from "vitest";

// ---------------------------------------------------------------------------
// Stub env so db.ts (transitively required by bot-collectors) does not throw
// ---------------------------------------------------------------------------

vi.stubEnv("DATABASE_URL", "postgres://mock:mock@localhost/mock");

// ---------------------------------------------------------------------------
// Hoisted shared state: table sentinels (so the tx mock can tell which table
// a select/insert targets) plus per-test row fixtures and insert capture.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => {
  const followEventsTable = { __table: "follow_events" };
  const unfollowEventsTable = { __table: "unfollow_events" };
  const botAccountsTable = { __table: "bot_accounts" };
  const botFollowRequestsTable = { __table: "bot_follow_requests" };
  const state = {
    acceptedBot: null as Record<string, unknown> | null,
    priorFollowRows: [] as Array<{ followedUsername: string }>,
    priorUnfollowRows: [] as Array<{ unfollowedUsername: string }>,
    insertedFollows: [] as Array<{ followedUsername: string }>,
    insertedUnfollows: [] as Array<{ unfollowedUsername: string }>,
    botUpdates: [] as Array<Record<string, unknown>>,
  };
  return {
    followEventsTable,
    unfollowEventsTable,
    botAccountsTable,
    botFollowRequestsTable,
    state,
  };
});

// ---------------------------------------------------------------------------
// Mock: ../db.js — getAcceptedBotForTrackedAccount uses
// select→from→innerJoin→where→limit; the diff runs inside db.transaction(tx)
// with tx.select→from→where and tx.insert→values. Rows are routed by table
// sentinel identity.
// ---------------------------------------------------------------------------

vi.mock("../db.js", () => {
  const tx = {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(async () => {
          if (table === h.followEventsTable) return h.state.priorFollowRows;
          if (table === h.unfollowEventsTable) return h.state.priorUnfollowRows;
          return [];
        }),
      })),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn(async (rows: Array<Record<string, string>>) => {
        if (table === h.followEventsTable) {
          h.state.insertedFollows.push(
            ...rows.map((r) => ({ followedUsername: r.followedUsername })),
          );
        }
        if (table === h.unfollowEventsTable) {
          h.state.insertedUnfollows.push(
            ...rows.map((r) => ({ unfollowedUsername: r.unfollowedUsername })),
          );
        }
      }),
    })),
  };
  return {
    db: {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => ({
          where: vi.fn(() => {
            h.state.botUpdates.push(values);
            return { catch: vi.fn().mockResolvedValue(undefined) };
          }),
        })),
      })),
      insert: vi.fn(),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          innerJoin: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(async () =>
                h.state.acceptedBot ? [h.state.acceptedBot] : [],
              ),
            })),
          })),
        })),
      })),
      transaction: vi.fn(async (cb: (t: typeof tx) => Promise<unknown>) =>
        cb(tx),
      ),
    },
  };
});

// ---------------------------------------------------------------------------
// Mock: shared/schema.js — sentinels let the tx mock discriminate tables.
// profileSnapshots is required by services/diff-completeness.js (imported
// for real so the 0.90 ratio gate under test is the production one).
// ---------------------------------------------------------------------------

vi.mock("../../shared/schema.js", () => ({
  likeEvents: {},
  followEvents: h.followEventsTable,
  unfollowEvents: h.unfollowEventsTable,
  botAccounts: h.botAccountsTable,
  botFollowRequests: h.botFollowRequestsTable,
  profileSnapshots: {},
}));

// ---------------------------------------------------------------------------
// Mock: drizzle-orm — and/eq used by bot-collectors, desc by diff-completeness
// ---------------------------------------------------------------------------

vi.mock("drizzle-orm", () => ({
  and: vi.fn((..._args: unknown[]) => true),
  eq: vi.fn((..._args: unknown[]) => true),
  isNull: vi.fn((..._args: unknown[]) => true),
  lt: vi.fn((..._args: unknown[]) => true),
  or: vi.fn((..._args: unknown[]) => true),
  desc: vi.fn((c: unknown) => c),
}));

// ---------------------------------------------------------------------------
// Mock: incidental dependencies pulled in by bot-collectors so the module can
// finish loading. humanDelay must resolve instantly or pagination tests would
// sleep for real.
// ---------------------------------------------------------------------------

vi.mock("../services/bot-runtime.js", () => ({
  invalidateBotSession: vi.fn().mockResolvedValue(undefined),
  ensureBotReady: vi.fn(async (botId: string) => ({
    botId,
    igUsername: "botuser",
    sessionData: "current-session",
    proxyEndpoint: "user-host:7777",
    proxyUrl: "http://user-host:7777",
    automationIdentity: null,
    transport: "web",
  })),
}));

vi.mock("../services/subscription-access.js", () => ({
  trackedAccountHasAccess: vi.fn().mockResolvedValue(true),
}));

vi.mock("../bot-manager.js", () => ({
  markFollowRequestAccepted: vi.fn(),
  markFollowRequestFailed: vi.fn(),
  markFollowRequestSent: vi.fn(),
  ensureBotFingerprint: vi.fn(async () => ({
    deviceId: "dev-1",
    userAgent: "ua",
    appId: "app",
    timezone: "UTC",
    locale: "en-US",
    awakeHourStart: 0,
    awakeHourEnd: 24,
  })),
}));

vi.mock("../crypto/session-envelope.js", () => ({
  decryptSessionData: (v: string) => v,
}));

vi.mock("../behavior/pacing.js", () => ({
  humanDelay: vi.fn().mockResolvedValue(undefined),
  isAwake: vi.fn(() => true),
  msUntilAwake: vi.fn(() => 0),
  reserveGlobalFollow: vi.fn(() => true),
}));

vi.mock("../behavior/caps.js", () => ({
  reserveDailyBudget: vi.fn().mockResolvedValue(undefined),
  effectiveFollowCap: vi.fn(() => 5),
  isInWarmup: vi.fn(() => false),
  IGDailyCapExceededError: class extends Error {
    resetAt = new Date();
  },
  nextMidnightUtc: vi.fn(() => new Date()),
}));

vi.mock("../behavior/decoration.js", () => ({
  decorateBeforeFollow: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../behavior/device-fingerprint.js", () => ({
  resolveFingerprint: vi.fn(() => ({
    deviceId: "dev-1",
    userAgent: "ua",
    appId: "app",
    timezone: "UTC",
    locale: "en-US",
    awakeHourStart: 0,
    awakeHourEnd: 24,
  })),
}));

vi.mock("../services/proxy-provider.js", () => ({
  proxyAgentUriForEndpoint: vi.fn(() => "http://proxy.example:7777"),
}));

vi.mock("../ig-playwright-client.js", () => ({
  playwrightSendFollowByUsername: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import type {
  IGClientPort,
  IGFriendshipPage,
} from "../domain/ig-client-port.js";
import {
  createBotCollectors,
  decideUnfollowGate,
  fetchAllFollowing,
  resolvePrivateFollowsMaxPages,
  DEFAULT_PRIVATE_FOLLOWS_MAX_PAGES,
  withBotErrorHandling,
} from "../bot-collectors.js";
import { IGAuthExpiredError, IGRateLimitedError } from "../ig-http-client.js";
import { invalidateBotSession } from "../services/bot-runtime.js";

describe("private collector auth-shaped throttles", () => {
  it.each([0, 30_000])("keeps the shared four-hour cooldown floor on a 429 with Retry-After %i ms", async retryAfterMs => {
    const err = new IGRateLimitedError(retryAfterMs);
    const before = Date.now();
    await expect(withBotErrorHandling("bot-1", "fixture", async () => { throw err; })).rejects.toBe(err);
    expect(invalidateBotSession).not.toHaveBeenCalled();
    expect(h.state.botUpdates).toHaveLength(1);
    expect((h.state.botUpdates[0].cooldownUntil as Date).getTime()).toBeGreaterThanOrEqual(before + 4 * 60 * 60_000);
    expect(h.state.botUpdates[0].lastLoginError).toMatch(/^cooldown: rate limited;/);
  });

  it("returns a rate-limit signal for the localized throttle while retaining the saved session", async () => {
    const err = new IGAuthExpiredError("auth rejected", { status: 401, body: JSON.stringify({
      message: "Bitte warte einige Minuten", require_login: true, igweb_rollout: true, status: "fail",
    }) });
    await expect(withBotErrorHandling("bot-1", "fixture", async () => { throw err; }))
      .rejects.toMatchObject({ name: "IGRateLimitedError", retryAfterMs: 600_000, cause: err });
    expect(invalidateBotSession).not.toHaveBeenCalled();
  });

  it("still invalidates a genuine auth rejection", async () => {
    const err = new IGAuthExpiredError("login_required", { status: 401, body: '{"message":"login_required","require_login":true}' });
    await expect(withBotErrorHandling("bot-1", "fixture", async () => { throw err; })).rejects.toBe(err);
    expect(invalidateBotSession).toHaveBeenCalledExactlyOnceWith("bot-1");
  });
});

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

const ACCEPTED_BOT = {
  id: "bot-1",
  igUsername: "botuser",
  proxyEndpoint: "user-host:7777",
  deviceId: "dev-1",
  deviceUserAgent: "ua",
  igAppId: "app",
  timezone: "UTC",
  locale: "en-US",
  awakeHourStart: 0,
  awakeHourEnd: 24,
};

function friendshipUser(username: string) {
  return {
    pk: `pk-${username}`,
    username,
    fullName: null,
    isPrivate: false,
    isVerified: false,
    profilePicUrl: null,
  };
}

function friendshipPage(
  usernames: string[],
  nextMaxId: string | null,
): IGFriendshipPage {
  return { users: usernames.map(friendshipUser), nextMaxId, bigList: false };
}

/** A client whose fetchFollowing yields each entry in order; an Error entry
 *  throws on that page. */
function makeClient(pages: Array<IGFriendshipPage | Error>): IGClientPort {
  let call = 0;
  return {
    fetchProfile: vi.fn(async () => ({
      pk: "tracked-pk",
      username: "target",
      fullName: null,
      biography: null,
      isPrivate: true,
      isVerified: false,
      followerCount: 0,
      followingCount: 0,
      postCount: 0,
      profilePicUrl: null,
      externalUrl: null,
      followedByViewer: true,
      requestedByViewer: false,
      posts: [],
    })),
    fetchFollowing: vi.fn(async () => {
      const next = pages[call];
      call += 1;
      if (next === undefined) throw new Error("test ran out of pages");
      if (next instanceof Error) throw next;
      return next;
    }),
    close: vi.fn(async () => {}),
  } as unknown as IGClientPort;
}

function makeCollectors(client: IGClientPort) {
  return createBotCollectors({ createClient: vi.fn(async () => client) });
}

function setPriorFollows(usernames: string[]): void {
  h.state.priorFollowRows = usernames.map((followedUsername) => ({
    followedUsername,
  }));
}

const range = (n: number, prefix = "u"): string[] =>
  Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);

let warnSpy: MockInstance;
let logSpy: MockInstance;

beforeEach(() => {
  vi.clearAllMocks();
  h.state.acceptedBot = { ...ACCEPTED_BOT };
  h.state.priorFollowRows = [];
  h.state.priorUnfollowRows = [];
  h.state.insertedFollows = [];
  h.state.insertedUnfollows = [];
  h.state.botUpdates = [];
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  logSpy.mockRestore();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// fetchAllFollowing — paginator completeness contract
// ---------------------------------------------------------------------------

describe("fetchAllFollowing", () => {
  it("is complete only when IG returns no next cursor", async () => {
    const client = makeClient([
      friendshipPage(["a", "b"], "cur-1"),
      friendshipPage(["c"], null),
    ]);
    const result = await fetchAllFollowing(client, "pk", "bot-1", "botuser", 10);
    expect(result.complete).toBe(true);
    expect(result.termination).toBe("exhausted");
    expect(result.pagesFetched).toBe(2);
    expect(result.users.map((u) => u.username)).toEqual(["a", "b", "c"]);
  });

  it("is INCOMPLETE when the page budget runs out with a live cursor", async () => {
    const client = makeClient([
      friendshipPage(["a"], "cur-1"),
      friendshipPage(["b"], "cur-2"),
    ]);
    const result = await fetchAllFollowing(client, "pk", "bot-1", "botuser", 2);
    expect(result.complete).toBe(false);
    expect(result.termination).toBe("max-pages");
    expect(result.pagesFetched).toBe(2);
    expect(result.users.map((u) => u.username)).toEqual(["a", "b"]);
  });

  it("returns a partial INCOMPLETE capture on a mid-walk page failure", async () => {
    const client = makeClient([
      friendshipPage(["a", "b"], "cur-1"),
      new Error("IG 500 mid-walk"),
    ]);
    const result = await fetchAllFollowing(client, "pk", "bot-1", "botuser", 10);
    expect(result.complete).toBe(false);
    expect(result.termination).toBe("page-error");
    expect(result.pagesFetched).toBe(1);
    expect(result.users.map((u) => u.username)).toEqual(["a", "b"]);
  });

  it("rethrows when the FIRST page fails (nothing captured)", async () => {
    const boom = new Error("first page down");
    const client = makeClient([boom]);
    await expect(
      fetchAllFollowing(client, "pk", "bot-1", "botuser", 10),
    ).rejects.toBe(boom);
  });
});

// ---------------------------------------------------------------------------
// decideUnfollowGate — pure gate rules
// ---------------------------------------------------------------------------

describe("decideUnfollowGate", () => {
  it("allows a complete capture at >= 90% of the prior baseline", () => {
    const gate = decideUnfollowGate(
      { complete: true, termination: "exhausted", pagesFetched: 3 },
      9,
      10,
    );
    expect(gate.allow).toBe(true);
  });

  it("blocks any incomplete capture regardless of counts", () => {
    const gate = decideUnfollowGate(
      { complete: false, termination: "max-pages", pagesFetched: 10 },
      500,
      400,
    );
    expect(gate).toMatchObject({ allow: false, reason: "incomplete-capture" });
  });

  it("blocks a complete capture below the 90% sanity ratio", () => {
    const gate = decideUnfollowGate(
      { complete: true, termination: "exhausted", pagesFetched: 1 },
      8,
      10,
    );
    expect(gate).toMatchObject({ allow: false, reason: "ratio-failed" });
  });

  it("allows when there is no prior baseline (first capture)", () => {
    const gate = decideUnfollowGate(
      { complete: true, termination: "exhausted", pagesFetched: 1 },
      5,
      0,
    );
    expect(gate.allow).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolvePrivateFollowsMaxPages — env override
// ---------------------------------------------------------------------------

describe("resolvePrivateFollowsMaxPages", () => {
  it("defaults to 10 when unset", () => {
    expect(resolvePrivateFollowsMaxPages()).toBe(
      DEFAULT_PRIVATE_FOLLOWS_MAX_PAGES,
    );
  });

  it("honours PRIVATE_FOLLOWS_MAX_PAGES", () => {
    vi.stubEnv("PRIVATE_FOLLOWS_MAX_PAGES", "40");
    expect(resolvePrivateFollowsMaxPages()).toBe(40);
  });

  it("falls back to the default on junk values", () => {
    vi.stubEnv("PRIVATE_FOLLOWS_MAX_PAGES", "lots");
    expect(resolvePrivateFollowsMaxPages()).toBe(
      DEFAULT_PRIVATE_FOLLOWS_MAX_PAGES,
    );
    vi.stubEnv("PRIVATE_FOLLOWS_MAX_PAGES", "0");
    expect(resolvePrivateFollowsMaxPages()).toBe(
      DEFAULT_PRIVATE_FOLLOWS_MAX_PAGES,
    );
  });
});

// ---------------------------------------------------------------------------
// collectFollowsViaBotSession — end-to-end gating through the diff
// ---------------------------------------------------------------------------

describe("collectFollowsViaBotSession (B12)", () => {
  it("complete capture: unfollows ARE computed alongside new follows", async () => {
    const prior = range(10); // u1..u10
    setPriorFollows(prior);
    // Live: 9 of the 10 prior + 1 newcomer → 10/10 = 1.0 ≥ 0.90, complete.
    const live = [...prior.slice(0, 9), "newbie"];
    const collectors = makeCollectors(makeClient([friendshipPage(live, null)]));

    const count = await collectors.collectFollowsViaBotSession(
      "ta-1",
      "target",
      "sess",
    );

    expect(h.state.insertedFollows.map((r) => r.followedUsername)).toEqual([
      "newbie",
    ]);
    expect(h.state.insertedUnfollows.map((r) => r.unfollowedUsername)).toEqual([
      "u10",
    ]);
    expect(count).toBe(2);
  });

  it("capped capture (max-pages hit): unfollows suppressed, additions kept", async () => {
    vi.stubEnv("PRIVATE_FOLLOWS_MAX_PAGES", "2");
    setPriorFollows(["a", "b", "ghost1", "ghost2"]);
    // Two pages allowed, cursor still live after page 2 → INCOMPLETE.
    // Before the fix, ghost1/ghost2 (beyond the captured window) would have
    // been falsely marked unfollowed.
    const collectors = makeCollectors(
      makeClient([
        friendshipPage(["a", "newbie"], "cur-1"),
        friendshipPage(["b"], "cur-2"),
      ]),
    );

    const count = await collectors.collectFollowsViaBotSession(
      "ta-1",
      "target",
      "sess",
    );

    expect(h.state.insertedUnfollows).toEqual([]);
    expect(h.state.insertedFollows.map((r) => r.followedUsername)).toEqual([
      "newbie",
    ]);
    expect(count).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("incomplete-capture"),
    );
  });

  it("mid-walk page failure: unfollows suppressed, partial additions kept", async () => {
    setPriorFollows(["ghost"]);
    const collectors = makeCollectors(
      makeClient([
        friendshipPage(["kept", "fresh"], "cur-1"),
        new Error("IG 500 mid-walk"),
      ]),
    );

    const count = await collectors.collectFollowsViaBotSession(
      "ta-1",
      "target",
      "sess",
    );

    expect(h.state.insertedUnfollows).toEqual([]);
    expect(h.state.insertedFollows.map((r) => r.followedUsername)).toEqual([
      "kept",
      "fresh",
    ]);
    expect(count).toBe(2);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("incomplete-capture"),
    );
  });

  it("complete but short capture (ratio < 0.90): unfollows suppressed", async () => {
    setPriorFollows(range(10)); // u1..u10
    // IG says "no more pages" but only 2 users came back (wire.fluid class).
    const collectors = makeCollectors(
      makeClient([friendshipPage(["u1", "u2"], null)]),
    );

    const count = await collectors.collectFollowsViaBotSession(
      "ta-1",
      "target",
      "sess",
    );

    expect(h.state.insertedUnfollows).toEqual([]);
    expect(h.state.insertedFollows).toEqual([]);
    expect(count).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("ratio-failed"),
    );
  });

  it("already-unfollowed users are excluded from the prior baseline", async () => {
    setPriorFollows(["u1", "u2", "gone"]);
    h.state.priorUnfollowRows = [{ unfollowedUsername: "gone" }];
    // priorActive = [u1, u2]; live = [u1, u2] → ratio 1.0, complete.
    const collectors = makeCollectors(
      makeClient([friendshipPage(["u1", "u2"], null)]),
    );

    const count = await collectors.collectFollowsViaBotSession(
      "ta-1",
      "target",
      "sess",
    );

    // "gone" must not be re-emitted as a fresh unfollow event.
    expect(h.state.insertedUnfollows).toEqual([]);
    expect(count).toBe(0);
  });
});
