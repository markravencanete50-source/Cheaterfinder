import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ request: vi.fn(), profileWrite: vi.fn(), postsWrite: vi.fn(), access: vi.fn() }));
vi.mock("../../db.js", () => ({ db: { select: () => {
  const chain = { from: () => chain, where: () => chain, orderBy: () => chain,
    limit: async () => [{ endpoint: "proxy.invalid:10001", expiresAt: new Date(Date.now() + 3600_000) }] };
  return chain;
} } }));
vi.mock("../proxy-provider.js", () => ({ fetchEndpoints: vi.fn(), proxyAgentUriForEndpoint: () => "http://proxy.invalid:10001" }));
vi.mock("../automation-client.js", () => ({ createAutomationClient: () => ({ createIdentity: async () => ({ bot_id: "public-fixture" }), requestInstagramHttp: f.request }) }));
vi.mock("../subscription-access.js", () => ({ trackedAccountHasAccess: f.access }));
vi.mock("../public-data-collector.js", () => ({ applyProfileToDb: f.profileWrite }));
vi.mock("../public-data-persistence.js", () => ({ persistPosts: f.postsWrite }));
vi.mock("../../ig-public-scraper.js", () => ({ extractHashtags: () => [], mapProfile: (profile: any) => ({ ...profile, postCount: profile.mediaCount }) }));
vi.mock("../bandwidth-meter.js", () => ({ recordBytes: vi.fn(), withScrapeContext: async (_context: unknown, work: () => unknown) => work() }));
vi.mock("../../observability/logger.js", () => ({ logger: { child: () => ({ warn: vi.fn(), info: vi.fn() }) } }));
import { fetchPublicProfileTier1, refreshPublicProfileTier1 } from "../public-read-client.js";
const profile = (username: string) => ({ status: "ok", data: { user: { id: "123", username,
  edge_followed_by: { count: 3 }, edge_follow: { count: 4 }, edge_owner_to_timeline_media: { count: 1, edges: [] } } } });
const response = (body: unknown, status = 200) => ({ body: typeof body === "string" ? body : JSON.stringify(body), status, headers: {} });
beforeEach(() => { vi.clearAllMocks(); f.access.mockResolvedValue(true); });
describe("unauthenticated profile evidence", () => {
  it.each([{}, { data: { user: null } }, { status: "fail", message: "login_required" }, "<html>Log in</html>"])("does not declare a missing account from a malformed/login envelope", async body => {
    f.request.mockResolvedValue(response(body));
    expect(await fetchPublicProfileTier1("unavailable_fixture")).toMatchObject({ ok: false, reason: "error" });
  });
  it("accepts an explicit 404 as not found", async () => {
    f.request.mockResolvedValue(response({}, 404));
    expect(await fetchPublicProfileTier1("missing_fixture")).toMatchObject({ ok: false, reason: "not_found", status: 404 });
  });
  it("rejects another profile identity rather than caching it under the requested name", async () => {
    f.request.mockResolvedValueOnce(response(profile("somebody_else"))).mockResolvedValueOnce(response(profile("identity_fixture")));
    expect(await fetchPublicProfileTier1("identity_fixture")).toMatchObject({ ok: false, reason: "error" });
    expect(await fetchPublicProfileTier1("identity_fixture")).toMatchObject({ ok: true, profile: { username: "identity_fixture" } });
    expect(f.request).toHaveBeenCalledTimes(2);
  });
  it("rechecks subscription access after a completed provider read and before persisting", async () => {
    f.access.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    f.request.mockResolvedValue(response(profile("revoked_fixture")));
    expect(await refreshPublicProfileTier1({ id: "account", userId: "customer", igUsername: "revoked_fixture", isActive: true })).toEqual({ ok: false, reason: "inactive" });
    expect(f.profileWrite).not.toHaveBeenCalled(); expect(f.postsWrite).not.toHaveBeenCalled();
  });
});
