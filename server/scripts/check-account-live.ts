import "dotenv/config";
import { pool } from "../db.js";
import { getPublicProfile, getUserPosts } from "../services/public-data-service.js";
async function main() {
  const u = process.argv[2];
  const p = await getPublicProfile(u);
  if (!p.ok) { console.log(`[live] profile FAIL: ${p.error}`); return; }
  console.log(`[live] @${u} followers=${p.data.followerCount} following=${p.data.followingCount} posts=${p.data.postCount ?? "?"} private=${p.data.isPrivate}`);
  const posts = await getUserPosts(u, p.data.igUserId!, 12);
  console.log(`[live] posts fetched=${posts.ok ? posts.data.length : "FAIL " + posts.error}`);
  if (posts.ok) for (const x of posts.data.slice(0,5)) console.log(`[live]   ${x.shortcode} taken=${x.takenAt} likes=${x.likeCount}`);
}
main().catch(e=>console.error("[live] ERR", e?.message??e)).finally(()=>pool.end().catch(()=>{}));
