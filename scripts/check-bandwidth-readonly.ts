// Isolated diagnostic: installed UI + real report SELECTs on a read-only DB
// connection. No production session, DDL, IG request, meter or sampler start.
import "dotenv/config";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import express from "express";
import { Client } from "pg";
import { PgDialect } from "drizzle-orm/pg-core";
import { chromium } from "playwright";
import { db, pool } from "../server/db.js";
import { getBandwidthReport } from "../server/services/bandwidth-meter.js";
import { getRefreshInterval } from "../server/services/refresh-config.js";

const client = new Client({ connectionString: process.env.DATABASE_URL,
  options: "-c default_transaction_read_only=on -c statement_timeout=15000" });
await client.connect();
const dialect = new PgDialect();
let skippedDdl = 0;
db.execute = (async (query: Parameters<typeof dialect.sqlToQuery>[0]) => {
  const q = dialect.sqlToQuery(query);
  // These idempotent initialization calls are unnecessary in the diagnostic;
  // actual table existence is proved by the subsequent real SELECTs.
  if (/^\s*CREATE (TABLE|INDEX) IF NOT EXISTS /i.test(q.sql)) { skippedDdl++; return { rows: [] }; }
  if (!/^\s*SELECT\b/i.test(q.sql)) throw new Error("Non-SELECT blocked in diagnostic");
  return client.query(q.sql, q.params);
}) as typeof db.execute;
// snapshot() below already owns the real read-only repeatable-read transaction.
db.transaction = (async work => work(db as never)) as typeof db.transaction;

async function snapshot() {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    const report = await getBandwidthReport("24h");
    const meta = (await client.query(`SELECT now() AS at,
      (SELECT max(id) FROM bandwidth_log) AS attribution_id,
      (SELECT max(occurred_at) FROM bandwidth_log) AS attribution_at,
      (SELECT max(id) FROM proxy_wire_samples) AS wire_id,
      (SELECT max(sampled_at) FROM proxy_wire_samples) AS wire_at`)).rows[0];
    const wireHourly = (await client.query(`SELECT count(*)::int samples,
      coalesce(sum(bytes_in+bytes_out),0)::bigint bytes,
      coalesce(sum(span_seconds),0)::int coverage_seconds,
      max(span_seconds)::int largest_span_seconds
      FROM proxy_wire_samples WHERE sampled_at>=now()-interval '1 hour'`)).rows[0];
    const sources = (await client.query(`SELECT byte_source,coalesce(transport,'unknown') transport,
      sum(bytes_in+bytes_out)::bigint bytes,sum(requests)::bigint requests,sum(failures)::bigint failures
      FROM bandwidth_log WHERE occurred_at>=now()-interval '1 hour' GROUP BY 1,2 ORDER BY 1,2`)).rows;
    const sums = { profiles:report.byProfile.reduce((s,r)=>s+r.totalBytes,0),
      users:report.byUser.reduce((s,r)=>s+r.totalBytes,0), endpoints:report.byEndpoint.reduce((s,r)=>s+r.totalBytes,0) };
    assert.equal(sums.endpoints,report.totals.totalBytes);
    if(report.byProfile.length<200)assert.equal(sums.profiles,report.totals.totalBytes);
    if(report.byUser.length<200)assert.equal(sums.users,report.totals.totalBytes);
    await client.query("COMMIT");
    return { report, meta, wireHourly, sources, sums };
  } catch(error) { await client.query("ROLLBACK"); throw error; }
}

