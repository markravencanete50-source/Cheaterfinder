// Targeted hunt: scan a tracked account's followed owners RIGHT NOW and report
// whether the tracked user appears in their recent posts' liker lists.
// Answers "is detection broken, or did we just not look in the right place?"
import "dotenv/config";
import { sql } from "drizzle-orm";
import { db, pool } from "../db.js";
import { getPublicProfile, getUserPosts, getPostLikers } from "../services/public-data-service.js";

async function main(): Promise<void> {
  const username = process.argv[2] ?? "sample_account";
  const maxOwners = Number(process.argv[3] ?? "40");
  const { rows: t } = (await db.execute(sql`
    SELECT id, ig_username FROM tracked_accounts WHERE ig_username=${username} AND is_active LIMIT 1`)) as any;
  const acct = t[0];
  const target = acct.ig_username.toLowerCase();

  // Prefer owners known to have posted recently — that's where new likes live.
  const { rows: owners } = (await db.execute(sql`
    SELECT username FROM roster_members
     WHERE tracked_account_id=${acct.id} AND dimension='following' AND is_current
     ORDER BY (last_post_at IS NULL), last_post_at DESC NULLS LAST
     LIMIT ${maxOwners}`)) as any;
  console.log(`[hunt] @${target}: checking ${owners.length} owners`);

  let checked = 0, reads = 0, hits = 0;
  for (const o of owners) {
    try {
      const p = await getPublicProfile(o.username);
      if (!p.ok || p.data.isPrivate || !p.data.igUserId) continue;
      const posts = await getUserPosts(o.username, p.data.igUserId, 6);
      if (!posts.ok) continue;
      const recent = posts.data
        .filter((x: any) => x.takenAt && new Date(x.takenAt).getTime() > Date.now() - 5*86400000)
        .slice(0, 3);
      for (const post of recent) {
        if (!post.shortcode || !post.mediaId) continue;
        checked++;
        const lk = await getPostLikers(post.shortcode, post.mediaId);
        if (!lk.ok) continue;
        reads++;
        const found = lk.data.some((u: any) => u.username?.toLowerCase() === target);
        if (found) { hits++; console.log(`[hunt] HIT: @${target} liked ${post.shortcode} by @${o.username} (${lk.data.length} likers seen)`); }
      }
      await new Promise(r => setTimeout(r, 1200));
    } catch { /* keep going */ }
  }
  console.log(`[hunt] DONE owners=${owners.length} posts_checked=${checked} liker_reads=${reads} HITS=${hits}`);
}
main().catch(e=>console.error("[hunt] ERR", e?.message??e)).finally(()=>pool.end().catch(()=>{}));
