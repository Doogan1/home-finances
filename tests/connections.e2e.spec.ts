import { expect, test } from "@playwright/test";
import { BASE_URL, inAppContainer, signInViaApi } from "./e2e/helpers";

// Reconnect, disconnect, history deletion and the OAuth return page, in a real
// browser, against the three synthetic connections seeded by global-setup
// (connected, needs sign-in, disconnected). Nothing here reaches Plaid: the
// requests that would are intercepted, and "Yes, disconnect" is never clicked.

test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  inAppContainer("reset-throttle");
});

const card = (page: import("@playwright/test").Page, name: string) =>
  page.locator("li.card", { hasText: name });

test("a connection that needs a sign-in says so and offers Reconnect", async ({ page }) => {
  await signInViaApi(page);
  await page.goto("/connections");

  const reauth = card(page, "E2E Needs Sign-in Bank");
  await expect(reauth.getByText("Sign-in needed")).toBeVisible();
  await expect(reauth.getByText(/Use “Reconnect”/)).toBeVisible();
  await expect(reauth.getByRole("button", { name: "Reconnect" })).toBeEnabled();
  // A connection that needs a sign-in cannot be "refreshed" until it is repaired.
  await expect(reauth.getByRole("button", { name: /accounts$/ })).toHaveCount(0);
});

test("Reconnect asks the server for an update-mode token and reports a failure safely", async ({ page }) => {
  await signInViaApi(page);
  let requestedUrl = "";
  await page.route("**/api/plaid/connections/*/reconnect", (route) => {
    requestedUrl = new URL(route.request().url()).pathname;
    return route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "unavailable", message: "Plaid or the bank is temporarily unavailable. Try again later." }),
    });
  });
  await page.goto("/connections");

  await card(page, "E2E Needs Sign-in Bank").getByRole("button", { name: "Reconnect" }).click();

  await expect(card(page, "E2E Needs Sign-in Bank").getByRole("status")).toHaveText(
    /temporarily unavailable/,
  );
  expect(requestedUrl).toMatch(/^\/api\/plaid\/connections\/[0-9a-f-]{36}\/reconnect$/);
  await expect(card(page, "E2E Needs Sign-in Bank").getByRole("button", { name: "Reconnect" })).toBeEnabled();
});

test("a connected bank offers to add or change accounts without linking it again", async ({ page }) => {
  await signInViaApi(page);
  let sentBody = "";
  await page.route("**/api/plaid/connections/*/reconnect", (route) => {
    sentBody = route.request().postData() ?? "";
    return route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "unavailable", message: "Plaid or the bank is temporarily unavailable. Try again later." }),
    });
  });
  await page.goto("/connections");
  const main = card(page, "First Platypus Bank (E2E)");

  await main.getByRole("button", { name: "Add or change accounts" }).click();

  await expect(main.getByRole("status")).toHaveText(/temporarily unavailable/);
  expect(JSON.parse(sentBody)).toEqual({ selectAccounts: true });
  // Plain Reconnect does not ask for account selection.
  await main.getByRole("button", { name: "Reconnect" }).click();
  await expect.poll(() => sentBody).toBe("{}");
});

test("Disconnect explains what it does and can be cancelled without any change", async ({ page }) => {
  await signInViaApi(page);
  await page.goto("/connections");
  const main = card(page, "First Platypus Bank (E2E)");

  await main.getByRole("button", { name: "Disconnect…" }).click();

  await expect(main.getByText(/asks Plaid to remove the connection/)).toBeVisible();
  await expect(main.getByText(/stay in this app until you delete them/)).toBeVisible();
  await main.getByRole("button", { name: "Cancel" }).click();
  await expect(main.getByRole("button", { name: "Disconnect…" })).toBeVisible();
  await expect(main.getByText("Connected", { exact: true })).toBeVisible();
});

test("a disconnected bank keeps its history visible and says so", async ({ page }) => {
  await signInViaApi(page);

  await page.goto("/connections");
  const closed = card(page, "E2E Closed Bank");
  await expect(closed.getByText("Disconnected", { exact: true })).toBeVisible();
  await expect(closed.getByText(/stay here until you delete them/)).toBeVisible();
  await expect(closed.getByText("1 saved account")).toBeVisible();
  // Nothing to refresh or reconnect once disconnected.
  await expect(closed.getByRole("button", { name: "Reconnect" })).toHaveCount(0);

  await page.goto("/accounts");
  const account = card(page, "E2E Closed Account");
  await expect(account.getByText("Disconnected · history kept")).toBeVisible();
  await expect(account.getByText("$75.25").first()).toBeVisible();
});

