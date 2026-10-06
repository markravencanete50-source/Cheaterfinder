// Smoke test: invoke loginBot's chromium config through Playwright in
// isolation, using a fresh proxy fetched the same way bot-runtime does.

import {
  fetchHealthyEndpoints,
  proxyEndpointLabel,
  toPlaywrightProxy,
} from "../services/proxy-provider.js";

async function main(): Promise<void> {
  const [endpoint] = await fetchHealthyEndpoints(1, { country: "US" });
  if (!endpoint) {
    throw new Error("no proxy");
  }
  console.log("Got:", proxyEndpointLabel(endpoint.endpoint));

  const { chromium } = await import("playwright");
  const browser = await chromium.launch({
    headless: true,
    proxy: toPlaywrightProxy(endpoint),
    args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
  });
  try {
    const ctx = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
      viewport: { width: 1366, height: 768 },
      locale: "en-US",
      timezoneId: "America/New_York",
    });
    ctx.setDefaultTimeout(15_000);
    ctx.setDefaultNavigationTimeout(30_000);

    const page = await ctx.newPage();
    console.log("→ goto IG");
    const t0 = Date.now();
    await page.goto("https://www.instagram.com/accounts/login/", {
      waitUntil: "domcontentloaded",
    });
    console.log("OK", page.url(), "in", Date.now() - t0, "ms");
  } finally {
    await browser.close();
  }
}

await main();
