// ─── Tests for seed-bots-v2 ────────────────────────────────────────────────
//
// Covers:
//   * Tier assignment matches the documented strategy (1-2 canary,
//     3-10 worker, 11+ reserve)
//   * Plan building encrypts ig_password and email_password before any
//     DB write, leaves email_password NULL when the fixture has none
//     (tmailgg bots), and routes IMAP host/port to NULL for tmailgg
//   * Provider classification picks tmailgg_web when the fixture says so
//     OR when the email domain matches @tmailgg.*
//   * applySeedPlan calls db.execute with INSERT … ON CONFLICT DO UPDATE
//     for each bot in the plan
//
// Network and DB are mocked so the suite is fast and CI-safe.
// ────────────────────────────────────────────────────────────────────────────

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Env stub — credentials.ts and db.ts both throw at import without keys.
// ---------------------------------------------------------------------------

vi.stubEnv("DATABASE_URL", "postgres://mock:mock@localhost/mock");
// 32-byte key, base64-encoded — required for encryptCredential.
vi.stubEnv(
  "BOT_CRED_KEY",
  Buffer.alloc(32, 7).toString("base64"),
);

// ---------------------------------------------------------------------------
// Logger mock
// ---------------------------------------------------------------------------

vi.mock("../../observability/logger.js", () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

// ---------------------------------------------------------------------------
// db mock — `dbExecute` is hoisted via vi.hoisted so vi.mock can reference
// it from inside the factory before module-init order would otherwise allow.
// ---------------------------------------------------------------------------

const { dbExecute } = vi.hoisted(() => ({ dbExecute: vi.fn() }));

vi.mock("../../db.js", () => ({
  db: { execute: dbExecute },
}));

// ---------------------------------------------------------------------------
// drizzle-orm sql tag mock — captures arguments without parsing SQL strings.
// ---------------------------------------------------------------------------

vi.mock("drizzle-orm", () => ({
  sql: new Proxy(
    Object.assign((...args: unknown[]) => args, {
      raw: (...args: unknown[]) => args,
      join: (...args: unknown[]) => args,
    }),
    {
      get(target, prop) {
        if (prop === "raw") return (...args: unknown[]) => args;
        if (prop === "join") return (...args: unknown[]) => args;
        return (target as Record<string | symbol, unknown>)[prop];
      },
      apply(_target, _thisArg, args) {
        return args;
      },
    },
  ),
}));

// ---------------------------------------------------------------------------
// Imports — must come *after* the vi.mock calls.
// ---------------------------------------------------------------------------

import {
  applySeedPlan,
  buildSeedPlan,
  loadFixture,
  resolveImapHost,
  resolveImapPort,
  summariseTiers,
  tierForSeat,
  type SeedPlanRow,
} from "../seed-bots-v2.js";
import {
  decryptCredential,
  isEncryptedCredential,
} from "../../crypto/credentials.js";

// ---------------------------------------------------------------------------
// Helpers — synthetic 25-bot fixture mirroring /tmp/ig-bots-v2/accounts.json.
// ---------------------------------------------------------------------------

function makeOnetBot(n: number) {
  return {
    n,
    tier: "pending_assignment",
    ig_username: `onet_user_${n}`,
    ig_password: `pw-onet-${n}`,
    email: `onet_user_${n}@onet.pl`,
    email_password: "andy@5246784",
  };
}

function makeTmailggBot(n: number) {
  return {
    n,
    tier: "pending_assignment",
    ig_username: `tg_user_${n}`,
    ig_password: `pw-tg-${n}`,
    email: `tg_user_${n}@tmailgg.site`,
    email_password: null as string | null,
    email_inbox_url: "https://tmailgg.site/mailbox",
    email_provider: "tmailgg_web" as const,
    auth_method: "totp",
    totp_secret: `SECRET${n.toString().padStart(2, "0")}AAAAAAAAAAAA`,
  };
}

function makeFixture25() {
  const bots = [];
  // 5 onet IMAP bots (seats 1-5), 20 tmailgg bots (seats 6-25)
  for (let n = 1; n <= 5; n += 1) bots.push(makeOnetBot(n));
  for (let n = 6; n <= 25; n += 1) bots.push(makeTmailggBot(n));
  return {
    schema_version: 2,
    imap_host_default: "imap.poczta.onet.pl",
    imap_port_default: 993,
    bots,
  };
}

// ---------------------------------------------------------------------------
// tierForSeat — pure unit
// ---------------------------------------------------------------------------

describe("tierForSeat", () => {
  it("assigns seats 1-2 to canary", () => {
    expect(tierForSeat(1)).toBe("canary");
    expect(tierForSeat(2)).toBe("canary");
  });

  it("assigns seats 3-10 to worker", () => {
    for (let n = 3; n <= 10; n += 1) {
      expect(tierForSeat(n)).toBe("worker");
    }
  });

  it("assigns seats 11+ to reserve", () => {
    for (const n of [11, 15, 25, 100]) {
      expect(tierForSeat(n)).toBe("reserve");
    }
  });

  it("rejects non-positive or non-integer seats", () => {
    expect(() => tierForSeat(0)).toThrow();
    expect(() => tierForSeat(-1)).toThrow();
    expect(() => tierForSeat(1.5)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// IMAP routing
// ---------------------------------------------------------------------------

describe("resolveImapHost / resolveImapPort", () => {
  it("returns NULL host+port for tmailgg.site bots", () => {
    const bot = makeTmailggBot(6);
    expect(resolveImapHost(bot)).toBeNull();
    expect(resolveImapPort(bot)).toBeNull();
  });

  it("returns NULL even when only the domain (not provider) signals tmailgg", () => {
    const bot = {
      ...makeOnetBot(1),
      email: "x@tmailgg.site",
    };
    expect(resolveImapHost(bot)).toBeNull();
  });

  it("returns the resolved IMAP host for onet bots", () => {
    const bot = makeOnetBot(1);
    expect(resolveImapHost(bot)).toBe("imap.onet.pl");
    expect(resolveImapPort(bot)).toBe(993);
  });

  it("respects an explicit imap_host override on the fixture", () => {
    const bot = { ...makeOnetBot(1), imap_host: "imap.poczta.onet.pl" };
    expect(resolveImapHost(bot)).toBe("imap.poczta.onet.pl");
  });

  it("respects an explicit imap_port override on the fixture", () => {
    const bot = { ...makeOnetBot(1), imap_port: 143 };
    expect(resolveImapPort(bot)).toBe(143);
  });
});

// ---------------------------------------------------------------------------
// buildSeedPlan
// ---------------------------------------------------------------------------

describe("buildSeedPlan", () => {
  it("produces one row per fixture bot with deterministic tier mapping", () => {
    const fx = makeFixture25();
    const plan = buildSeedPlan(fx);
    expect(plan).toHaveLength(25);

    const tiers = plan.map((p) => p.tier);
    expect(tiers.slice(0, 2).every((t) => t === "canary")).toBe(true);
    expect(tiers.slice(2, 10).every((t) => t === "worker")).toBe(true);
    expect(tiers.slice(10, 25).every((t) => t === "reserve")).toBe(true);
  });

  it("encrypts ig_password into a v1 envelope and the round-trip recovers plaintext", () => {
    const fx = makeFixture25();
    const plan = buildSeedPlan(fx);

    for (const row of plan) {
      expect(isEncryptedCredential(row.igPasswordEncrypted)).toBe(true);
    }

    const seat3 = plan.find((p) => p.seat === 3);
    expect(seat3).toBeDefined();
    expect(decryptCredential(seat3!.igPasswordEncrypted)).toBe("pw-onet-3");
  });

  it("encrypts email_password for IMAP bots and leaves NULL for tmailgg bots", () => {
    const fx = makeFixture25();
    const plan = buildSeedPlan(fx);

    const onet = plan.find((p) => p.seat === 3);
    expect(onet?.emailPasswordEncrypted).not.toBeNull();
    expect(isEncryptedCredential(onet!.emailPasswordEncrypted!)).toBe(true);
    expect(decryptCredential(onet!.emailPasswordEncrypted!)).toBe(
      "andy@5246784",
    );

    const tmailgg = plan.find((p) => p.seat === 7);
    expect(tmailgg?.emailPasswordEncrypted).toBeNull();
  });

  it("populates totp_secret for tmailgg bots and leaves it null for onet bots", () => {
    const fx = makeFixture25();
    const plan = buildSeedPlan(fx);

    expect(plan.find((p) => p.seat === 1)?.totpSecret).toBeNull();
    expect(plan.find((p) => p.seat === 6)?.totpSecret).toBe(
      "SECRET06AAAAAAAAAAAA",
    );
  });

  it("classifies email_provider correctly for both vendor types", () => {
    const fx = makeFixture25();
    const plan = buildSeedPlan(fx);

    expect(plan.find((p) => p.seat === 1)?.emailProvider).toBe("imap");
    expect(plan.find((p) => p.seat === 6)?.emailProvider).toBe("tmailgg_web");
  });

  it("rejects empty fixtures", () => {
    expect(() => buildSeedPlan({ bots: [] })).toThrow();
  });

  it("rejects duplicate seat numbers", () => {
    const fx = {
      bots: [makeOnetBot(1), { ...makeOnetBot(1), ig_username: "alt" }],
    };
    expect(() => buildSeedPlan(fx)).toThrow(/duplicate seat/);
  });

  it("rejects duplicate ig_usernames", () => {
    const fx = {
      bots: [
        makeOnetBot(1),
        { ...makeOnetBot(2), ig_username: "ONET_USER_1" }, // case-insensitive
      ],
    };
    expect(() => buildSeedPlan(fx)).toThrow(/duplicate ig_username/);
  });

  it("rejects bots with empty ig_password", () => {
    const fx = { bots: [{ ...makeOnetBot(1), ig_password: "" }] };
    expect(() => buildSeedPlan(fx)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// summariseTiers
// ---------------------------------------------------------------------------

describe("summariseTiers", () => {
  it("counts the 25-bot fixture as 2 canary / 8 worker / 15 reserve", () => {
    const fx = makeFixture25();
    const plan = buildSeedPlan(fx);
    const summary = summariseTiers(plan);
    expect(summary).toEqual({
      canary: 2,
      worker: 8,
      reserve: 15,
      total: 25,
      byProvider: { imap: 5, tmailgg_web: 20 },
    });
  });
});

// ---------------------------------------------------------------------------
// loadFixture — reads JSON from disk
// ---------------------------------------------------------------------------

describe("loadFixture", () => {
  it("reads and parses a JSON fixture from disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "seed-bots-v2-"));
    const path = join(dir, "accounts.json");
    const fx = makeFixture25();
    writeFileSync(path, JSON.stringify(fx), "utf8");

    const loaded = loadFixture(path);
    expect(loaded.bots).toHaveLength(25);
    expect(loaded.bots[0].ig_username).toBe("onet_user_1");
  });

  it("throws on a malformed fixture (missing bots array)", () => {
    const dir = mkdtempSync(join(tmpdir(), "seed-bots-v2-"));
    const path = join(dir, "bad.json");
    writeFileSync(path, JSON.stringify({ schema_version: 2 }), "utf8");

    expect(() => loadFixture(path)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// applySeedPlan — verifies the UPSERT path is invoked once per row
// ---------------------------------------------------------------------------

describe("applySeedPlan", () => {
  beforeEach(() => {
    dbExecute.mockReset();
    dbExecute.mockResolvedValue({ rows: [] });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("calls db.execute once per planned row", async () => {
    const fx = makeFixture25();
    const plan = buildSeedPlan(fx);

    const result = await applySeedPlan(plan);
    expect(result.upserted).toBe(25);
    expect(dbExecute).toHaveBeenCalledTimes(25);
  });

  it("passes the encrypted credentials and tier values to db.execute", async () => {
    const fx = { bots: [makeOnetBot(1)] };
    const plan = buildSeedPlan(fx);

    await applySeedPlan(plan);

    // The sql mock returns its argument array; first call is the only INSERT.
    const callArgs = dbExecute.mock.calls[0]?.[0] as unknown[];
    // The interpolated values appear after the static template strings array
    // in the sql tag — they're embedded in the second-onwards entries.
    // We assert that the encrypted ig_password ciphertext is somewhere in the
    // captured tag arguments to prove it was passed, and that the tier value
    // 'canary' was passed.
    const flat = JSON.stringify(callArgs);
    expect(flat).toContain(plan[0].igPasswordEncrypted);
    expect(flat).toContain("canary");
  });

  it("supports an idempotent re-run path (re-invokes UPSERT for existing rows)", async () => {
    const fx = { bots: [makeOnetBot(1)] };
    const plan = buildSeedPlan(fx);

    await applySeedPlan(plan);
    await applySeedPlan(plan);

    // Two passes, one row each → 2 db.execute calls, both INSERT … ON CONFLICT.
    expect(dbExecute).toHaveBeenCalledTimes(2);
    const firstCall = JSON.stringify(dbExecute.mock.calls[0]?.[0]);
    const secondCall = JSON.stringify(dbExecute.mock.calls[1]?.[0]);
    expect(firstCall).toContain("ON CONFLICT");
    expect(secondCall).toContain("ON CONFLICT");
  });

  it("accepts an injected database stub (test seam)", async () => {
    const stubExecute = vi.fn().mockResolvedValue({ rows: [] });
    const plan: SeedPlanRow[] = [
      {
        seat: 1,
        igUsername: "alpha",
        igPasswordEncrypted: "v1:aaa:bbb:ccc",
        emailAddress: "a@b.c",
        emailPasswordEncrypted: null,
        imapHost: null,
        imapPort: null,
        totpSecret: "SECRET",
        emailProvider: "tmailgg_web",
        tier: "canary",
      },
    ];

    const result = await applySeedPlan(plan, {
      database: { execute: stubExecute },
    });

    expect(result.upserted).toBe(1);
    expect(stubExecute).toHaveBeenCalledTimes(1);
    expect(dbExecute).not.toHaveBeenCalled();
  });
});
