// Unit tests for server/services/imap-code-fetcher.ts
// ImapFlow and mailparser are fully mocked — no real IMAP traffic.

import { describe, it, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Shared mock state containers — referenced inside vi.mock factories.
// Using module-scope objects (not let variables) avoids the hoisting
// ReferenceError that occurs when vi.mock factories run before let declarations.
// ---------------------------------------------------------------------------

const lockHandle = { release: vi.fn() };

const imapMocks = {
  connect: vi.fn().mockResolvedValue(undefined),
  getMailboxLock: vi.fn().mockResolvedValue(lockHandle),
  logout: vi.fn().mockResolvedValue(undefined),
  search: vi.fn().mockResolvedValue([]),
  fetchOne: vi.fn().mockResolvedValue(undefined),
  messageFlagsAdd: vi.fn().mockResolvedValue(undefined),
  status: vi.fn().mockResolvedValue({ messages: 42 }),
};

const parserMocks = {
  simpleParser: vi.fn(),
};

// ---------------------------------------------------------------------------
// vi.mock — must use class/function constructor syntax for `new ImapFlow()`
// ---------------------------------------------------------------------------

vi.mock("imapflow", () => {
  // Use a regular function so it is callable with `new`
  function ImapFlow() {
    return {
      connect: imapMocks.connect,
      getMailboxLock: imapMocks.getMailboxLock,
      search: imapMocks.search,
      fetchOne: imapMocks.fetchOne,
      messageFlagsAdd: imapMocks.messageFlagsAdd,
      logout: imapMocks.logout,
      status: imapMocks.status,
    };
  }
  return { ImapFlow };
});

vi.mock("mailparser", () => ({
  // Arrow function is fine here — simpleParser is not a constructor
  simpleParser: (...args: unknown[]) => parserMocks.simpleParser(...args),
}));

vi.mock("../observability/logger.js", () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

// ---------------------------------------------------------------------------
// Import module under test AFTER all vi.mock() calls
// ---------------------------------------------------------------------------

import { pingImap, fetchInstagramCode, type ImapCredentials } from "./imap-code-fetcher.js";

const CREDS: ImapCredentials = {
  host: "imap.example.com",
  port: 993,
  user: "bot@example.com",
  password: "secret",
};

function resetMocks() {
  vi.clearAllMocks();
  imapMocks.connect.mockResolvedValue(undefined);
  imapMocks.getMailboxLock.mockResolvedValue(lockHandle);
  imapMocks.logout.mockResolvedValue(undefined);
  imapMocks.search.mockResolvedValue([]);
  imapMocks.fetchOne.mockResolvedValue(undefined);
  imapMocks.messageFlagsAdd.mockResolvedValue(undefined);
  imapMocks.status.mockResolvedValue({ messages: 42 });
  lockHandle.release.mockClear();
}

// ---------------------------------------------------------------------------
// pingImap
// ---------------------------------------------------------------------------

describe("pingImap", () => {
  beforeEach(resetMocks);

  it("returns the message count from status()", async () => {
    const count = await pingImap(CREDS);
    expect(count).toBe(42);
  });

  it("calls connect, getMailboxLock('INBOX'), status('INBOX', …), and logout", async () => {
    await pingImap(CREDS);
    expect(imapMocks.connect).toHaveBeenCalledOnce();
    expect(imapMocks.getMailboxLock).toHaveBeenCalledWith("INBOX");
    expect(imapMocks.status).toHaveBeenCalledWith("INBOX", { messages: true });
    expect(lockHandle.release).toHaveBeenCalled();
    expect(imapMocks.logout).toHaveBeenCalledOnce();
  });

  it("returns 0 when status reports no messages field", async () => {
    imapMocks.status.mockResolvedValue({});
    const count = await pingImap(CREDS);
    expect(count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// fetchInstagramCode — code regex extraction
// ---------------------------------------------------------------------------

describe("fetchInstagramCode — code regex extraction", () => {
  const SINCE = new Date(Date.now() - 60_000);

  function stubMessage(fromAddress: string, subject: string, text: string) {
    imapMocks.search.mockResolvedValue([1]);
    imapMocks.fetchOne.mockResolvedValue({
      source: Buffer.from("raw"),
      envelope: { from: [{ address: fromAddress }] },
    });
    parserMocks.simpleParser.mockResolvedValue({ subject, text });
  }

  beforeEach(resetMocks);

  it('extracts a 6-digit code from "Your code is 123456" in the body', async () => {
    stubMessage(
      "security@mail.instagram.com",
      "Your Instagram code",
      "Your code is 123456. It expires in 10 minutes.",
    );
    const code = await fetchInstagramCode(CREDS, {
      since: SINCE,
      timeoutMs: 500,
      pollIntervalMs: 100,
    });
    expect(code).toBe("123456");
  });

  it('extracts a code from "Use 654321 to verify your account"', async () => {
    stubMessage(
      "no-reply@instagram.com",
      "Verify your account",
      "Use 654321 to verify your Instagram account.",
    );
    const code = await fetchInstagramCode(CREDS, {
      since: SINCE,
      timeoutMs: 500,
      pollIntervalMs: 100,
    });
    expect(code).toBe("654321");
  });

  it('extracts a code from "Your security code: 789012"', async () => {
    stubMessage(
      "security@facebookmail.com",
      "Instagram security code: 789012",
      "Your security code: 789012",
    );
    const code = await fetchInstagramCode(CREDS, {
      since: SINCE,
      timeoutMs: 500,
      pollIntervalMs: 100,
    });
    expect(code).toBe("789012");
  });

  it("extracts only the first 6-digit code when body has multiple", async () => {
    stubMessage(
      "security@mail.instagram.com",
      "Your code",
      "Use 111111 to verify. Reference 999999 in your ticket.",
    );
    const code = await fetchInstagramCode(CREDS, {
      since: SINCE,
      timeoutMs: 500,
      pollIntervalMs: 100,
    });
    expect(code).toBe("111111");
  });

  it("extracts code from subject when body is empty", async () => {
    stubMessage("security@mail.instagram.com", "Instagram code: 246810", "");
    const code = await fetchInstagramCode(CREDS, {
      since: SINCE,
      timeoutMs: 500,
      pollIntervalMs: 100,
    });
    expect(code).toBe("246810");
  });
});

// ---------------------------------------------------------------------------
// Sender domain validation
// ---------------------------------------------------------------------------

describe("fetchInstagramCode — sender domain validation", () => {
  const SINCE = new Date(Date.now() - 60_000);

  beforeEach(resetMocks);

  it("rejects emails not from an instagram/facebookmail domain", async () => {
    imapMocks.search.mockResolvedValue([1]);
    imapMocks.fetchOne.mockResolvedValue({
      source: Buffer.from("raw"),
      envelope: { from: [{ address: "hacker@evil.com" }] },
    });
    parserMocks.simpleParser.mockResolvedValue({
      subject: "Your code is 123456",
      text: "Your code is 123456",
    });

    await expect(
      fetchInstagramCode(CREDS, {
        since: SINCE,
        timeoutMs: 300,
        pollIntervalMs: 100,
      }),
    ).rejects.toThrow(/no IG verification code/);
  });

  it("accepts emails from mail.instagram.com", async () => {
    imapMocks.search.mockResolvedValue([1]);
    imapMocks.fetchOne.mockResolvedValue({
      source: Buffer.from("raw"),
      envelope: { from: [{ address: "noreply@mail.instagram.com" }] },
    });
    parserMocks.simpleParser.mockResolvedValue({ subject: "", text: "123456" });

    const code = await fetchInstagramCode(CREDS, {
      since: SINCE,
      timeoutMs: 500,
      pollIntervalMs: 100,
    });
    expect(code).toBe("123456");
  });

  it("accepts emails from instagram.com directly", async () => {
    imapMocks.search.mockResolvedValue([1]);
    imapMocks.fetchOne.mockResolvedValue({
      source: Buffer.from("raw"),
      envelope: { from: [{ address: "security@instagram.com" }] },
    });
    parserMocks.simpleParser.mockResolvedValue({ subject: "", text: "555444" });

    const code = await fetchInstagramCode(CREDS, {
      since: SINCE,
      timeoutMs: 500,
      pollIntervalMs: 100,
    });
    expect(code).toBe("555444");
  });

  it("accepts emails from facebookmail.com", async () => {
    imapMocks.search.mockResolvedValue([1]);
    imapMocks.fetchOne.mockResolvedValue({
      source: Buffer.from("raw"),
      envelope: { from: [{ address: "security@facebookmail.com" }] },
    });
    parserMocks.simpleParser.mockResolvedValue({ subject: "", text: "334455" });

    const code = await fetchInstagramCode(CREDS, {
      since: SINCE,
      timeoutMs: 500,
      pollIntervalMs: 100,
    });
    expect(code).toBe("334455");
  });
});

// ---------------------------------------------------------------------------
// Edge case: fetchOne returns a message with no from address
// ---------------------------------------------------------------------------

describe("fetchInstagramCode — message with missing from address", () => {
  const SINCE = new Date(Date.now() - 60_000);

  beforeEach(resetMocks);

  it("skips messages whose envelope has no from address and eventually times out", async () => {
    imapMocks.search.mockResolvedValue([1]);
    imapMocks.fetchOne.mockResolvedValue({
      source: Buffer.from("raw"),
      // from array is empty — address would be undefined
      envelope: { from: [] },
    });
    parserMocks.simpleParser.mockResolvedValue({ subject: "", text: "111222" });

    await expect(
      fetchInstagramCode(CREDS, {
        since: SINCE,
        timeoutMs: 300,
        pollIntervalMs: 100,
      }),
    ).rejects.toThrow(/no IG verification code/);
  });
});

// ---------------------------------------------------------------------------
// Timeout path
// ---------------------------------------------------------------------------

describe("fetchInstagramCode — timeout when no code arrives", () => {
  beforeEach(resetMocks);

  it("throws after the timeout when no messages are found", async () => {
    imapMocks.search.mockResolvedValue([]); // mailbox always empty

    await expect(
      fetchInstagramCode(CREDS, {
        since: new Date(),
        timeoutMs: 200,
        pollIntervalMs: 50,
      }),
    ).rejects.toThrow(/no IG verification code/);
  });
});
