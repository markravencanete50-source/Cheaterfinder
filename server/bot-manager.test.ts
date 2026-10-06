// Unit tests for server/bot-manager.ts
//
// Focus: regression test for the Postgres bot_status enum cast bug.
// Previously the UPDATE bot_accounts.status used an inline drizzle
// `sql\`CASE WHEN ... THEN 'in_use' ELSE 'available' END\`` expression,
// which Postgres rejects:
//   column "status" is of type bot_status but expression is of type text
//
// The fix computes the next status in JS and passes a typed enum literal
// to .set() so drizzle emits a properly-cast parameter.
//
// All external I/O (DB) is mocked — no real Postgres connection is made.

import { describe, it, expect, beforeEach, vi } from "vitest";

// Stub env so importing ./db.js doesn't blow up before we mock it.
vi.stubEnv("DATABASE_URL", "postgres://mock:mock@localhost/mock");

// ---------------------------------------------------------------------------
// Capture .set() payloads from the txn so tests can assert what drizzle saw.
// ---------------------------------------------------------------------------

interface SetCall {
  table: "botAccounts" | "trackedAccounts";
  values: Record<string, unknown>;
}

const state: {
  setCalls: SetCall[];
  insertedFollowRequests: Array<Record<string, unknown>>;
  bot: {
    id: string;
    igUsername: string;
    currentFollows: number;
    maxFollows: number;
    status: string;
  } | null;
  existingActiveFollowRequest: { id: string } | null;
} = {
  setCalls: [],
  insertedFollowRequests: [],
  bot: null,
  existingActiveFollowRequest: null,
};

function resetState() {
  state.setCalls = [];
  state.insertedFollowRequests = [];
  state.bot = {
    id: "bot-1",
    igUsername: "test_bot",
    currentFollows: 0,
    maxFollows: 5,
    status: "available",
  };
  state.existingActiveFollowRequest = null;
}

// ---------------------------------------------------------------------------
// Mock: ../shared/schema.js — only the table refs we actually touch.
// We tag each ref so the mocked update() can route the .set() call.
// ---------------------------------------------------------------------------

vi.mock("../shared/schema.js", () => {
  const tag = (name: string) => ({ __tableName: name });
  return {
    botAccounts: tag("botAccounts"),
    botFollowRequests: tag("botFollowRequests"),
    trackedAccounts: tag("trackedAccounts"),
    notifications: tag("notifications"),
  };
});

// ---------------------------------------------------------------------------
// Mock: ./db.js — minimal drizzle-shaped builder that records .set() values
// and serves a stubbed bot row from .select().
// ---------------------------------------------------------------------------

vi.mock("./db.js", () => {
  // Builder used inside the transaction. It is intentionally permissive —
  // each method just returns `this` until a terminal awaited call resolves.
  const makeTxn = () => {
    let mode: "selectFR" | "selectBot" | "selectTA" | "insertFR" | "updateBot" | "updateTA" | "" = "";
    let updateTable: "botAccounts" | "trackedAccounts" | "" = "";
    const builder: Record<string, unknown> = {};
    builder.execute = async () => [];

    builder.select = (..._args: unknown[]) => {
      // We can't tell from .select alone whether it's the existence check or
      // bot picker — the .from() call distinguishes.
      return builder;
    };
    builder.from = (tbl: { __tableName?: string }) => {
      if (tbl?.__tableName === "botFollowRequests") mode = "selectFR";
      else if (tbl?.__tableName === "botAccounts") mode = "selectBot";
      else if (tbl?.__tableName === "trackedAccounts") mode = "selectTA";
      return builder;
    };
    builder.where = () => builder;
    builder.then = (resolve: (value: unknown) => void) => resolve(
      mode === "selectFR" && state.existingActiveFollowRequest ? [state.existingActiveFollowRequest] : [],
    );
    builder.orderBy = () => builder;
    builder.limit = () => builder;
    builder.for = () => {
      if (mode === "selectBot") {
        return Promise.resolve(state.bot ? [state.bot] : []);
      }
      // Other .for() calls (rare) — return empty.
      return Promise.resolve([]);
    };
    // Some queries don't end in .for() (the existence check ends in .limit()).
    // Make .limit return a thenable for that path.
    const origLimit = builder.limit;
    builder.limit = function () {
      origLimit();
      const self = this;
      return {
        // chainable .for()
        for: builder.for,
        // awaiting .limit() resolves to existence-check result
        then: (resolve: (v: unknown) => void) => {
          if (mode === "selectFR") {
            resolve(
              state.existingActiveFollowRequest
                ? [state.existingActiveFollowRequest]
                : [],
            );
          } else if (mode === "selectTA") {
            resolve([{ id: "tracked-1" }]);
          } else {
            resolve([]);
          }
          return self;
        },
      } as unknown;
    };

    builder.insert = (tbl: { __tableName?: string }) => {
      if (tbl?.__tableName === "botFollowRequests") mode = "insertFR";
      return builder;
    };
    builder.values = (vals: Record<string, unknown>) => {
      if (mode === "insertFR") {
        const row = { id: `fr-${state.insertedFollowRequests.length + 1}`, ...vals };
        state.insertedFollowRequests.push(row);
        return {
          returning: () => Promise.resolve([{ id: row.id }]),
        };
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
        state.setCalls.push({ table: updateTable, values: vals });
      }
      return {
        where: () => Promise.resolve(undefined),
      };
    };

    return builder;
  };

  return {
    db: {
      transaction: async <T,>(fn: (tx: unknown) => Promise<T>) => fn(makeTxn()),
    },
  };
});

