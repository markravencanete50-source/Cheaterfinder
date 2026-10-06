// Real client components in Chromium; synthetic media/API only, no provider calls.
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright";

const root = resolve(import.meta.dirname, "..");
const output = await mkdtemp(join(tmpdir(), "shared-media-browser-"));
const source = `
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import i18n from 'i18next';import {I18nextProvider} from 'react-i18next';
import MediaImage from '@/components/MediaImage';
import LikedPostsGallery from '@/components/dashboard/LikedPostsGallery';
import OwnPostsGrid from '@/components/dashboard/OwnPostsGrid';
import PostDetailModal from '@/components/dashboard/PostDetailModal';
import StoriesViewer from '@/components/dashboard/StoriesViewer';
import HighlightsCarousel from '@/components/dashboard/HighlightsCarousel';
import {LikedPostLightbox} from '@/pages/admin/LikedPostLightbox';
import AdminActivityFeed from '@/pages/admin/AdminActivityFeed';
import {Sheet,SheetContent,SheetTitle} from '@/components/ui/sheet';
i18n.init({lng:'en',fallbackLng:'en',resources:{en:{translation:{}}},initImmediate:false});
const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
const now=new Date().toISOString();
const post={shortcode:'fixture',postType:'photo',thumbnailUrl:'/images/ok.svg',takenAt:now,likeCount:1,commentCount:1};
function App(){
 const [mode,setMode]=useState('shared');window.setMode=setMode;
 const [image,setImage]=useState({src:'/images/slow.svg',fallbackSrc:'/images/ok.svg'});
 const [sheet,setSheet]=useState(false),[account,setAccount]=useState('a'),[kind,setKind]=useState('all');
 const [liked,setLiked]=useState(null);window.setLiked=setLiked;
 const [customerPost,setCustomerPost]=useState(null);window.openCustomer=shortcode=>setCustomerPost({...post,shortcode,likeCount:0,commentCount:0});
 window.setImage=setImage;window.setAccount=setAccount;window.setKind=setKind;
 if(mode==='activity')return <main className="min-w-0 px-5 py-7"><AdminActivityFeed/></main>;
 if(mode==='lightbox')return <><main style={{height:1800,width:'100%'}}>Synthetic background</main><LikedPostLightbox item={liked} onClose={()=>setLiked(null)}/></>;
 return <><button onClick={()=>setSheet(true)}>Open account</button>
 <LikedPostLightbox item={liked} onClose={()=>setLiked(null)}/>
 <PostDetailModal post={customerPost} onClose={()=>setCustomerPost(null)}/>
 <div data-testid="image" style={{width:80,height:80}}><MediaImage {...image} alt="Fixture media" className="h-full w-full" loading="eager"/></div>
 <div data-testid="gallery"><LikedPostsGallery events={[{id:'like',eventType:'like',detectedAt:now,displayUrl:' ',thumbnailUrl:'/images/ok.svg',ownerUsername:'fixture'}]}/></div>
 <div data-testid="pagination"><OwnPostsGrid posts={[post]} postType={kind} onPostTypeChange={setKind} dataSource="cached" accountId={account} postsEndpoint={'/api/admin/tracked-accounts/'+account+'/posts'} engagementBasePath={'/api/admin/tracked-accounts/'+account+'/posts'}/></div>
 <Sheet open={sheet} onOpenChange={setSheet}><SheetContent aria-describedby={undefined} data-testid="sheet" style={{width:360,overflow:'auto'}}><SheetTitle>Account fixture</SheetTitle>
 <div style={{transform:'translateX(0)',width:300}}>
 <OwnPostsGrid posts={[post]} postType="all" onPostTypeChange={()=>{}} dataSource="cached" accountId="nested" engagementBasePath="/api/admin/tracked-accounts/nested/posts"/>
 <StoriesViewer dataSource="cached" stories={[{storyId:'story',mediaType:'photo',mediaUrl:'/images/ok.svg',takenAt:now,expiresAt:'2099-01-01T00:00:00Z'}]}/>
 <HighlightsCarousel dataSource="cached" highlights={[{highlightId:'highlight',title:'Fixture highlight',coverUrl:'/images/ok.svg',mediaCount:1,items:[{storyId:'highlight-story',mediaType:'photo',mediaUrl:'/images/ok.svg',takenAt:now}]}]}/>
 </div></SheetContent></Sheet></>;
}
createRoot(document.getElementById('root')).render(<I18nextProvider i18n={i18n}><QueryClientProvider client={client}><App/></QueryClientProvider></I18nextProvider>);
`;
const bundle = await build({ absWorkingDir: root, stdin: { contents: source, loader: "tsx", resolveDir: root },
  bundle: true, write: false, format: "esm", platform: "browser", jsx: "automatic",
  define: { "process.env.NODE_ENV": '"development"', "import.meta.env": '{}' } });
