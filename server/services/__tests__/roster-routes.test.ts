// Integration tests for roster.ts (followers / following roster builders).
//
// These tests touch an isolated Postgres database referenced explicitly by
// TEST_DATABASE_URL. Each test inserts fixture rows into a fresh
// tracked_account row keyed by a known UUID and tears them down in afterEach
// via ON DELETE CASCADE on the foreign key from
// {follower,unfollow,follow}_events to tracked_accounts. They never load .env
// or fall back to DATABASE_URL, which may point at production.

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import {
  followEvents,
  followerEvents,
  followerUnfollowEvents,
  trackedAccounts,
  unfollowEvents,
  users,
} from "../../../shared/schema.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL?.trim();
vi.stubEnv(
  "DATABASE_URL",
  TEST_DATABASE_URL || "postgres://mock:mock@localhost/mock",
);

const { db } = await import("../../db.js");
const {
  buildFollowersRoster,
  buildFollowingRoster,
  getFollowersRosterStats,
  getFollowingRosterStats,
} = await import("../roster.js");

const describeWithDatabase = describe.skipIf(!TEST_DATABASE_URL);

// Stable test fixture identifiers — randomized per file load so reruns don't
// collide if a previous run aborted before cleanup.
const TEST_USER_ID = randomUUID();
const TEST_USER_EMAIL = `roster-test-${TEST_USER_ID}@example.test`;
const ACCOUNT_IDS: string[] = [];

async function createAccount(igUsername: string): Promise<string> {
  const id = randomUUID();
  ACCOUNT_IDS.push(id);
  await db.insert(trackedAccounts).values({
    id,
    userId: TEST_USER_ID,
    igUsername,
  });
  return id;
}

async function insertFollower(
  trackedAccountId: string,
  username: string,
  detectedAt: Date,
  extras: {
    displayName?: string | null;
    igUserId?: string | null;
    pfpUrl?: string | null;
  } = {},
): Promise<void> {
  await db.insert(followerEvents).values({
    trackedAccountId,
    followerUsername: username,
    followerDisplayName: extras.displayName ?? null,
    followerIgUserId: extras.igUserId ?? null,
    followerPfpUrl: extras.pfpUrl ?? null,
    detectedAt,
  });
}

async function insertFollowerUnfollow(
  trackedAccountId: string,
  username: string,
  detectedAt: Date,
): Promise<void> {
  await db.insert(followerUnfollowEvents).values({
    trackedAccountId,
    unfollowerUsername: username,
    detectedAt,
  });
}

async function insertFollow(
  trackedAccountId: string,
  username: string,
  detectedAt: Date,
  displayName: string | null = null,
): Promise<void> {
  await db.insert(followEvents).values({
    trackedAccountId,
    followedUsername: username,
    followedDisplayName: displayName,
    detectedAt,
  });
}

async function insertUnfollow(
  trackedAccountId: string,
  username: string,
  detectedAt: Date,
): Promise<void> {
  await db.insert(unfollowEvents).values({
    trackedAccountId,
    unfollowedUsername: username,
    detectedAt,
  });
}

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  // Create a parent user the tracked accounts can FK against.
  //
  // Raw SQL on purpose: drizzle's generated INSERT names every schema column
  // (including users.role added in migration 0018), which fails with
  // `column "role" of relation "users" does not exist` on databases where
  // 0018 has not been applied yet. The roster tests only need the FK parent
  // row, so insert just the columns that exist in every schema version.
  await db.execute(sql`
    INSERT INTO users (id, email, name)
    VALUES (${TEST_USER_ID}, ${TEST_USER_EMAIL}, 'Roster Test User')
  `);
});

afterEach(async () => {
  if (!TEST_DATABASE_URL) return;
  // Cascading delete — removing tracked_accounts wipes all child events.
  for (const id of ACCOUNT_IDS.splice(0)) {
    await db.delete(trackedAccounts).where(eq(trackedAccounts.id, id));
  }
});

