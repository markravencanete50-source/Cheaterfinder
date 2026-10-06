// Read-only diagnostic render of the installed UI and actual admin handlers.
// Uses DB/Redis state and hydrates endpoint history; never starts workers,
// logs in, changes production sessions, or sends Instagram requests.
import "dotenv/config";
import express from "express";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
import { registerAdminRoutes } from "../server/admin-routes.js";
import { hydrateFromOutcomeLog } from "../server/services/scrape-metrics.js";
import { db, pool } from "../server/db.js";
import { PgDialect } from "drizzle-orm/pg-core";

// Live read-only rendering must not perform the handler's lazy settings DDL.
// The table must already exist; the real settings SELECT still runs below.
if (process.env.DIAGNOSTIC_READ_ONLY === "1") {
  // db.ts supplies explicit startup options, which override PGOPTIONS. Set
  // this diagnostic pool's actual options before its first connection.
  if (pool.totalCount !== 0) throw new Error("Read-only diagnostic must configure its pool before use");
  pool.options.options = `${pool.options.options ?? ""} -c default_transaction_read_only=on`;
  assert.equal((await pool.query("SHOW default_transaction_read_only")).rows[0].default_transaction_read_only, "on");
  const execute = db.execute.bind(db);
  db.execute = ((query: Parameters<typeof execute>[0]) => {
    const statement = new PgDialect().sqlToQuery(query as import("drizzle-orm").SQL).sql;
    if (/^\s*CREATE TABLE IF NOT EXISTS system_settings\s*\(/i.test(statement)) {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    return execute(query);
  }) as typeof db.execute;
}

const root = process.env.DIAGNOSTIC_PUBLIC_DIR ?? `${process.cwd()}/dist/public`;
const shellPath = process.env.DIAGNOSTIC_SHELL ?? `${process.cwd()}/dist/app-shell.html`;
const prefix = process.env.DIAGNOSTIC_SCREENSHOT_PREFIX ?? "/tmp/cheaterfinder-system-health-before";
const key = randomUUID();
const app = express();
app.use((req, res, next) => {
  if (req.headers["x-diagnostic-key"] !== key || req.method !== "GET") {
    res.sendStatus(403); return;
  }
  req.isAuthenticated = (() => true) as typeof req.isAuthenticated;
  req.user = { id: "diagnostic-only", role: "admin", email: "diagnostic@example.invalid" } as Express.User;
  next();
});
app.get("/api/auth/me", (_req, res) => res.json({ id: "diagnostic-only", role: "admin", email: "diagnostic@example.invalid" }));
registerAdminRoutes(app);
app.use(express.static(root));
const shell = await readFile(shellPath, "utf8");
app.use((_req, res) => res.type("html").send(shell));
await hydrateFromOutcomeLog();
const server = await new Promise<import("node:http").Server>(resolve => {
  const s = app.listen(0, "127.0.0.1", () => resolve(s));
});
const origin = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
const browser = await chromium.launch({ args: ["--no-sandbox"] });
try {
  const requestedHeight = Number(process.env.DIAGNOSTIC_VIEWPORT_HEIGHT ?? 1100);
  const height = Number.isFinite(requestedHeight) ? Math.max(844, Math.min(2400, Math.floor(requestedHeight))) : 1100;
  const page = await browser.newPage({ viewport: { width: 1440, height }, extraHTTPHeaders: { "x-diagnostic-key": key } });
  const errors: string[] = [], failedRequests: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("response", r => { if (r.url().startsWith(origin + "/api/") && !r.ok()) failedRequests.push(`${r.status()} ${new URL(r.url()).pathname}`); });
  await page.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const response = page.waitForResponse(r => r.url().endsWith("/api/admin/health") && r.status() === 200);
  await page.goto(`${origin}/admin/health`);
  const snapshot = await (await response).json();
  await page.getByRole("heading", { name: "System Health", exact: true }).waitFor();
  await page.waitForTimeout(800);
  if (process.env.DIAGNOSTIC_ASSERT_CURRENT === "1") {
    assert.match(await page.getByText("Active pool", { exact:true }).locator("..").innerText(), new RegExp(String(snapshot.summary.activePoolBots)));
    assert.match(await page.getByText("Leaseable", { exact:true }).locator("..").innerText(), new RegExp(String(snapshot.summary.leaseableBots)));
    await page.getByTestId("roster-health").waitFor();
    assert.match(await page.getByTestId("roster-health").innerText(), /complete read within 48h/);
    assert.equal(await page.getByText("Smartproxy", { exact:true }).count(), 0);
  }
  if (process.env.DIAGNOSTIC_ASSERT_SCAN_LABEL === "1") {
    await page.getByTestId("roster-sync-progress").filter({ hasText: "reported at scan start" }).waitFor();
  }
  await page.screenshot({ path: `${prefix}.png` });
  await page.screenshot({ path: `${prefix}-full.png`, fullPage: true });
  if (await page.getByTestId("roster-health").count()) {
    await page.getByTestId("roster-health").screenshot({path:`${prefix}-roster.png`});
    console.log("ROSTER_SCREENSHOT " + `${prefix}-roster.png`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${prefix}-mobile.png` });
  const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  const regressions: string[] = [];
  if (process.env.DIAGNOSTIC_ASSERT_CURRENT === "1") {
    let status = 200, calls = 0;
    await page.route("**/api/admin/health", async route => {
      calls += 1;
      const n = calls;
      if (n === 1) await new Promise(r=>setTimeout(r,600));
      const body = { ...snapshot, summary: { ...snapshot.summary, activePoolBots: n === 1 ? 777 : 888 }, queues: [{ name:"diagnostic-queue", waiting:0,active:0,delayed:0,failed:0,error:"Queue state unavailable" }] };
      await route.fulfill({ status, json: status === 200 ? body : { message:"Diagnostic error" } }).catch(()=>{});
    });
    await page.getByRole("button", {name:"Refresh",exact:true}).click();
    await page.waitForTimeout(100);
    await page.getByRole("button", {name:"Refresh",exact:true}).click();
    await page.waitForTimeout(800);
    assert.match(await page.getByText("Active pool", {exact:true}).locator("..").innerText(), /888/);
    await page.getByText("Queue state unavailable", {exact:true}).waitFor();
    regressions.push("request race", "unavailable queue is not zero");
    status=500;
    await page.getByRole("button", {name:"Refresh",exact:true}).click();
    await page.getByText("Failed to refresh health. Displayed data may be out of date.", {exact:true}).waitFor();
    regressions.push("refresh error visible");
    status=403;
    // The automatic poll can already observe 403 and remove the button before
    // Playwright's stability wait finishes. Either trigger now or assert the
    // permission-loss screen the poll has already produced.
    await page.evaluate(() => {
      [...document.querySelectorAll("button")].find(button => button.textContent?.trim() === "Refresh")?.click();
    });
    await page.getByText("Access Denied", {exact:true}).waitFor();
    assert.equal(await page.getByTestId("roster-health").count(),0);
    regressions.push("permission loss hides prior data");
  }
  console.log("HEALTH_SCREENSHOT " + JSON.stringify({ at: snapshot.generatedAt, source: "isolated read-only handlers + selected built frontend + current DB/Redis; error fixtures applied only after screenshots", status: snapshot.status, summary: snapshot.summary, collection:snapshot.collection, endpoints: snapshot.endpoints, screenshots: [prefix + ".png", prefix + "-full.png", prefix + "-mobile.png"], pageErrors: errors, failedRequests, mobileOverflow,regressions }));
} finally {
  await browser.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await pool.end();
}
process.exit(0);
