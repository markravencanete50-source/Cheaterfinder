import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.BACKEND_FIX_TEST_DATABASE_URL;
if (url) {
  const parsed = new URL(url);
  if (parsed.pathname !== "/cheaterfinder_backend_fix_test_20260907" ||
      !["127.0.0.1", "localhost"].includes(parsed.hostname) || !parsed.port || parsed.port === "5432") {
    throw new Error("An isolated scratch database is required");
  }
  process.env.DATABASE_URL = url;
}

(url ? describe : describe.skip)("report aggregation and export windows (Postgres)", () => {
  let pool: typeof import("../../db.js").pool;
  let build: typeof import("../report-data.js").buildReportData;
  let csv: typeof import("../report-csv.js").buildReportCsv;
  let html: typeof import("../report-pdf.js").renderReportHtml;
  const users: string[] = [];

  beforeAll(async () => {
    ({ pool } = await import("../../db.js"));
    ({ buildReportData: build } = await import("../report-data.js"));
    ({ buildReportCsv: csv } = await import("../report-csv.js"));
    ({ renderReportHtml: html } = await import("../report-pdf.js"));
  });
  afterAll(async () => {
    if (pool) {
      await pool.query("DELETE FROM users WHERE id=ANY($1::varchar[])", [users]);
      await pool.end();
    }
  });

  async function account(trackingStarted = "2026-07-01T00:00:00Z", publicIdentity?: string) {
    const userId = randomUUID(), id = randomUUID(); users.push(userId);
    await pool.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Report fixture')", [userId, userId + "@example.invalid"]);
    await pool.query("INSERT INTO subscriptions(user_id,status,stripe_customer_id,stripe_subscription_id,current_period_end) VALUES($1,'active',$2,$3,now()+interval '1 day')", [userId, "cus_" + userId, "sub_" + userId]);
    await pool.query("INSERT INTO tracked_accounts(id,user_id,ig_username,ig_user_id,is_private,access_status,tracking_started) VALUES($1,$2,$3,$4,$5,'has_access',$6)",
      [id, userId, "report_" + (publicIdentity ?? id), publicIdentity ?? null, !publicIdentity, trackingStarted]);
    return id;
  }
  async function snapshot(id: string, at: string, followers: number, following: number) {
    await pool.query("INSERT INTO profile_snapshots(tracked_account_id,ig_username,snapshot_at,follower_count,following_count,post_count) VALUES($1,'report_fixture',$2,$3,$4,130)", [id, at, followers, following]);
  }

  it.each(["weekly", "monthly"])("counts all %s posts without letting an all-time leaderboard set the total", async type => {
    const id = await account(), start = new Date(type === "weekly" ? "2026-08-01" : "2026-07-09"), end = new Date("2026-08-08");
    await pool.query("INSERT INTO posts_cache(tracked_account_id,shortcode,taken_at,like_count,comment_count) SELECT $1,'old_'||n,'2026-06-01'::timestamptz,10000,100 FROM generate_series(1,61) n", [id]);
    await pool.query("INSERT INTO posts_cache(tracked_account_id,shortcode,taken_at,like_count,comment_count) SELECT $1,'period_'||n,'2026-08-02'::timestamptz,n,2 FROM generate_series(1,65) n", [id]);
    await pool.query("INSERT INTO posts_cache(tracked_account_id,shortcode,taken_at,like_count) VALUES($1,'end_boundary',$2,20000),($1,'unknown_date',NULL,20000)", [id, end]);
    const report = await build(id, start, end, type);
    expect(report.ownPosts).toMatchObject({ publishedInPeriod: 65, avgLikes: 33, avgComments: 2 });
    expect(report.ownPosts.topPosts.map(p => p.shortcode)).toEqual(["period_65", "period_64", "period_63", "period_62", "period_61", "period_60"]);
    expect(report.ownPosts.topPosts.every(p => p.takenAt && p.takenAt >= start && p.takenAt < end)).toBe(true);
    const exported = await html(report);
    expect(exported).toContain("Posted This Period");
    expect(exported).toContain("Counts describe observed activity.");
    expect(exported).not.toContain("old_");
    expect(exported).not.toContain("end_boundary");
  });

  it("requires distinct observation times for current and previous growth, preserving unknown in the PDF", async () => {
    const id = await account(), start = new Date("2026-08-01"), end = new Date("2026-08-08");
    await snapshot(id, "2026-07-26T00:00:00Z", 90, 40);
    await snapshot(id, "2026-08-02T00:00:00Z", 100, 50);
    let report = await build(id, start, end, "weekly");
    expect(report.summary.netFollowerChange).toBeNull();
    expect(report.summary.netFollowingChange).toBeNull();
    expect(report.previous.netFollowerChange).toBeNull();
    expect(report.profile.followerCountEnd).toBe(100);
    await snapshot(id, "2026-08-02T00:00:00Z", 100, 50);
    await snapshot(id, "2026-07-30T00:00:00Z", 95, 45);
    report = await build(id, start, end, "weekly");
    expect(report.summary.netFollowerChange).toBeNull();
    expect(report.previous.netFollowerChange).toBe(5);
    const exported = await html(report);
    const growthCard = exported.slice(exported.indexOf("Follower Growth"), exported.indexOf("Likes Detected"));
    expect(growthCard).not.toContain("vs last");
    await snapshot(id, "2026-08-07T00:00:00Z", 104, 48);
    report = await build(id, start, end, "weekly");
    expect(report.summary.netFollowerChange).toBe(4);
    expect(report.summary.netFollowingChange).toBe(-2);
  });

  it("matches CSV to half-open report windows and the requesting twin's tracking and settled boundaries", async () => {
    const identity = randomUUID().replaceAll("-", "");
    const canonical = await account("2026-07-01T00:00:00Z", identity);
    const requested = await account("2026-08-05T00:00:00Z", identity);
    const start = new Date("2026-08-01"), end = new Date("2026-08-08");
    await pool.query("UPDATE tracked_accounts SET following_first_complete_at='2026-08-02',last_following_refresh_at='2026-08-07' WHERE id=ANY($1::varchar[])", [[canonical, requested]]);
    await pool.query("INSERT INTO roster_sync_state(tracked_account_id,dimension,settled_at,last_success_at,last_complete_read_at) VALUES($1,'following','2026-08-06','2026-08-07','2026-08-07')", [canonical]);
    await snapshot(requested, "2026-08-07T00:00:00Z", 100, 2);
    for (const [name, at] of [["pre_tracking", "2026-08-04"], ["pre_settled", "2026-08-05T12:00:00Z"], ["visible_departure", "2026-08-06T12:00:00Z"], ["end_departure", "2026-08-08"]]) {
      await pool.query("INSERT INTO roster_members(tracked_account_id,dimension,username_lower,username,is_current,left_at) VALUES($1,'following',$2,$2,false,$3)", [canonical, name, at]);
    }
    for (const [name, at] of [["visible_follow", "2026-08-06T12:00:00Z"], ["end_follow", "2026-08-08"]]) {
      await pool.query("INSERT INTO roster_members(tracked_account_id,dimension,username_lower,username) VALUES($1,'following',$2,$2)", [canonical, name]);
      await pool.query("INSERT INTO follow_events(tracked_account_id,followed_username,detected_at) VALUES($1,$2,$3)", [canonical, name, at]);
    }
    for (const id of [canonical, requested]) {
      await pool.query("INSERT INTO like_events(tracked_account_id,post_id,owner_username,detected_at,post_taken_at) VALUES($1,'shared_visible','visible_like','2026-08-07','2026-08-06'),($1,'shared_end','end_like','2026-08-08','2026-08-07')", [id]);
    }
    const report = await build(requested, start, end, "weekly");
    expect(report.summary).toMatchObject({ totalLikes: 1, accountsFollowed: 1, accountsUnfollowed: 1 });
    const exported = await csv(requested, start, end);
    expect(exported.trim().split("\r\n")).toHaveLength(4);
    for (const name of ["visible_like", "visible_follow", "visible_departure"]) expect(exported).toContain(name);
    for (const name of ["pre_tracking", "pre_settled", "end_like", "end_follow", "end_departure"]) expect(exported).not.toContain(name);
    const nextEnd = new Date("2026-08-15");
    const nextReport = await build(requested, end, nextEnd, "weekly");
    expect(nextReport.summary).toMatchObject({ totalLikes: 1, accountsFollowed: 1, accountsUnfollowed: 1 });
    const nextCsv = await csv(requested, end, nextEnd);
    for (const name of ["end_like", "end_follow", "end_departure"]) expect(nextCsv).toContain(name);
    for (const name of ["visible_like", "visible_follow", "visible_departure"]) expect(nextCsv).not.toContain(name);
  });
});
