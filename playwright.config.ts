import { defineConfig, devices } from "@playwright/test";

/**
 * Browser tests run from the host against the app that `docker compose up`
 * publishes on http://localhost:3000. They create a labelled throwaway user in
 * the development database (via the app container) and delete it afterwards.
 * Run them with `npm run test:e2e` while the stack is up.
 */
export default defineConfig({
  testDir: "tests",
  testMatch: "**/*.e2e.spec.ts",
  globalSetup: "./tests/e2e/global-setup.ts",
  // One shared user and one shared sign-in throttle: run in order, one at a time.
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