// Final cleanup runs after all tests via afterAll-equivalent: just delete
// the test user, which cascades. We bind via a once-only afterEach guard at
// the bottom (vitest doesn't expose afterAll on the file scope without
// importing it, so handle it via a sentinel test).
afterAll(async () => {
  if (!TEST_DATABASE_URL) return;
  await db.delete(users).where(eq(users.id, TEST_USER_ID));
});

// ---------------------------------------------------------------------------
// buildFollowersRoster
// ---------------------------------------------------------------------------

describeWithDatabase("buildFollowersRoster", () => {
  let accountId: string;

  beforeEach(async () => {
    accountId = await createAccount(`roster_test_${randomUUID().slice(0, 8)}`);
  });

  it("returns empty page when no events exist", async () => {
    const page = await buildFollowersRoster(accountId);
    expect(page).toEqual({
      items: [],
      nextCursor: null,
      total: 0,
      lastUpdatedAt: null,
    });
  });

  it("excludes usernames present in follower_unfollow_events (case-insensitive)", async () => {
    const t0 = new Date("2026-04-01T00:00:00Z");
    const t1 = new Date("2026-04-02T00:00:00Z");
    const t2 = new Date("2026-04-03T00:00:00Z");

    await insertFollower(accountId, "alice", t0);
    await insertFollower(accountId, "Bob", t1);
    await insertFollower(accountId, "carol", t2);

    // Unfollow with different casing — must still be excluded.
    await insertFollowerUnfollow(accountId, "BOB", new Date("2026-04-04T00:00:00Z"));

    const page = await buildFollowersRoster(accountId);

    expect(page.total).toBe(2);
    const usernames = page.items.map((i) => i.username.toLowerCase()).sort();
    expect(usernames).toEqual(["alice", "carol"]);
    expect(page.nextCursor).toBeNull();
  });

  it("includes a follower again when a newer follower event exists after an unfollow", async () => {
    const t0 = new Date("2026-04-01T00:00:00Z");
    const t1 = new Date("2026-04-02T00:00:00Z");
    const t2 = new Date("2026-04-03T00:00:00Z");

    await insertFollower(accountId, "alice", t0);
    await insertFollowerUnfollow(accountId, "ALICE", t1);
    await insertFollower(accountId, "Alice", t2, {
      displayName: "Alice Refollowed",
      igUserId: "alice-2",
      pfpUrl: "https://example.test/alice.jpg",
    });

    const page = await buildFollowersRoster(accountId);

    expect(page.total).toBe(1);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      username: "Alice",
      displayName: "Alice Refollowed",
      igUserId: "alice-2",
      pfpUrl: "https://example.test/alice.jpg",
      firstSeenAt: t2.toISOString(),
    });
  });

  it("dedupes duplicate usernames: earliest detectedAt wins for firstSeenAt, latest non-null display fields preferred", async () => {
    const earliest = new Date("2026-03-01T00:00:00Z");
    const middle = new Date("2026-03-15T00:00:00Z");
    const latest = new Date("2026-03-30T00:00:00Z");

    // Earliest row has display data but stale.
    await insertFollower(accountId, "dave", earliest, {
      displayName: "Old Dave",
      igUserId: "111",
      pfpUrl: "https://old.example/pfp.jpg",
    });

    // Middle row has no display data at all.
    await insertFollower(accountId, "dave", middle);

    // Latest row has fresh display data.
    await insertFollower(accountId, "dave", latest, {
      displayName: "New Dave",
      igUserId: "222",
      pfpUrl: "https://new.example/pfp.jpg",
    });

    const page = await buildFollowersRoster(accountId);

    expect(page.total).toBe(1);
    expect(page.items).toHaveLength(1);
    const [entry] = page.items;
    expect(entry.username.toLowerCase()).toBe("dave");
    // firstSeenAt should be the earliest detectedAt.
    expect(entry.firstSeenAt).toBe(earliest.toISOString());
    // Display fields should come from the latest non-null row.
    expect(entry.displayName).toBe("New Dave");
    expect(entry.igUserId).toBe("222");
    expect(entry.pfpUrl).toBe("https://new.example/pfp.jpg");
  });

  it("paginates correctly via cursor", async () => {
    // 7 entries with strictly increasing detectedAt — newest first in result.
    const base = new Date("2026-01-01T00:00:00Z").getTime();
    const usernames = ["u1", "u2", "u3", "u4", "u5", "u6", "u7"];
    for (let i = 0; i < usernames.length; i++) {
      await insertFollower(
        accountId,
        usernames[i],
        // Stagger by 1 hour each.
        new Date(base + i * 3600_000),
      );
    }

    // Page 1: limit=3 → most recent 3 (u7, u6, u5) and a cursor.
    const page1 = await buildFollowersRoster(accountId, { limit: 3 });
    expect(page1.total).toBe(7);
    expect(page1.items).toHaveLength(3);
    expect(page1.items.map((i) => i.username)).toEqual(["u7", "u6", "u5"]);
    expect(page1.nextCursor).not.toBeNull();
    // Composite opaque cursor: `${firstSeenAtIso}|${usernameLower}`.
    expect(page1.nextCursor).toBe(`${page1.items[2].firstSeenAt}|u5`);

    // Page 2: cursor from page 1 → next 3 (u4, u3, u2).
    const page2 = await buildFollowersRoster(accountId, {
      limit: 3,
      cursor: page1.nextCursor!,
    });
    expect(page2.total).toBe(7);
    expect(page2.items).toHaveLength(3);
    expect(page2.items.map((i) => i.username)).toEqual(["u4", "u3", "u2"]);
    expect(page2.nextCursor).toBe(`${page2.items[2].firstSeenAt}|u2`);

    // Page 3: cursor from page 2 → final 1 (u1) and null cursor.
    const page3 = await buildFollowersRoster(accountId, {
      limit: 3,
      cursor: page2.nextCursor!,
    });
    expect(page3.total).toBe(7);
    expect(page3.items).toHaveLength(1);
    expect(page3.items.map((i) => i.username)).toEqual(["u1"]);
    expect(page3.nextCursor).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildFollowingRoster
// ---------------------------------------------------------------------------

describeWithDatabase("buildFollowingRoster", () => {
  let accountId: string;

  beforeEach(async () => {
    accountId = await createAccount(`roster_test_${randomUUID().slice(0, 8)}`);
  });

  it("excludes usernames present in unfollow_events (case-insensitive)", async () => {
    const t0 = new Date("2026-04-01T00:00:00Z");
    const t1 = new Date("2026-04-02T00:00:00Z");
    const t2 = new Date("2026-04-03T00:00:00Z");

    await insertFollow(accountId, "alpha", t0);
    await insertFollow(accountId, "Beta", t1, "Beta Display");
    await insertFollow(accountId, "gamma", t2);

    await insertUnfollow(accountId, "BETA", new Date("2026-04-04T00:00:00Z"));

    const page = await buildFollowingRoster(accountId);

    expect(page.total).toBe(2);
    expect(page.nextCursor).toBeNull();
    const usernames = page.items.map((i) => i.username.toLowerCase()).sort();
    expect(usernames).toEqual(["alpha", "gamma"]);
    // Following entries should NOT include pfpUrl / igUserId fields.
    for (const item of page.items) {
      expect(item).not.toHaveProperty("pfpUrl");
      expect(item).not.toHaveProperty("igUserId");
    }
  });

  it("includes a followed account again when a newer follow event exists after an unfollow", async () => {
    const t0 = new Date("2026-04-01T00:00:00Z");
    const t1 = new Date("2026-04-02T00:00:00Z");
    const t2 = new Date("2026-04-03T00:00:00Z");

    await insertFollow(accountId, "alpha", t0, "Alpha Old");
    await insertUnfollow(accountId, "ALPHA", t1);
    await insertFollow(accountId, "Alpha", t2, "Alpha Refollowed");

    const page = await buildFollowingRoster(accountId);

    expect(page.total).toBe(1);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      username: "Alpha",
      displayName: "Alpha Refollowed",
      firstSeenAt: t2.toISOString(),
    });
    expect(page.items[0]).not.toHaveProperty("pfpUrl");
    expect(page.items[0]).not.toHaveProperty("igUserId");
  });

  it("returns empty page when no events exist", async () => {
    const page = await buildFollowingRoster(accountId);
    expect(page).toEqual({
      items: [],
      nextCursor: null,
      total: 0,
      lastUpdatedAt: null,
    });
  });
});