test("deleting saved history needs its own typed confirmation", async ({ page }) => {
  await signInViaApi(page);
  await page.goto("/connections");
  const closed = card(page, "E2E Closed Bank");

  await closed.getByRole("button", { name: "Delete saved history…" }).click();
  await expect(closed.getByText(/cannot be undone/)).toBeVisible();
  const confirmButton = closed.getByRole("button", { name: "Delete permanently" });
  await expect(confirmButton).toBeDisabled();

  await closed.getByRole("textbox").fill("delete");
  await expect(confirmButton).toBeDisabled();
  await closed.getByRole("textbox").fill("DELETE");
  await expect(confirmButton).toBeEnabled();
  await confirmButton.click();

  await expect(page.locator("li.card", { hasText: "E2E Closed Bank" })).toHaveCount(0);
  // The other two connections are untouched.
  await expect(card(page, "First Platypus Bank (E2E)")).toBeVisible();
  await expect(card(page, "E2E Needs Sign-in Bank")).toBeVisible();
  await page.goto("/accounts");
  await expect(page.getByText("E2E Closed Account")).toHaveCount(0);
  await expect(page.getByText("E2E Checking")).toBeVisible();
});

test("a bank account can be attached to an account entered by hand, after a plain-language confirmation", async ({ page }) => {
  await signInViaApi(page);
  await page.goto("/connections");
  const created = await page.request.post("/api/accounts", {
    headers: { origin: new URL(page.url()).origin },
    data: { name: "E2E Attach Checking", kind: "checking", ownerLabel: "Shared" },
  });
  expect(created.status()).toBe(201);
  await page.reload();

  // No hand-entered card exists, so the bank's card has nothing to be used for.
  await expect(card(page, "First Platypus Bank (E2E)").getByLabel("Use E2E Credit Card ••••3333 for")).toHaveCount(0);

  const reauth = card(page, "E2E Needs Sign-in Bank");
  await reauth.getByLabel("Use E2E Reauth Account ••••4444 for").selectOption({ label: "E2E Attach Checking" });
  await reauth.getByRole("button", { name: "Attach…" }).click();
  await expect(reauth.getByText(/keeps its name, owner, cushion, bills and income/)).toBeVisible();
  await reauth.getByRole("button", { name: "Yes, attach" }).click();

  await expect(reauth.getByText(/attached to E2E Attach Checking/)).toBeVisible();
  await expect(reauth.getByRole("button", { name: "Attach…" })).toHaveCount(0);

  await page.goto("/accounts");
  const attached = card(page, "E2E Attach Checking");
  await expect(attached.getByText(/attached to E2E Needs Sign-in Bank/)).toBeVisible();
  await expect(attached.getByText("$50.00").first()).toBeVisible();
  await expect(page.locator("li.card", { hasText: "E2E Reauth Account" })).toHaveCount(0);

  const anonymous = await page.context().request.post(`/api/accounts/${crypto.randomUUID()}/attach`, {
    headers: { origin: "https://evil.example" },
    data: { plaidAccountId: crypto.randomUUID() },
  });
  expect(anonymous.status()).toBe(403);
});

test("lifecycle routes refuse anonymous, cross-site and malformed calls", async ({ page, request }) => {
  const id = crypto.randomUUID();
  for (const action of ["reconnect", "disconnect", "delete-history"]) {
    const anonymous = await request.post(`/api/plaid/connections/${id}/${action}`, {
      headers: { origin: BASE_URL },
      data: action === "delete-history" ? { confirm: "DELETE" } : {},
    });
    expect(anonymous.status(), `${action} anonymous`).toBe(401);
  }

  await signInViaApi(page);
  for (const action of ["reconnect", "disconnect", "delete-history"]) {
    const crossSite = await page.request.post(`/api/plaid/connections/${id}/${action}`, {
      headers: { origin: "https://evil.example" },
      data: action === "delete-history" ? { confirm: "DELETE" } : {},
    });
    expect(crossSite.status(), `${action} cross-site`).toBe(403);

    const unknown = await page.request.post(`/api/plaid/connections/${id}/${action}`, {
      headers: { origin: BASE_URL },
      data: action === "delete-history" ? { confirm: "DELETE" } : {},
    });
    expect(unknown.status(), `${action} unknown id`).toBe(404);
  }

  const resume = await page.request.post("/api/plaid/oauth/resume", {
    headers: { origin: BASE_URL },
    data: { attemptId: id },
  });
  expect(resume.status()).toBe(404);
});

