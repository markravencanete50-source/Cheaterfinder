import { describe, it, expect, vi } from "vitest";

// ig-http-client's import graph reaches the DB module, which throws without
// DATABASE_URL at load time; the detector under test needs neither.
vi.mock("../db.js", () => ({ db: { execute: async () => ({ rows: [] }) } }));
vi.mock("../observability/logger.js", () => {
  const noop = () => undefined;
  const logger: Record<string, unknown> = { warn: noop, info: noop, debug: noop, error: noop, trace: noop, fatal: noop };
  logger.child = () => logger; // modules create child loggers at import time
  return { logger, default: logger };
});
import { IGHttpError } from "../ig-http-client.js";
import { isCheckpointError } from "../services/ig-checkpoint.js";

describe("isCheckpointError", () => {
  it("detects checkpoint_required from the typed igErrorCode even with a generic message", () => {
    const err = new IGHttpError(400, "[ig-http] GET friendship_status failed with status 400", {
      igErrorCode: "checkpoint_required",
    });
    expect(isCheckpointError(err)).toBe(true);
  });

  it("detects challenge_required", () => {
    const err = new IGHttpError(400, "[ig-http] GET x failed with status 400", { igErrorCode: "challenge_required" });
    expect(isCheckpointError(err)).toBe(true);
  });

  it("does not flag a plain 400 without a checkpoint code", () => {
    expect(isCheckpointError(new IGHttpError(400, "[ig-http] GET x failed with status 400"))).toBe(false);
  });

  it("does not flag rate limits or network errors", () => {
    expect(isCheckpointError(new IGHttpError(429, "rate limited", { igErrorCode: undefined }))).toBe(false);
    expect(isCheckpointError(new Error("network error for GET friendship_status"))).toBe(false);
  });

  it("falls back to the message for wrapped/plain errors", () => {
    expect(isCheckpointError(new Error("upstream: ig-code=checkpoint_required"))).toBe(true);
    expect(isCheckpointError("challenge_required")).toBe(true);
  });
});
