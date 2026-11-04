import { expect, test, type APIResponse } from "@playwright/test";
import { BASE_URL, inAppContainer, signInViaApi } from "./e2e/helpers";

// What the browser actually receives. Run against the dev server by default and,
// via `npm run verify:image`, against the production image, where caching
// behaviour differs and matters most.

test.beforeAll(() => {
  inAppContainer("reset-throttle");
});

const PRIVATE_PAGES = ["/", "/connections", "/accounts", "/transactions"];

function shared(response: APIResponse): string {
  return response.headers()["cache-control"] ?? "";
}

/** A response a shared cache (proxy, CDN) would be allowed to store and hand to someone else. */
function sharedCacheable(response: APIResponse): boolean {
  const cache = shared(response).toLowerCase();
  if (/no-store|private/.test(cache)) return false;
  return /public|s-maxage|max-age=[1-9]/.test(cache);
}

test("pages that show household data are never storable by a shared cache", async ({ page }) => {
  await signInViaApi(page);

  for (const path of PRIVATE_PAGES) {
    const response = await page.request.get(path);
    expect(response.status(), path).toBe(200);
    expect(sharedCacheable(response), `${path}: Cache-Control was "${shared(response)}"`).toBe(false);
  }
});

test("a redirect to the login page is not storable either", async ({ request }) => {
  for (const path of PRIVATE_PAGES) {
    const response = await request.get(path, { maxRedirects: 0 });
    expect(response.status(), path).toBe(307);
    expect(sharedCacheable(response), `${path}: Cache-Control was "${shared(response)}"`).toBe(false);
  }
});

test("household data never appears in a page a signed-out visitor can fetch", async ({ request }) => {
  for (const path of ["/login", ...PRIVATE_PAGES]) {
    const response = await request.get(path);
    const text = await response.text();

    expect(text, path).not.toMatch(/E2E (Checking|Savings|Credit Card)|First Platypus Bank \(E2E\)|e2e\.[a-f0-9]{12}@example\.test/);
  }
});

test("API responses that carry session or household data forbid caching", async ({ page }) => {
  await signInViaApi(page);

  const session = await page.request.get("/api/auth/get-session");
  expect(session.status()).toBe(200);
  expect(shared(session)).toContain("no-store");

  const refused = await page.request.post("/api/plaid/link-token", { headers: { origin: "https://evil.example" }, data: {} });
  expect(refused.status()).toBe(403);
  expect(shared(refused)).toContain("no-store");

  const unknown = await page.request.post(`/api/plaid/connections/${crypto.randomUUID()}/sync`, { headers: { origin: BASE_URL }, data: {} });
  expect(unknown.status()).toBe(404);
  expect(shared(unknown)).toContain("no-store");
});

test("every page carries basic browser hardening headers", async ({ page, request }) => {
  await signInViaApi(page);

  for (const [label, response] of [
    ["/login", await request.get("/login")],
    ["/connections", await page.request.get("/connections")],
    ["/api/health", await request.get("/api/health")],
  ] as const) {
    const headers = response.headers();
    expect(headers["x-content-type-options"], label).toBe("nosniff");
    expect(headers["x-frame-options"], label).toBe("DENY");
    expect(headers["referrer-policy"], label).toBeTruthy();
  }
});

test("the OAuth return page sends no Referer at all", async ({ page }) => {
  await signInViaApi(page);

  const response = await page.request.get("/plaid/oauth?oauth_state_id=synthetic");

  expect(response.headers()["referrer-policy"]).toBe("no-referrer");
});

test("the health check reveals nothing about configuration", async ({ request }) => {
  const response = await request.get("/api/health");
  const text = await response.text();

  expect(JSON.parse(text)).toEqual({ status: "ok" });
  expect(text).not.toMatch(/postgres|secret|key|plaid|token/i);
  expect(shared(response)).toContain("no-store");
});
