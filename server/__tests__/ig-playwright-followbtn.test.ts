// Unit tests for detectAndClickFollow in ig-playwright-client.ts.
//
// We mock the Playwright page object — no real browser is launched. The page
// exposes a single `locator(selector).first().isVisible()` chain plus a
// `click()` and a `screenshot()` method. Each test programs which selectors
// should report visible and validates the returned state.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.stubEnv("DATABASE_URL", "postgres://mock:mock@localhost/mock");
// Dynamic import ensures the env stub runs before transitive db.ts loading.
const { detectAndClickFollow } = await import("../ig-playwright-client.js");

// Selector constants must mirror the ones in ig-playwright-client.ts. We don't
// export them — duplicating here keeps the test independent and forces a test
// failure if production selectors drift unexpectedly.
const FOLLOWING_SEL =
  'main header button:text-is("Following"), main header div[role="button"]:text-is("Following")';
const REQUESTED_SEL =
  'main header button:text-is("Requested"), main header div[role="button"]:text-is("Requested")';
const FOLLOW_SEL =
  'main header button:text-is("Follow"), main header div[role="button"]:text-is("Follow"), main header button:text-is("Follow Back"), main header button:text-is("Seguir")';

interface VisibilityMap {
  // Maps selector string -> sequence of booleans returned by isVisible().
  // Each call to isVisible on that selector consumes the next entry. If
  // exhausted, the last value is reused. Defaults to false.
  [selector: string]: boolean[];
}

function makeMockPage(visibility: VisibilityMap) {
  // Track click and screenshot invocations for assertions.
  const clickedSelectors: string[] = [];
  const screenshotCalls: Array<Record<string, unknown> | undefined> = [];

  // Mutable copy so we can mutate visibility mid-test (e.g. after click).
  const state: VisibilityMap = { ...visibility };

  const locator = (selector: string) => ({
    first: () => ({
      click: vi.fn(async () => {
        clickedSelectors.push(selector);
      }),
      waitFor: vi.fn(async () => undefined),
      isVisible: vi.fn(async () => {
        const queue = state[selector];
        if (!queue || queue.length === 0) return false;
        const next = queue.length === 1 ? queue[0] : queue.shift();
        return next ?? false;
      }),
    }),
  });

  const page = {
    locator,
    url: () => "https://www.instagram.com/test/",
    goto: vi.fn(async () => undefined),
    mouse: {
      move: vi.fn(async () => undefined),
    },
    waitForTimeout: vi.fn(async () => undefined),
    screenshot: vi.fn(async (opts?: Record<string, unknown>) => {
      screenshotCalls.push(opts);
    }),
    close: vi.fn(async () => undefined),
  };

  return { page, clickedSelectors, screenshotCalls, state };
}

describe("detectAndClickFollow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns following=true when 'Following' button is already visible", async () => {
    const { page, clickedSelectors } = makeMockPage({
      [FOLLOWING_SEL]: [true],
    });

    const result = await detectAndClickFollow(
      page as unknown as Parameters<typeof detectAndClickFollow>[0],
      "test",
    );

    expect(result).toEqual({ requested: false, following: true });
    expect(clickedSelectors).toHaveLength(0);
  });

  it("returns requested=true when 'Requested' button is already visible", async () => {
    const { page, clickedSelectors } = makeMockPage({
      [FOLLOWING_SEL]: [false],
      [REQUESTED_SEL]: [true],
    });

    const result = await detectAndClickFollow(
      page as unknown as Parameters<typeof detectAndClickFollow>[0],
      "test",
    );

    expect(result).toEqual({ requested: true, following: false });
    expect(clickedSelectors).toHaveLength(0);
  });

  it("clicks Follow and reports requested=true when the post-click state shows 'Requested'", async () => {
    const { page, clickedSelectors } = makeMockPage({
      // Pre-click state probes
      [FOLLOWING_SEL]: [false, false], // first probe (already-following), then post-click probe
      [REQUESTED_SEL]: [false, true], // first probe (already-requested), then post-click probe
      [FOLLOW_SEL]: [true],
    });

    const result = await detectAndClickFollow(
      page as unknown as Parameters<typeof detectAndClickFollow>[0],
      "test",
    );

    expect(result).toEqual({ requested: true, following: false });
    expect(clickedSelectors).toEqual([FOLLOW_SEL]);
  });

  it("returns null when no Follow / Following / Requested button is visible", async () => {
    const { page, clickedSelectors, screenshotCalls } = makeMockPage({
      [FOLLOWING_SEL]: [false],
      [REQUESTED_SEL]: [false],
      [FOLLOW_SEL]: [false],
    });

    const result = await detectAndClickFollow(
      page as unknown as Parameters<typeof detectAndClickFollow>[0],
      "test",
    );

    expect(result).toBeNull();
    expect(clickedSelectors).toHaveLength(0);
    // Ensures we capture a debug screenshot for triage on the failure path.
    expect(screenshotCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("does not click after access is revoked while the action row hydrates", async () => {
    const { page, clickedSelectors } = makeMockPage({ [FOLLOW_SEL]: [true] });
    let eligible = true;
    const locator = page.locator;
    page.locator = (selector) => ({ first: () => ({
      ...locator(selector).first(),
      waitFor: vi.fn(async () => { eligible = false; }),
    }) });
    const canFollow = vi.fn(async () => eligible);
    const result = await detectAndClickFollow(
      page as unknown as Parameters<typeof detectAndClickFollow>[0], "test", canFollow,
    );
    expect(canFollow).toHaveBeenCalledOnce();
    expect(result).toBeNull();
    expect(clickedSelectors).toHaveLength(0);
  });
  it.each(["https://www.instagram.com/accounts/login/", "https://www.instagram.com/somebody_else/", "https://attacker.invalid/test/"])("never observes or clicks follow on a redirected page: %s", async current => {
    const { page, clickedSelectors } = makeMockPage({ [FOLLOWING_SEL]: [true], [FOLLOW_SEL]: [true] });
    page.url = () => current;
    const locator = vi.spyOn(page, "locator");
    expect(await detectAndClickFollow(page, "test")).toBeNull();
    expect(locator).not.toHaveBeenCalled();
    expect(clickedSelectors).toHaveLength(0);
  });
  it("rechecks profile identity after hydration before any relationship evidence", async () => {
    const { page, clickedSelectors } = makeMockPage({ [FOLLOWING_SEL]: [true], [FOLLOW_SEL]: [true] });
    const locator = page.locator;
    page.locator = selector => ({ first: () => ({ ...locator(selector).first(), waitFor: vi.fn(async () => {
      page.url = () => "https://www.instagram.com/another/";
    }) }) });
    expect(await detectAndClickFollow(page, "test")).toBeNull();
    expect(clickedSelectors).toHaveLength(0);
  });

});
