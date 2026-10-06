/** Operator-only, one saved session, no retry loop and no automatic login.
 * Preview: npx tsx server/scripts/revalidate-mobile-session.ts --bot-id UUID --expected-user-id NUMERIC_ID
 * Apply: add --apply to make one authenticated GET and reactivate only on exact identity proof.
 * Known challenges/failures, disabled/banned bots and current cooldowns require separate recovery.
 * Load the application's environment before running. Receipts intentionally contain no identities.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  commitMobileRevalidation,
  mobileRevalidationFailureReason,
  parseMobileRevalidationArgs,
  readMobileRevalidationBot,
  revalidateMobileSession,
} from "../services/mobile-session-revalidation.js";

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let options;
  try { options = parseMobileRevalidationArgs(argv); }
  catch (error) {
    console.log(JSON.stringify({ outcome: "blocked", reason: mobileRevalidationFailureReason(error) }));
    return 2;
  }
  if (!options) {
    console.log("Usage: revalidate-mobile-session.ts --bot-id UUID --expected-user-id NUMERIC_ID [--dry-run | --apply]\nDefault: read-only preview. Apply: one authenticated own-account GET, shared lease/budget, then conditional reactivation. No retries, credential refresh, proxy changes or public-target checks.");
    return 0;
  }
  // Runtime modules can log full request errors. This isolated CLI emits only
  // allowlisted receipts; it never runs inside an application/worker process.
  process.env.LOG_LEVEL = "silent";
  let closePool: (() => Promise<void>) | undefined;
  let flushMeter: (() => Promise<void>) | undefined;
  let exitCode = 1;
  try {
    const { db, pool } = await import("../db.js");
    closePool = () => pool.end();
    const { decryptSessionData } = await import("../crypto/session-envelope.js");
    const { withOperationLease } = await import("../services/operation-lease.js");
    const { reserveOrThrow } = await import("../behavior/daily-budget.js");
    const { createMobileReadClient } = await import("../ig-mobile-read-client.js");
    const { stopBandwidthMeter } = await import("../services/bandwidth-meter.js");
    flushMeter = stopBandwidthMeter;
    const result = await revalidateMobileSession(options, {
      now: () => new Date(),
      readBot: id => readMobileRevalidationBot(db, id),
      decrypt: decryptSessionData,
      withLease: withOperationLease,
      reserveProfileBudget: id => reserveOrThrow(id, "profile"),
      createClient: (bot, session) => {
        const client = createMobileReadClient({ session, proxyEndpoint: bot.proxyUrl, botId: bot.id, botUsername: bot.igUsername });
        return { fetchRaw: (path, init) => client.fetchRaw!(path, init), close: () => client.close() };
      },
      commitRecovered: (bot, guard) => commitMobileRevalidation(db, bot, guard),
    });
    console.log(JSON.stringify(result));
    exitCode = ["eligible", "recovered"].includes(result.outcome) ? 0 : 1;
  } catch (error) {
    console.log(JSON.stringify({ outcome: "blocked", reason: mobileRevalidationFailureReason(error) }));
  } finally {
    try { await flushMeter?.(); }
    catch { console.log(JSON.stringify({ outcome: "cleanup_warning", reason: "bandwidth_flush_incomplete" })); exitCode = 1; }
    try { await closePool?.(); }
    catch { console.log(JSON.stringify({ outcome: "cleanup_warning", reason: "database_close_failed" })); exitCode = 1; }
  }
  return exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
