import { expect, test } from "@playwright/test";
import { signInViaApi } from "./e2e/helpers";

// Runs against the throwaway E2E household (tests/e2e/global-setup.ts), which
// starts with no time zone and three synthetic Plaid connections.

test("add an account by hand, record its balance, then archive it", async ({ page }) => {
  await signInViaApi(page);
  await page.goto("/accounts");

  // No time zone yet: the page asks for one before balances can be entered.
  await page.getByLabel("Household time zone").selectOption("America/New_York");
  await page.getByRole("button", { name: "Save time zone" }).click();
  await expect(page.getByText("Time zone: America/New_York")).toBeVisible();

  await page.getByRole("button", { name: "Add an account" }).click();
  await page.getByLabel("Name", { exact: true }).fill("E2E Hand Checking");
  await page.getByLabel("Kind").selectOption("checking");
  await page.getByLabel("Owner").fill("Shared");
  await page.getByLabel("Cushion").fill("1,500");
  await page.getByRole("button", { name: "Add account" }).click();
  const card = page.locator(".card", { hasText: "E2E Hand Checking" });
  await expect(card).toContainText("Entered by hand");
  await expect(card).toContainText("Shared");
  await expect(card).toContainText("No balance recorded yet.");

  await page.getByRole("link", { name: "Update balances" }).first().click();
  await expect(page).toHaveURL(/\/accounts\/balances$/);
  // Plaid-linked accounts are not offered here.
  await expect(page.getByText("E2E Checking", { exact: true })).toHaveCount(0);
  await page.getByLabel("New balance for E2E Hand Checking").fill("2,431.07");
  await page.getByRole("button", { name: "Save balances" }).click();

  await expect(page).toHaveURL(/\/accounts$/);
  await expect(card).toContainText("$2,431.07");
  await expect(card).toContainText("As of");

  page.once("dialog", (dialog) => void dialog.accept());
  await card.getByRole("button", { name: "Archive" }).click();
  await expect(card).toContainText("Archived");
  await page.goto("/accounts/balances");
  await expect(page.getByLabel("New balance for E2E Hand Checking")).toHaveCount(0);
});

test("an unreadable amount and a future date are refused with a message", async ({ page }) => {
  await signInViaApi(page);
  await page.goto("/accounts/balances");
  const origin = { origin: new URL(page.url()).origin };
  // The previous test (same household) set the time zone and archived its
  // account, so add a fresh one through the API to keep this test independent.
  const created = await page.request.post("/api/accounts", { headers: origin, data: { name: "E2E Hand Savings", kind: "savings" } });
  expect(created.status()).toBe(201);
  const { id } = (await created.json()) as { id: string };
  await page.reload();

  await page.getByLabel("New balance for E2E Hand Savings").fill("12.345");
  await page.getByRole("button", { name: "Save balances" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "E2E Hand Savings" })).toBeVisible();

  // The date field's `max` stops the browser from sending a future date, so
  // the server's own refusal is checked directly.
  const future = await page.request.post("/api/balances", {
    headers: origin,
    data: { asOfDate: "2999-01-01", entries: [{ accountId: id, balance: "10" }] },
  });
  expect(future.status()).toBe(400);
  expect(((await future.json()) as { message: string }).message).toBe("That date is in the future.");
});
