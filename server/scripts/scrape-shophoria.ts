import { sql } from "drizzle-orm";
import { db } from "/root/instaapp/ROB-APP/ROB-APP/server/db.js";
import { collectPublicData } from "/root/instaapp/ROB-APP/ROB-APP/server/services/public-data-collector.js";

async function main() {
  const r = await db.execute(sql`SELECT id, ig_username FROM tracked_accounts WHERE ig_username='shophoria.pk' LIMIT 1`);
  const t = (r as any).rows[0];
  console.log("Scraping", t.ig_username, t.id);
  try {
    const out = await collectPublicData({ id: t.id, igUsername: t.ig_username, isPrivate: false, accessStatus: "public" });
    console.log("OK:", JSON.stringify({ posts: out.posts, snaps: out.profile, isPrivate: out.isPrivate }).slice(0, 400));
  } catch (e: any) {
    console.error("FAIL:", e.message?.slice(0, 200));
  }
  process.exit(0);
}
main();
