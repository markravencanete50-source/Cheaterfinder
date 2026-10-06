import { beforeEach, describe, expect, it, vi } from "vitest";

vi.stubEnv("DATABASE_URL", "postgres://mock:mock@localhost/mock");

const returning = vi.hoisted(() => vi.fn());
const where = vi.hoisted(() => vi.fn(() => ({ returning })));
const set = vi.hoisted(() => vi.fn(() => ({ where })));
const update = vi.hoisted(() => vi.fn(() => ({ set })));

vi.mock("../../db.js", () => ({ db: { update } }));
vi.mock("../../../shared/schema.js", () => ({
  collectionJobs: {
    id: "id",
    status: "status",
    completedAt: "completed_at",
    startedAt: "started_at",
  },
}));
vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((...args: unknown[]) => args),
  isNull: vi.fn((...args: unknown[]) => args),
  lt: vi.fn((...args: unknown[]) => args),
}));
vi.mock("../../observability/logger.js", () => ({
  logger: {
    child: () => ({ warn: vi.fn() }),
  },
}));

import { reconcileStaleCollectionJobs } from "../collection-job-reconciler.js";

describe("reconcileStaleCollectionJobs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marks returned stale running rows failed and reports the count", async () => {
    returning.mockResolvedValue([{ id: "one" }, { id: "two" }]);
    const now = new Date("2026-08-16T12:00:00.000Z");

    await expect(
      reconcileStaleCollectionJobs(2 * 60 * 60 * 1000, now),
    ).resolves.toBe(2);

    expect(update).toHaveBeenCalledOnce();
    expect(set).toHaveBeenCalledWith({
      status: "failed",
      completedAt: null,
      error: "reconciled: worker exited before collection job completed",
    });
    expect(where).toHaveBeenCalledOnce();
    expect(returning).toHaveBeenCalledWith({ id: "id" });
  });

  it("returns zero when there is nothing to reconcile", async () => {
    returning.mockResolvedValue([]);
    await expect(reconcileStaleCollectionJobs()).resolves.toBe(0);
  });
});
