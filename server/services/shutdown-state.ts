// Process-wide shutdown flag (2026-09-02 audit, C4 — deploy safety).
//
// `shutdown()` in server/index.ts flips this BEFORE it drains the BullMQ
// workers. Long-running loops poll it between units of work and stop early,
// returning their partial progress with a resume point:
//   - the like-evidence owner loop (workers.ts) yields between owners;
//   - the follower/following page walk (public-data-service.ts) yields between
//     pages and returns the captured pages as a truncated leg with its cursor.
// Without it a like scan could run up to LIKE_EVIDENCE_MAX_SCAN_MS (600 s) and
// a large roster walk ~100 pages x 9-16 s inside a 170 s drain budget: 5 of 8
// shutdowns on 2026-09-02 hit "forced shutdown after timeout", and a killed
// walk re-ran from page 1 because its cursor is saved only when it returns.
//
// Deliberately dependency-free: it is imported by the hottest modules in the
// process and must never pull in db/redis/logger at load time.

// The one deliberate mutation in this module: a process-lifetime latch.
let shuttingDown = false;
let shutdownStartedAtMs: number | null = null;
const shutdownListeners = new Set<() => void>();
let cleanupFailures = 0;

/** Latch the flag. Idempotent — a second signal keeps the first timestamp. */
export function markShuttingDown(nowMs: number = Date.now()): void {
  if (shuttingDown) return;
  shuttingDown = true;
  shutdownStartedAtMs = nowMs;
  const listeners = [...shutdownListeners];
  shutdownListeners.clear();
  for (const listener of listeners) {
    try { listener(); } catch { cleanupFailures += 1; }
  }
}

/** Small synchronous cleanup hooks (SSE/timers), never long-running work. */
export function onShutdown(listener: () => void): () => void {
  if (shuttingDown) { listener(); return () => {}; }
  shutdownListeners.add(listener);
  return () => { shutdownListeners.delete(listener); };
}

export function shutdownCleanupFailures(): number { return cleanupFailures; }

/** Stop paced background loops promptly without pretending IG failed. */
export function waitForShutdownOrTimeout(ms: number): Promise<"shutdown" | "timeout"> {
  if (shuttingDown) return Promise.resolve("shutdown");
  return new Promise(resolve => {
    const timer = setTimeout(() => { unsubscribe(); resolve("timeout"); }, ms);
    const unsubscribe = onShutdown(() => { clearTimeout(timer); resolve("shutdown"); });
  });
}

export function isShuttingDown(): boolean {
  return shuttingDown;
}

/** Milliseconds since shutdown began; null while the process runs normally. */
export function shutdownElapsedMs(nowMs: number = Date.now()): number | null {
  if (shutdownStartedAtMs === null) return null;
  return Math.max(0, nowMs - shutdownStartedAtMs);
}

/** Test hook: back to the running state. */
export function resetShutdownStateForTests(): void {
  shuttingDown = false;
  shutdownStartedAtMs = null;
  shutdownListeners.clear();
  cleanupFailures = 0;
}