// ---------------------------------------------------------------------------
// Tie-breaking parity (old JS semantics: a follow at detected_at <= the
// latest unfollow's detected_at is shadowed by that unfollow)
// ---------------------------------------------------------------------------

describeWithDatabase("detected_at tie-breaking", () => {
  let accountId: string;

  beforeEach(async () => {
    accountId = await createAccount(`roster_test_${randomUUID().slice(0, 8)}`);
  });

  it("treats a follower event at the exact unfollow timestamp as unfollowed", async () => {
    const t0 = new Date("2026-04-01T00:00:00Z");
    const tie = new Date("2026-04-02T00:00:00Z");

    await insertFollower(accountId, "eve", t0);
    // Unfollow and a re-follow share the same detected_at — the unfollow
    // wins (old JS skipped rows with detectedMs <= latestUnfollowMs).
    await insertFollowerUnfollow(accountId, "eve", tie);
    await insertFollower(accountId, "eve", tie);

    const page = await buildFollowersRoster(accountId);
    expect(page.total).toBe(0);
    expect(page.items).toEqual([]);

    // A strictly newer follow row resurrects the entry.
    const t2 = new Date("2026-04-03T00:00:00Z");
    await insertFollower(accountId, "eve", t2);
    const page2 = await buildFollowersRoster(accountId);
    expect(page2.total).toBe(1);
    expect(page2.items[0].firstSeenAt).toBe(t2.toISOString());
  });

  it("treats a follow event at the exact unfollow timestamp as unfollowed (following)", async () => {
    const tie = new Date("2026-04-02T00:00:00Z");
    await insertFollow(accountId, "frank", tie);
    await insertUnfollow(accountId, "FRANK", tie);

    const page = await buildFollowingRoster(accountId);
    expect(page.total).toBe(0);
  });

  it("orders entries with identical firstSeenAt deterministically (username ASC)", async () => {
    const t = new Date("2026-04-01T00:00:00Z");
    await insertFollower(accountId, "zoe", t);
    await insertFollower(accountId, "anna", t);
    await insertFollower(accountId, "mike", t);

    const page = await buildFollowersRoster(accountId);
    expect(page.total).toBe(3);
    expect(page.items.map((i) => i.username)).toEqual(["anna", "mike", "zoe"]);
  });
});