const cssFolder = resolve(process.env.MEDIA_TEST_ASSETS ?? join(root, "dist/public/assets"));
const cssFile = (await readdir(cssFolder)).find(file => file.endsWith(".css"));
assert(cssFile, "A built stylesheet is required for real modal geometry checks");
const css = await readFile(join(cssFolder, cssFile));
const server = http.createServer((req, res) => {
  if (req.url === "/test.js") { res.setHeader("Content-Type", "text/javascript");res.end(bundle.outputFiles[0].contents); }
  else if (req.url === "/test.css") {res.setHeader("Content-Type", "text/css");res.end(css);}
  else { res.setHeader("Content-Type", "text/html"); res.end('<html><head><link rel="stylesheet" href="/test.css"></head><body><div id="root"></div><script type="module" src="/test.js"></script></body></html>'); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser, page;
const checks = [], requests = [], pageErrors = [];
try {
  browser = await chromium.launch({ args: ["--no-sandbox", "--disable-background-networking"] });
  const context = await browser.newContext({ viewport: { width: 1200, height: 1000 }, reducedMotion: "reduce" });
  await context.addCookies([{ name: "session-fixture", value: "present", url: origin, httpOnly: true }]);
  page = await context.newPage();
  page.on("pageerror", error => pageErrors.push(error.message));
  let releaseSlow, releasePage, bPages = 0;
  const slow = new Promise(resolve => { releaseSlow = resolve; });
  const delayedPage = new Promise(resolve => { releasePage = resolve; });
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) return route.abort();
    if (!["/images/", "/api/"].some(prefix => url.pathname.startsWith(prefix))) return route.continue();
    requests.push({ path: url.pathname, query: url.search, cookie: (await request.allHeaders()).cookie ?? "" });
    if (url.pathname === "/images/slow.svg") await slow;
    if (url.pathname === "/images/broken.svg" || url.pathname === "/api/media/denied") return route.fulfill({ status: 404, body: "Unavailable" }).catch(() => {});
    if (url.pathname === '/images/portrait.svg') return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920"><rect width="1080" height="1920" fill="#4477cc"/></svg>'});
    if (url.pathname.startsWith("/images/") || url.pathname === "/api/media/thumb") return route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120"><rect width="160" height="120" fill="#4477cc"/></svg>' }).catch(() => {});
    if (url.pathname === '/api/admin/activity') return route.fulfill({json:{items:[{id:'like:geometry',trackedAccountId:'fixture',eventType:'like',igUsername:'tracked_profile_with_30_letters',ownerUsername:'a'.repeat(30),userEmail:'long_customer_email_identifier@example.invalid',thumbnailUrl:'/images/portrait.svg',detectedAt:new Date().toISOString(),caption:'Synthetic saved caption. '.repeat(30),postType:'reel',postUrl:'https://example.invalid/fixture'}],total:1,asOf:new Date().toISOString()}});
    if (url.pathname.includes('/tracking/posts/unknown/')) return route.fulfill({json:url.pathname.endsWith('/likers')
      ? {items:[{username:'unknown_total_liker'}],total:1,isPartial:true}
      : {items:[],total:0,isPartial:true}});
    if (url.pathname.includes('/tracking/posts/complete/')) return route.fulfill({json:{items:[{username:'complete_liker'}],total:1,expectedTotal:1,isPartial:false}});
    if (url.pathname.endsWith("/likers")) return route.fulfill({ json: { items: [{username:"fixture_liker"}], total:1, expectedTotal:401, isPartial:true } });
    if (url.pathname.endsWith("/comments")) return route.fulfill({ json: { items: [{author:"fixture_author",text:"Fixture comment"}],total:1, expectedTotal:202, isPartial:true } });
    if (url.pathname === "/api/admin/tracked-accounts/a/posts") { await delayedPage; return route.fulfill({ json: {items:[{shortcode:'old-account-only',postType:'photo',thumbnailUrl:'/images/ok.svg',takenAt:new Date().toISOString()}],hasMore:false} }).catch(() => {}); }
    if (url.pathname === "/api/admin/tracked-accounts/b/posts") return route.fulfill({ json: ++bPages === 1 ? {items:[]} : {items:[],hasMore:false} });
    throw Error("Unexpected fixture API route: " + url.pathname);
  });
  await page.goto(origin);
  const media = page.getByTestId("image").locator("[data-media-state]");
  await media.locator("img").waitFor();
  assert.equal(await media.getAttribute("data-media-state"), "loading");
  releaseSlow(); await page.waitForFunction(() => document.querySelector('[data-testid="image"] [data-media-state]')?.dataset.mediaState === 'loaded');
  checks.push("loading stays distinct from loaded and unavailable");
  assert(requests.find(r => r.path === "/images/slow.svg").cookie.includes("session-fixture=present"));
  checks.push("same-origin image carries HttpOnly session cookie");
  await page.evaluate(() => window.setImage({src:'/images/broken.svg',fallbackSrc:'/images/ok.svg'}));
  await page.waitForFunction(() => document.querySelector('[data-testid="image"] img')?.getAttribute('src') === '/images/ok.svg');
  await page.evaluate(() => window.setImage({src:'/images/broken.svg'}));
  await page.getByRole("img", {name:"Image unavailable: Fixture media",exact:true}).waitFor();
  await page.evaluate(() => window.setImage({src:''}));
  await page.getByRole("img", {name:"Image not captured: Fixture media",exact:true}).waitFor();
  await page.evaluate(() => window.setImage({src:'/images/ok.svg'}));
  await page.waitForFunction(() => document.querySelector('[data-testid="image"] [data-media-state]')?.dataset.mediaState === 'loaded');
  checks.push("fallback tried once; missing/error differ; changed source recovers");
  const before = requests.length;
  await page.evaluate(() => window.setImage({src:'/api/media/denied',fallbackSrc:'https://cdninstagram.com/forbidden-fallback.jpg'}));
  await page.getByRole("img", {name:"Image unavailable: Fixture media",exact:true}).waitFor();
  assert(!requests.slice(before).some(r => r.path === '/api/img-proxy'));
  checks.push("protected denial never falls back to raw CDN/proxy");
  await page.getByTestId("gallery").locator('[data-media-state="loaded"]').waitFor();
  checks.push("empty display URL uses valid gallery thumbnail");
  await page.evaluate(() => window.setLiked({id:'liked-fixture',eventType:'like',igUsername:'fixture_target',ownerUsername:'fixture_owner',thumbnailUrl:'/images/broken.svg',detectedAt:new Date().toISOString()}));
  await page.getByText('Preview unavailable. The recorded like is still shown.',{exact:true}).waitFor();
  await page.getByText('@fixture_target liked a post by @fixture_owner',{exact:true}).waitFor();
  await page.evaluate(() => window.setLiked({id:'liked-fixture',eventType:'like',igUsername:'fixture_target',ownerUsername:'fixture_owner',thumbnailUrl:'/images/ok.svg',detectedAt:new Date().toISOString()}));
  await page.getByRole('dialog').locator('[data-media-state="loaded"]').waitFor();
  await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});
  checks.push("liked-post preview retains recorded activity on media failure and recovers on URL update");
  await page.getByTestId("pagination").getByRole("button",{name:"Load more",exact:true}).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="pagination"] button:disabled'));
  await page.evaluate(() => window.setAccount('b')); releasePage();
  await page.waitForTimeout(100);
  assert.equal(await page.getByRole("button",{name:"View post details for old-account-only"}).count(),0);
  await page.evaluate(() => window.setKind('photo'));
  await page.getByTestId("pagination").getByRole("button",{name:"Load more",exact:true}).click();
  await page.getByTestId("pagination").getByRole("button",{name:"Retry loading posts",exact:true}).click();
  await page.waitForFunction(() => !Array.from(document.querySelectorAll('[data-testid="pagination"] button')).some(b=>b.textContent==='Load more'));
  assert(requests.some(r => r.path.endsWith('/b/posts') && r.query.includes('postType=photo')));
  checks.push("pagination discards stale account responses, retries malformed pages and keeps admin type scope");
  await page.getByRole("button",{name:"Open account",exact:true}).click();
  const sheet = page.getByTestId("sheet");
  await sheet.getByRole("button",{name:"View post details for fixture"}).click();
  await page.getByText('@fixture_liker',{exact:true}).waitFor();
  const postDialog = page.getByRole("dialog",{name:"Photo",exact:true});
  await postDialog.getByRole('status').filter({hasText:'Showing 1 saved likes of 401 reported. This list is incomplete.'}).waitFor();
  await postDialog.getByRole("tab",{name:/Comments/}).click();
  await page.getByText('Fixture comment',{exact:true}).waitFor();
  await postDialog.getByRole('status').filter({hasText:'Showing 1 saved comments of 202 reported. This list is incomplete.'}).waitFor();
  checks.push('nonempty admin liker/comment subsets display reported totals and incomplete coverage');
  assert(requests.filter(r=>/\/(likers|comments)$/.test(r.path)).every(r=>r.path.startsWith('/api/admin/tracked-accounts/nested/posts/')&&!r.query.includes('refresh')));
  await page.keyboard.press('Tab');
  assert(await postDialog.evaluate(element=>element.contains(document.activeElement)));
  await page.keyboard.press('Escape'); await postDialog.waitFor({state:'hidden'});await sheet.waitFor();
  checks.push("nested post dialog traps focus; scoped cached APIs; Escape keeps parent sheet");
  await sheet.getByRole("button",{name:/Open story/}).click();
  const storyDialog = page.getByRole("dialog",{name:"Story viewer",exact:true});await storyDialog.waitFor();
  await page.waitForFunction(()=>{const e=document.querySelector('[role="dialog"][aria-label="Story viewer"]');return e&&getComputedStyle(e).opacity==='1'&&[...e.children].every(c=>getComputedStyle(c).opacity==='1');});
  const box=await storyDialog.boundingBox();assert(box && box.x===0 && box.y===0 && box.width===1200 && box.height===1000);
  await page.screenshot({path:join(output,'story-desktop.png')});
  await page.keyboard.press('Escape');await storyDialog.waitFor({state:'hidden'});await sheet.waitFor();
  await sheet.getByRole("button",{name:"View highlight details: Fixture highlight"}).click();
  const highlightDialog=page.getByRole('dialog',{name:'Highlight: Fixture highlight',exact:true});await highlightDialog.waitFor();
  await page.keyboard.press('Escape');await highlightDialog.waitFor({state:'hidden'});await sheet.waitFor();
  checks.push("story/highlight nested portals cover viewport and preserve parent on Escape");
  await page.setViewportSize({width:390,height:844});
  await sheet.getByRole("button",{name:/Open story/}).click();await storyDialog.waitFor();
  await page.waitForFunction(()=>{const e=document.querySelector('[role="dialog"][aria-label="Story viewer"]');return e&&getComputedStyle(e).opacity==='1'&&[...e.children].every(c=>getComputedStyle(c).opacity==='1');});
  const mobileBox=await storyDialog.boundingBox();assert(mobileBox&&mobileBox.width===390&&mobileBox.height===844);
  await page.screenshot({path:join(output,'story-mobile.png')});
  checks.push("mobile story portal stays within viewport");
  await page.keyboard.press('Escape');await storyDialog.waitFor({state:'hidden'});
  await page.keyboard.press('Escape');await sheet.waitFor({state:'hidden'});
  await page.evaluate(()=>window.openCustomer('unknown'));
  await postDialog.getByRole('status').filter({hasText:'Showing 1 saved likes. This list is incomplete.'}).waitFor();
  await postDialog.getByRole('tab',{name:/Comments/}).click();
  await postDialog.getByRole('status').filter({hasText:'Showing 0 saved comments. This list is incomplete.'}).waitFor();
  await postDialog.getByText('No comment details have been captured yet.',{exact:true}).waitFor();
  assert.equal(await postDialog.getByText(/of 0 reported/).count(),0);
  assert(requests.filter(r=>r.path.includes('/tracking/posts/unknown/')).every(r=>r.query==='?refresh=true'));
  await page.evaluate(()=>window.openCustomer('complete'));
  await postDialog.getByText('@complete_liker',{exact:true}).waitFor();
  assert.equal(await postDialog.getByRole('status').count(),0);
  checks.push('customer partial metadata preserves unknown totals; empty saved details do not claim no activity; complete data has no partial warning');
  await page.keyboard.press('Escape'); await postDialog.waitFor({state:'hidden'});
  await page.evaluate(()=>window.setMode('lightbox'));
  const longLike={id:'geometry-like',eventType:'like',igUsername:'x'.repeat(30),ownerUsername:'y'.repeat(30),detectedAt:new Date().toISOString(),caption:'Synthetic saved caption. '.repeat(35)+'https://example.invalid/'+ 'long'.repeat(50),postType:'reel',postUrl:'https://example.invalid/fixture',likesCount:23000,commentsCount:500,postTakenAt:new Date().toISOString()};
  async function settleAnimations(){await page.evaluate(async()=>{await Promise.allSettled(document.getAnimations().filter(a=>a.effect?.getComputedTiming().iterations!==Infinity).map(a=>a.finished));});}
  async function assertPreviewBounds(dialog,label){
    await settleAnimations();
    const dimensions=await dialog.evaluate(e=>{const b=e.getBoundingClientRect();return{x:b.x,y:b.y,width:b.width,height:b.height,viewportWidth:innerWidth,viewportHeight:innerHeight,documentWidth:document.documentElement.scrollWidth};});
    assert(dimensions.x>=0&&dimensions.y>=0&&dimensions.x+dimensions.width<=dimensions.viewportWidth+1&&dimensions.y+dimensions.height<=dimensions.viewportHeight+1,label+': '+JSON.stringify(dimensions));
    assert.equal(dimensions.documentWidth,dimensions.viewportWidth,label+' document must not overflow horizontally');
    const close=dialog.getByRole('button',{name:'Close',exact:true});
    assert(await close.evaluate(button=>{const b=button.getBoundingClientRect();const hit=document.elementFromPoint(b.x+b.width/2,b.y+b.height/2);return b.x>=0&&b.y>=0&&b.right<=innerWidth&&b.bottom<=innerHeight&&(hit===button||button.contains(hit));}),label+' Close must remain visible and clickable');
    assert(await page.getByTestId('liked-post-preview-scroll').evaluate(e=>e.scrollWidth<=e.clientWidth+1),label+' long text must wrap inside the scroll region');
  }
  for(const viewport of [{width:1440,height:1000},{width:390,height:844},{width:844,height:390},{width:667,height:320}]){
    await page.setViewportSize(viewport);
    for(const available of [true,false]){
      const label=viewport.width+'x'+viewport.height+' '+(available?'portrait image':'unavailable image');
      await page.evaluate(item=>window.setLiked(item),{...longLike,thumbnailUrl:available?'/images/portrait.svg':'/images/broken.svg'});
      const dialog=page.getByRole('dialog'); await dialog.waitFor();
      await dialog.locator(available?'[data-media-state="loaded"]':'[data-media-state="error"]').waitFor();
      if(available)assert(await dialog.locator('img').evaluate(img=>img.complete&&img.naturalWidth>0));
      else await dialog.getByText('Preview unavailable. The recorded like is still shown.',{exact:true}).waitFor();
      await assertPreviewBounds(dialog,label+' initial');
      await dialog.getByRole('link',{name:'Open on Instagram'}).scrollIntoViewIfNeeded();
      await assertPreviewBounds(dialog,label+' scrolled');
      await page.screenshot({path:join(output,'liked-preview-'+viewport.width+'-'+(available?'image':'unavailable')+'.png')});
      await dialog.getByRole('button',{name:'Close',exact:true}).click(); await dialog.waitFor({state:'hidden'});
      checks.push('liked preview viewport/Close bounds before and after scroll: '+label);
    }
  }
  await page.setViewportSize({width:390,height:844}); await page.evaluate(()=>window.setMode('activity'));
  await page.getByRole('button',{name:'liked a post by @'+'a'.repeat(30),exact:true}).waitFor();
  await settleAnimations();
  const feedGeometry=await page.evaluate(()=>({viewport:innerWidth,width:document.documentElement.scrollWidth}));
  assert.equal(feedGeometry.width,feedGeometry.viewport,'Activity feed with long handles/email must fit viewport: '+JSON.stringify(feedGeometry));
  await page.getByRole('button',{name:'liked a post by @'+'a'.repeat(30),exact:true}).click();
  const activityDialog=page.getByRole('dialog'); await activityDialog.locator('[data-media-state="loaded"]').waitFor();
  await assertPreviewBounds(activityDialog,'full Activity feed preview');
  await page.keyboard.press('Escape');await activityDialog.waitFor({state:'hidden'});
  checks.push('mobile Activity feed wraps long handles/email; cached preview decodes and Escape closes it');
  assert.deepEqual(pageErrors,[]);
  const result={passed:checks.length,checks,pageErrors,providerRequests:0,evidence:output};
  await writeFile(join(output,'report.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
} catch (error) {
  if (page) {
    await page.screenshot({path:join(output,'failure.png')}).catch(()=>{});
    console.error(JSON.stringify({checks,pageErrors,dialogs:await page.getByRole('dialog').evaluateAll(elements=>elements.map(e=>({label:e.getAttribute('aria-label'),labelledBy:e.getAttribute('aria-labelledby'),title:document.getElementById(e.getAttribute('aria-labelledby'))?.textContent}))),evidence:output}));
  }
  throw error;
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
