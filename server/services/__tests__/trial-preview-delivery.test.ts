// Provider/database boundaries are fixtures; no customer records or live delivery.
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({
  insert: vi.fn(), execute: vi.fn(), query: vi.fn(), push: vi.fn(), isPreview: vi.fn(), send: vi.fn(),
}));
vi.mock("../../db.js", () => ({ db: { insert: f.insert, execute: f.execute }, pool: { query: f.query } }));
vi.mock("../push-notifications.js", () => ({ sendPushToUser: f.push }));
vi.mock("../trial-preview-access.js", () => ({ isTrialPreviewUser: f.isPreview }));
vi.mock("../email-delivery.js", () => ({
  EmailDeliveryError: class extends Error { code = "fixture_failure"; }, sendApplicationEmail: f.send,
}));
vi.mock("../../observability/logger.js", () => ({ logger: { warn: vi.fn() } }));

import { createNotification } from "../notifications.js";
import { flushTransactionalEmails } from "../transactional-emails.js";

const drainPush = () => new Promise(resolve => setImmediate(resolve));
const values = vi.fn();
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("SESSION_SECRET", "trial-preview-delivery-fixture-secret");
  vi.stubEnv("APP_URL", "https://cheaterfinder.com");
  vi.stubEnv("EMAIL_FROM", "CheaterFinder <notifications@cheaterfinder.com>");
  f.insert.mockReturnValue({ values });
  values.mockReturnValue({ onConflictDoNothing: () => ({ returning: async () => [{ id: "notice-id" }] }) });
  f.isPreview.mockResolvedValue(true);
  f.push.mockResolvedValue(undefined);
  f.send.mockResolvedValue("provider-fixture-accepted");
});
afterEach(() => vi.unstubAllEnvs());

describe("trial preview push delivery", () => {
  it("stores real evidence but sends projected activity text and nested data to a trial user", async () => {
    const input = { userId: "customer-a", type: "new_like" as const, title: "Real private title", body: "@secret.person liked a private post",
      dedupeKey: "like:account-a:REALSOURCE", data: { username: "secret.person", postId: "REALSOURCE", trackedAccountId: "account-a",
        mediaUrl: "https://secret.example/photo.jpg", caption: "SECRET_CAPTION" } };
    await createNotification(input);
    await drainPush();
    expect(values).toHaveBeenCalledWith({ userId: input.userId, type: input.type, title: input.title, body: input.body,
      dedupeKey: input.dedupeKey });
    expect(f.push).toHaveBeenCalledTimes(1);
    const [userId, outgoing] = f.push.mock.calls[0];
    expect(userId).toBe(input.userId);
    expect(outgoing).toMatchObject({ title: "Activity preview", body: "Activate subscription to view this content.",
      data: { type: "new_like", trackedAccountId: "account-a", mediaUrl: "/assets/preview-blur.png" } });
    for (const privateValue of ["secret.person", "REALSOURCE", "SECRET_CAPTION", "https://secret.example", input.title]) {
      expect(JSON.stringify(outgoing)).not.toContain(privateValue);
    }
  });

  it("keeps real activity unchanged for an active user and preserves the transactional skipInsert path", async () => {
    f.isPreview.mockResolvedValue(false);
    await createNotification({ userId: "customer-a", type: "report_ready", title: "Weekly report ready",
      body: "Observed likes: 124", data: { reportId: "report-a" }, skipInsert: true });
    await drainPush();
    expect(f.insert).not.toHaveBeenCalled();
    expect(f.push).toHaveBeenCalledWith("customer-a", { title: "Weekly report ready", body: "Observed likes: 124",
      data: { type: "report_ready", reportId: "report-a" } });
  });

  it.each(["payment_failed", "subscription_updated", "trial_ending", "access_granted", "access_pending"] as const)(
    "keeps %s operational messaging actionable during a trial", async type => {
      await createNotification({ userId: "customer-a", type, title: "Account notice", body: "Open billing to update your card.",
        data: { url: "/settings?tab=billing" }, skipInsert: true });
      await drainPush();
      expect(f.push).toHaveBeenCalledWith("customer-a", { title: "Account notice", body: "Open billing to update your card.",
        data: { type, url: "/settings?tab=billing" } });
    },
  );

  it("fails closed when subscription lookup fails and never falls back to a raw activity push", async () => {
    f.isPreview.mockRejectedValue(new Error("database unavailable"));
    await expect(createNotification({ userId: "customer-a", type: "new_follow", title: "Sensitive title",
      body: "Sensitive content", skipInsert: true })).resolves.toBeUndefined();
    await drainPush();
    expect(f.push).not.toHaveBeenCalled();
  });

  it("does not deliver a duplicate business event", async () => {
    values.mockReturnValue({ onConflictDoNothing: () => ({ returning: async () => [] }) });
    await createNotification({ userId: "customer-a", type: "new_like", title: "New like", body: "Private activity", dedupeKey: "duplicate" });
    await drainPush();
    expect(f.isPreview).not.toHaveBeenCalled();
    expect(f.push).not.toHaveBeenCalled();
  });
});

