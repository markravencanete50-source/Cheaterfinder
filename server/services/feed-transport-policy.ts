import { createHash } from "node:crypto";
const httpWalls = new Map<string, number>();
const PROBE_INTERVAL_MS = 6 * 60 * 60 * 1000;
export function feedTransportKey(botId: string, session: string, path: string): string {
  return `${botId}:${createHash("sha256").update(session).digest("hex")}:${path}`;
}
export function shouldSkipWalledHttp(key: string, now = Date.now()): boolean {
  const until = httpWalls.get(key);
  if (until === undefined) return false;
  if (until <= now) { httpWalls.delete(key); return false; }
  return true;
}
export function markHttpFeedWalled(key: string, now = Date.now()): void {
  for (const [k, until] of httpWalls) if (until <= now) httpWalls.delete(k);
  if (httpWalls.size >= 512) httpWalls.delete(httpWalls.keys().next().value!);
  httpWalls.set(key, now + PROBE_INTERVAL_MS);
}
