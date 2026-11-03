import { defineConfig } from "vitest/config";
import { alias } from "./vitest.shared.mjs";

// Integration tests talk to a real PostgreSQL, but only to a throwaway database
// created for the run (see tests/setup/integration-global.ts).
export default defineConfig({
  resolve: { alias },
  test: {
    environment: "node",
    include: ["tests/**/*.integration.test.ts"],
    globalSetup: ["tests/setup/integration-global.ts"],
    // One shared throwaway database, so test files run one at a time.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
