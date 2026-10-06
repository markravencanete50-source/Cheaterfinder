// Unit tests for pagination wrappers in server/services/public-data-service.ts.
//
// We mock the inner `scrapeUserFollowers` / `scrapeUserFollowing` functions
// from `ig-public-scraper.js` and the `runBot` retry path so each page call
// resolves directly with the mocked page. This keeps the test deterministic
// and avoids touching the bot pool, DB, or network.
//
// Coverage targets:
//   - happy path: 3 pages of (50, 50, 30) → 130 users total
//   - maxItems cap: stop accumulating beyond cap
//   - maxPages cap: stop walking after N pages even if cursor present
//   - mid-walk failure: first page ok, second throws → partial-success
//   - first-page failure: surface { ok: false }

import { describe, it, expect, beforeEach, vi } from "vitest";
import { resetFollowCaptureShare } from "../follow-capture-share.js";
import { viewerAffinity } from "../viewer-affinity.js";
import { withScrapeRetry } from "../scrape-retry.js";

// ─── Env / module-load order stubs ──────────────────────────────────────────
//
// public-data-service.ts pulls in observability/logger and scrape-retry; we
// stub both so the tested module loads cleanly without any I/O side effects.

vi.stubEnv("DATABASE_URL", "postgres://mock:mock@localhost/mock");
// Pin the mid-walk retry budget so call-count assertions stay deterministic
// regardless of the production default (env-tunable, defaults higher in prod).
vi.stubEnv("FOLLOW_MIDWALK_RETRY_BUDGET", "3");

