// Wave 6 — bot tier system unit tests.
//
// Covers:
//   1. assignBotToTrackedAccount picks tier='worker' first
//   2. Falls back to tier='canary' when no workers available
//   3. Refuses to pick tier='reserve' (and 'retired')
//   4. Canary protocol approves an endpoint after >= 3 successes (>= 80%)
//
// All DB I/O is mocked — no real Postgres connection is made.

import { describe, it, expect, beforeEach, vi } from "vitest";

// Stub env so importing ./db.js doesn't blow up before we mock it.
vi.stubEnv("DATABASE_URL", "postgres://mock:mock@localhost/mock");

// ─────────────────────────────────────────────────────────────────────────────
// Shared mock state
// ─────────────────────────────────────────────────────────────────────────────

type Tier = "canary" | "worker" | "reserve" | "retired";

interface MockBot {
  id: string;
  igUsername: string;
  currentFollows: number;
  maxFollows: number;
  status: string;
  tier: Tier;
}

const botManagerState: {
  bots: MockBot[];
  setCalls: Array<{ table: string; values: Record<string, unknown> }>;
  insertedFollowRequests: Array<Record<string, unknown>>;
  existingActiveFollowRequest: { id: string } | null;
  pickedTiers: Tier[];
} = {
  bots: [],
  setCalls: [],
  insertedFollowRequests: [],
  existingActiveFollowRequest: null,
  pickedTiers: [],
};

