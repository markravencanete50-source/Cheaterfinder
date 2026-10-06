import { describe, expect, it, vi } from "vitest";
vi.mock("../../db.js", () => ({ db: {} }));
import { derivePostsCollectionState, verifiedPostsCheckAt } from "../posts-collection-state.js";

const now = Date.parse("2026-09-24T10:00:00Z");
const before = new Date(now - 60_000), earlier = new Date(now - 120_000);
const base = { savedTotal: 0, profileSnapshot: null, lastContentRefreshAt: null, attempt: null,
  nextRetryAt: null, trackingActive: true, source: "account" as const, now };
describe("posts evidence states", () => {
  it("does not treat a missing snapshot or its default zero as an observed empty feed", () => {
    expect(derivePostsCollectionState(base)).toMatchObject({ state: "not_collected", recordedProfileCount: null });
    expect(derivePostsCollectionState({ ...base, profileSnapshot: { postCount: 0, snapshotAt: earlier } }).state).toBe("not_collected");
    expect(derivePostsCollectionState({ ...base, attempt: { status: "completed", startedAt: earlier, completedAt: before, error: null } }).state).toBe("not_collected");
  });
  it("requires actual read evidence and a noncontradictory recorded count for an empty observation", () => {
    expect(derivePostsCollectionState({ ...base, lastContentRefreshAt: before,
      profileSnapshot: { postCount: 0, snapshotAt: earlier } }).state).toBe("empty_observed");
    expect(derivePostsCollectionState({ ...base, lastContentRefreshAt: before,
      profileSnapshot: { postCount: 123, snapshotAt: earlier } }).state).toBe("unavailable");
    expect(derivePostsCollectionState({ ...base, lastContentRefreshAt: earlier,
      profileSnapshot: { postCount: 0, snapshotAt: before } }).state).toBe("unavailable");
  });
  it.each([0, 12])("retains saved total %i while reporting a newer posts failure", savedTotal => {
    const value = derivePostsCollectionState({ ...base, savedTotal, lastContentRefreshAt: earlier,
      profileSnapshot: { postCount: 0, snapshotAt: earlier },
      attempt: { status: "failed", startedAt: before, completedAt: new Date(now), error: "partial collection: posts: rejected empty feed" } });
    expect(value).toMatchObject({ state: "failed", savedTotal, lastPostsReadAt: earlier.toISOString() });
    expect(JSON.stringify(value)).not.toContain("rejected");
  });
  it("does not misclassify a successful posts read because a different collection dimension failed", () => {
    expect(derivePostsCollectionState({ ...base, savedTotal: 12, lastContentRefreshAt: before,
      attempt: { status: "failed", startedAt: earlier, completedAt: new Date(now), error: "partial collection: followers: cooldown" } }).state).toBe("available");
  });
  it("does not let an older failed job hide a later saved read", () => {
    expect(derivePostsCollectionState({ ...base, savedTotal: 12, lastContentRefreshAt: before,
      attempt: { status: "failed", startedAt: earlier, completedAt: earlier, error: "posts failed" } }).state).toBe("available");
  });
  it("shows pending and throttled work as delayed without inventing a retry timestamp", () => {
    for (const attempt of [
      { status: "pending", startedAt: before, completedAt: null, error: "deferred: upstream timeout" },
      { status: "failed", startedAt: before, completedAt: before, error: "partial collection: posts: no healthy posts reader" },
    ]) expect(derivePostsCollectionState({ ...base, attempt })).toMatchObject({ state: "delayed", nextRetryAt: null });
  });
  it("does not report an abandoned running job as collecting forever", () => {
    expect(derivePostsCollectionState({ ...base, attempt: { status: "running", startedAt: before, completedAt: null, error: null } }).state).toBe("collecting");
    expect(derivePostsCollectionState({ ...base, attempt: { status: "running", startedAt: new Date(now - 3 * 3600_000), completedAt: null, error: null } }).state).toBe("failed");
  });
  it("retains readable public history while paused, without suggesting a future check", () => {
    expect(derivePostsCollectionState({ ...base, savedTotal: 3, trackingActive: false, nextRetryAt: new Date(now + 3600_000) }))
      .toMatchObject({ state: "available", trackingActive: false, nextRetryAt: null });
  });
});