vi.mock("../../observability/logger.js", () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

// scrape-retry pass-through: invoke the bot fn directly. This makes runBot
// a single-attempt call to the underlying scraper, which is exactly what we
// want for paginate logic tests.
vi.mock("../scrape-retry.js", () => ({
  withScrapeRetry: vi.fn(async (_label: string, fn: () => Promise<unknown>) =>
    fn(),
  ),
}));

// scrape-metrics shouldn't fire in tests.
vi.mock("../scrape-metrics.js", () => ({
  recordOutcome: vi.fn(),
}));

// bot-cooldown imports db.js at module load (which throws without a real
// DATABASE_URL before vi.stubEnv applies, since static imports hoist). Mock
// it with a passthrough rotation-policy wrapper.
vi.mock("../bot-cooldown.js", () => ({
  withRotationRateLimitCooldownPolicy: vi.fn(
    async (fn: () => Promise<unknown>) => fn(),
  ),
  cooldownBotForRateLimit: vi.fn(),
  cooldownBotForCheckpoint: vi.fn(),
  resolveRateLimitCooldownMs: vi.fn(),
}));

// IG http-client error shapes are referenced in the runBot rotation guard.
vi.mock("../../ig-http-client.js", () => ({
  IGAuthExpiredError: class IGAuthExpiredError extends Error {},
  IGHttpError: class IGHttpError extends Error {
    status: number = 0;
    igErrorCode?: string;
  },
}));

// ─── Mocked scraper boundary ────────────────────────────────────────────────
//
// We replace `scrapeUserFollowers` and `scrapeUserFollowing` with vi.fn()
// stubs that the individual tests configure per-case. The IGPublicScraperError
// class is preserved so runBot's `instanceof` rotation guard still works.
// vi.hoisted ensures the stubs exist before vi.mock factories execute.

const { scrapeUserFollowers, scrapeUserFollowing } = vi.hoisted(() => ({
  scrapeUserFollowers: vi.fn(),
  scrapeUserFollowing: vi.fn(),
}));

vi.mock("../../ig-public-scraper.js", () => ({
  scrapeProfile: vi.fn(),
  scrapeUserPosts: vi.fn(),
  scrapeUserClips: vi.fn(),
  scrapeUserTagged: vi.fn(),
  scrapeUserStories: vi.fn(),
  scrapeUserHighlights: vi.fn(),
  scrapeUserFollowers,
  scrapeUserFollowing,
  IGPublicScraperError: class IGPublicScraperError extends Error {
    cause?: unknown;
    constructor(message: string, cause?: unknown) {
      super(message);
      this.name = "IGPublicScraperError";
      this.cause = cause;
    }
  },
  IGListRestrictedError: class IGListRestrictedError extends Error {
    botId?: string;
    constructor(_kind: string, _igUserId: string, botId?: string) {
      super("list restricted");
      this.botId = botId;
    }
  },
}));

// Module under test imported AFTER the mocks above.
import {
  getAllUserFollowers,
  getAllUserFollowing,
  __setMidwalkRetrySleepForTests,
} from "../public-data-service.js";

// ─── Test helpers ───────────────────────────────────────────────────────────

interface FollowUser {
  readonly igUserId: string;
  readonly username: string;
  readonly fullName: string;
  readonly profilePicUrl: string;
  readonly isPrivate: boolean;
  readonly isVerified: boolean;
}

function buildUsers(count: number, prefix: string): ReadonlyArray<FollowUser> {
  return Array.from({ length: count }, (_, i) => ({
    igUserId: `${prefix}-${i}`,
    username: `${prefix}_${i}`,
    fullName: `User ${prefix}-${i}`,
    profilePicUrl: "",
    isPrivate: false,
    isVerified: false,
  }));
}

// Run paginations with no actual sleep so the test suite stays fast.
const FAST_PAGINATION = {
  pageDelayMinMs: 0,
  pageDelayMaxMs: 0,
};

beforeEach(() => {
  vi.stubEnv("ROSTER_PIN_VIEWER_TARGETS", "");
  resetFollowCaptureShare();
  scrapeUserFollowers.mockReset();
  scrapeUserFollowing.mockReset();
  // Skip the mid-walk retry backoff (real one is up to ~60s/retry).
  __setMidwalkRetrySleepForTests(async () => {});
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("roster viewer canary wiring", () => {
  it("pins only following pages for a following-qualified target", async () => {
    vi.stubEnv("ROSTER_PIN_VIEWER_TARGETS", "acct:following");
    const followingViewers: Array<string | undefined> = [];
    scrapeUserFollowing.mockImplementation(async (_id, cursor) => {
      const viewer = viewerAffinity();
      expect(viewer?.pin).toBe(true);
      followingViewers.push(viewer?.botId);
      // The actual lease layer pins after its first successful request.
      if (viewer) viewer.botId = "proven-reader";
      return { users: buildUsers(2, cursor ? "second" : "first"), nextCursor: cursor ? null : "NEXT" };
    });
    const result = await getAllUserFollowing("ig-1", { ...FAST_PAGINATION, fallbackUsername: "acct" });
    expect(followingViewers).toEqual([undefined, "proven-reader"]);
    expect(result).toMatchObject({ ok: true, complete: true, viewerBotId: "proven-reader" });
    scrapeUserFollowers.mockImplementation(async () => {
      expect(viewerAffinity()).toBeUndefined();
      return { users: buildUsers(2, "followers"), nextCursor: null };
    });
    await getAllUserFollowers("acct", "ig-1", FAST_PAGINATION);
    expect(scrapeUserFollowers).toHaveBeenCalledTimes(1);
    expect(viewerAffinity()).toBeUndefined();
  });

  it("restores the saved reader for an opted-in continuation", async () => {
    vi.stubEnv("ROSTER_PIN_VIEWER_TARGETS", "acct:following");
    scrapeUserFollowing.mockImplementation(async (_id, cursor) => {
      expect(cursor).toBe("RESUME");
      expect(viewerAffinity()).toMatchObject({ pin: true, botId: "saved-reader" });
      return { users: buildUsers(2, "last"), nextCursor: null };
    });
    const result = await getAllUserFollowing("ig-1", {
      ...FAST_PAGINATION, fallbackUsername: "acct", startCursor: "RESUME", viewerBotId: "saved-reader",
    });
    expect(result).toMatchObject({ ok: true, complete: true, startedFromTop: false, viewerBotId: "saved-reader" });
  });
});

describe("getAllUserFollowers — pagination", () => {
  it("bounded mode does not turn a failed page into nested retries or lose its cursor",async()=>{
    scrapeUserFollowers.mockResolvedValueOnce({users:buildUsers(50,"saved"),nextCursor:"gql:UNREAD"})
      .mockRejectedValue(new Error("temporary failure"));
    const result=await getAllUserFollowers("acct","bounded-retry",{...FAST_PAGINATION,pinViewer:true,rosterSource:"graphql",nativeOnly:true,savedSessionOnly:true,maxPages:5,maxMidwalkRetries:0});
    expect(result).toMatchObject({ok:true,complete:false,pagesFetched:2,pagesSucceeded:1,stopReason:"page_error",nextCursor:"gql:UNREAD"});
    expect(scrapeUserFollowers).toHaveBeenCalledTimes(2);
    expect(vi.mocked(withScrapeRetry).mock.calls.at(-1)?.[2]).toEqual({maxAttempts:1});
  });
  it("retains a limited REST preview without claiming cursor exhaustion or completeness", async () => {
    scrapeUserFollowers.mockResolvedValue({ users: buildUsers(48,"preview"), nextCursor:null,sourceLimited:true });
    const result = await getAllUserFollowers("acct","limited",FAST_PAGINATION);
    expect(result).toMatchObject({ok:true,complete:false,stopReason:"source_limited",nextCursor:null});
    if(result.ok) expect(result.data).toHaveLength(48);
    expect(scrapeUserFollowers).toHaveBeenCalledTimes(1);
  });
  it("explicit GraphQL starts a new epoch, pins its own viewer and does not leak context", async () => {
    scrapeUserFollowers.mockImplementation(async (_id,cursor) => {
      expect(cursor).toBeUndefined();
      expect(viewerAffinity()).toMatchObject({pin:true,rosterSource:"graphql",savedSessionOnly:true});
      viewerAffinity()!.botId="reader";
      return {users:buildUsers(50,"gql"),nextCursor:"gql:OWN"};
    });
    const result=await getAllUserFollowers("acct","gql",{...FAST_PAGINATION,pinViewer:true,rosterSource:"graphql",savedSessionOnly:true,nativeOnly:true,maxPages:1});
    expect(result).toMatchObject({ok:true,startedFromTop:true,complete:false,nextCursor:"gql:OWN",viewerBotId:"reader"});
    expect(viewerAffinity()).toBeUndefined();
  });
  it("deadline stop preserves the first unread cursor without a complete-read claim", async () => {
    scrapeUserFollowers.mockResolvedValue({users:buildUsers(2,"deadline"),nextCursor:"UNREAD"});
    const result=await getAllUserFollowers("acct","deadline",{...FAST_PAGINATION,shouldStop:()=>true,stopReasonWhenRequested:"time_budget"});
    expect(result).toMatchObject({ok:true,complete:false,stopReason:"time_budget",nextCursor:"UNREAD"});
    expect(scrapeUserFollowers).toHaveBeenCalledTimes(1);
  });
  it("does not share captures across different page bounds or explicit sources", async () => {
    scrapeUserFollowers.mockResolvedValue({users:buildUsers(2,"shared"),nextCursor:null});
    await getAllUserFollowers("acct","bounds",{...FAST_PAGINATION,maxPages:1,pinViewer:true});
    await getAllUserFollowers("acct","bounds",{...FAST_PAGINATION,maxPages:5,pinViewer:true});
    await getAllUserFollowers("acct","bounds",{...FAST_PAGINATION,maxPages:5,pinViewer:true,rosterSource:"graphql"});
    expect(scrapeUserFollowers).toHaveBeenCalledTimes(3);
  });
  it("counts distinct members against the cap and retains raw page telemetry", async () => {
    const repeated = buildUsers(50, "shared");
    scrapeUserFollowers.mockResolvedValueOnce({ users: repeated, nextCursor: "A" })
      .mockResolvedValueOnce({ users: [...repeated, ...buildUsers(50, "new")], nextCursor: null });
    const result = await getAllUserFollowers("acct", "ig-1", { ...FAST_PAGINATION, maxItems: 100 });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected capture");
    expect(result.data).toHaveLength(100);
    expect(result.rawItemsFetched).toBe(150);
    expect(result.pagesFetched).toBe(2);
    expect(result.complete).toBe(true);
  });

  it("does not declare a repeated cursor complete", async () => {
    scrapeUserFollowers.mockResolvedValueOnce({ users: buildUsers(2, "p1"), nextCursor: "A" })
      .mockResolvedValueOnce({ users: buildUsers(2, "p2"), nextCursor: "A" });
    const result = await getAllUserFollowers("acct", "ig-1", { ...FAST_PAGINATION });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected partial capture");
    expect(result.complete).toBe(false);
    expect(result.stopReason).toBe("page_error");
    expect(scrapeUserFollowers).toHaveBeenCalledTimes(2);
  });

  it("walks every page until nextCursor is null", async () => {
    const page1 = { users: buildUsers(50, "p1"), nextCursor: "A" };
    const page2 = { users: buildUsers(50, "p2"), nextCursor: "B" };
    const page3 = { users: buildUsers(30, "p3"), nextCursor: null };

    scrapeUserFollowers
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce(page2)
      .mockResolvedValueOnce(page3);

    const result = await getAllUserFollowers("acct", "ig-1", {
      ...FAST_PAGINATION,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok=true");
    expect(result.data).toHaveLength(130);
    expect(result.complete).toBe(true);
    expect(result.stopReason).toBe("exhausted");
    expect(scrapeUserFollowers).toHaveBeenCalledTimes(3);
    expect(scrapeUserFollowers).toHaveBeenNthCalledWith(
      1,
      "ig-1",
      undefined,
      expect.any(Set),
    );
    expect(scrapeUserFollowers).toHaveBeenNthCalledWith(
      2,
      "ig-1",
      "A",
      expect.any(Set),
    );
    expect(scrapeUserFollowers).toHaveBeenNthCalledWith(
      3,
      "ig-1",
      "B",
      expect.any(Set),
    );
  });

  it("respects maxItems cap", async () => {
    scrapeUserFollowers.mockImplementation(async (_id: string, cursor?: string) => ({
      users: buildUsers(50, `c-${cursor ?? "first"}`),
      nextCursor: `next-${cursor ?? "first"}`,
    }));

    const result = await getAllUserFollowers("acct", "ig-2", {
      maxItems: 100,
      ...FAST_PAGINATION,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok=true");
    expect(result.data).toHaveLength(100);
    // Page1 (50) → page2 (50) hits cap; we should not call a third time.
    expect(scrapeUserFollowers).toHaveBeenCalledTimes(2);
    // Cursor still present → capture is TRUNCATED by the item cap.
    expect(result.complete).toBe(false);
    expect(result.stopReason).toBe("item_cap");
  });

  it("item cap landing exactly on the final page (null cursor) is complete", async () => {
    const page1 = { users: buildUsers(50, "x1"), nextCursor: "A" };
    const page2 = { users: buildUsers(50, "x2"), nextCursor: null };

    scrapeUserFollowers
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce(page2);

    const result = await getAllUserFollowers("acct", "ig-2b", {
      maxItems: 100,
      ...FAST_PAGINATION,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok=true");
    expect(result.data).toHaveLength(100);
    // Nothing was dropped and no pages remained — full roster captured.
    expect(result.complete).toBe(true);
    expect(result.stopReason).toBe("exhausted");
  });

  it("respects maxPages cap", async () => {
    scrapeUserFollowers.mockImplementation(async (_id: string, cursor?: string) => ({
      users: buildUsers(50, `mp-${cursor ?? "first"}`),
      nextCursor: `next-${cursor ?? "first"}`,
    }));

    const result = await getAllUserFollowers("acct", "ig-3", {
      maxPages: 3,
      ...FAST_PAGINATION,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok=true");
    expect(result.data).toHaveLength(150);
    expect(scrapeUserFollowers).toHaveBeenCalledTimes(3);
    expect(result.complete).toBe(false);
    expect(result.stopReason).toBe("page_cap");
  });

  it("mid-walk failure returns partial success", async () => {
    const page1 = { users: buildUsers(50, "ok"), nextCursor: "A" };
    scrapeUserFollowers
      .mockResolvedValueOnce(page1)
      .mockRejectedValue(new Error("boom"));

    const result = await getAllUserFollowers("acct", "ig-4", {
      ...FAST_PAGINATION,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok=true (graceful degradation)");
    expect(result.data).toHaveLength(50);
    // Partial data is surfaced but explicitly marked truncated.
    expect(result.complete).toBe(false);
    expect(result.stopReason).toBe("page_error");
  });

  it("first-page failure surfaces error", async () => {
    scrapeUserFollowers.mockRejectedValue(new Error("auth expired"));

    const result = await getAllUserFollowers("acct", "ig-5", {
      ...FAST_PAGINATION,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok=false");
    expect(result.error).toMatch(/auth expired/i);
  });
});

describe("getAllUserFollowing — pagination", () => {
  it("walks every page using getUserFollowing under the hood", async () => {
    const page1 = { users: buildUsers(50, "f1"), nextCursor: "A" };
    const page2 = { users: buildUsers(20, "f2"), nextCursor: null };

    scrapeUserFollowing
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce(page2);

    const result = await getAllUserFollowing("ig-99", { ...FAST_PAGINATION });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok=true");
    expect(result.data).toHaveLength(70);
    expect(result.complete).toBe(true);
    expect(result.stopReason).toBe("exhausted");
    expect(scrapeUserFollowing).toHaveBeenCalledTimes(2);
    expect(scrapeUserFollowing).toHaveBeenNthCalledWith(
      1,
      "ig-99",
      undefined,
      expect.any(Set),
    );
    expect(scrapeUserFollowing).toHaveBeenNthCalledWith(
      2,
      "ig-99",
      "A",
      expect.any(Set),
    );
  });
});

// ─── Resume points (migration 0039) ─────────────────────────────────────────
//
// A large roster cannot be enumerated in one walk (lesson 7), so a truncated
// walk reports the cursor the NEXT walk should start from and the collector
// persists it. These tests pin the two halves of that contract: the walk starts
// where it was told to, and it hands back a resume point that actually advances
// (never one that re-reads a page we already paid for).

describe("follow pagination — resume points", () => {
  it("starts the walk at the persisted cursor instead of page 1", async () => {
    scrapeUserFollowers.mockResolvedValueOnce({
      users: buildUsers(30, "resumed"),
      nextCursor: null,
    });

    const result = await getAllUserFollowers("acct", "ig-resume-1", {
      startCursor: "PAGE_11",
      ...FAST_PAGINATION,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok=true");
    expect(result.data).toHaveLength(30);
    expect(scrapeUserFollowers).toHaveBeenCalledTimes(1);
    expect(scrapeUserFollowers).toHaveBeenNthCalledWith(
      1,
      "ig-resume-1",
      "PAGE_11",
      expect.any(Set),
    );
    // Cursor exhausted → clear the resume point, next cycle starts a fresh pass.
    expect(result.nextCursor).toBeNull();
    expect(result.startedFromTop).toBe(false);
  });

  it("resumes AFTER the last page when the page cap stops the walk", async () => {
    scrapeUserFollowers.mockImplementation(
      async (_id: string, cursor?: string) => ({
        users: buildUsers(50, `pc-${cursor ?? "first"}`),
        nextCursor: `next-${cursor ?? "first"}`,
      }),
    );

    const result = await getAllUserFollowers("acct", "ig-resume-2", {
      maxPages: 3,
      ...FAST_PAGINATION,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok=true");
    expect(result.stopReason).toBe("page_cap");
    // Page 3 was captured in full, so the resume point is the page after it —
    // resuming on page 3's own cursor would re-read a page we already have.
    expect(result.nextCursor).toBe("next-next-next-first");
  });

  it("re-reads the capped page when the item cap cut it in half", async () => {
    scrapeUserFollowers
      .mockResolvedValueOnce({ users: buildUsers(50, "ic1"), nextCursor: "A" })
      .mockResolvedValueOnce({ users: buildUsers(50, "ic2"), nextCursor: "B" });

    const result = await getAllUserFollowers("acct", "ig-resume-3", {
      maxItems: 75,
      ...FAST_PAGINATION,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok=true");
    expect(result.data).toHaveLength(75);
    expect(result.stopReason).toBe("item_cap");
    // 25 users of the "A" page were dropped — that page must be read again.
    expect(result.nextCursor).toBe("A");
  });

  it("resumes after the capped page when the item cap landed on a boundary", async () => {
    scrapeUserFollowers
      .mockResolvedValueOnce({ users: buildUsers(50, "ib1"), nextCursor: "A" })
      .mockResolvedValueOnce({ users: buildUsers(50, "ib2"), nextCursor: "B" });

    const result = await getAllUserFollowers("acct", "ig-resume-4", {
      maxItems: 100,
      ...FAST_PAGINATION,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok=true");
    expect(result.data).toHaveLength(100);
    expect(result.stopReason).toBe("item_cap");
    // Nothing was dropped, so the next walk starts at the first unread page.
    expect(result.nextCursor).toBe("B");
  });

  it("mid-walk page failure resumes on the page that failed", async () => {
    scrapeUserFollowers
      .mockResolvedValueOnce({ users: buildUsers(50, "mw"), nextCursor: "A" })
      .mockRejectedValue(
        new Error("[ig-public-scraper] [ig-http] GET failed with status 400"),
      );

    const result = await getAllUserFollowers("acct", "ig-resume-5", {
      ...FAST_PAGINATION,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok=true");
    expect(result.data).toHaveLength(50);
    expect(result.stopReason).toBe("page_error");
    // Page "A" yielded nothing, so it is still the resume point.
    expect(result.nextCursor).toBe("A");
  });
});

// ─── Refused resume cursor ──────────────────────────────────────────────────
//
// IG expires pagination cursors. A refused one is a dead end the collector
// cannot clear on its own (it only persists a resume point for an `ok`
// capture), so the walk itself has to notice and restart from the top.

describe("follow pagination — refused resume cursor", () => {
  it("stops retrying when a transient error becomes a deterministic cursor refusal", async () => {
    scrapeUserFollowers.mockResolvedValueOnce({ users: buildUsers(5, "first"), nextCursor: "NEXT" })
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockRejectedValue(new Error("GET failed with status 400"));
    const result = await getAllUserFollowers("acct", "ig-retry-classification", FAST_PAGINATION);
    expect(result).toMatchObject({ ok: true, complete: false, nextCursor: "NEXT" });
    expect(scrapeUserFollowers).toHaveBeenCalledTimes(3);
  });
  it("drops a refused cursor and finishes the walk from page 1", async () => {
    scrapeUserFollowers
      .mockRejectedValueOnce(
        new Error(
          "[ig-public-scraper] [ig-http] GET /friendships/followers/ failed with status 400",
        ),
      )
      .mockResolvedValueOnce({ users: buildUsers(40, "fresh"), nextCursor: null });

    const result = await getAllUserFollowers("acct", "ig-refused-1", {
      startCursor: "STALE",
      ...FAST_PAGINATION,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok=true");
    expect(result.data).toHaveLength(40);
    expect(result.startedFromTop).toBe(true);
    expect(result.complete).toBe(true);
    expect(result.stopReason).toBe("exhausted");
    // The dead cursor is cleared downstream by the fresh walk's own result.
    expect(result.nextCursor).toBeNull();
    expect(scrapeUserFollowers).toHaveBeenCalledTimes(2);
    expect(scrapeUserFollowers).toHaveBeenNthCalledWith(
      1,
      "ig-refused-1",
      "STALE",
      expect.any(Set),
    );
    expect(scrapeUserFollowers).toHaveBeenNthCalledWith(
      2,
      "ig-refused-1",
      undefined,
      expect.any(Set),
    );
  });

  it("restarts at most once — a fresh page 1 that also fails is not retried", async () => {
    scrapeUserFollowers.mockRejectedValue(
      new Error("[ig-public-scraper] [ig-http] GET failed with status 400"),
    );

    const result = await getAllUserFollowers("acct", "ig-refused-2", {
      startCursor: "STALE",
      ...FAST_PAGINATION,
    });

    expect(result.ok).toBe(false);
    expect(scrapeUserFollowers).toHaveBeenCalledTimes(2);
  });

  it("keeps the resume cursor when the first page fails for a TRANSIENT reason", async () => {
    scrapeUserFollowers.mockRejectedValue(
      new Error("[ig-public-scraper] [ig-http] rate limited for GET followers"),
    );

    const result = await getAllUserFollowers("acct", "ig-refused-3", {
      startCursor: "GOOD_DEEP_CURSOR",
      ...FAST_PAGINATION,
    });

    // Bubbled as a hard failure: the collector persists no new cursor, so the
    // deep resume point survives for the next cycle.
    expect(result.ok).toBe(false);
    expect(scrapeUserFollowers).toHaveBeenCalledTimes(1);
  });

  it("treats a checkpoint-shaped 400 as a session verdict, not a bad cursor", async () => {
    scrapeUserFollowers.mockRejectedValue(
      new Error(
        "[ig-public-scraper] [ig-http] GET failed with status 400 checkpoint_required",
      ),
    );

    const result = await getAllUserFollowers("acct", "ig-refused-4", {
      startCursor: "GOOD_DEEP_CURSOR",
      ...FAST_PAGINATION,
    });

    expect(result.ok).toBe(false);
    expect(scrapeUserFollowers).toHaveBeenCalledTimes(1);
  });

  it("does not restart a walk that never had a resume cursor", async () => {
    scrapeUserFollowing.mockRejectedValue(
      new Error("[ig-public-scraper] [ig-http] GET failed with status 400"),
    );

    const result = await getAllUserFollowing("ig-refused-5", {
      ...FAST_PAGINATION,
    });

    expect(result.ok).toBe(false);
    expect(scrapeUserFollowing).toHaveBeenCalledTimes(1);
  });
});