function resetBotManagerState() {
  botManagerState.bots = [];
  botManagerState.setCalls = [];
  botManagerState.insertedFollowRequests = [];
  botManagerState.existingActiveFollowRequest = null;
  botManagerState.pickedTiers = [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock: ../shared/schema.js — only the table/column refs we touch.
// Each ref is tagged so the mocked drizzle builder can identify it. The eq()
// helper from the drizzle mock looks at __columnName to read filters.
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("../../shared/schema.js", () => {
  const col = (table: string, name: string) => ({
    __tableName: table,
    __columnName: name,
  });
  // Each table is a Proxy: __tableName for explicit checks, every other
  // property access returns a tagged column ref so eq()/inArray()/etc. don't
  // blow up on unknown columns the bot-manager touches.
  const tableProxy = (name: string) =>
    new Proxy(
      { __tableName: name } as Record<string, unknown>,
      {
        get(target, prop: string) {
          if (prop === "__tableName") return name;
          if (prop in target) return target[prop];
          const ref = col(name, prop);
          target[prop] = ref;
          return ref;
        },
      },
    );

  return {
    botAccounts: tableProxy("botAccounts"),
    botFollowRequests: tableProxy("botFollowRequests"),
    trackedAccounts: tableProxy("trackedAccounts"),
    notifications: tableProxy("notifications"),
    endpointCanaryState: tableProxy("endpointCanaryState"),
  };
});

// ─────────────────────────────────────────────────────────────────────────────
// Mock: drizzle-orm — minimal helpers used by bot-manager and canary-protocol.
// We capture eq() filters so the bot picker can match on tier.
// ─────────────────────────────────────────────────────────────────────────────

interface FilterFn {
  (rows: MockBot[]): MockBot[];
  __filter?: { column?: string; value?: unknown };
}

vi.mock("drizzle-orm", () => {
  const eq = (left: unknown, right: unknown) => {
    const colName =
      left && typeof left === "object" && "__columnName" in left
        ? ((left as { __columnName?: string }).__columnName ?? "")
        : "";
    const fn: FilterFn = (rows: MockBot[]) =>
      rows.filter(
        (r) =>
          colName === "" ||
          (r as unknown as Record<string, unknown>)[colName] === right,
      );
    fn.__filter = { column: colName, value: right };
    return fn;
  };
  const and = (...filters: FilterFn[]) => {
    const fn: FilterFn = (rows: MockBot[]) =>
      filters.reduce(
        (acc, f) => (typeof f === "function" ? f(acc) : acc),
        rows,
      );
    fn.__filter = filters.find((f) => f?.__filter)?.__filter;
    // expose nested filters for the picker to inspect tier
    (fn as unknown as { __filters: unknown }).__filters = filters
      .map((f) => f?.__filter)
      .filter(Boolean);
    return fn;
  };
  const or = (..._filters: FilterFn[]) => {
    const fn: FilterFn = (rows: MockBot[]) => rows;
    return fn;
  };
  const noop: FilterFn = (rows: MockBot[]) => rows;
  return {
    eq,
    ne: () => noop,
    and,
    or,
    not: () => noop,
    inArray: () => noop,
    isNull: () => noop,
    // Bot selection now also requires a live session (isNotNull(sessionData)).
    // These tier-preference tests don't exercise session filtering, so treat it
    // as a pass-through — the session requirement is covered elsewhere.
    isNotNull: () => noop,
    lt: () => noop,
    sql: () => noop,
    asc: () => undefined,
    desc: () => undefined,
    relations: () => ({}),
  };
});

// ─────────────────────────────────────────────────────────────────────────────
// Mock: ./db.js (relative to bot-manager). Drizzle-shaped recorder.
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("../db.js", () => {
  type Mode = "selectFR" | "selectBot" | "selectTA" | "insertFR" | "updateBot" | "updateTA" | "";

  const makeTxn = () => {
    let mode: Mode = "";
    let updateTable = "";
    let activeAndFilter:
      | { __filters?: Array<{ column?: string; value?: unknown }> }
      | undefined;

    const builder: Record<string, unknown> = {};
    // The real transaction serializes assignment using an advisory lock.
    // Concurrency is covered by the database-backed allocation suite.
    builder.execute = async () => [];

    builder.select = () => builder;
    builder.from = (tbl: { __tableName?: string }) => {
      if (tbl?.__tableName === "botFollowRequests") mode = "selectFR";
      else if (tbl?.__tableName === "botAccounts") mode = "selectBot";
      else if (tbl?.__tableName === "trackedAccounts") mode = "selectTA";
      return builder;
    };
    builder.where = (filter: unknown) => {
      activeAndFilter = filter as {
        __filters?: Array<{ column?: string; value?: unknown }>;
      };
      return builder;
    };
    builder.orderBy = () => builder;
    // Historical-request reads are awaited without a limit. These tier tests
    // use a fresh eligible private target; admission is exercised in real DB tests.
    builder.then = (resolve: (value: unknown) => void) => resolve(
      mode === "selectFR" && botManagerState.existingActiveFollowRequest
        ? [botManagerState.existingActiveFollowRequest] : [],
    );
    builder.limit = function () {
      // Two terminations: existence check ends in .limit(); bot picker
      // ends in .for(). We support both.
      const self = this;
      return {
        for: builder.for,
        then: (resolve: (v: unknown) => void) => {
          if (mode === "selectFR") {
            resolve(
              botManagerState.existingActiveFollowRequest
                ? [botManagerState.existingActiveFollowRequest]
                : [],
            );
          } else if (mode === "selectTA") {
            const targetId = activeAndFilter?.__filters?.find(f => f.column === "id")?.value;
            resolve([{ id: targetId, isActive: true, isPrivate: true }]);
          } else {
            resolve([]);
          }
          return self;
        },
      };
    };
    builder.for = () => {
      if (mode !== "selectBot") return Promise.resolve([]);

      // Inspect captured filters to find the tier the picker is asking for.
      const filters = activeAndFilter?.__filters ?? [];
      const tierFilter = filters.find((f) => f?.column === "tier");
      const wanted = tierFilter?.value as Tier | undefined;
      const candidates = wanted
        ? botManagerState.bots.filter((b) => b.tier === wanted)
        : botManagerState.bots;
      if (wanted) botManagerState.pickedTiers.push(wanted);

      // Only return bots that are status='available' and under capacity. The
      // mock keeps it simple — real drizzle handles cooldown/etc.
      const eligible = candidates.filter(
        (b) => b.status === "available" && b.currentFollows < b.maxFollows,
      );
      return Promise.resolve(eligible.length > 0 ? [eligible[0]] : []);
    };

    builder.insert = (tbl: { __tableName?: string }) => {
      if (tbl?.__tableName === "botFollowRequests") mode = "insertFR";
      return builder;
    };
    builder.values = (vals: Record<string, unknown>) => {
      if (mode === "insertFR") {
        const row = {
          id: `fr-${botManagerState.insertedFollowRequests.length + 1}`,
          ...vals,
        };
        botManagerState.insertedFollowRequests.push(row);
        return { returning: () => Promise.resolve([{ id: row.id }]) };
      }
      return Promise.resolve(undefined);
    };

    builder.update = (tbl: { __tableName?: string }) => {
      if (tbl?.__tableName === "botAccounts") {
        mode = "updateBot";
        updateTable = "botAccounts";
      } else if (tbl?.__tableName === "trackedAccounts") {
        mode = "updateTA";
        updateTable = "trackedAccounts";
      }
      return builder;
    };
    builder.set = (vals: Record<string, unknown>) => {
      if (updateTable) {
        botManagerState.setCalls.push({ table: updateTable, values: vals });
      }
      return { where: () => Promise.resolve(undefined) };
    };

    return builder;
  };

  return {
    db: {
      transaction: async <T,>(fn: (tx: unknown) => Promise<T>) => fn(makeTxn()),
    },
  };
});

vi.mock("../domain/follow-request-state.js", () => ({
  transitionFollowRequest: vi.fn().mockResolvedValue({ changed: false }),
}));

vi.mock("../crypto/session-envelope.js", () => ({
  decryptSessionData: (v: string) => v,
  ensureEncrypted: (v: string) => v,
  isEncryptedEnvelope: () => true,
}));

vi.mock("../observability/logger.js", () => {
  const noop = () => undefined;
  const child = () => ({
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    child,
  });
  return { logger: { info: noop, warn: noop, error: noop, debug: noop, child } };
});

vi.mock("../behavior/device-fingerprint.js", () => ({
  generateDeviceFingerprint: () => ({}),
  resolveFingerprint: () => ({}),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Test 1: assignBot prefers worker, falls back to canary, refuses reserve.
// ─────────────────────────────────────────────────────────────────────────────

describe("assignBotToTrackedAccount — tier preference (Wave 6)", () => {
  beforeEach(() => {
    resetBotManagerState();
    vi.resetModules();
  });

  it("returns a worker first when both worker and canary are available", async () => {
    botManagerState.bots = [
      {
        id: "bot-worker",
        igUsername: "wrk",
        currentFollows: 0,
        maxFollows: 5,
        status: "available",
        tier: "worker",
      },
      {
        id: "bot-canary",
        igUsername: "can",
        currentFollows: 0,
        maxFollows: 5,
        status: "available",
        tier: "canary",
      },
    ];

    const { assignBotToTrackedAccount } = await import("../bot-manager.js");
    const id = await assignBotToTrackedAccount("tracked-1");

    expect(id).not.toBeNull();
    expect(botManagerState.insertedFollowRequests[0]).toMatchObject({
      botAccountId: "bot-worker",
    });
    // First tier the picker asked for must be worker.
    expect(botManagerState.pickedTiers[0]).toBe("worker");
  });

  it("falls back to canary when no workers are available", async () => {
    botManagerState.bots = [
      {
        id: "bot-canary",
        igUsername: "can",
        currentFollows: 0,
        maxFollows: 5,
        status: "available",
        tier: "canary",
      },
      {
        id: "bot-reserve",
        igUsername: "rsv",
        currentFollows: 0,
        maxFollows: 5,
        status: "available",
        tier: "reserve",
      },
    ];

    const { assignBotToTrackedAccount } = await import("../bot-manager.js");
    const id = await assignBotToTrackedAccount("tracked-2");

    expect(id).not.toBeNull();
    expect(botManagerState.insertedFollowRequests[0]).toMatchObject({
      botAccountId: "bot-canary",
    });
    // The picker should have probed worker first, then canary.
    expect(botManagerState.pickedTiers).toEqual(["worker", "canary"]);
  });

  it("refuses reserves and retired bots even when nothing else is available", async () => {
    botManagerState.bots = [
      {
        id: "bot-reserve",
        igUsername: "rsv",
        currentFollows: 0,
        maxFollows: 5,
        status: "available",
        tier: "reserve",
      },
      {
        id: "bot-retired",
        igUsername: "ret",
        currentFollows: 0,
        maxFollows: 5,
        status: "available",
        tier: "retired",
      },
    ];

    const { assignBotToTrackedAccount } = await import("../bot-manager.js");
    const id = await assignBotToTrackedAccount("tracked-3");

    expect(id).toBeNull();
    expect(botManagerState.insertedFollowRequests).toHaveLength(0);
    // Picker probed worker, then canary, and gave up — never tried reserve/retired.
    expect(botManagerState.pickedTiers).toEqual(["worker", "canary"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 2: canary-protocol pool approval after 3 successes.
// ─────────────────────────────────────────────────────────────────────────────

interface CanaryRow {
  endpoint: string;
  lastTestedAt: Date | null;
  successCount: number;
  failureCount: number;
  poolApproved: boolean;
  poolApprovedAt: Date | null;
}

const canaryStore: Map<string, CanaryRow> = new Map();

function resetCanaryStore() {
  canaryStore.clear();
}

vi.mock("../db.js?canary", async () => {
  // Unused — left here so the mock graph is explicit. Real mock is below.
  return {};
});

describe("canary-protocol — endpoint approval (Wave 6)", () => {
  beforeEach(() => {
    resetCanaryStore();
    vi.resetModules();

    // Re-mock db.js for the canary protocol tests with a different shape:
    // a key/value store keyed by endpoint.
    vi.doMock("../db.js", () => {
      const makeTxn = () => {
        let mode: "select" | "insert" | "update" = "select";
        let pendingEndpoint: string | undefined;

        const builder: Record<string, unknown> = {};
        builder.select = () => {
          mode = "select";
          return builder;
        };
        builder.from = () => builder;
        builder.where = (filter: { __filter?: { value?: unknown } }) => {
          pendingEndpoint = filter?.__filter?.value as string | undefined;
          return builder;
        };
        builder.orderBy = () => builder;
        builder.limit = function () {
          const row = pendingEndpoint
            ? canaryStore.get(pendingEndpoint)
            : undefined;
          return {
            for: () => Promise.resolve(row ? [row] : []),
            then: (resolve: (v: unknown) => void) =>
              resolve(row ? [row] : []),
          };
        };
        builder.for = () => {
          const row = pendingEndpoint
            ? canaryStore.get(pendingEndpoint)
            : undefined;
          return Promise.resolve(row ? [row] : []);
        };
        builder.insert = () => {
          mode = "insert";
          return builder;
        };
        builder.values = (vals: Record<string, unknown>) => {
          if (mode === "insert") {
            canaryStore.set(vals.endpoint as string, {
              endpoint: vals.endpoint as string,
              lastTestedAt: (vals.lastTestedAt as Date) ?? null,
              successCount: (vals.successCount as number) ?? 0,
              failureCount: (vals.failureCount as number) ?? 0,
              poolApproved: (vals.poolApproved as boolean) ?? false,
              poolApprovedAt: (vals.poolApprovedAt as Date) ?? null,
            });
          }
          return Promise.resolve(undefined);
        };
        builder.update = () => {
          mode = "update";
          return builder;
        };
        builder.set = (vals: Record<string, unknown>) => {
          return {
            where: (filter: { __filter?: { value?: unknown } }) => {
              const ep = filter?.__filter?.value as string | undefined;
              if (ep && canaryStore.has(ep)) {
                const prev = canaryStore.get(ep)!;
                canaryStore.set(ep, { ...prev, ...vals } as CanaryRow);
              }
              return Promise.resolve(undefined);
            },
          };
        };
        return builder;
      };

      return {
        db: {
          transaction: async <T,>(fn: (tx: unknown) => Promise<T>) =>
            fn(makeTxn()),
          select: makeTxn().select,
        },
      };
    });
  });

  it("approves an endpoint after 3 successes (>= 80% success rate)", async () => {
    const { markEndpointTested, isEndpointPoolApproved } = await import(
      "../services/canary-protocol.js"
    );

    expect(await isEndpointPoolApproved("/api/v1/foo")).toBe(false);

    await markEndpointTested("/api/v1/foo", "success");
    expect(await isEndpointPoolApproved("/api/v1/foo")).toBe(false);

    await markEndpointTested("/api/v1/foo", "success");
    expect(await isEndpointPoolApproved("/api/v1/foo")).toBe(false);

    await markEndpointTested("/api/v1/foo", "success");
    expect(await isEndpointPoolApproved("/api/v1/foo")).toBe(true);

    const stored = canaryStore.get("/api/v1/foo");
    expect(stored?.successCount).toBe(3);
    expect(stored?.failureCount).toBe(0);
    expect(stored?.poolApproved).toBe(true);
    expect(stored?.poolApprovedAt).toBeInstanceOf(Date);
  });

  it("does not approve when success rate is below 80%", async () => {
    const { markEndpointTested, isEndpointPoolApproved } = await import(
      "../services/canary-protocol.js"
    );

    // 2 successes + 1 failure = 66% — below threshold.
    await markEndpointTested("/api/v1/bar", "success");
    await markEndpointTested("/api/v1/bar", "success");
    await markEndpointTested("/api/v1/bar", "failure");

    expect(await isEndpointPoolApproved("/api/v1/bar")).toBe(false);
    expect(canaryStore.get("/api/v1/bar")?.poolApproved).toBe(false);
  });
});

// These allocation tests use an eligible customer; entitlement denial and expiry
// are exercised against real PostgreSQL in private-follow-access.integration.
vi.mock("../services/subscription-access.js", () => ({ trackedAccountHasAccess: vi.fn().mockResolvedValue(true), customerAccessSql: vi.fn() }));
