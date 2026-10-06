// Same saved viewer: browser REST control, HTTP REST metadata, existing GraphQL
// alternative and (only if available) its first continuation. No roster writes,
// login, follows, or session replacement. Every request reserves normal budget.
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { db, pool } from "../db.js";
import { buildLeaseCandidateQuery } from "../ig-public-scraper.js";
import { decryptSessionData } from "../crypto/session-envelope.js";
import { reserveOrThrow } from "../behavior/daily-budget.js";
import { requireAutomationIdentity } from "../services/automation-identity.js";
import { createAutomationClient } from "../services/automation-client.js";
import { assertDurableAccountProxyUrl } from "../services/proxy-durability.js";
import { withOperationLease } from "../services/operation-lease.js";
import { withScrapeContext, recordBytes, flushBandwidth } from "../services/bandwidth-meter.js";
import { recordOutcome } from "../services/scrape-metrics.js";
const username = "tracked_user_4", botId = "2f153cd3-7968-4860-8959-4872f1b96d8e";
if (!process.argv.includes("--probe-jannat") || process.env.BOT_AUTO_LOGIN_ENABLED !== "false") throw new Error("Explicit no-login bounded probe required");
try {
  const target = (await pool.query("SELECT id,user_id,ig_user_id FROM tracked_accounts WHERE is_active AND ig_username=$1 ORDER BY tracking_started,id LIMIT 1", [username])).rows[0];
  const q = buildLeaseCandidateQuery(db, { label: "followers", viewer: { pin: true, botId } }).toSQL();
  const bot = (await pool.query(q.sql.replace(/\s+for update skip locked\s*$/i, ""), q.params)).rows[0];
  if (!target?.ig_user_id || !bot) throw new Error("Target or previously tested eligible reader unavailable");
  assertDurableAccountProxyUrl(bot.proxy_url);
  const proxy = new URL(bot.proxy_url);
  const state = JSON.parse(decryptSessionData(bot.session_data));
  const identity = requireAutomationIdentity(bot.automation_identity, botId);
  const csrf = state.cookies?.find((c: {name:string}) => c.name === "csrftoken")?.value;
  if (!csrf || !state.cookies?.some((c: {name:string}) => c.name === "sessionid")) throw new Error("Incomplete saved session");
  const automation = createAutomationClient({ timeoutMs: 65_000 });
  const summaries: unknown[] = [];
  const started = new Date().toISOString();
  let calls = 0;
  await withOperationLease(`bot:${botId}`, async signal => withScrapeContext({ userId: target.user_id, trackedAccountId: target.id, username }, async () => {
    const request = async (transport: "browser" | "http", path: string, kind: "rest" | "graphql") => {
      signal.throwIfAborted();
      if (++calls > 4) throw new Error("Four-request probe cap reached");
      await reserveOrThrow(botId, "followers");
      const input = { operation_id: `roster-visibility:${randomUUID()}`, deadline_ms: 60_000,
        identity, storage_state: state, proxy: { server: `${proxy.protocol}//${proxy.host}`,
          username: decodeURIComponent(proxy.username), password: decodeURIComponent(proxy.password) },
        request: { method: "GET" as const, path, headers: { "x-csrftoken": csrf, "x-ig-www-claim": "0" },
          referer: `https://www.instagram.com/${username}/`, timeout_ms: 30_000 } };
      const response = await (transport === "browser" ? automation.requestInstagramBrowser(input) : automation.requestInstagramHttp(input));
      let body: any = {};
      try { body = JSON.parse(response.body); } catch {}
      const connection = body?.data?.user?.edge_followed_by;
      const users = kind === "rest" ? body?.users : connection?.edges?.map((e: any) => e.node);
      const valid = response.status === 200 && body?.status !== "fail" && Array.isArray(users);
      recordBytes({ endpoint: "followers", botId, transport,
        byteSource: transport === "browser" && response.wire_bytes_in != null ? "browser_wire" : "decoded_payload",
        bytesIn: transport === "browser" && response.wire_bytes_in != null ? response.wire_bytes_in : Buffer.byteLength(response.body),
        bytesOut: transport === "browser" && response.wire_bytes_out != null ? response.wire_bytes_out : path.length,
        resourceBytes: response.wire_breakdown ?? undefined, failed: !valid });
      recordOutcome("followers", valid ? "success" : "failure", botId);
      const meta = Object.fromEntries(Object.entries(body ?? {}).filter(([key, value]) =>
        !["users","data"].includes(key) && /count|list|more|limit|cursor|next|status|empty|message/.test(key))
        .map(([key,value]) => [key, /cursor|next/.test(key) ? { present: value != null && value !== "", type: typeof value } : value]));
      summaries.push({ transport, kind, status: response.status, valid, count: users?.length ?? 0,
        distinct: new Set((users ?? []).map((u: any) => u.username)).size,
        fields: users?.[0] ? Object.keys(users[0]).sort() : [], meta,
        graphReported: connection?.count, graphHasNext: connection?.page_info?.has_next_page,
        payloadBytes: Buffer.byteLength(response.body), wireIn: response.wire_bytes_in,
        transportError: response.transport_error ?? null });
      console.log(JSON.stringify({ checkpoint: true, summary: summaries.at(-1) }));
      if (!valid) throw new Error("Control failed; stopping without further requests or promotion");
      return { cursor: connection?.page_info?.end_cursor as string | undefined,
        ids: new Set<string>((users ?? []).map((u: any) => String(u.id ?? u.pk))),
        fields: users?.[0] ? Object.keys(users[0]) : [] };
    };
    const rest = `https://www.instagram.com/api/v1/friendships/${target.ig_user_id}/followers/?count=50`;
    if (!process.argv.includes("--graphql-parity")) {
      await request("browser", rest, "rest");
      await new Promise(r => setTimeout(r, 12_000));
      await request("http", rest, "rest");
      await new Promise(r => setTimeout(r, 12_000));
    }
    const graph = (after?: string) => `https://www.instagram.com/graphql/query/?${new URLSearchParams({
      query_hash: "37479f2b8209594dde7facb0d904896a", variables: JSON.stringify({ id: target.ig_user_id, include_reel: true, fetch_mutual: false, first: 50, ...(after ? { after } : {}) }),
    })}`;
    const browserPage = await request("browser", graph(), "graphql");
    if (process.argv.includes("--graphql-parity")) {
      await new Promise(r => setTimeout(r, 12_000));
      const httpPage = await request("http", graph(), "graphql");
      console.log(JSON.stringify({ parity: true, browserCount: browserPage.ids.size, httpCount: httpPage.ids.size,
        overlapping: [...browserPage.ids].filter(id => httpPage.ids.has(id)).length,
        browserFieldsMissingInHttp: browserPage.fields.filter((field: string) => !httpPage.fields.includes(field)),
        cursorEqual: browserPage.cursor === httpPage.cursor }));
      if (httpPage.cursor) {
        await new Promise(r => setTimeout(r, 12_000));
        const next = await request("http", graph(httpPage.cursor), "graphql");
        console.log(JSON.stringify({ continuation: true, first: httpPage.ids.size, second: next.ids.size,
          overlap: [...httpPage.ids].filter(id => next.ids.has(id)).length }));
      }
    } else if (browserPage.cursor) {
      await new Promise(r => setTimeout(r, 12_000));
      await request("browser", graph(browserPage.cursor), "graphql");
    }
  }));
  console.log(JSON.stringify({ started, ended: new Date().toISOString(), username, persisted: false, summaries }));
} catch (error) {
  console.error("Visibility probe stopped:", error instanceof Error ? error.message : "unknown error");
  process.exitCode = 1;
} finally { await flushBandwidth(); await pool.end(); }
process.exit(process.exitCode ?? 0);