// ---------------------------------------------------------------------------
// Cursor pagination: boundary ties and legacy (bare-ISO) cursors
//
// Bulk diff inserts give thousands of entries the same detected_at. The
// composite cursor (`${firstSeenAtIso}|${usernameLower}`) must resume exactly
// after the last returned row across such ties. Legacy bare-ISO cursors keep
// the old strict-< semantics (which drop tied rows) for clients that still
// hold a pre-composite cursor.
// ---------------------------------------------------------------------------

describeWithDatabase("cursor pagination across firstSeenAt ties", () => {
  let accountId: string;

  beforeEach(async () => {
    accountId = await createAccount(`roster_test_${randomUUID().slice(0, 8)}`);
  });

  it("walks a tie group spanning multiple page boundaries without skips or duplicates", async () => {
    const tied = new Date("2026-04-01T00:00:00Z");
    const newer = new Date("2026-04-01T01:00:00Z");

    // 5 entries share the same detected_at; 1 strictly newer entry on top.
    for (const u of ["a", "b", "c", "d", "e"]) {
      await insertFollower(accountId, u, tied);
    }
    await insertFollower(accountId, "newer", newer);

    // Page 1: newest first, then ties in username ASC. Boundary lands
    // mid-tie-group: cursor must encode ("a") so page 2 starts at "b".
    const page1 = await buildFollowersRoster(accountId, { limit: 2 });
    expect(page1.total).toBe(6);
    expect(page1.items.map((i) => i.username)).toEqual(["newer", "a"]);
    expect(page1.nextCursor).toBe(`${tied.toISOString()}|a`);

    const page2 = await buildFollowersRoster(accountId, {
      limit: 2,
      cursor: page1.nextCursor!,
    });
    expect(page2.items.map((i) => i.username)).toEqual(["b", "c"]);
    expect(page2.nextCursor).toBe(`${tied.toISOString()}|c`);

    const page3 = await buildFollowersRoster(accountId, {
      limit: 2,
      cursor: page2.nextCursor!,
    });
    expect(page3.items.map((i) => i.username)).toEqual(["d", "e"]);
    // Exactly `limit` rows returned, so a cursor is emitted even though the
    // roster is exhausted — the follow-up page is empty with a null cursor.
    expect(page3.nextCursor).toBe(`${tied.toISOString()}|e`);

    const page4 = await buildFollowersRoster(accountId, {
      limit: 2,
      cursor: page3.nextCursor!,
    });
    expect(page4.items).toEqual([]);
    expect(page4.nextCursor).toBeNull();
    expect(page4.total).toBe(6);

    // Union across pages covers every entry exactly once.
    const seen = [...page1.items, ...page2.items, ...page3.items].map(
      (i) => i.username,
    );
    expect(new Set(seen).size).toBe(6);
  });

  it("paginates ties on the following roster with the composite cursor", async () => {
    const tied = new Date("2026-04-01T00:00:00Z");
    for (const u of ["x1", "x2", "x3"]) {
      await insertFollow(accountId, u, tied);
    }

    const page1 = await buildFollowingRoster(accountId, { limit: 2 });
    expect(page1.items.map((i) => i.username)).toEqual(["x1", "x2"]);
    expect(page1.nextCursor).toBe(`${tied.toISOString()}|x2`);

    const page2 = await buildFollowingRoster(accountId, {
      limit: 2,
      cursor: page1.nextCursor!,
    });
    expect(page2.items.map((i) => i.username)).toEqual(["x3"]);
    expect(page2.nextCursor).toBeNull();
  });
});

