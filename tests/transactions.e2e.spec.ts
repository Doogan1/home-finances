import { expect, test } from "@playwright/test";
import { BASE_URL, SENTINEL_CIPHERTEXT_FRAGMENT, inAppContainer, signInViaApi } from "./e2e/helpers";

// The Transactions page and the Sync button in a real browser, against the
// synthetic data seeded by global-setup (a finished sync and five transactions,
// one of them removed). Nothing here reaches Plaid: the seeded stored token is
// not decryptable, so pressing "Sync now" is refused by the server before any
// provider call, which is exactly what we want to see handled.

test.beforeAll(() => {
  inAppContainer("reset-throttle");
});

test("anonymous visitors are sent to sign in", async ({ page, request }) => {
  const response = await request.get("/transactions", { maxRedirects: 0 });
  expect(response.status()).toBe(307);
  await page.goto("/transactions");
  await expect(page).toHaveURL(/\/login$/);
});

test("shows live transactions with direction, pending state and no removed ones", async ({ page }) => {
  await signInViaApi(page);
  await page.goto("/transactions");
  const table = page.locator("table");

  await expect(table.getByText("E2E Grocery Store")).toBeVisible();
  const grocery = table.locator("tr", { hasText: "E2E Grocery Store" });
  await expect(grocery.getByText("$82.17")).toBeVisible();
  await expect(grocery.getByText("out", { exact: true })).toBeVisible();
  await expect(grocery.getByText("E2E Checking ••••0000")).toBeVisible();

  // Money arriving: stored negative (Plaid's convention), displayed as "in".
  const payroll = table.locator("tr", { hasText: "E2E Payroll Deposit" });
  await expect(payroll.getByText("$2,500.00")).toBeVisible();
  await expect(payroll.getByText("in", { exact: true })).toBeVisible();
  await expect(table.locator("tr", { hasText: "E2E Store Refund" }).getByText("in", { exact: true })).toBeVisible();

  await expect(table.locator("tr", { hasText: "E2E Coffee Shop" }).getByText("Pending")).toBeVisible();
  await expect(table.getByText("E2E Removed Charge")).toHaveCount(0);
  await expect(page.getByText(/Plaid reports|as the bank reports them/)).toBeVisible();
});

test("shows each bank's sync state in plain words", async ({ page }) => {
  await signInViaApi(page);
  await page.goto("/transactions");

  const main = page.locator("li.card", { hasText: "First Platypus Bank (E2E)" });
  await expect(main.getByText("Up to date")).toBeVisible();
  await expect(main.getByText(/Last sync 2 h ago \(4 new, 0 changed, 0 removed\)/)).toBeVisible();
  await expect(main.getByRole("button", { name: "Sync now" })).toBeEnabled();

  // A bank that needs a new sign-in cannot be synced, and says how to fix it.
  const reauth = page.locator("li.card", { hasText: "E2E Needs Sign-in Bank" });
  await expect(reauth.getByText("Sign-in needed")).toBeVisible();
  await expect(reauth.getByRole("button", { name: "Sync now" })).toHaveCount(0);
  await expect(reauth.getByRole("link", { name: "Reconnect on Connections" })).toBeVisible();

  // Disconnected banks are not offered for syncing at all.
  await expect(page.locator("li.card", { hasText: "E2E Closed Bank" })).toHaveCount(0);
});

test("Sync now reports a refusal safely instead of hanging, and can be pressed again", async ({ page }) => {
  await signInViaApi(page);
  await page.goto("/transactions");
  const main = page.locator("li.card", { hasText: "First Platypus Bank (E2E)" });

  await main.getByRole("button", { name: "Sync now" }).click();

  // The seeded token cannot be decrypted, so the server stops before calling Plaid.
  await expect(main.getByRole("status")).toContainText("stored connection key can no longer be read");
  await expect(main.getByRole("button", { name: "Sync now" })).toBeEnabled();
});

test("Sync now shows the outcome the server reports", async ({ page }) => {
  await signInViaApi(page);
  await page.route("**/api/plaid/connections/*/sync", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        runId: "r", status: "SUCCEEDED", added: 3, modified: 1, removed: 0,
        completedAt: new Date().toISOString(), errorCode: null, providerStatus: "HISTORICAL_UPDATE_COMPLETE",
      }),
    }),
  );
  await page.goto("/transactions");
  const main = page.locator("li.card", { hasText: "First Platypus Bank (E2E)" });

  await main.getByRole("button", { name: "Sync now" }).click();
  await expect(main.getByRole("status")).toHaveText("Synced: 3 new, 1 changed, 0 removed.");

  await page.unroute("**/api/plaid/connections/*/sync");
  await page.route("**/api/plaid/connections/*/sync", (route) =>
    route.fulfill({
      status: 429,
      contentType: "application/json",
      headers: { "retry-after": "42" },
      body: JSON.stringify({ error: "sync_throttled", message: "Synced very recently. Wait a little before syncing again.", retryAfterSeconds: 42 }),
    }),
  );
  await main.getByRole("button", { name: "Sync now" }).click();
  await expect(main.getByRole("status")).toHaveText("Synced very recently. Wait a little before syncing again.");
});

test("the sync route refuses anonymous, cross-site and unknown callers", async ({ page, request }) => {
  const id = crypto.randomUUID();
  const anonymous = await request.post(`/api/plaid/connections/${id}/sync`, { headers: { origin: BASE_URL }, data: {} });
  expect(anonymous.status()).toBe(401);

  await signInViaApi(page);
  const crossSite = await page.request.post(`/api/plaid/connections/${id}/sync`, {
    headers: { origin: "https://evil.example" },
    data: {},
  });
  expect(crossSite.status()).toBe(403);
  const unknown = await page.request.post(`/api/plaid/connections/${id}/sync`, {
    headers: { origin: BASE_URL },
    data: {},
  });
  expect(unknown.status()).toBe(404);
});

test("the Transactions page carries no token or cursor material", async ({ page }) => {
  await signInViaApi(page);
  const bodies: string[] = [];
  page.on("response", async (response) => {
    const type = response.headers()["content-type"] ?? "";
    if (/html|json|javascript|text/.test(type) && new URL(response.url()).origin === new URL(BASE_URL).origin) {
      bodies.push(await response.text().catch(() => ""));
    }
  });

  await page.goto("/transactions");
  await page.waitForLoadState("networkidle");
  bodies.push(await page.content());

  for (const body of bodies) {
    expect(body).not.toContain(SENTINEL_CIPHERTEXT_FRAGMENT);
    expect(body).not.toMatch(/access-(sandbox|production)-/);
    expect(body).not.toMatch(/accessTokenCiphertext|syncCursor|syncLeaseToken/);
  }
});
