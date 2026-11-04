import { defineConfig } from "vitest/config";

// Tests that drive the real Docker stack from the host (backup and restore).
// They create and drop their own uniquely named throwaway databases and never
// touch the live one. Run with `npm run test:backup` while `docker compose up`
// is running.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.docker.test.ts"],
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
