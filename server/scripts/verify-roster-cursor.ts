import "dotenv/config";
import { pool } from "../db.js";
import { loadRosterCursor, saveRosterCursor } from "../services/roster-store.js";
async function main() {
  const id = "6cb465e0-58c4-4491-ba31-1f2ce75dc31a";
  const before = await loadRosterCursor(id, "follower");
  await saveRosterCursor(id, "follower", "TEST_CURSOR_abc123");
  const saved = await loadRosterCursor(id, "follower");
  await saveRosterCursor(id, "follower", null);           // exhausted-walk case
  const cleared = await loadRosterCursor(id, "follower");
  console.log(`[cursor] before=${before ?? "null"} afterSave=${saved ?? "null"} afterClear=${cleared ?? "null"}`);
  console.log(saved === "TEST_CURSOR_abc123" && cleared === null
    ? "[cursor] PASS — resume point persists and clears correctly"
    : "[cursor] FAIL");
}
main().catch(e => console.error("[cursor] ERR", e?.message ?? e)).finally(() => pool.end().catch(()=>{}));
