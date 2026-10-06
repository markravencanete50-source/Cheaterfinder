import { describe, expect, it, vi } from "vitest";
import {
  MOBILE_OWN_ACCOUNT_PATH,
  parseMobileRevalidationArgs,
  revalidateMobileSession,
  validateSavedMobileSession,
  type MobileRevalidationBot,
  type MobileRevalidationDependencies,
} from "../mobile-session-revalidation.js";
import type { OperationLeaseGuard } from "../operation-lease.js";

const BOT_ID = "12345678-1234-1234-1234-123456789abc";
const EXPECTED_ID = "123456789";
const NOW = new Date("2026-09-25T12:00:00Z");
const options = { botId: BOT_ID, expectedUserId: EXPECTED_ID, apply: true };
const session = () => ({
  __marker: "instagram-mobile-bearer", version: 1, dsUserId: EXPECTED_ID,
  sessionid: `${EXPECTED_ID}%3Asynthetic-cookie`,
  bearer: "Bearer IGT:2:" + Buffer.from(JSON.stringify({ ds_user_id: EXPECTED_ID, sessionid: `${EXPECTED_ID}:synthetic-cookie` })).toString("base64"),
  mid: "synthetic-mid", wwwClaim: "0", rur: null, userAgent: "Synthetic test device",
  androidId: "android-1234567890abcdef", deviceUuid: BOT_ID, extraUuids: [],
});

function harness(overrides: Partial<MobileRevalidationBot> = {}) {
  const bot: MobileRevalidationBot = {
    id: BOT_ID, rowVersion: "100", igUserId: EXPECTED_ID, igUsername: "private_test_name",
    sessionData: "v1:synthetic-encrypted-session", proxyUrl: "http://private-user:private-password@proxy.example.invalid:10000",
    hasAutomationIdentity: false, transport: "mobile", tier: "worker", role: "scraper",
    status: "session_expired", cooldownUntil: null, lastLoginError: null, ...overrides,
  };
  const controller = new AbortController();
  const guard = { assertOwned: vi.fn(async () => {}) };
  const client = { fetchRaw: vi.fn(async (): Promise<unknown> => ({ status: "ok", user: { pk: EXPECTED_ID } })), close: vi.fn(async () => {}) };
  const deps = {
    now: () => NOW,
    readBot: vi.fn(async (): Promise<MobileRevalidationBot | null> => bot),
    decrypt: vi.fn(() => JSON.stringify(session())),
    withLease: vi.fn(async <T>(_key: string, work: (signal: AbortSignal, leaseGuard: OperationLeaseGuard) => Promise<T>): Promise<T> => work(controller.signal, guard)),
    reserveProfileBudget: vi.fn(async () => {}),
    createClient: vi.fn(() => client),
    commitRecovered: vi.fn(async () => true),
  } satisfies MobileRevalidationDependencies;
  return { bot, deps, client, controller, guard };
}

describe("one-bot mobile recovery arguments", () => {
  it("requires explicit identifiers, with a read-only default", () => {
    expect(parseMobileRevalidationArgs(["--bot-id", BOT_ID, "--expected-user-id", EXPECTED_ID])).toEqual({ ...options, apply: false });
    expect(parseMobileRevalidationArgs(["--bot-id", BOT_ID, "--expected-user-id", EXPECTED_ID, "--apply"])).toEqual(options);
    expect(parseMobileRevalidationArgs(["--help"])).toBeNull();
  });
  it.each([
    [], ["--apply"], ["--bot-id", BOT_ID, "--apply"],
    ["--bot-id", BOT_ID, "--expected-user-id", "username"],
    ["--bot-id", BOT_ID, "--expected-user-id", EXPECTED_ID, "--all"],
    ["--bot-id", BOT_ID, "--expected-user-id", EXPECTED_ID, "--apply", "--dry-run"],
    ["--bot-id", BOT_ID, "--expected-user-id", EXPECTED_ID, "--bot-id", BOT_ID],
  ].map(argv => ({ argv })))("rejects incomplete, ambiguous or bulk arguments %#", ({ argv }) => {
    expect(() => parseMobileRevalidationArgs(argv)).toThrow("invalid_arguments");
  });
});

