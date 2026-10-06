import { beforeEach, describe, expect, it, vi } from "vitest";
const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock("undici", () => ({
  fetch: fetchMock,
  Agent: class {},
  ProxyAgent: class {},
}));
vi.mock("../services/proxy-provider.js", () => ({ proxyAgentUriForEndpoint: vi.fn() }));
vi.mock("../services/bandwidth-meter.js", () => ({ recordBytes: vi.fn() }));
vi.mock("../ig-http-client.js", () => ({
  IGAuthExpiredError: class extends Error {},
  IGRateLimitedError: class extends Error {},
  IGHttpError: class extends Error { constructor(_status: number, message: string) { super(message); } },
  formatNetworkErrorMessage: () => "network error",
}));
import { createMobileReadClient } from "../ig-mobile-read-client.js";
import type { MobileSession } from "../services/mobile-session.js";
const session: MobileSession = {
  __marker: "instagram-mobile-bearer", version: 1, dsUserId: "1", sessionid: "test",
  mid: "test", bearer: "test-only", wwwClaim: "0", rur: null,
  userAgent: "test-agent", androidId: "android-test", deviceUuid: "test-device", extraUuids: [],
};
const read = () => createMobileReadClient({ session, proxyEndpoint: null, botId: "test", botUsername: "test" }).fetchUserFeed("123");
beforeEach(() => fetchMock.mockReset());
describe("mobile posts accuracy", () => {
  it.each([{}, null, [], { status: "fail" }, { status: "fail", items: [] }, { items: null }])(
    "does not accept an invalid 200 envelope as fresh empty posts: %j", async body => {
      fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
      await expect(read()).rejects.toThrow();
    },
  );
  it("retains valid empty results", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ status: "ok", items: [], more_available: false })));
    await expect(read()).resolves.toMatchObject({ items: [], nextMaxId: null });
  });
  it("retains actual post identities and pagination", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ status: "ok", items: [
      { pk: "456", id: "456_123", code: "actual-post", media_type: 1, taken_at: 1700000000 },
    ], more_available: true, next_max_id: "next-page" })));
    const page = await read();
    expect(page.items).toHaveLength(1);
    expect(page.nextMaxId).toBe("next-page");
    expect(JSON.stringify(page.items[0])).toContain("actual-post");
  });
});
