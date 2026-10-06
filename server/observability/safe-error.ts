/** Error messages, stacks and Drizzle causes can embed SQL parameters or URLs.
 * Keep a bounded diagnostic code; never serialize the original exception. */
export function safeError(error: unknown): { type: string; code?: string } {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return {
    type: "Error",
    ...(typeof code === "string" && /^(?:[0-9A-Z]{5}|E[A-Z_]{2,24})$/.test(code) ? { code } : {}),
  };
}
