import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ getJob: vi.fn(), addBulk: vi.fn(), resolve: vi.fn(), cache: vi.fn() }));
vi.mock("bullmq", () => ({ Queue: class { getJob = f.getJob; addBulk = f.addBulk; } }));
vi.mock("ioredis", () => ({ default: class { on() {} } }));
vi.mock("../../observability/logger.js", () => ({ logger: { error: vi.fn() } }));
vi.mock("../media-cache.js", () => ({
  isAllowedMediaUrl: (url: string) => url.startsWith("https://scontent.cdninstagram.com/"),
  mediaCacheKey: (url: string) => new URL(url).pathname.slice(1),
  resolveCachedMediaUrls: f.resolve, cacheMediaUrl: f.cache,
}));
import { enqueueMediaCacheUrls, processMediaCacheUrl } from "../media-cache-jobs.js";
const old = "https://scontent.cdninstagram.com/a.jpg?sig=old", fresh = old.replace("old", "new");
beforeEach(() => { vi.resetAllMocks(); f.resolve.mockResolvedValue(new Map()); f.getJob.mockResolvedValue(null); });
describe("media repair jobs", () => {
  it("does not redownload intact cached assets on each page view", async () => {
    f.resolve.mockResolvedValue(new Map([[old, "/api/media/key"]]));
    expect(await enqueueMediaCacheUrls([old])).toBe(0); expect(f.addBulk).not.toHaveBeenCalled();
  });
  it("repairs missing files despite a retained successful job, deduplicating new signatures", async () => {
    const retry = vi.fn(); const updateData = vi.fn(); f.getJob.mockResolvedValue({ getState: async () => "completed", retry, updateData });
    expect(await enqueueMediaCacheUrls([old, fresh])).toBe(1); expect(retry).toHaveBeenCalledWith("completed", {resetAttemptsMade:true,resetAttemptsStarted:true});
    expect(updateData).toHaveBeenCalledWith({url:fresh,reason:"viewer"});expect(f.addBulk).not.toHaveBeenCalled();
  });
  it("updates a delayed retry with a renewed URL without bypassing its backoff", async () => {
    const updateData = vi.fn(); f.getJob.mockResolvedValue({ getState: async () => "delayed", data:{url:old}, updateData });
    expect(await enqueueMediaCacheUrls([fresh])).toBe(0);
    expect(updateData).toHaveBeenCalledWith({url:fresh,reason:"viewer"});expect(f.addBulk).not.toHaveBeenCalled();
  });
  it("leaves active downloads alone", async () => {
    f.getJob.mockResolvedValue({getState:async()=>"active",data:{url:old}});
    expect(await enqueueMediaCacheUrls([fresh])).toBe(0);expect(f.addBulk).not.toHaveBeenCalled();
  });
  it("backs off exhausted failures until a new signed URL arrives", async () => {
    const retry=vi.fn();f.getJob.mockResolvedValue({getState:async()=>"failed",data:{url:old},finishedOn:Date.now(),retry,updateData:vi.fn()});
    expect(await enqueueMediaCacheUrls([old])).toBe(0);expect(retry).not.toHaveBeenCalled();
    expect(await enqueueMediaCacheUrls([fresh])).toBe(1);expect(retry).toHaveBeenCalledOnce();
  });
  it("retries an exhausted same-URL job after the repair cooldown", async () => {
    const retry=vi.fn();f.getJob.mockResolvedValue({getState:async()=>"failed",data:{url:old},finishedOn:Date.now()-11*60_000,retry,updateData:vi.fn()});
    expect(await enqueueMediaCacheUrls([old])).toBe(1);expect(retry).toHaveBeenCalledOnce();
  });
  it("does not remove or duplicate a job recovered by a concurrent caller", async () => {
    const retry=vi.fn().mockRejectedValue(Object.assign(new Error("not terminal"),{code:-3}));
    f.getJob.mockResolvedValue({getState:async()=>"completed",retry,updateData:vi.fn()});
    expect(await enqueueMediaCacheUrls([fresh])).toBe(0);expect(f.addBulk).not.toHaveBeenCalled();
  });
  it("rejects failed downloads so BullMQ performs retries", async () => {
    f.cache.mockResolvedValue({cacheKey:"a",status:"failed"});
    await expect(processMediaCacheUrl(old)).rejects.toThrow("media cache download failed");
    f.cache.mockResolvedValue({cacheKey:"a",status:"cached"});
    await expect(processMediaCacheUrl(old)).resolves.toMatchObject({status:"cached"});
  });
});