test.describe("the OAuth return page", () => {
  test("is only for signed-in people", async ({ page }) => {
    await page.goto("/plaid/oauth?oauth_state_id=synthetic");

    await expect(page).toHaveURL(/\/login$/);
  });

  test("says clearly when there is no attempt to resume", async ({ page }) => {
    await signInViaApi(page);
    await page.goto("/plaid/oauth?oauth_state_id=synthetic");

    await expect(page.locator("main").getByRole("alert")).toContainText("can no longer be resumed");
    await expect(page.getByRole("link", { name: "Back to Connections" })).toBeVisible();
  });

  test("tells browsers not to send the callback address to other sites", async ({ page }) => {
    await signInViaApi(page);
    const response = await page.goto("/plaid/oauth?oauth_state_id=synthetic");

    expect(response?.headers()["referrer-policy"]).toBe("no-referrer");
  });

  test("does nothing when it is loaded inside a popup, leaving the attempt to the original window", async ({ page, context }) => {
    // Plaid's docs do not say whether desktop OAuth lands here in a popup or in the
    // main window. If it is a popup, this page must not resume the attempt itself:
    // the window that opened it is still waiting to finish it.
    await signInViaApi(page);
    const resumeRequests: string[] = [];
    context.on("request", (request) => {
      if (request.url().includes("/api/plaid/oauth/resume")) resumeRequests.push(request.url());
    });
    await context.addInitScript(() => sessionStorage.setItem("hf.plaid.attempt", "00000000-0000-4000-8000-000000000000"));
    await page.goto("/connections");

    const [popup] = await Promise.all([
      page.waitForEvent("popup"),
      page.evaluate(() => {
        window.open("/plaid/oauth?oauth_state_id=synthetic");
      }),
    ]);
    const popupErrors: string[] = [];
    popup.on("console", (message) => {
      if (message.type() === "error") popupErrors.push(message.text());
    });
    await popup.waitForLoadState("networkidle");
    // Give Plaid Link's own script time to load; initialising it here would
    // overwrite the message and clear the attempt (this happened in production).
    await popup.waitForTimeout(3000);

    await expect(popup.getByText(/can close this window/i)).toBeVisible();
    await expect(popup.getByText(/Cancelled/)).toHaveCount(0);
    expect(popupErrors.filter((text) => /initializing Plaid Link/i.test(text))).toEqual([]);
    expect(resumeRequests).toEqual([]);
    // The remembered attempt is left alone for the window that is still using it.
    expect(await popup.evaluate(() => sessionStorage.getItem("hf.plaid.attempt"))).not.toBeNull();
  });

  test("keeps waiting for its link token instead of starting Plaid Link without one", async ({ page }) => {
    await signInViaApi(page);
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.route("**/api/plaid/oauth/resume", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 4000)); // a slow server
      await route.fulfill({
        status: 410,
        contentType: "application/json",
        body: JSON.stringify({ error: "attempt_expired", message: "That connection attempt expired. Start again." }),
      });
    });
    await page.addInitScript(() => sessionStorage.setItem("hf.plaid.attempt", "00000000-0000-4000-8000-000000000000"));
    await page.goto("/plaid/oauth?oauth_state_id=synthetic");

    // Plaid Link's script loads while we wait; it must not be started with no token.
    await page.waitForTimeout(2500);
    await expect(page.getByText("Resuming your bank connection")).toBeVisible();
    await expect(page.getByText(/Cancelled/)).toHaveCount(0);
    expect(errors.filter((text) => /initializing Plaid Link/i.test(text))).toEqual([]);

    // The server's answer is then shown as it is.
    await expect(page.locator("main").getByRole("alert")).toHaveText("That connection attempt expired. Start again.");
  });

  test("reports a server refusal instead of hanging", async ({ page }) => {
    await signInViaApi(page);
    await page.route("**/api/plaid/oauth/resume", (route) =>
      route.fulfill({
        status: 410,
        contentType: "application/json",
        body: JSON.stringify({ error: "attempt_expired", message: "That connection attempt expired. Start again." }),
      }),
    );
    // Simulates what Link's pre-redirect step leaves behind.
    await page.addInitScript(() => sessionStorage.setItem("hf.plaid.attempt", "00000000-0000-4000-8000-000000000000"));

    await page.goto("/plaid/oauth?oauth_state_id=synthetic");

    await expect(page.locator("main").getByRole("alert")).toHaveText("That connection attempt expired. Start again.");
  });
});
