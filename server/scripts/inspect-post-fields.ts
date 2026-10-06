import "dotenv/config";
import { pool } from "../db.js";
import { getUserPosts, getPublicProfile } from "../services/public-data-service.js";
async function main() {
  const owner = process.argv[2] ?? "natgeo";
  const prof = await getPublicProfile(owner);
  if (!prof.ok) { console.log("[fields] profile FAIL", prof.error); return; }
  const posts = await getUserPosts(owner, prof.data.igUserId!, 6);
  if (!posts.ok) { console.log("[fields] posts FAIL", posts.error); return; }
  console.log(`[fields] got ${posts.data.length} posts from @${owner}`);
  for (const p of posts.data.slice(0, 5)) {
    console.log(`[fields] shortcode=${p.shortcode} takenAt=${p.takenAt ?? "MISSING"} likeCount=${p.likeCount ?? "MISSING"} mediaId=${p.mediaId ? "yes" : "MISSING"}`);
  }
}
main().catch(e => console.error("[fields] ERR", e?.message ?? e)).finally(() => pool.end().catch(()=>{}));