function queueFixture() {
  const account = "fixture-account", due = now + 3600_000;
  const key = `bull:collection-profile:repeat:account-refresh:${account}:${due}`;
  const hashes = new Map([[key, { name: "account-refresh", data: JSON.stringify({ trackedAccountId: account, source: "account-refresh" }), timestamp: String(now), delay: String(due - now) }]]);
  const scores = new Map([[`bull:collection-profile:repeat|account-refresh:${account}`, String(due)],
    [`bull:collection-profile:delayed|repeat:account-refresh:${account}:${due}`, String(due * 4096)]]);
  const redis = {
    hget: vi.fn(async () => null as string | null),
    hmget: vi.fn(async (key: string, ...fields: string[]) => fields.map(field => (hashes.get(key) as Record<string, string> | undefined)?.[field] ?? null)),
    zscore: vi.fn(async (key: string, member: string) => scores.get(`${key}|${member}`) ?? null),
  };
  return { account, due, key, hashes, scores, redis };
}
describe("bounded scheduled-check evidence", () => {
  it("verifies an actual future delayed scheduler job using exact keys only", async () => {
    const f = queueFixture();
    expect(await verifiedPostsCheckAt(f.redis, f.account, null, now)).toBe(new Date(f.due).toISOString());
    expect(f.redis.hmget).toHaveBeenCalledTimes(1);
    expect(f.redis.zscore).toHaveBeenCalledTimes(2);
  });
  it.each(["paused", "removed", "wrong-target", "malformed", "timing-mismatch", "already-due"])("suppresses an unverified scheduled check: %s", async scenario => {
    const f = queueFixture();
    const row = f.hashes.get(f.key)!;
    if (scenario === "paused") f.redis.hget.mockResolvedValue("1");
    if (scenario === "removed") f.scores.delete(`bull:collection-profile:delayed|repeat:account-refresh:${f.account}:${f.due}`);
    if (scenario === "wrong-target") row.data = JSON.stringify({ trackedAccountId: "other" });
    if (scenario === "malformed") row.data = "{";
    if (scenario === "timing-mismatch") row.delay = "1";
    expect(await verifiedPostsCheckAt(f.redis, f.account, null, scenario === "already-due" ? f.due + 1 : now)).toBeNull();
  });
  it("verifies a recorded recovery ID but never infers a job from the error alone", async () => {
    const f = queueFixture();
    f.scores.clear(); f.hashes.clear();
    const id = `private-cooldown_${f.account}_${f.due - 1000}`;
    const error = `deferred until approved viewer cooldown expires: ${new Date(f.due).toISOString()}; unavailable`;
    expect(await verifiedPostsCheckAt(f.redis, f.account, error, now)).toBeNull();
    f.scores.set(`bull:collection-profile:delayed|${id}`, String(f.due * 4096));
    f.hashes.set(`bull:collection-profile:${id}`, { name: "collect-profile", data: JSON.stringify({ trackedAccountId: f.account, source: "private-cooldown" }), timestamp: String(now), delay: String(f.due - now) });
    expect(await verifiedPostsCheckAt(f.redis, f.account, error, now)).toBe(new Date(f.due).toISOString());
  });
  it("uses actual delayed timing when queue insertion drifts from the recorded recovery time", async () => {
    const f = queueFixture();
    f.scores.clear(); f.hashes.clear();
    const id = `public-posts-capacity_${f.account}_${f.due - 1000}`, actualDue = f.due + 14;
    f.scores.set(`bull:collection-profile:delayed|${id}`, String(actualDue * 4096));
    f.hashes.set(`bull:collection-profile:${id}`, { name: "collect-profile", data: JSON.stringify({ trackedAccountId: f.account, source: "public-posts-capacity" }), timestamp: String(now + 14), delay: String(f.due - now) });
    expect(await verifiedPostsCheckAt(f.redis, f.account, `deferred until public posts reader capacity returns: ${new Date(f.due).toISOString()}`, now)).toBe(new Date(actualDue).toISOString());
  });
});
