import { expect, test } from "@playwright/test";
import { BASE_URL } from "./e2e/helpers";

// Real browser, real app, real database. The user is a throwaway created by
// tests/e2e/global-setup.ts. Sign-in attempts share one throttle counter
// (5 per minute), so the order below matters and the throttle test runs last.

test.describe.configure({ mode: "serial" });

const email = () => process.env.E2E_EMAIL!;
const password = () => process.env.E2E_PASSWORD!;

test("an anonymous visitor is redirected to the login page", async ({ page, request }) => {
  const response = await request.get("/", { maxRedirects: 0 });
  expect(response.status()).toBe(307);
  // The header may be absolute or relative; resolve it either way.
  expect(new URL(response.headers()["location"], BASE_URL).pathname).toBe("/login");

  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});

test("direct requests without a session get nothing", async ({ request }) => {
  const session = await request.get("/api/auth/get-session");
  expect(session.status()).toBe(200);
  expect(await session.json()).toBeNull();

  // Registration is closed even for a well-formed same-origin request.
  const signUp = await request.post("/api/auth/sign-up/email", {
    headers: { origin: BASE_URL },
    data: { email: "intruder@example.test", password: "correct horse battery staple", name: "Intruder" },
  });
  expect(signUp.ok()).toBe(false);

  // A sign-in attempt that claims to come from another website is refused
  // outright, even with the right credentials (no login CSRF).
  const crossOrigin = await request.post("/api/auth/sign-in/email", {
    headers: { origin: "https://evil.example" },
    data: { email: email(), password: password() },
  });
  expect(crossOrigin.status()).toBe(403);
  expect(crossOrigin.headers()["set-cookie"]).toBeUndefined();
});

test("a wrong password shows one generic error and signs nobody in", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email());
  await page.getByLabel("Password").fill("definitely not the password");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.locator("form").getByRole("alert")).toHaveText("That email and password did not work.");
  await expect(page).toHaveURL(/\/login$/);
});

test("sign in, stay signed in across a reload, then sign out and lose access", async ({ page, context }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email());
  await page.getByLabel("Password").fill(password());
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText("E2E Tester")).toBeVisible();
  await expect(page.getByText(/E2E test household/)).toBeVisible();

  // The session cookie is HttpOnly (invisible to page scripts) and not Secure
  // on loopback http.
  const [sessionCookie] = (await context.cookies()).filter((c) => c.name.includes("session_token"));
  expect(sessionCookie.httpOnly).toBe(true);
  expect(sessionCookie.sameSite).toBe("Lax");
  expect(await page.evaluate(() => document.cookie)).not.toContain("session_token");

  await page.reload();
  await expect(page.getByText("E2E Tester")).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);

  // Replaying the old cookie must fail: logout revoked the session on the
  // server, not just in this browser.
  await context.addCookies([sessionCookie]);
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByText("E2E Tester")).toHaveCount(0);
});

test("repeated failures are throttled", async ({ page }) => {
  await page.goto("/login");
  for (let attempt = 0; attempt < 6; attempt++) {
    await page.getByLabel("Email").fill(email());
    await page.getByLabel("Password").fill(`wrong password ${attempt}`);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.locator("form").getByRole("alert")).toBeVisible();
  }

  await expect(page.locator("form").getByRole("alert")).toContainText("Too many sign-in attempts");

  // Even the right password is refused while throttled.
  await page.getByLabel("Password").fill(password());
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator("form").getByRole("alert")).toContainText("Too many sign-in attempts");
  await expect(page).toHaveURL(/\/login$/);
});

test.describe("before the page's JavaScript has loaded", () => {
  // A form submitted before hydration (slow dev server, blocked script) falls
  // back to the browser's native behaviour. That must never put credentials in
  // the URL, where they would reach history, logs and Referer headers.
  test.use({ javaScriptEnabled: false });

  test("submitting the login form never puts credentials in the URL", async ({ page }) => {
    const requestedUrls: string[] = [];
    page.on("request", (request) => requestedUrls.push(request.url()));

    await page.goto("/login");
    await page.getByLabel("Email").fill(email());
    await page.getByLabel("Password").fill(password());
    await Promise.all([
      page.waitForEvent("framenavigated"),
      page.locator("form").evaluate((form: HTMLFormElement) => form.requestSubmit()),
    ]);
    await page.waitForLoadState("load");

    const leaked = [page.url(), ...requestedUrls].filter(
      (url) => url.includes(encodeURIComponent(password())) || url.includes("password="),
    );
    expect(leaked).toEqual([]);
    expect(await page.locator("form").getAttribute("method")).toBe("post");
    await expect(page.getByRole("button", { name: /sign in/i })).toBeDisabled();
  });
});
