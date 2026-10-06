import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const url = process.env.BACKEND_FIX_TEST_DATABASE_URL;
if (url) {
  const parsed = new URL(url);
  const runnerPort = Boolean(process.env.STRESS_NONCE) && parsed.port !== "5432" &&
    (process.env.STRESS_ALLOWED_PORTS ?? "").split(",").includes(parsed.port);
  if (parsed.pathname !== "/cheaterfinder_backend_fix_test_20260907" ||
      !["127.0.0.1", "localhost"].includes(parsed.hostname) || !parsed.port ||
      (parsed.port !== "55439" && !runnerPort)) {
    throw new Error("Isolated admin audit database or guarded runner database required");
  }
  process.env.DATABASE_URL = url;
  process.env.WORKERS_DISABLED = "1";
  delete process.env.STRIPE_SECRET_KEY;
}

// Queue and provider boundaries stay inert: these tests only write fixtures to
// the guarded scratch database and make HTTP requests to their own server.
const queue = vi.hoisted(() => ({ add: vi.fn() }));
const followQueue = vi.hoisted(() => ({ add: vi.fn() }));
vi.mock("../../workers.js", () => ({
  collectionProfileQueue: queue,
  getQueues: () => ({ collectionProfileQueue: queue, botFollowRequestQueue: followQueue }),
}));
vi.mock("../media-cache-jobs.js", () => ({ enqueueMediaCacheUrls: vi.fn() }));

