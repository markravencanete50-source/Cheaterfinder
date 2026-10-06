export interface RecoveryStatus {
  running: boolean;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastSuccessAt: string | null;
  failedSteps: string[];
}

const state: RecoveryStatus = { running: false, lastStartedAt: null, lastFinishedAt: null, lastSuccessAt: null, failedSteps: [] };
let inFlight: Promise<void> | null = null;

export const recoveryStatus = (): RecoveryStatus => ({ ...state, failedSteps: [...state.failedSteps] });

/** Idempotent DB/queue repairs run once at a time; one failed repair cannot hide or skip another. */
export function runRecoverySweep(steps: Record<string, () => Promise<unknown>>): Promise<void> {
  if (inFlight) return inFlight;
  state.running = true;
  state.lastStartedAt = new Date().toISOString();
  inFlight = Promise.all(Object.entries(steps).map(async ([name, run]) => {
    try { await run(); return null; } catch { return name; }
  })).then(results => {
    state.failedSteps = results.filter((name): name is string => name !== null);
    if (state.failedSteps.length === 0) state.lastSuccessAt = new Date().toISOString();
  }).finally(() => {
    state.running = false;
    state.lastFinishedAt = new Date().toISOString();
    inFlight = null;
  });
  return inFlight;
}