describe("mobile saved-session diagnostic", () => {
  it("previews without a lease, quota reservation, upstream client or write", async () => {
    const { deps } = harness();
    const report = await revalidateMobileSession({ ...options, apply: false }, deps);
    expect(report).toEqual({ mode: "dry_run", outcome: "eligible", reason: "eligible_for_one_identity_check", requestAttempted: false, dailyBudgetReserved: false, botChanged: false });
    expect(deps.withLease).not.toHaveBeenCalled();
    expect(deps.reserveProfileBudget).not.toHaveBeenCalled();
    expect(deps.createClient).not.toHaveBeenCalled();
    expect(deps.commitRecovered).not.toHaveBeenCalled();
  });

  it.each([
    { status: "banned" }, { status: "disabled" }, { status: "available" }, { status: "in_use" },
    { transport: "web" }, { tier: "reserve" }, { tier: "retired" }, { role: "feed_watcher" },
    { hasAutomationIdentity: true }, { lastLoginError: "challenge_required: private context" },
    { lastLoginError: "mobile session dead: 6 consecutive auth failures" },
    { cooldownUntil: new Date(NOW.getTime() + 1) },
    { proxyUrl: null }, { proxyUrl: "http://rotating.dataimpulse.com:823" },
    { sessionData: JSON.stringify(session()) }, { igUserId: "987654321" },
  ])("does not probe an ineligible candidate %#", async overrides => {
    const { deps } = harness(overrides);
    expect((await revalidateMobileSession(options, deps)).outcome).toBe("blocked");
    expect(deps.withLease).not.toHaveBeenCalled();
    expect(deps.createClient).not.toHaveBeenCalled();
    expect(deps.commitRecovered).not.toHaveBeenCalled();
  });

  it("rejects a disappeared row and a decryption failure without echoing private data", async () => {
    const { deps } = harness();
    deps.readBot.mockResolvedValueOnce(null);
    expect((await revalidateMobileSession(options, deps)).reason).toBe("not_found");
    deps.decrypt.mockImplementationOnce(() => { throw new Error("private-password private-token"); });
    const report = await revalidateMobileSession(options, deps);
    expect(report.reason).toBe("operation_failed");
    expect(JSON.stringify(report)).not.toContain("private");
    expect(deps.createClient).not.toHaveBeenCalled();
  });

  it("rejects inconsistent bearer/cookie/account identity and missing original device fields", () => {
    const valid = session();
    expect(validateSavedMobileSession(JSON.stringify(valid), EXPECTED_ID)).toEqual(valid);
    for (const patch of [
      { dsUserId: "987654321" }, { version: 2 }, { deviceUuid: "" }, { userAgent: "" },
      { sessionid: "987654321%3Adifferent" }, { extraUuids: ["malformed"] },
      { bearer: "Bearer IGT:2:" + Buffer.from(JSON.stringify({ ds_user_id: EXPECTED_ID, sessionid: `${EXPECTED_ID}:different-cookie` })).toString("base64") },
      { bearer: "Bearer IGT:2:" + Buffer.from(JSON.stringify({ ds_user_id: "987654321", sessionid: valid.sessionid })).toString("base64") },
    ]) expect(() => validateSavedMobileSession(JSON.stringify({ ...valid, ...patch }), EXPECTED_ID)).toThrow("invalid_saved_session");
  });

  it("uses exactly one authenticated own-account GET on the unchanged saved session/proxy", async () => {
    const { bot, deps, client, guard } = harness({ cooldownUntil: new Date(NOW.getTime() - 1) });
    const original = structuredClone(bot);
    const report = await revalidateMobileSession(options, deps);
    expect(report).toMatchObject({ outcome: "recovered", reason: "same_identity_confirmed", requestAttempted: true, dailyBudgetReserved: true, botChanged: true });
    expect(deps.withLease).toHaveBeenCalledWith(`bot:${BOT_ID}`, expect.any(Function));
    expect(deps.readBot).toHaveBeenCalledTimes(3);
    expect(deps.reserveProfileBudget).toHaveBeenCalledExactlyOnceWith(BOT_ID);
    expect(deps.createClient).toHaveBeenCalledExactlyOnceWith(bot, session());
    expect(client.fetchRaw).toHaveBeenCalledExactlyOnceWith(MOBILE_OWN_ACCOUNT_PATH, { method: "GET" });
    expect(deps.commitRecovered).toHaveBeenCalledExactlyOnceWith(bot, guard);
    expect(client.close).toHaveBeenCalledTimes(1);
    expect(bot).toEqual(original);
    expect(JSON.stringify(report)).not.toMatch(/private|synthetic|123456789|proxy/);
  });

  it.each([
    { status: "ok", user: { pk: "987654321" } },
    { status: "ok", data: { user: { pk: EXPECTED_ID } } },
    { status: "ok", user: { pk: EXPECTED_ID, pk_id: "987654321" } },
    { user: { pk: EXPECTED_ID } }, { status: "fail", user: { pk: EXPECTED_ID } },
    { status: "ok", user: { pk: EXPECTED_ID }, challenge: { url: "private-token" } },
    "<html>logged out</html>", null,
  ])("does not treat a public, mismatched, malformed or challenged envelope as proof %#", async response => {
    const { deps, client } = harness();
    client.fetchRaw.mockResolvedValueOnce(response);
    expect((await revalidateMobileSession(options, deps)).outcome).toBe("unverified");
    expect(deps.commitRecovered).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["IGRateLimitedError", "rate_limited"], ["IGAuthExpiredError", "login_required"],
    ["IGHttpError", "operation_failed"], ["AbortError", "operation_failed"],
  ])("leaves holds untouched after %s, with no retry or private output", async (name, reason) => {
    const { bot, deps, client } = harness({ cooldownUntil: new Date(NOW.getTime() - 1) });
    const original = structuredClone(bot);
    client.fetchRaw.mockRejectedValueOnce(Object.assign(new Error("private-password private-token private_test_name"), { name, body: "private-contact" }));
    const report = await revalidateMobileSession(options, deps);
    expect(report).toMatchObject({ outcome: "unverified", reason, botChanged: false });
    expect(JSON.stringify(report)).not.toContain("private");
    expect(client.fetchRaw).toHaveBeenCalledTimes(1);
    expect(deps.commitRecovered).not.toHaveBeenCalled();
    expect(bot).toEqual(original);
  });

  it("retains a newly observed challenge as an unverified result", async () => {
    const { deps, client } = harness();
    client.fetchRaw.mockRejectedValueOnce(Object.assign(new Error("private context"), { authDiagnostics: { reason: "checkpoint_required", challengeKind: "native" } }));
    expect(await revalidateMobileSession(options, deps)).toMatchObject({ reason: "challenge_required", botChanged: false });
    expect(deps.commitRecovered).not.toHaveBeenCalled();
  });

  it("does not call upstream after quota denial", async () => {
    const { deps, client } = harness();
    deps.reserveProfileBudget.mockRejectedValueOnce(Object.assign(new Error("private bot id"), { name: "IGDailyCapExceededError" }));
    expect(await revalidateMobileSession(options, deps)).toMatchObject({ reason: "daily_cap", requestAttempted: false, botChanged: false });
    expect(client.fetchRaw).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("does not reserve quota when another process owns the bot", async () => {
    const { deps } = harness();
    deps.withLease.mockRejectedValueOnce(Object.assign(new Error("private key"), { name: "OperationBusyError" }));
    expect((await revalidateMobileSession(options, deps)).reason).toBe("lease_busy");
    expect(deps.reserveProfileBudget).not.toHaveBeenCalled();
  });

  it.each([2, 3])("stops on an operator edit at read %i", async readNumber => {
    const { bot, deps, client } = harness();
    for (let i = 1; i < readNumber; i += 1) deps.readBot.mockResolvedValueOnce(bot);
    deps.readBot.mockResolvedValueOnce({ ...bot, rowVersion: "101" });
    expect((await revalidateMobileSession(options, deps)).reason).toBe("snapshot_changed");
    expect(client.fetchRaw).not.toHaveBeenCalled();
    expect(deps.commitRecovered).not.toHaveBeenCalled();
  });

  it("cannot persist after losing the lease during upstream I/O", async () => {
    const { deps, client, controller } = harness();
    client.fetchRaw.mockImplementationOnce(async () => { controller.abort(); return { status: "ok", user: { pk: EXPECTED_ID } }; });
    expect((await revalidateMobileSession(options, deps)).reason).toBe("lease_lost");
    expect(deps.commitRecovered).not.toHaveBeenCalled();
  });

  it("reports a final CAS conflict without claiming recovery", async () => {
    const { deps } = harness();
    deps.commitRecovered.mockResolvedValueOnce(false);
    expect(await revalidateMobileSession(options, deps)).toMatchObject({ outcome: "unverified", reason: "snapshot_changed", botChanged: false });
  });
});
