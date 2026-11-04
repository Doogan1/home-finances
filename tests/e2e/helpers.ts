import { execFileSync } from "node:child_process";
import path from "node:path";
import type { Page } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");
export const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

/** Run the e2e-user script inside the app container (the only thing that can reach the database). */
export function inAppContainer(...args: string[]): string {
  return execFileSync(
    "docker",
    ["compose", "exec", "-T", "app", "npx", "tsx", "scripts/e2e-user.mts", ...args],
    { cwd: repoRoot, encoding: "utf8" },
  );
}

/** Planted in the seeded connection's stored token; it must never appear in a browser. */
export const SENTINEL_CIPHERTEXT_FRAGMENT = "E2E-SENTINEL-CIPHERTEXT";

// Sign-in is limited to 5 attempts a minute for the whole app, so the tests sign
// in once and every later test starts from that same session, as a person who
// stays signed in would.
let savedSession: Awaited<ReturnType<ReturnType<Page["context"]>["cookies"]>> | null = null;

/** Gives the page's browser context a signed-in session (signing in through the API the first time). */
export async function signInViaApi(page: Page): Promise<void> {
  if (savedSession) {
    await page.context().addCookies(savedSession);
    return;
  }
  const response = await page.request.post("/api/auth/sign-in/email", {
    headers: { origin: BASE_URL },
    data: { email: process.env.E2E_EMAIL, password: process.env.E2E_PASSWORD },
  });
  if (!response.ok()) throw new Error(`E2E sign-in failed with status ${response.status()}`);
  savedSession = await page.context().cookies();
}