(url ? describe : describe.skip)("admin counts and retries — isolated PostgreSQL", () => {
  let pool: typeof import("../../db.js").pool;
  let server: Server;
  let origin: string;
  const userIds = Array.from({ length: 4 }, () => randomUUID());
  const accountIds = Array.from({ length: 4 }, () => randomUUID());
  const username = "admin_count_" + randomUUID().replaceAll("-", "");
  const baseline = new Date("2026-01-01T00:00:00Z");
  const detected = new Date("2026-01-05T00:00:00Z");
  const token = "a".repeat(64);

  const request = async (path: string, method = "GET", role = "admin", csrf = true, body?: unknown) => {
    const response = await fetch(origin + path, {
      method,
      headers: {
        "x-fixture-role": role,
        "Content-Type": "application/json",
        ...(csrf ? { cookie: `csrf_token=${token}`, "x-csrf-token": token } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };

  const failedJob = async (jobType = "profile") => {
    const id = randomUUID();
    await pool.query(`INSERT INTO collection_jobs(id,tracked_account_id,job_type,status,started_at,completed_at,error)
      VALUES($1,$2,$3,'failed',$4,$5,'fixture original failure')`, [id, accountIds[0], jobType, baseline, detected]);
    return id;
  };
  const jobState = async (id: string) => (await pool.query(
    "SELECT status,error,started_at,completed_at FROM collection_jobs WHERE id=$1", [id],
  )).rows[0];

  beforeAll(async () => {
    pool = (await import("../../db.js")).pool;
    for (const id of userIds) {
      await pool.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Admin count fixture')", [id, id + "@example.invalid"]);
      await pool.query(`INSERT INTO subscriptions(user_id,stripe_customer_id,stripe_subscription_id,status,plan,current_period_end)
        VALUES($1,$2,$3,'active','standard',now()+interval '1 day')`, [id, "cus_admin_fixture_" + id, "sub_admin_fixture_" + id]);
    }
    for (let i = 0; i < accountIds.length; i++) {
      await pool.query(`INSERT INTO tracked_accounts(id,user_id,ig_username,ig_user_id,tracking_started,following_first_complete_at,is_private)
        VALUES($1,$2,$3,$4,$5,$6,$7)`, [
        accountIds[i], userIds[i], i === 2 ? username + "_unsettled" : username,
        i === 2 ? "private_" + accountIds[i] : "public_" + accountIds[0],
        i === 3 ? new Date("2026-01-06T00:00:00Z") : new Date(baseline.getTime() + i * 1000),
        i === 2 ? null : baseline, i === 2,
      ]);
    }
    await pool.query("INSERT INTO roster_sync_state(tracked_account_id,dimension,settled_at) VALUES($1,'following',$2)", [accountIds[0], baseline]);
    for (const id of accountIds.slice(0, 3)) {
      await pool.query(`INSERT INTO follow_events(tracked_account_id,followed_username,detected_at) VALUES
        ($1,'real_follow',$2),($1,'seed_noise',$3),($1,'flip_flop',$2),($1,'no_longer_followed',$2)`,
      [id, detected, new Date("2025-12-31T00:00:00Z")]);
      await pool.query(`INSERT INTO unfollow_events(tracked_account_id,unfollowed_username,detected_at) VALUES
        ($1,'flip_flop',$2),($1,'returned_user',$3),($1,'real_departure',$3)`,
      [id, new Date("2026-01-04T00:00:00Z"), detected]);
    }
    await pool.query(`INSERT INTO roster_members(tracked_account_id,dimension,username,username_lower,is_current,left_at) VALUES
      ($1,'following','returned_user','returned_user',true,NULL),
      ($1,'following','real_departure','real_departure',false,$2),
      ($1,'following','no_longer_followed','no_longer_followed',false,NULL)`, [accountIds[0], detected]);

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const role = req.get("x-fixture-role");
      req.isAuthenticated = (() => role === "admin" || role === "user") as typeof req.isAuthenticated;
      if (req.isAuthenticated()) req.user = { id: userIds[0], role } as Express.User;
      next();
    });
    (await import("../../admin-routes.js")).registerAdminRoutes(app);
    server = createServer(app);
    await new Promise<void>(resolve => server.listen(Number(process.env.STRESS_FAULT_PORT ?? 0), "127.0.0.1", resolve));
    origin = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  }, 30_000);

  beforeEach(() => {
    queue.add.mockReset(); queue.add.mockResolvedValue({ id: "fixture-queued" });
    followQueue.add.mockReset(); followQueue.add.mockResolvedValue({ id: "fixture-follow-queued" });
  });
  afterAll(async () => {
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    if (pool) {
      await pool.query("DELETE FROM users WHERE id=ANY($1::varchar[])", [userIds]);
      await pool.end();
    }
  });

  it("keeps list, tracked-account detail and user detail consistent without seed or twin noise", async () => {
    const list = await request("/api/admin/tracked-accounts?search=" + username);
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(4);
    for (let i = 0; i < accountIds.length; i++) {
      const expected = { followCount: i < 2 ? 1 : 0, unfollowCount: i < 2 ? 1 : 0 };
      expect(list.body.items.find((row: { id: string }) => row.id === accountIds[i])).toMatchObject(expected);
      const detail = await request("/api/admin/tracked-accounts/" + accountIds[i]);
      expect(detail.status).toBe(200); expect(detail.body.stats).toMatchObject(expected);
      const user = await request("/api/admin/users/" + userIds[i]);
      expect(user.status).toBe(200); expect(user.body.trackedAccounts[0]).toMatchObject(expected);
    }
  });

  it("applies combined user search and subscription filters to items and total", async () => {
    const result = await request("/api/admin/users?status=active&search=" + userIds[1]);
    expect(result.status).toBe(200); expect(result.body.total).toBe(1);
    expect(result.body.items).toHaveLength(1); expect(result.body.items[0].id).toBe(userIds[1]);
    expect(result.body.items[0].trackedAccountCount).toBe(1);
  });

  it("counts all active owners even when pagination or owner search returns one row", async () => {
    const mine = await request("/api/admin/tracked-accounts?owner=me&limit=1");
    expect(mine.status).toBe(200); expect(mine.body.items).toHaveLength(1);
    expect(mine.body.items[0]).toMatchObject({ id: accountIds[0], ownerCount: 3 });
    const search = await request("/api/admin/tracked-accounts?search=" + userIds[1]);
    expect(search.body.items).toHaveLength(1); expect(search.body.items[0].ownerCount).toBe(3);
    await pool.query("UPDATE tracked_accounts SET is_active=false WHERE id=$1", [accountIds[1]]);
    try {
      const updated = await request("/api/admin/tracked-accounts?owner=me&limit=1");
      expect(updated.body.items[0].ownerCount).toBe(2);
      const paused = await request("/api/admin/tracked-accounts/" + accountIds[1]);
      expect(paused.body.owners).toHaveLength(2);
      expect(paused.body.owners.every((owner: { isActive: boolean }) => owner.isActive)).toBe(true);
    } finally { await pool.query("UPDATE tracked_accounts SET is_active=true WHERE id=$1", [accountIds[1]]); }
  });

  it("keeps auth, role and CSRF gates ahead of admin reads and writes", async () => {
    expect((await request("/api/admin/users", "GET", "anonymous")).status).toBe(401);
    expect((await request("/api/admin/users", "GET", "user")).status).toBe(403);
    const id = await failedJob();
    expect((await request(`/api/admin/jobs/${id}/retry`, "POST", "admin", false)).status).toBe(403);
    expect((await request(`/api/admin/jobs/${id}/retry`, "POST", "user")).status).toBe(403);
    expect((await jobState(id)).status).toBe("failed"); expect(queue.add).not.toHaveBeenCalled();
  });

  it("keeps health yellow for stale rosters or queue errors even when features, recovery and capacity are healthy", async () => {
    const healthBots = Array.from({ length: 3 }, () => randomUUID());
    const collection = await import("../collection-health.js");
    const recovery = await import("../recovery-watchdog.js");
    const transport = await import("../scraper-transport-config.js");
    const workers = await import("../../workers.js");
    const queueCounts = vi.fn().mockResolvedValue({ waiting: 0, active: 0, delayed: 0, failed: 0 });
    const healthyQueues = Object.fromEntries([
      "collection-profile", "collection-likes", "collection-follows", "collection-roster",
      "report-generate", "email-send", "bot-follow-request", "bot-follow-check",
      "retention", "refresh-sweep", "bot-cooldown-probe", "bot-pool-rescue", "bot-warmer",
    ].map(name => [name, { name, getJobCounts: queueCounts }]));
    const queuesRead = vi.spyOn(workers, "getQueues").mockReturnValue(healthyQueues as unknown as ReturnType<typeof workers.getQueues>);
    const collectionRead = vi.spyOn(collection, "readCollectionHealth");
    const recoveryRead = vi.spyOn(recovery, "recoveryStatus").mockReturnValue({
      running: false, lastStartedAt: null, lastFinishedAt: null,
      lastSuccessAt: new Date().toISOString(), failedSteps: [],
    });
    const transportRead = vi.spyOn(transport, "getScraperReadTransport").mockResolvedValue({
      value: "http", source: "default", updatedAt: null,
    });
    const healthy: Awaited<ReturnType<typeof collection.readCollectionHealth>> = {
      verification: "verified", incompleteProfiles: 0, features: [], activeProfiles: 1,
      rosterEligibleProfiles: 1, awaitingApprovalProfiles: 0, accessDeniedProfiles: 0,
      missingProfileBaselines: 0, blockedPrivateReaders: 0, providerBlockedProfiles: 0, excludedSubscriptionTrackings: 0,
      staleFollowerRosters: 0, staleFollowingRosters: 0,
      postSuccessesLastHour: 1, postFailuresLastHour: 0, profiles: [],
    };
    const workersDisabled = process.env.WORKERS_DISABLED;
    try {
      for (const id of healthBots) await pool.query(`INSERT INTO bot_accounts
        (id,ig_username,status,tier,session_data,automation_identity,proxy_url)
        VALUES($1,$2,'available','worker','fixture session',jsonb_build_object('bot_id',$1::varchar),'http://fixed.example.invalid:15003')`,
      [id, "health_" + id]);
      // Only the status display reads this flag here; workers remain mocked.
      process.env.WORKERS_DISABLED = "0";
      collectionRead.mockResolvedValue(healthy);
      const green = await request("/api/admin/health");
      expect(green.status).toBe(200); expect(green.body.status).toBe("green");
      for (const field of ["staleFollowerRosters", "staleFollowingRosters", "awaitingApprovalProfiles", "accessDeniedProfiles", "missingProfileBaselines", "blockedPrivateReaders", "providerBlockedProfiles"] as const) {
        collectionRead.mockResolvedValue({ ...healthy, [field]: 1 });
        const stale = await request("/api/admin/health");
        expect(stale.status).toBe(200); expect(stale.body.status).toBe("yellow");
        expect(stale.body.collection[field]).toBe(1);
      }
      collectionRead.mockResolvedValue(healthy);
      queueCounts.mockRejectedValueOnce(new Error("fixture queue health unavailable"));
      const unavailable = await request("/api/admin/health");
      expect(unavailable.status).toBe(200); expect(unavailable.body.status).toBe("yellow");
      expect(unavailable.body.queues.some((q: { error?: string }) => q.error === "Queue state unavailable")).toBe(true);
      recoveryRead.mockReturnValue({ ...recoveryRead.mock.results[0].value, lastSuccessAt: "invalid" });
      expect((await request("/api/admin/health")).body.status).toBe("yellow");
    } finally {
      if (workersDisabled === undefined) delete process.env.WORKERS_DISABLED;
      else process.env.WORKERS_DISABLED = workersDisabled;
      collectionRead.mockRestore(); recoveryRead.mockRestore(); transportRead.mockRestore(); queuesRead.mockRestore();
      await pool.query("DELETE FROM bot_accounts WHERE id=ANY($1::varchar[])", [healthBots]);
    }
  });

  it("restores the original failure when enqueueing fails, so a later retry can succeed", async () => {
    const id = await failedJob();
    const original = await jobState(id);
    queue.add.mockRejectedValueOnce(new Error("fixture queue unavailable"));
    const rejected = await request(`/api/admin/jobs/${id}/retry`, "POST");
    expect(rejected.status).toBe(503); expect(rejected.body.message).toContain("queue");
    expect(await jobState(id)).toEqual(original);
    expect((await request(`/api/admin/jobs/${id}/retry`, "POST")).status).toBe(200);
    expect(await jobState(id)).toMatchObject({ status: "pending", error: null, started_at: null, completed_at: null });
    expect(queue.add.mock.calls[0][2]).toEqual(queue.add.mock.calls[1][2]);
    expect(queue.add.mock.calls[1][2].jobId).toContain(id);
  });

  it("accepts only one of two simultaneous retries", async () => {
    const id = await failedJob();
    const results = await Promise.all([
      request(`/api/admin/jobs/${id}/retry`, "POST"), request(`/api/admin/jobs/${id}/retry`, "POST"),
    ]);
    expect(results.map(result => result.status).sort()).toEqual([200, 409]);
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it("does not roll a claimed worker back after an enqueue acknowledgement error", async () => {
    const id = await failedJob();
    queue.add.mockImplementationOnce(async () => {
      await pool.query("UPDATE collection_jobs SET status='running',started_at=now() WHERE id=$1", [id]);
      throw new Error("fixture acknowledgement lost");
    });
    expect((await request(`/api/admin/jobs/${id}/retry`, "POST")).status).toBe(503);
    expect((await jobState(id)).status).toBe("running");
  });

  it.each(["likes", "follows", "report"])("rejects unsupported %s retries without altering their audit row", async type => {
    const id = await failedJob(type), original = await jobState(id);
    const result = await request(`/api/admin/jobs/${id}/retry`, "POST");
    expect(result.status).toBe(409); expect(result.body.message).toMatch(/profile|Reports/);
    expect(await jobState(id)).toEqual(original); expect(queue.add).not.toHaveBeenCalled();
  });

  const withBotFixtures = async (work: (ids: { botId: string; replacementId: string; pendingId: string; acceptedId: string }) => Promise<void>) => {
    const botId = randomUUID(), replacementId = randomUUID(), pendingId = randomUUID(), acceptedId = randomUUID();
    const acceptedTargetId = randomUUID();
    await pool.query("INSERT INTO tracked_accounts(id,user_id,ig_username,is_private,access_status) VALUES($1,$2,$3,true,'has_access')",
      [acceptedTargetId, userIds[0], "accepted_" + acceptedTargetId]);
    await pool.query("UPDATE tracked_accounts SET access_status='pending_access' WHERE id=$1", [accountIds[2]]);
    await pool.query(`INSERT INTO bot_accounts(id,ig_username,status,current_follows,max_follows,tier,session_data,automation_identity,proxy_url) VALUES
      ($1,$2,'in_use',2,2,'worker','fixture session',jsonb_build_object('bot_id',$1::varchar),'http://fixed.example.invalid:15000'),
      ($3,$4,'available',0,5,'worker','fixture session',jsonb_build_object('bot_id',$3::varchar),'http://fixed.example.invalid:15001')`,
    [botId, "stopped_" + botId, replacementId, "replacement_" + replacementId]);
    await pool.query(`INSERT INTO bot_follow_requests(id,bot_account_id,tracked_account_id,status) VALUES
      ($1,$2,$3,'pending'),($4,$2,$5,'accepted')`, [pendingId, botId, accountIds[2], acceptedId, acceptedTargetId]);
    try { await work({ botId, replacementId, pendingId, acceptedId }); }
    finally {
      await pool.query("DELETE FROM bot_accounts WHERE id=ANY($1::varchar[])", [[botId, replacementId]]);
      await pool.query("DELETE FROM tracked_accounts WHERE id=$1", [acceptedTargetId]);
    }
  };

  it.each(["disabled", "banned", "disable-action"])("releases pending requests and enqueues a replacement through %s", async status => {
    await withBotFixtures(async ({ botId, replacementId, pendingId, acceptedId }) => {
      const call = () => status === "disable-action"
        ? request(`/api/admin/bots/${botId}/disable`, "POST")
        : request(`/api/admin/bots/${botId}`, "PUT", "admin", true, { status });
      const result = await call();
      expect(result.status).toBe(200);
      const bot = (await pool.query("SELECT status,current_follows FROM bot_accounts WHERE id=$1", [botId])).rows[0];
      expect(bot).toEqual({ status: status === "banned" ? "banned" : "disabled", current_follows: 1 });
      expect((await pool.query("SELECT status FROM bot_follow_requests WHERE id=$1", [pendingId])).rows[0].status).toBe("failed");
      expect((await pool.query("SELECT status FROM bot_follow_requests WHERE id=$1", [acceptedId])).rows[0].status).toBe("accepted");
      const replacement = (await pool.query("SELECT id,status FROM bot_follow_requests WHERE bot_account_id=$1", [replacementId])).rows;
      expect(replacement).toHaveLength(1); expect(replacement[0].status).toBe("queued");
      expect(followQueue.add).toHaveBeenCalledWith("send-follow", { botFollowRequestId: replacement[0].id }, {
        jobId: `private-backup-${replacement[0].id}`, delay: 60_000,
      });
      const responseBot = result.body.bot ?? result.body;
      expect(responseBot.currentFollows).toBe(1); expect(responseBot).not.toHaveProperty("sessionData");
      expect((await call()).status).toBe(200);
      expect((await pool.query("SELECT current_follows FROM bot_accounts WHERE id=$1", [botId])).rows[0].current_follows).toBe(1);
      expect((await pool.query("SELECT count(*)::int n FROM bot_follow_requests WHERE bot_account_id=$1", [replacementId])).rows[0].n).toBe(1);
    });
  });

  it("recovers replacement enqueue failure on a repeated status save", async () => {
    await withBotFixtures(async ({ botId, replacementId }) => {
      followQueue.add.mockRejectedValueOnce(new Error("fixture follow queue unavailable"));
      const path = `/api/admin/bots/${botId}`;
      const failed = await request(path, "PUT", "admin", true, { status: "disabled" });
      expect(failed.status).toBe(503); expect(failed.body.message).toContain("Save this status again");
      expect((await pool.query("SELECT status FROM bot_accounts WHERE id=$1", [botId])).rows[0].status).toBe("disabled");
      expect((await request(path, "PUT", "admin", true, { status: "disabled" })).status).toBe(200);
      expect((await pool.query("SELECT count(*)::int n FROM bot_follow_requests WHERE bot_account_id=$1", [replacementId])).rows[0].n).toBe(1);
      expect(followQueue.add).toHaveBeenCalledTimes(2);
      expect(followQueue.add.mock.calls[0][1]).toEqual(followQueue.add.mock.calls[1][1]);
    });
  });

  it("allocates one replacement for simultaneous status saves", async () => {
    await withBotFixtures(async ({ botId, replacementId }) => {
      const spareId = randomUUID();
      await pool.query(`INSERT INTO bot_accounts(id,ig_username,status,current_follows,max_follows,tier,session_data,automation_identity,proxy_url)
        VALUES($1,$2,'available',0,5,'worker','fixture session',jsonb_build_object('bot_id',$1::varchar),'http://fixed.example.invalid:15002')`,
      [spareId, "spare_" + spareId]);
      try {
        const results = await Promise.all([
          request(`/api/admin/bots/${botId}`, "PUT", "admin", true, { status: "disabled" }),
          request(`/api/admin/bots/${botId}`, "PUT", "admin", true, { status: "disabled" }),
        ]);
        expect(results.map(result => result.status)).toEqual([200, 200]);
        const active = (await pool.query(`SELECT id FROM bot_follow_requests
          WHERE tracked_account_id=$1 AND status IN ('queued','pending','accepted')`, [accountIds[2]])).rows;
        expect(active).toHaveLength(1);
        expect((await pool.query("SELECT sum(current_follows)::int n FROM bot_accounts WHERE id=ANY($1::varchar[])",
          [[replacementId, spareId]])).rows[0].n).toBe(1);
      } finally { await pool.query("DELETE FROM bot_accounts WHERE id=$1", [spareId]); }
    });
  });

  it.each(["pending", "accepted"])("does not allocate another viewer after replacement becomes %s", async status => {
    await withBotFixtures(async ({ botId, replacementId }) => {
      const spareId = randomUUID();
      const save = () => request(`/api/admin/bots/${botId}`, "PUT", "admin", true, { status: "disabled" });
      expect((await save()).status).toBe(200);
      await pool.query("UPDATE bot_follow_requests SET status=$2 WHERE bot_account_id=$1", [replacementId, status]);
      await pool.query(`INSERT INTO bot_accounts(id,ig_username,status,current_follows,max_follows,tier,session_data,automation_identity,proxy_url)
        VALUES($1,$2,'available',0,5,'worker','fixture session',jsonb_build_object('bot_id',$1::varchar),'http://fixed.example.invalid:15002')`,
      [spareId, "spare_" + spareId]);
      try {
        followQueue.add.mockClear();
        expect((await save()).status).toBe(200);
        expect((await pool.query("SELECT count(*)::int n FROM bot_follow_requests WHERE bot_account_id=$1", [spareId])).rows[0].n).toBe(0);
        expect((await pool.query("SELECT current_follows FROM bot_accounts WHERE id=$1", [replacementId])).rows[0].current_follows).toBe(1);
        expect(followQueue.add).not.toHaveBeenCalled();
      } finally { await pool.query("DELETE FROM bot_accounts WHERE id=$1", [spareId]); }
    });
  });

  it.each(["paused", "unpaid"])("releases stopped work without scheduling a replacement for a %s target", async state => {
    await withBotFixtures(async ({ botId, replacementId, pendingId }) => {
      if (state === "paused") await pool.query("UPDATE tracked_accounts SET is_active=false WHERE id=$1", [accountIds[2]]);
      else await pool.query("UPDATE subscriptions SET status='canceled' WHERE user_id=$1", [userIds[2]]);
      try {
        expect((await request(`/api/admin/bots/${botId}/disable`, "POST")).status).toBe(200);
        expect((await pool.query("SELECT status FROM bot_follow_requests WHERE id=$1", [pendingId])).rows[0].status).toBe("failed");
        expect((await pool.query("SELECT current_follows FROM bot_accounts WHERE id=$1", [replacementId])).rows[0].current_follows).toBe(0);
        expect(followQueue.add).not.toHaveBeenCalled();
      } finally {
        await pool.query("UPDATE tracked_accounts SET is_active=true WHERE id=$1", [accountIds[2]]);
        await pool.query("UPDATE subscriptions SET status='active' WHERE user_id=$1", [userIds[2]]);
      }
    });
  });

  const pendingOnly = async ({ botId, acceptedId }: { botId: string; acceptedId: string }) => {
    const target = (await pool.query("SELECT tracked_account_id FROM bot_follow_requests WHERE id=$1", [acceptedId])).rows[0].tracked_account_id as string;
    await pool.query("DELETE FROM bot_follow_requests WHERE id=$1", [acceptedId]);
    await pool.query("UPDATE bot_accounts SET current_follows=1 WHERE id=$1", [botId]);
    return target;
  };

  it("refuses bot deletion with accepted access history before changing status or pending work", async () => {
    await withBotFixtures(async ({ botId, pendingId, acceptedId }) => {
      const result = await request(`/api/admin/bots/${botId}`, "DELETE");
      expect(result.status).toBe(409); expect(result.body.message).toContain("Use Disable");
      expect((await pool.query("SELECT status,current_follows FROM bot_accounts WHERE id=$1", [botId])).rows[0])
        .toEqual({ status: "in_use", current_follows: 2 });
      expect((await pool.query("SELECT status FROM bot_follow_requests WHERE id=$1", [pendingId])).rows[0].status).toBe("pending");
      expect((await pool.query("SELECT status FROM bot_follow_requests WHERE id=$1", [acceptedId])).rows[0].status).toBe("accepted");
      expect(followQueue.add).not.toHaveBeenCalled();
    });
  });

  it("acknowledges replacement scheduling before deleting a bot with pending work", async () => {
    await withBotFixtures(async ids => {
      await pendingOnly(ids);
      followQueue.add.mockImplementationOnce(async () => {
        expect((await pool.query("SELECT status,current_follows FROM bot_accounts WHERE id=$1", [ids.botId])).rows[0])
          .toEqual({ status: "disabled", current_follows: 0 });
        return { id: "fixture-acknowledged" };
      });
      expect((await request(`/api/admin/bots/${ids.botId}`, "DELETE")).status).toBe(200);
      expect((await pool.query("SELECT id FROM bot_accounts WHERE id=$1", [ids.botId])).rows).toHaveLength(0);
      const replacement = (await pool.query("SELECT id,status FROM bot_follow_requests WHERE bot_account_id=$1", [ids.replacementId])).rows;
      expect(replacement).toHaveLength(1); expect(replacement[0].status).toBe("queued");
      expect(followQueue.add).toHaveBeenCalledWith("send-follow", { botFollowRequestId: replacement[0].id }, {
        jobId: `private-backup-${replacement[0].id}`, delay: 60_000,
      });
    });
  });

  it("keeps bot and failed history on an enqueue error, then safely finishes a repeated Delete", async () => {
    await withBotFixtures(async ids => {
      await pendingOnly(ids);
      followQueue.add.mockRejectedValueOnce(new Error("fixture delete acknowledgement failed"));
      const path = `/api/admin/bots/${ids.botId}`;
      const failed = await request(path, "DELETE");
      expect(failed.status).toBe(503); expect(failed.body.message).toContain("not deleted");
      expect((await pool.query("SELECT status,current_follows FROM bot_accounts WHERE id=$1", [ids.botId])).rows[0])
        .toEqual({ status: "disabled", current_follows: 0 });
      expect((await pool.query("SELECT status FROM bot_follow_requests WHERE id=$1", [ids.pendingId])).rows[0].status).toBe("failed");
      expect((await request(path, "DELETE")).status).toBe(200);
      expect((await pool.query("SELECT id FROM bot_accounts WHERE id=$1", [ids.botId])).rows).toHaveLength(0);
      expect((await pool.query("SELECT current_follows FROM bot_accounts WHERE id=$1", [ids.replacementId])).rows[0].current_follows).toBe(1);
      expect((await pool.query("SELECT count(*)::int n FROM bot_follow_requests WHERE bot_account_id=$1", [ids.replacementId])).rows[0].n).toBe(1);
      expect(followQueue.add.mock.calls[0][1]).toEqual(followQueue.add.mock.calls[1][1]);
    });
  });

  it("rechecks access records after recovery so a late accepted relationship cannot be cascaded away", async () => {
    await withBotFixtures(async ids => {
      const targetId = await pendingOnly(ids);
      followQueue.add.mockImplementationOnce(async () => {
        await pool.query("INSERT INTO bot_follow_requests(id,bot_account_id,tracked_account_id,status) VALUES($1,$2,$3,'accepted')",
          [ids.acceptedId, ids.botId, targetId]);
        return { id: "fixture-acknowledged" };
      });
      const result = await request(`/api/admin/bots/${ids.botId}`, "DELETE");
      expect(result.status).toBe(409); expect(result.body.message).toContain("not deleted");
      expect((await pool.query("SELECT id FROM bot_accounts WHERE id=$1", [ids.botId])).rows).toHaveLength(1);
      expect((await pool.query("SELECT status FROM bot_follow_requests WHERE id=$1", [ids.acceptedId])).rows[0].status).toBe("accepted");
    });
  });

  it("preserves a bot reactivated while delete recovery waits for its queue acknowledgement", async () => {
    await withBotFixtures(async ids => {
      await pendingOnly(ids);
      followQueue.add.mockImplementationOnce(async () => {
        await pool.query("UPDATE bot_accounts SET status='available' WHERE id=$1", [ids.botId]);
        return { id: "fixture-acknowledged" };
      });
      const result = await request(`/api/admin/bots/${ids.botId}`, "DELETE");
      expect(result.status).toBe(409); expect(result.body.message).toContain("reactivated");
      expect((await pool.query("SELECT status FROM bot_accounts WHERE id=$1", [ids.botId])).rows[0].status).toBe("available");
    });
  });
});
