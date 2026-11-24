import { expect, test } from "@playwright/test";
import { signInViaApi } from "./e2e/helpers";

const PAGES = [
  "/",
  "/register",
  "/calendar",
  "/bills",
  "/bills/new?kind=bill",
  "/accounts",
  "/accounts/balances",
  "/accounts/did-it-clear",
  "/connections",
  "/transactions",
];

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("no page scrolls sideways", async ({ page }) => {
    test.setTimeout(120_000); // visits every page, which a cold dev server compiles first
    await signInViaApi(page);
    for (const path of PAGES) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.getByText("Loading…")).toHaveCount(0, { timeout: 20_000 });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, path).toBeLessThanOrEqual(0);
    }
  });

  test("the bottom bar reaches every page, the rest through More", async ({ page }) => {
    await signInViaApi(page);
    await page.goto("/register");
    const nav = page.getByRole("navigation", { name: "Main" });
    await expect(nav.getByRole("link")).toHaveText(["Home", "Register", "Calendar", "Bills"], { useInnerText: true });
    await expect(nav.getByRole("link", { name: "Register" })).toHaveAttribute("aria-current", "page");

    const more = nav.getByRole("button", { name: "More" });
    await more.click();
    await expect(nav.getByRole("button", { name: "Sign out" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(nav.getByRole("link", { name: "Accounts" })).toHaveCount(0);
    await expect(more).toBeFocused();

    await more.click();
    await nav.getByRole("link", { name: "Accounts" }).click();
    await expect(page).toHaveURL(/\/accounts$/);
    await expect(nav.getByRole("link", { name: "Accounts" })).toHaveCount(0);
  });
});

test("on a desktop the sidebar shows every page and Sign out", async ({ page }) => {
  await signInViaApi(page);
  await page.goto("/accounts/balances");
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link")).toHaveText(
    ["Home", "Register", "Calendar", "Bills & income", "Accounts", "Transactions", "Connections", "Update balances"],
    { useInnerText: true },
  );
  // The more exact page is the marked one, not Accounts above it.
  await expect(nav.locator("[aria-current=page]")).toHaveText("Update balances");
  await expect(nav.getByRole("button", { name: "Sign out" })).toBeVisible();
  await expect(nav.getByRole("button", { name: "More" })).toBeHidden();
});

test("the sign-in page has no navigation", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByRole("navigation")).toHaveCount(0);
});
