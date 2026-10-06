// Real Chromium + built application, with deterministic API fixtures only.
// Never logs in, changes production data, or calls Instagram.
import assert from "node:assert/strict";
import express from "express";
import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
const root = process.env.ACTIVITY_TEST_BUILD ?? "/tmp/cheaterfinder-admin-reliability-build-20260907";
const app = express();
app.use(express.static(root));
const shell = await readFile(`${root}/index.html`, "utf8");
app.use((_req,res)=>res.type("html").send(shell));
const server = await new Promise(resolve=>{const s=app.listen(0,"127.0.0.1",()=>resolve(s));});
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({args:["--no-sandbox"]});
  const page = await browser.newPage({viewport:{width:1280,height:900}});
  const pageErrors=[];
  page.on("pageerror",e=>pageErrors.push(e.message));
  let status=200, requests=[];
  const rows=Array.from({length:31},(_,i)=>({id:`${i}`,eventType:i===1?"follower_unfollow":"follower",
    detectedAt:new Date(Date.now()-i*1000).toISOString(),igUsername:`target${i}`,userId:"admin-test",
    userEmail:"admin@example.invalid",followerUsername:`new${i}`,unfollowerUsername:`lost${i}`}));
  await page.route("**/*",async route=>{
    const url=new URL(route.request().url());
    if(url.origin!==origin) return route.abort();
    if(!url.pathname.startsWith("/api/"))return route.continue();
    if(url.pathname==="/api/auth/me")return route.fulfill({json:{id:"admin-test",email:"admin@example.invalid",role:"admin"}});
    if(url.pathname==="/api/admin/stats")return route.fulfill({json:{}});
    if(url.pathname!=="/api/admin/activity")return route.fulfill({json:{}});
    const p=Object.fromEntries(url.searchParams);requests.push(p);
    if(p.search==="slow")await new Promise(r=>setTimeout(r,400));
    if(status!==200)return route.fulfill({status,json:{message:"Fixture failure"}}).catch(()=>{});
    const selected=rows.filter(r=>(!p.type||p.type===r.eventType)&&(!p.search||r.igUsername.includes(p.search)));
    const offset=(Number(p.page??1)-1)*30;
    return route.fulfill({json:{items:selected.slice(offset,offset+30),total:selected.length,asOf:new Date().toISOString(),
      collectionHealth:{staleFollowerRosters:6,activeProfiles:7,postSuccessesLastHour:6,postFailuresLastHour:19}}}).catch(()=>{});
  });
  await page.goto(`${origin}/admin?section=activity`);
  await page.getByText("Showing 1–30 of 31").waitFor();
  await page.getByText("gained follower",{exact:false}).first().waitFor();
  await page.getByText("lost follower",{exact:false}).first().waitFor();
  assert.match(await page.getByTestId("collection-health").textContent(),/6\/7 profiles/);
  await page.getByRole("button",{name:/Next/}).click();
  await page.getByText("Showing 31–31 of 31").waitFor();
  await page.getByRole("combobox").click();
  await page.getByRole("option",{name:"New followers",exact:true}).click();
  await page.getByText("Showing 1–30 of 30").waitFor();
  const input=page.getByPlaceholder("Search by IG username...");
  await input.fill("target7");
  const before=requests.length;
  await page.waitForFunction(()=>false,{},{timeout:16_000}).catch(()=>{});
  assert(requests.length>before,"Activity did not auto-refresh");
  assert.equal(requests.at(-1).search,undefined,"Unsubmitted search leaked into polling");
  await input.press("Enter");
  await page.getByText("Showing 1–1 of 1").waitFor();
  await input.fill("slow");await input.press("Enter");
  await input.fill("target7");await input.press("Enter");
  await page.waitForTimeout(600);
  assert.equal(await page.getByText("Showing 1–1 of 1").count(),1,"Old request overwrote current search");
  status=500;
  await page.getByRole("button",{name:"Refresh",exact:true}).click();
  await page.getByRole("alert").filter({hasText:"Displayed data may be out of date"}).waitFor();
  assert.equal(await page.getByText("@target7",{exact:true}).count(),1,"Transient error discarded the last result");
  status=403;
  await page.getByRole("button",{name:"Refresh",exact:true}).click();
  await page.getByText("You don't have access to this section.",{exact:true}).waitFor();
  assert.equal(await page.getByText("@target7",{exact:true}).count(),0,"Permission loss left activity visible");
  assert.deepEqual(pageErrors,[]);
  console.log(JSON.stringify({passed:["both follower directions","collection-health warning","pagination","filter resets page","15s auto-refresh","draft search isolation","request race","refresh error visible","permission loss clears view"],pageErrors}));
} finally {
  await browser?.close();
  await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
}
