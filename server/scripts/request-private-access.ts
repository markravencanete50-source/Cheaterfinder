// Trigger a bot follow-request for a private tracked account so its roster
// (followers/following) can be collected via the accepted bot's session.
// Mirrors the routes.ts "request access" flow. Use for accounts stuck in a
// stale `has_access` state (their follower bot was deleted) or any private
// account that needs (re)assignment.
//
//   npx tsx server/scripts/request-private-access.ts <trackedAccountId> [<id> ...]

import "dotenv/config";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { eq, inArray } from "drizzle-orm";
import { db, pool } from "../db.js";
import { trackedAccounts, botFollowRequests } from "../../shared/schema.js";
import {
  assignBotToTrackedAccount,
  rotateBotForTrackedAccount,
} from "../bot-manager.js";
import { trackedAccountHasAccess } from "../services/subscription-access.js";
import { ensureBotReady } from "../services/bot-runtime.js";

async function main(): Promise<void> {
  const ids = process.argv.slice(2).filter(Boolean);
  if (ids.length === 0) {
    console.error("usage: request-private-access <trackedAccountId> [<id> ...]");
    process.exit(1);
  }

  const connection = new IORedis(process.env.REDIS_URL || "redis://127.0.0.1:6379", {
    maxRetriesPerRequest: null,
  });
  const queue = new Queue("bot-follow-request", { connection });

  for (const id of ids) {
    if (!(await trackedAccountHasAccess(id))) {
      console.log(`[private-access] ${id} -> SKIPPED: tracking or subscription inactive`);
      continue;
    }
    await db.update(trackedAccounts)
      .set({ accessStatus: "pending_access", updatedAt: new Date() })
      .where(eq(trackedAccounts.id, id));
    const requestId =
      (await rotateBotForTrackedAccount(id)) ?? (await assignBotToTrackedAccount(id));
    if (!requestId) {
      console.log(`[private-access] ${id} -> NO BOT AVAILABLE (or already has an active request)`);
      continue;
    }
    // Ensure the assigned bot has a fresh proxy_endpoint before it sends follow
    // traffic — the send-follow worker refuses to egress without one.
    const [req] = await db
      .select({ botId: botFollowRequests.botAccountId })
      .from(botFollowRequests)
      .where(eq(botFollowRequests.id, requestId));
    if (req?.botId && await trackedAccountHasAccess(id)) {
      try {
        await ensureBotReady(req.botId);
      } catch (err) {
        console.log(`[private-access] ensureBotReady(${req.botId}) failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // Human-like delay before the follow, same as the app.
    const delay = 30_000 + (id.charCodeAt(0) % 60) * 1000;
    await queue.add("send-follow", { botFollowRequestId: requestId }, { delay });
    console.log(`[private-access] ${id} -> follow-request ${requestId} queued (send in ~${Math.round(delay / 1000)}s)`);
  }

  await queue.close();
  await connection.quit();
  await pool.end();
}

main().catch(async (err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  await pool.end().catch(() => undefined);
  process.exit(1);
});
