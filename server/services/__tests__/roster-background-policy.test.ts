import { afterEach, describe, expect, it, vi } from "vitest";
import { backgroundRosterTargets, backgroundRosterTarget, managedRosterCompleteReadMinimum,
  backgroundRosterWorkerReady, setBackgroundRosterWorkerReady } from "../roster-background-policy.js";
import { nextBackgroundFullReadAt, backgroundRosterBoundaryPauseMs, nextBackgroundReadRetryAt } from "../roster-background-policy.js";
import { backgroundRosterSyncState, recentRosterCheckOverdue, type BackgroundRosterView } from "../../../shared/roster-background.js";

afterEach(() => { vi.unstubAllEnvs(); setBackgroundRosterWorkerReady(false); });
describe("bounded background roster policy", () => {
  it("retries just after a current reader cooldown and retains fallback for unknown failures",()=>{
    const now=Date.now();
    expect(+nextBackgroundReadRetryAt(new Date(now+3*60_000),now)).toBe(now+3*60_000+1_000);
    expect(+nextBackgroundReadRetryAt(new Date(now+30*60_000).toISOString(),now)).toBe(now+30*60_000+1_000);
    for(const value of [null,"invalid",new Date(now-1_000)])
      expect(+nextBackgroundReadRetryAt(value,now)).toBe(now+15*60_000);
  });
  it("paces a catch-up tick without adding delay to an already spaced batch",()=>{
    const now=Date.now();
    expect(backgroundRosterBoundaryPauseMs(new Date(now),now,0)).toBe(9_000);
    expect(backgroundRosterBoundaryPauseMs(new Date(now).toISOString(),now,1)).toBe(16_000);
    expect(backgroundRosterBoundaryPauseMs(new Date(now-5_000),now,0)).toBe(4_000);
    expect(backgroundRosterBoundaryPauseMs(new Date(now-60_000),now,1)).toBe(0);
    expect(backgroundRosterBoundaryPauseMs(null,now,0)).toBe(0);
    expect(backgroundRosterBoundaryPauseMs("invalid",now,0)).toBe(0);
  });
  it("schedules start-to-start without adding a 24h blind wait to a 30h pass",()=>{
    const now=Date.parse("2026-09-08T02:00:00Z");
    expect(+nextBackgroundFullReadAt(new Date(now-30*3600_000),now)).toBe(now+1000);
    expect(+nextBackgroundFullReadAt(new Date(now-30*3600_000).toISOString(),now)).toBe(now+1000);
    expect(+nextBackgroundFullReadAt(new Date(now-2*3600_000),now)).toBe(now+22*3600_000);
    expect(+nextBackgroundFullReadAt(null,now)).toBe(now+24*3600_000);
  });
  it("never hides an old recent-read clock just because the next retry is later",()=>{
    const now=Date.now(), progress={enabled:true,nextHeadRunAt:new Date(now+900_000).toISOString(),lastHeadReadAt:new Date(now-21*60_000).toISOString()} as BackgroundRosterView;
    expect(recentRosterCheckOverdue(progress,now)).toBe(true);
    expect(recentRosterCheckOverdue({...progress,lastHeadReadAt:new Date(now).toISOString()},now)).toBe(false);
    expect(recentRosterCheckOverdue({...progress,enabled:false},now)).toBe(false);
  });
  it("requires a named target/dimension and an exact supported source", () => {
    expect(backgroundRosterTargets(" Jannat:follower:graphql,other:following, bad, x:likes, x:follower:unknown,x:follower:graphql:extra, !:follower")).toEqual([
      { username: "jannat", dimension: "follower", source: "graphql" },
      { username: "other", dimension: "following", source: "auto" },
    ]);
  });
  it("does not broaden a follower canary to following or a different target", () => {
    vi.stubEnv("ROSTER_BACKGROUND_TARGETS", "jannat:follower:graphql");
    expect(backgroundRosterTarget("JANNAT", "follower")?.source).toBe("graphql");
    expect(backgroundRosterTarget("jannat", "following")).toBeUndefined();
    expect(backgroundRosterTarget("other", "follower")).toBeUndefined();
    expect(backgroundRosterTargets("")).toEqual([]);
  });
  it("does not delegate until the worker schedule is registered", () => {
    expect(backgroundRosterWorkerReady()).toBe(false);
    setBackgroundRosterWorkerReady(true); expect(backgroundRosterWorkerReady()).toBe(true);
  });
  it("requires distinct expected-count coverage without lowering the old 90% gate", () => {
    expect(managedRosterCompleteReadMinimum(335603)).toBe(302043);
    expect(managedRosterCompleteReadMinimum(10)).toBe(9);
    expect(managedRosterCompleteReadMinimum(0)).toBe(0);
    for (const bad of [NaN, Infinity, -1]) expect(() => managedRosterCompleteReadMinimum(bad)).toThrow();
  });
  it("never labels active incomplete or source-limited progress complete/capped", () => {
    const progress = { enabled:true,status:"syncing",baselineCompleteAt:null } as BackgroundRosterView;
    expect(backgroundRosterSyncState(progress,"capped")).toBe("syncing");
    expect(backgroundRosterSyncState({...progress,status:"source_limited"},"complete")).toBe("restricted");
    expect(backgroundRosterSyncState({...progress,status:"complete"},"complete")).toBe("syncing");
    expect(backgroundRosterSyncState({...progress,status:"complete",baselineCompleteAt:new Date().toISOString()},"capped")).toBe("complete");
    expect(backgroundRosterSyncState({...progress,enabled:false},"capped")).toBe("capped");
  });
});
