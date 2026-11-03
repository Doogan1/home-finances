import { expect, test } from "@playwright/test";
import { BASE_URL, SENTINEL_CIPHERTEXT_FRAGMENT, inAppContainer, signInViaApi } from "./e2e/helpers";

// Real browser against the running app, using the synthetic bank connection that
// tests/e2e/global-setup.ts seeds for the throwaway user. Plaid is never called:
// the Connect button's request is intercepted, and "refresh" is never clicked.

test.beforeAll(() => {
  // The auth spec exhausts the shared sign-in throttle on purpose.
  inAppContainer("reset-throttle");
});

test("anonymous visitors cannot see connections or accounts", async ({ page, request }) => {
  for (const path of ["/connections", "/accounts"]) {
    const response = await request.get(path, { maxRedirects: 0 });
    expect(response.status()).toBe(307);
    await page.goto(path);
    await expect(page).toHaveURL(/\/login$/);
  }
});

test("Plaid routes refuse anonymous and cross-site callers", async ({ page, request }) => {
  const anonymous = await request.post("/api/plaid/link-token", { headers: { origin: BASE_URL }, data: {} });
  expect(anonymous.status()).toBe(401);

  await signInViaApi(page);
  const crossSite = await page.request.post("/api/plaid/link-token", {
    headers: { origin: "https://evil.example" },
    data: {},
  });
  expect(crossSite.status()).toBe(403);

  // Another household's (or a made-up) connection is simply "not found".
  const foreign = await page.request.post(`/api/plaid/connections/${crypto.randomUUID()}/refresh`, {
    headers: { origin: BASE_URL },
    data: {},
  });
  expect(foreign.status()).toBe(404);
});

test("connections page shows the connection, its state and a Connect button", async ({ page }) => {
  await signInViaApi(page);
  await page.goto("/connections");

  await expect(page.getByRole("heading", { name: "Connections" })).toBeVisible();
  await expect(page.getByText("Plaid Sandbox (test data, no real bank)")).toBeVisible();
  const card = page.locator("li.card", { hasText: "First Platypus Bank (E2E)" });
  await expect(card.getByText("Connected", { exact: true })).toBeVisible();
  await expect(card.getByText("3 accounts")).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect a bank" })).toBeEnabled();
});

test("a failed attempt to start Link shows a safe message and can be retried", async ({ page }) => {
  await signInViaApi(page);
  await page.route("**/api/plaid/link-token", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "unavailable", message: "Plaid or the bank is temporarily unavailable. Try again later." }),
    }),
  );
  await page.goto("/connections");

  await page.getByRole("button", { name: "Connect a bank" }).click();

  await expect(page.getByRole("status")).toHaveText("Plaid or the bank is temporarily unavailable. Try again later.");
  await expect(page.getByRole("button", { name: "Connect a bank" })).toBeEnabled();
});

test("accounts page shows masked accounts with timestamped, honest balances", async ({ page }) => {
  await signInViaApi(page);
  await page.goto("/accounts");

  const checking = page.locator("li.card", { hasText: "E2E Checking" });
  await expect(checking.getByText("••••0000")).toBeVisible();
  await expect(checking.getByText("$110.00")).toBeVisible();
  await expect(checking.getByText("$100.00")).toBeVisible();
  await expect(checking.getByText(/As of .* UTC/)).toBeVisible();
  await expect(checking.getByText("May be out of date")).toHaveCount(0);

  // Credit cards say "owed" and show the limit; old observations are flagged.
  const card = page.locator("li.card", { hasText: "E2E Credit Card" });
  await expect(card.getByText("Owed")).toBeVisible();
  await expect(card.getByText("$410.00")).toBeVisible();
  await expect(card.getByText("$2,000.00")).toBeVisible();
  await expect(card.getByText("May be out of date")).toBeVisible();

  // An unreported figure is never shown as zero.
  const savings = page.locator("li.card", { hasText: "E2E Savings" });
  await expect(savings.getByText("$1,234.50")).toBeVisible();
  await expect(savings.getByText("Not reported")).toBeVisible();
  await expect(savings.getByText("$0.00")).toHaveCount(0);

  // Full account numbers are never stored, so none can be shown.
  await expect(page.locator("main")).not.toContainText(/\d{9,}/);
});

test("no page or API response carries token material", async ({ page }) => {
  await signInViaApi(page);
  const bodies: string[] = [];
  page.on("response", async (response) => {
    const type = response.headers()["content-type"] ?? "";
    if (/html|json|javascript|text/.test(type) && new URL(response.url()).origin === new URL(BASE_URL).origin) {
      bodies.push(await response.text().catch(() => ""));
    }
  });

  for (const path of ["/", "/connections", "/accounts"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    bodies.push(await page.content());
  }

  expect(bodies.length).toBeGreaterThan(3);
  for (const body of bodies) {
    expect(body).not.toContain(SENTINEL_CIPHERTEXT_FRAGMENT);
    expect(body).not.toMatch(/access-(sandbox|production)-/);
    expect(body).not.toMatch(/accessTokenCiphertext|syncCursor/);
  }
});