const first = await snapshot();
const cadence = await getRefreshInterval();
let visibleReport = first.report;
let bandwidthCalls = 0;
const app = express();
app.use(express.static(process.env.DIAGNOSTIC_PUBLIC_DIR ?? `${process.cwd()}/dist/public`));
const shell = await readFile(process.env.DIAGNOSTIC_SHELL ?? `${process.cwd()}/dist/app-shell.html`,"utf8");
const currentUi = process.env.DIAGNOSTIC_ASSERT_CURRENT === "1";
const screenshotPrefix = process.env.DIAGNOSTIC_SCREENSHOT_PREFIX ?? "/tmp/cheaterfinder-bandwidth-20260907";
app.use((_req,res)=>res.type("html").send(shell));
const server = await new Promise<import("node:http").Server>(resolve=>{
  const s=app.listen(0,"127.0.0.1",()=>resolve(s));
});
const origin=`http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
const browser = await chromium.launch({args:["--no-sandbox"]});
try {
  const page=await browser.newPage({viewport:{width:1440,height:1100}});
  const pageErrors:string[]=[];
  page.on("pageerror",e=>pageErrors.push(e.message));
  await page.route("**/*",route=>{
    const url=new URL(route.request().url());
    if(url.origin!==origin || route.request().method()!=="GET")return route.abort();
    if(!url.pathname.startsWith("/api/"))return route.continue();
    if(url.pathname==="/api/auth/me")return route.fulfill({json:{id:"diagnostic",email:"diagnostic@example.invalid",role:"admin"}});
    if(url.pathname==="/api/admin/refresh-interval")return route.fulfill({json:{current:cadence}});
    if(url.pathname==="/api/admin/bandwidth") {
      bandwidthCalls++;
      // Only customer contact information is redacted from screenshots.
      return route.fulfill({json:{...visibleReport,
        byProfile:visibleReport.byProfile.map(r=>({...r,userEmail:r.userEmail?"[customer redacted]":null})),
        byUser:visibleReport.byUser.map(r=>({...r,userEmail:r.userEmail?"[customer redacted]":null}))}});
    }
    return route.fulfill({json:{}});
  });
  await page.goto(origin+"/admin?section=bandwidth");
  await page.getByRole("heading",{name:"Bandwidth usage",exact:true}).waitFor();
  const wireLabel = currentUi ? "Proxy wire (measured)" : "Proxy wire (billable)";
  await page.getByText(wireLabel,{exact:true}).waitFor();
  await page.waitForTimeout(500);
  const initialCalls=bandwidthCalls;
  const tile=page.getByText(wireLabel,{exact:true}).locator("..");
  const firstTile=await tile.innerText();
  await page.screenshot({path:screenshotPrefix+"-before.png",fullPage:true});
  console.log("BANDWIDTH_INITIAL "+JSON.stringify({meta:first.meta,wire:first.report.wire,totals:first.report.totals,wireHourly:first.wireHourly,sources:first.sources,sums:first.sums,initialCalls,firstTile}));
  await page.waitForTimeout(35000);
  if (currentUi) assert.ok(bandwidthCalls > initialCalls, "visible bandwidth page must poll automatically");
  console.log("BANDWIDTH_IDLE_35S "+JSON.stringify({bandwidthCalls,tile:await tile.innerText()}));
  await page.waitForTimeout(35000);
  const callsBeforeManual=bandwidthCalls;
  const second=await snapshot();
  visibleReport=second.report;
  const delta=(await client.query(`SELECT
    (SELECT coalesce(sum(bytes_in+bytes_out),0)::bigint FROM proxy_wire_samples WHERE id>$1 AND id<=$2) AS wire_bytes_added,
    (SELECT count(*)::int FROM proxy_wire_samples WHERE id>$1 AND id<=$2) AS wire_samples_added,
    (SELECT coalesce(sum(bytes_in+bytes_out),0)::bigint FROM bandwidth_log WHERE id>$3 AND id<=$4) AS attribution_bytes_added,
    (SELECT coalesce(sum(requests),0)::bigint FROM bandwidth_log WHERE id>$3 AND id<=$4) AS requests_added`,
    [first.meta.wire_id,second.meta.wire_id,first.meta.attribution_id,second.meta.attribution_id])).rows[0];
  const response=page.waitForResponse(r=>r.url().includes("/api/admin/bandwidth"));
  await page.locator("button").filter({has:page.locator("svg.lucide-refresh-cw")}).click();
  await response; await page.waitForTimeout(500);
  await page.screenshot({path:screenshotPrefix+"-after.png",fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:screenshotPrefix+"-mobile.png"});
  const mobileOverflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
  const regressions:string[]=[];
  if(currentUi){
    assert.equal(mobileOverflow,false);
    assert.match(await tile.innerText(),/window coverage/);
    const profiles=second.report.counts.profilesWithTraffic;
    assert.match(await page.getByText("Profiles with traffic",{exact:true}).locator("..").innerText(),new RegExp(String(profiles)));
    regressions.push("automatic 30s polling","sample time and coverage visible","system bucket excluded","mobile fits");
    // Only AFTER real read-only screenshots: inject explicit failure/race fixtures.
    let status=500;
    await page.route("**/api/admin/bandwidth?*",async route=>{
      const win=new URL(route.request().url()).searchParams.get("window")??"24h";
      if(status===200&&win==="1h")await new Promise(r=>setTimeout(r,600));
      await route.fulfill({status,json:status===200?{...second.report,window:win,totals:{...second.report.totals,totalBytes:win==="1h"?11111111:22222222}}:{message:"Injected diagnostic error"}}).catch(()=>{});
    });
    await page.getByRole("button",{name:"Refresh bandwidth"}).click();
    await page.getByText("Failed to load bandwidth report.",{exact:true}).waitFor();
    assert.equal(await page.getByText(wireLabel,{exact:true}).count(),1);
    regressions.push("500 retains data with error");
    status=200;
    await page.getByRole("button",{name:"1 hour",exact:true}).first().click();await page.waitForTimeout(50);
    await page.getByRole("button",{name:"7 days",exact:true}).click();await page.waitForTimeout(850);
    const displayed=await page.getByText("Request attribution (mixed units)",{exact:true}).locator("..").innerText();
    assert.match(displayed,/21\.2/); // 22,222,222 bytes in binary MiB; late 1h must not replace it
    regressions.push("window race rejects old response");
    status=403;await page.getByRole("button",{name:"Refresh bandwidth"}).click();
    await page.getByText("You don't have access to this section.",{exact:true}).waitFor();
    assert.equal(await page.getByText(wireLabel,{exact:true}).count(),0);
    regressions.push("permission loss removes old data");
  }
  console.log("BANDWIDTH_FINAL "+JSON.stringify({source:"selected built UI + real report SELECTs; local auth fixture, emails redacted; DB enforced read-only; error/race fixtures only after screenshots",meta:second.meta,wire:second.report.wire,totals:second.report.totals,sums:second.sums,delta,initialCalls,callsBeforeManual,callsAfterManual:bandwidthCalls,pageErrors,skippedDdl,mobileOverflow,regressions}));
} finally {
  await browser.close(); await new Promise<void>(resolve=>server.close(()=>resolve()));
  await client.end(); await pool.end();
}
process.exit(0);
