// Measure the liked-post detection ceiling: for a tracked account, sample the
// recent posts of accounts it FOLLOWS and report, per post, the post's like
// count vs how many likers IG actually returns. Detection is impossible
// whenever likersReturned << likeCount, no matter how many reads we spend.
import "dotenv/config";
import { sql } from "drizzle-orm";
import { db, pool } from "../db.js";
import { getPublicProfile, getUserPosts, getPostLikers } from "../services/public-data-service.js";

async function main() {
  const user = process.argv[2] ?? "sample_account";
  const owners = Number(process.argv[3] ?? 8);
  const { rows } = (await db.execute(sql`
    SELECT rm.username FROM roster_members rm
      JOIN tracked_accounts ta ON ta.id = rm.tracked_account_id
     WHERE ta.ig_username = ${user} AND rm.dimension='following' AND rm.is_current
       AND rm.last_post_at > NOW() - INTERVAL '7 days'
     ORDER BY rm.last_post_at DESC LIMIT ${owners}
  `)) as unknown as { rows: Array<{ username: string }> };
  console.log(`[diag] ${user}: sampling ${rows.length} recently-active owners`);

  let checked = 0, visible = 0, capped = 0;
  for (const r of rows) {
    const prof = await getPublicProfile(r.username);
    if (!prof.ok || !prof.data.igUserId || prof.data.isPrivate) continue;
    const posts = await getUserPosts(r.username, prof.data.igUserId, 3);
    if (!posts.ok) continue;
    for (const p of posts.data.slice(0, 2)) {
      if (!p.shortcode || !p.mediaId) continue;
      const likers = await getPostLikers(p.shortcode, p.mediaId);
      checked++;
      const lc = typeof p.likeCount === "number" ? p.likeCount : -1;
      const got = likers.ok ? likers.data.length : -1;
      const pct = lc > 0 && got > 0 ? Math.round((got / lc) * 100) : 0;
      if (lc > 0 && got > 0 && got < lc) capped++;
      if (pct >= 90) visible++;
      const age = p.takenAt ? Math.round((Date.now() - new Date(p.takenAt).getTime()) / 3600000) : -1;
      console.log(`  @${r.username} likes=${lc} likersReturned=${got} visible=${pct}% ageH=${age}`);
      await new Promise((s) => setTimeout(s, 700));
    }
  }
  console.log(`[diag] posts=${checked} fullyVisible=${visible} truncatedByIG=${capped}`);
}
main().catch((e) => console.error("[diag]", e?.message ?? e)).finally(() => pool.end().catch(() => {}));
