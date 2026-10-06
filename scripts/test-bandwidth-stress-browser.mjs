// Compiled current client + replay of the REAL isolated stress API result.
// No production server/database/auth or external network, no live dist writes.
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, setPriority } from "node:os";
import express from "express";
import { build } from "vite";
import { chromium } from "playwright";
const source=process.argv[2];
assert(source&&/^\/tmp\/cheaterfinder-stress-[A-Za-z0-9]+\/bandwidth-api\.json$/.test(source),"Supply an actual isolated stress bandwidth-api.json");
const original=JSON.parse(await readFile(source,"utf8"));
assert.equal(original.counts.customersWithTraffic,450);
assert(original.byProfile.every(row=>row.igUsername?.startsWith("stress_meter_")||row.trackedAccountId===null),"Synthetic stress report only");
setPriority(0,10);
const output=await mkdtemp(join(tmpdir(),"cheaterfinder-stress-browser-"));
const publicDir=join(output,"public");
// Overrides Vite's live-dist target before the build. No prerender/backend.
await build({build:{outDir:publicDir,emptyOutDir:false},logLevel:"warn"});
const app=express();let status=200,calls=0;
const scaled=(factor,window)=>({
  ...original,window,
  totals:Object.fromEntries(Object.entries(original.totals).map(([k,v])=>[k,v*factor])),
  byProfile:original.byProfile.map(r=>({...r,bytesIn:r.bytesIn*factor,bytesOut:r.bytesOut*factor,totalBytes:r.totalBytes*factor,requests:r.requests*factor})),
  byUser:original.byUser.map(r=>({...r,bytesIn:r.bytesIn*factor,bytesOut:r.bytesOut*factor,totalBytes:r.totalBytes*factor,requests:r.requests*factor})),
  byEndpoint:original.byEndpoint.map(r=>({...r,bytesIn:r.bytesIn*factor,bytesOut:r.bytesOut*factor,totalBytes:r.totalBytes*factor,requests:r.requests*factor})),
  breakdownCoverage:Object.fromEntries(Object.entries(original.breakdownCoverage).map(([k,v])=>[k,{...v,omittedBytes:v.omittedBytes*factor,omittedRequests:v.omittedRequests*factor}])),
});
app.get("/api/auth/me",(_req,res)=>res.json({id:"synthetic-stress-admin",email:"stress@example.invalid",role:"admin"}));
app.get("/api/admin/refresh-interval",(_req,res)=>res.json({current:{intervalSec:10800,min:60,max:86400,source:"fixture",updatedAt:null}}));
app.get("/api/admin/bandwidth",(req,res)=>{
  calls++;const responseStatus=status,window=String(req.query.window??"24h");
  setTimeout(()=>{if(!res.destroyed)res.status(responseStatus).json(responseStatus===200?scaled(window==="7d"?2:1,window):{message:"Stress fixture response"});},window==="1h"?600:25);
});
app.use("/api",(_req,res)=>res.json({}));
app.use(express.static(publicDir));
const shell=await readFile(join(publicDir,"index.html"),"utf8");
app.use((_req,res)=>res.type("html").send(shell));
const server=await new Promise(resolve=>{const s=app.listen(0,"127.0.0.1",()=>resolve(s));});
const origin="http://127.0.0.1:"+server.address().port;
const browser=await chromium.launch({args:["--no-sandbox","--disable-background-networking","--disable-component-update"]});
const passed=[],errors=[];
let failure,page;
try {
  page=await browser.newPage({viewport:{width:1440,height:1100}});
  page.on("pageerror",error=>errors.push(error.message));
  await page.route("**/*",route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  await page.goto(origin+"/admin?section=bandwidth");
  const profile=page.getByTestId("profile-bandwidth-coverage"),customer=page.getByTestId("customer-bandwidth-coverage");
  await profile.waitFor();await customer.waitFor();
  assert.match(await profile.innerText(),/top 200 of 451/);
  assert.match(await customer.innerText(),/top 200 of 451/);
  assert.match(await profile.innerText(),/included in the totals above/);
  assert.match(await page.getByText("Profiles with traffic",{exact:true}).locator("..").innerText(),/450/);
  assert.match(await page.getByText("Profiles with traffic",{exact:true}).locator("..").innerText(),/450 customers/);
  assert.equal(await page.locator("tbody").first().locator("tr").count(),200);
  assert.equal(await page.locator("tbody").nth(1).locator("tr").count(),200);
  passed.push("Real 450-customer report renders bounded 200-row tables and discloses all 451 attribution groups including system traffic");
  const customerRows=page.locator("tbody").nth(1).locator("tr");
  assert.equal(await customerRows.filter({hasText:"Customer record unavailable"}).count(),1);
  assert.equal(await customerRows.filter({hasText:"— system —"}).count(),1);
  assert.equal(await customerRows.filter({hasText:"@example.invalid"}).count(),198);
  passed.push("198 visible real customer records, one deleted fixture owner and one system group remain distinct");
  const firstShare=Math.round(original.byProfile[0].totalBytes/original.totals.totalBytes*100);
  assert(firstShare<100);
  await page.getByTitle(`${firstShare}% of recorded traffic`,{exact:true}).first().waitFor();
  passed.push("Share denominator is the full window, not the largest row");
  await page.screenshot({path:join(output,"profile-coverage.png")});
  await customer.scrollIntoViewIfNeeded();await page.screenshot({path:join(output,"customer-coverage.png")});
  // Twenty rapid changes: delayed old-window responses cannot overwrite the
  // final selected window. Scale the entire real snapshot consistently.
  await page.evaluate(()=>scrollTo(0,0));
  for(let i=0;i<10;i++){
    await page.getByRole("button",{name:"1 hour",exact:true}).first().click();
    await page.getByRole("button",{name:"7 days",exact:true}).click();
  }
  const formatBytes=n=>`${(n/(1024*1024)).toFixed(1)} MB`;
  const total=page.getByText("Request attribution (mixed units)",{exact:true}).locator("..");
  await page.waitForFunction(expected=>document.body.innerText.includes(expected),formatBytes(original.totals.totalBytes*2));
  await page.waitForTimeout(800); // Allows the deliberately delayed older response to arrive.
  assert.match(await total.innerText(),new RegExp((original.totals.totalBytes*2/(1024*1024)).toFixed(1).replace(".","\\.")));
  passed.push("20 rapid window switches reject delayed old responses");
  status=500;await page.getByRole("button",{name:"Refresh bandwidth"}).click();
  await page.getByText("Failed to load bandwidth report.",{exact:true}).waitFor();
  assert.equal(await profile.count(),1);
  passed.push("500 preserves last valid 450-customer snapshot with an explicit refresh error");
  status=200;await page.getByRole("button",{name:"Refresh bandwidth"}).click();
  await page.getByText("Failed to load bandwidth report.",{exact:true}).waitFor({state:"hidden"});
  await page.setViewportSize({width:390,height:844});await page.evaluate(()=>scrollTo(0,0));
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:join(output,"mobile-coverage.png")});
  await profile.scrollIntoViewIfNeeded();await page.screenshot({path:join(output,"mobile-profile-coverage.png")});
  await customer.scrollIntoViewIfNeeded();await page.screenshot({path:join(output,"mobile-customer-coverage.png")});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  passed.push("Large tables/disclosure fit a 390px mobile viewport");
  status=403;await page.getByRole("button",{name:"Refresh bandwidth"}).click();
  await page.getByText("You don't have access to this section.",{exact:true}).waitFor();
  assert.equal(await profile.count(),0);assert.equal(await customer.count(),0);
  passed.push("403 removes previously visible report data");
  assert.deepEqual(errors,[]);
} catch(error){
  failure=error;console.error(error);
  if(page){
    await page.screenshot({path:join(output,"failure.png")}).catch(()=>{});
    console.error("LAYOUT_DIAGNOSTIC",JSON.stringify(await page.evaluate(()=>({viewport:innerWidth,documentWidth:document.documentElement.scrollWidth,overflow:[...document.querySelectorAll("*")].map(el=>({tag:el.tagName,className:String(el.className),width:el.getBoundingClientRect().width,scroll:el.scrollWidth})).filter(el=>el.width>innerWidth).slice(0,20)})).catch(()=>({}))));
  }
}
finally {
  await browser.close();await new Promise(resolve=>server.close(resolve));
  const report={source,output,passed,errors,requests:calls,scope:"Current compiled UI + replay of real synthetic stress report; no production/API-auth/provider end-to-end claim",...(failure?{failure:failure.stack}:{})};
  await writeFile(join(output,"report.json"),JSON.stringify(report,null,2)+"\n");
  console.log(JSON.stringify(report));
}
process.exitCode=failure?1:0;
