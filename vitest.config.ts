import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // BullMQ + node:http2 are incompatible with worker_threads isolation.
    // forks give us full process isolation without that constraint.
    pool: "forks",
    // Backend-wide denominator. A handful of covered Wave-4 modules must not
    // be presented as coverage of the current auth/worker/roster/billing app.
    coverage: {
      provider: "v8",
      include: [
        "server/**/*.ts",
        "shared/**/*.ts",
      ],
      exclude: ["**/__tests__/**", "**/*.test.ts", "server/scripts/**", "**/*.d.ts"],
      reporter: ["text", "lcov"],
    },
  },
});