type EmailRow = { id: string; user_id: string; kind: string; payload: Record<string, any> };
function emailFixture(status: "trialing" | "active", frozen = false, kind = "report") {
  const originalDelivery = { to: "fixture@example.invalid", from: "CheaterFinder <notifications@cheaterfinder.com>",
    subject: "Frozen real report", text: "Private report details: 872 likes", html: "<p>Private report details: 872 likes</p>" };
  const row: EmailRow = { id: "email-a", user_id: "customer-a", kind,
    payload: { reportId: "report-a", ...(frozen ? { delivery: originalDelivery } : {}) } };
  const sqlStatements: string[] = [];
  const dialect = new PgDialect();
  f.execute.mockImplementation(async query => {
    const statement = dialect.sqlToQuery(query).sql.replace(/\s+/g, " ");
    sqlStatements.push(statement);
    // Exercise the production query's correlated exclusion in this fixture.
    // Without the predicate, the fixture exposes the real report just as the
    // existing broad active-or-trial entitlement would.
    const excludesTrial = /NOT EXISTS \(SELECT 1 FROM subscriptions preview WHERE preview\.user_id=t\.user_id AND preview\.status='trialing'\)/.test(statement);
    return { rows: status === "trialing" && excludesTrial ? [] : [{ type: "weekly", ig_username: "tracked.account",
      metrics: { summary: { totalLikes: 872, netFollowerChange: 16 }, peakActivityHour: 14 },
      period_start: new Date("2026-09-20T00:00:00Z"), period_end: new Date("2026-09-27T00:00:00Z") }] };
  });
  f.query.mockImplementation(async (query: string) => {
    if (query.includes("WITH due AS")) return { rows: [row], rowCount: 1 };
    if (query.startsWith("SELECT name,email")) return { rows: [{ name: "Fixture", email: originalDelivery.to }], rowCount: 1 };
    return { rows: [{ id: row.id }], rowCount: 1 };
  });
  return { row, originalDelivery, sqlStatements };
}

describe("trial preview report email delivery", () => {
  it.each([false, true])("suppresses queued real report mail for a trial, including frozen retries (frozen=%s)", async frozen => {
    const fixture = emailFixture("trialing", frozen);
    expect(await flushTransactionalEmails(1, fixture.row.id)).toEqual({ accepted: 0, skipped: 1, failed: 0 });
    expect(f.send).not.toHaveBeenCalled();
    expect(fixture.sqlStatements).toHaveLength(1);
    expect(fixture.sqlStatements[0]).toContain("preview.user_id=t.user_id AND preview.status='trialing'");
    expect(f.query.mock.calls.some(([query]) => query.includes("skipped_at=now()"))).toBe(true);
    expect(f.query.mock.calls.some(([query]) => query.includes("jsonb_set"))).toBe(false);
  });

  it.each([false, true])("preserves real report delivery and idempotency for an active user (frozen=%s)", async frozen => {
    const fixture = emailFixture("active", frozen);
    expect(await flushTransactionalEmails(1, fixture.row.id)).toEqual({ accepted: 1, skipped: 0, failed: 0 });
    expect(f.send).toHaveBeenCalledTimes(1);
    const [delivery, key] = f.send.mock.calls[0];
    expect(key).toBe("email-job:report-email-report-a");
    if (frozen) expect(delivery).toEqual(fixture.originalDelivery);
    else expect(delivery.text).toContain("Observed likes: 872");
  });

  it("retains non-report transactional messages during a trial", async () => {
    const fixture = emailFixture("trialing", false, "welcome");
    expect(await flushTransactionalEmails(1, fixture.row.id)).toEqual({ accepted: 1, skipped: 0, failed: 0 });
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it("retries an eligibility lookup failure without sending a frozen report body", async () => {
    const fixture = emailFixture("trialing", true);
    f.execute.mockRejectedValue(new Error("database unavailable"));
    expect(await flushTransactionalEmails(1, fixture.row.id)).toEqual({ accepted: 0, skipped: 0, failed: 1 });
    expect(f.send).not.toHaveBeenCalled();
  });
});