describeWithDatabase("legacy and malformed cursors", () => {
  let accountId: string;

  beforeEach(async () => {
    accountId = await createAccount(`roster_test_${randomUUID().slice(0, 8)}`);
  });

  it("accepts a legacy bare-ISO cursor with the old strict-< semantics", async () => {
    const base = new Date("2026-01-01T00:00:00Z").getTime();
    // Strictly distinct timestamps — legacy and composite agree here.
    for (let i = 1; i <= 4; i++) {
      await insertFollower(accountId, `u${i}`, new Date(base + i * 3600_000));
    }

    const page1 = await buildFollowersRoster(accountId, { limit: 2 });
    expect(page1.items.map((i) => i.username)).toEqual(["u4", "u3"]);

    // A pre-composite client holds the bare firstSeenAt of the last row.
    const legacyCursor = page1.items[1].firstSeenAt;
    const page2 = await buildFollowersRoster(accountId, {
      limit: 2,
      cursor: legacyCursor,
    });
    expect(page2.items.map((i) => i.username)).toEqual(["u2", "u1"]);
    expect(page2.total).toBe(4);
  });

  it("legacy bare-ISO cursor drops rows tied at the cursor timestamp (documented old behavior)", async () => {
    const tied = new Date("2026-04-01T00:00:00Z");
    const older = new Date("2026-03-01T00:00:00Z");
    for (const u of ["a", "b", "c"]) {
      await insertFollower(accountId, u, tied);
    }
    await insertFollower(accountId, "old", older);

    // Legacy cursor at the tie timestamp: strict-< skips ALL tied rows
    // ("b", "c" are lost) — exactly what the old JS pagination did. New
    // clients get the composite cursor and do not hit this.
    const page = await buildFollowersRoster(accountId, {
      limit: 2,
      cursor: tied.toISOString(),
    });
    expect(page.items.map((i) => i.username)).toEqual(["old"]);
    expect(page.total).toBe(4);
  });

  it("treats an unparseable cursor as no cursor (first page)", async () => {
    const t = new Date("2026-04-01T00:00:00Z");
    await insertFollower(accountId, "solo", t);

    for (const bad of ["not-a-date", "not-a-date|solo", "|solo", ""]) {
      const page = await buildFollowersRoster(accountId, {
        limit: 5,
        cursor: bad,
      });
      expect(page.items.map((i) => i.username)).toEqual(["solo"]);
      expect(page.total).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Stats functions (D4): must agree exactly with the paged builders' totals
// ---------------------------------------------------------------------------

describeWithDatabase("getFollowersRosterStats / getFollowingRosterStats", () => {
  let accountId: string;

  beforeEach(async () => {
    accountId = await createAccount(`roster_test_${randomUUID().slice(0, 8)}`);
  });

  it("returns zeros for an account with no events", async () => {
    expect(await getFollowersRosterStats(accountId)).toEqual({
      total: 0,
      lastUpdatedAt: null,
    });
    expect(await getFollowingRosterStats(accountId)).toEqual({
      total: 0,
      lastUpdatedAt: null,
    });
  });

  it("matches buildFollowersRoster total/lastUpdatedAt incl. unfollow exclusions", async () => {
    const t0 = new Date("2026-04-01T00:00:00Z");
    const t1 = new Date("2026-04-02T00:00:00Z");
    const t2 = new Date("2026-04-03T00:00:00Z");

    await insertFollower(accountId, "alice", t0);
    await insertFollower(accountId, "bob", t1);
    await insertFollower(accountId, "carol", t2);
    await insertFollowerUnfollow(accountId, "BOB", new Date("2026-04-04T00:00:00Z"));

    const [stats, page] = await Promise.all([
      getFollowersRosterStats(accountId),
      buildFollowersRoster(accountId),
    ]);
    expect(stats.total).toBe(page.total);
    expect(stats.lastUpdatedAt).toBe(page.lastUpdatedAt);
    expect(stats).toEqual({ total: 2, lastUpdatedAt: t2.toISOString() });
  });

  it("matches buildFollowingRoster total/lastUpdatedAt incl. refollow epochs", async () => {
    const t0 = new Date("2026-04-01T00:00:00Z");
    const t1 = new Date("2026-04-02T00:00:00Z");
    const t2 = new Date("2026-04-03T00:00:00Z");

    await insertFollow(accountId, "alpha", t0);
    await insertUnfollow(accountId, "alpha", t1);
    await insertFollow(accountId, "alpha", t2);
    await insertFollow(accountId, "beta", t0);

    const [stats, page] = await Promise.all([
      getFollowingRosterStats(accountId),
      buildFollowingRoster(accountId),
    ]);
    expect(stats.total).toBe(page.total);
    expect(stats.lastUpdatedAt).toBe(page.lastUpdatedAt);
    // alpha's refollow at t2 is the most recent roster entry.
    expect(stats).toEqual({ total: 2, lastUpdatedAt: t2.toISOString() });
  });
});