// ---------------------------------------------------------------------------
// Mock domain helpers used elsewhere in bot-manager (not exercised here but
// imported at module load).
// ---------------------------------------------------------------------------

vi.mock("./domain/follow-request-state.js", () => ({
  transitionFollowRequest: vi.fn().mockResolvedValue({ changed: false }),
}));

vi.mock("./crypto/session-envelope.js", () => ({
  decryptSessionData: (v: string) => v,
  ensureEncrypted: (v: string) => v,
  isEncryptedEnvelope: () => true,
}));

vi.mock("./observability/logger.js", () => {
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

vi.mock("./behavior/device-fingerprint.js", () => ({
  generateDeviceFingerprint: () => ({}),
  resolveFingerprint: () => ({}),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const VALID_ENUM_VALUES = new Set([
  "available",
  "in_use",
  "cooldown",
  "disabled",
  "banned",
  "session_expired",
]);

describe("assignBotToTrackedAccount — bot_status enum cast regression", () => {
  beforeEach(() => {
    resetState();
  });

  it("returns the new follow request id and inserts a bot_follow_requests row", async () => {
    const { assignBotToTrackedAccount } = await import("./bot-manager.js");

    const requestId = await assignBotToTrackedAccount("tracked-1");

    expect(requestId).not.toBeNull();
    expect(state.insertedFollowRequests).toHaveLength(1);
    expect(state.insertedFollowRequests[0]).toMatchObject({
      botAccountId: "bot-1",
      trackedAccountId: "tracked-1",
      status: "queued",
    });
  });

  it("passes a plain enum-literal string for status (NOT a drizzle sql CASE expression)", async () => {
    const { assignBotToTrackedAccount } = await import("./bot-manager.js");

    await assignBotToTrackedAccount("tracked-1");

    const botUpdate = state.setCalls.find((c) => c.table === "botAccounts");
    expect(botUpdate).toBeDefined();
    // The previous broken implementation passed a SQL template (object).
    // The fix passes a plain string literal that Postgres accepts as bot_status.
    expect(typeof botUpdate!.values.status).toBe("string");
    expect(VALID_ENUM_VALUES.has(botUpdate!.values.status as string)).toBe(true);
  });

  it("increments current_follows by 1 (passes a plain number, not a drizzle sql expression)", async () => {
    state.bot!.currentFollows = 2;

    const { assignBotToTrackedAccount } = await import("./bot-manager.js");
    await assignBotToTrackedAccount("tracked-1");

    const botUpdate = state.setCalls.find((c) => c.table === "botAccounts");
    expect(typeof botUpdate!.values.currentFollows).toBe("number");
    expect(botUpdate!.values.currentFollows).toBe(3);
  });

  it("sets status='available' when next currentFollows < maxFollows", async () => {
    // bot starts at 0/5 → next is 1/5 → still available
    const { assignBotToTrackedAccount } = await import("./bot-manager.js");
    await assignBotToTrackedAccount("tracked-1");

    const botUpdate = state.setCalls.find((c) => c.table === "botAccounts");
    expect(botUpdate!.values.status).toBe("available");
  });

  it("flips status to 'in_use' when next currentFollows reaches maxFollows", async () => {
    // 4/5 → next is 5/5 → in_use
    state.bot!.currentFollows = 4;
    state.bot!.maxFollows = 5;

    const { assignBotToTrackedAccount } = await import("./bot-manager.js");
    await assignBotToTrackedAccount("tracked-1");

    const botUpdate = state.setCalls.find((c) => c.table === "botAccounts");
    expect(botUpdate!.values.status).toBe("in_use");
    expect(botUpdate!.values.currentFollows).toBe(5);
  });

  it("returns null when no bot is available and writes nothing", async () => {
    state.bot = null;

    const { assignBotToTrackedAccount } = await import("./bot-manager.js");
    const requestId = await assignBotToTrackedAccount("tracked-1");

    expect(requestId).toBeNull();
    expect(state.insertedFollowRequests).toHaveLength(0);
    expect(state.setCalls).toHaveLength(0);
  });

  it("returns null when a non-terminal follow request already exists (idempotency guard)", async () => {
    state.existingActiveFollowRequest = { id: "existing-fr" };

    const { assignBotToTrackedAccount } = await import("./bot-manager.js");
    const requestId = await assignBotToTrackedAccount("tracked-1");

    expect(requestId).toBeNull();
    expect(state.insertedFollowRequests).toHaveLength(0);
  });

  it("does not rotate another viewer during repeated stopped-bot cleanup", async () => {
    state.existingActiveFollowRequest = { id: "replacement-fr" };
    const { rotateBotForTrackedAccount } = await import("./bot-manager.js");

    expect(await rotateBotForTrackedAccount("tracked-1", { onlyIfNoActive: true })).toBeNull();
    expect(state.insertedFollowRequests).toHaveLength(0);
    expect(state.setCalls).toHaveLength(0);
  });
});

// These allocation tests use an eligible customer; entitlement denial and expiry
// are exercised against real PostgreSQL in private-follow-access.integration.
vi.mock("./services/subscription-access.js", () => ({ trackedAccountHasAccess: vi.fn().mockResolvedValue(true), customerAccessSql: vi.fn() }));
