import { expect, test, type Page } from "@playwright/test";
import { signInViaApi } from "./e2e/helpers";

const ZONE = "America/New_York";
const today = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const plusDays = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const shown = (iso: string) => new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`));

async function setUp(page: Page) {
  await signInViaApi(page);
  await page.goto("/");
  const headers = { origin: new URL(page.url()).origin };
  const post = (url: string, data: unknown) => page.request.post(url, { headers, data });
  expect((await post("/api/household/time-zone", { timeZone: ZONE })).ok()).toBe(true);
  const created = await post("/api/accounts", { name: "E2E Panel Spend", kind: "checking", cushion: "500" });
  expect(created.status()).toBe(201);
  const spend = ((await created.json()) as { id: string }).id;
  const now = today();
  expect((await post("/api/balances", { asOfDate: now, entries: [{ accountId: spend, balance: "1,000" }] })).ok()).toBe(true);
  const bill = async (name: string, amount: string, on: string) =>
    expect(
      (await post("/api/rules", { kind: "BILL", name, amount, schedule: { recurrence: "ONCE", anchorDate: on }, allocations: [{ accountId: spend, mode: "REMAINDER" }] })).status(),
    ).toBe(201);
  return { spend, now, bill };
}

test("Register, panel, Calendar and Home agree; Did it clear? is answered on Home and after Update balances", async ({ page }) => {
  test.setTimeout(90_000); // a cold dev server compiles each page on its first visit
  const { spend, now, bill } = await setUp(page);
  const phoneDay = plusDays(now, 3);
  await bill("E2E Panel Phone", "100", phoneDay);
  await bill("E2E Panel Old bill", "50", plusDays(now, -2));

  // The main navigation reaches the Register.
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Register" }).click();
  await expect(page).toHaveURL(/\/register$/);
  await page.goto(`/register?account=${spend}`);
  const register = page.getByRole("table", { name: "E2E Panel Spend register" });
  const phone = register.getByRole("row", { name: /E2E Panel Phone/ });
  await expect(phone).toContainText(shown(phoneDay));
  await expect(phone).toContainText("-$100.00");
  await expect(phone).toContainText("$900.00");
  await expect(phone.locator("td.estimate")).toHaveCount(1);

  // Confirm an amount in the panel: the preview shows the new low point before saving.
  await phone.getByRole("link", { name: "E2E Panel Phone" }).click();
  await expect(page).toHaveURL(new RegExp(`/occurrences/[0-9a-f-]{36}/${phoneDay}\\?back=`));
  await page.getByLabel("Confirmed amount").fill("120");
  await expect(page.getByRole("radio", { name: /^Confirmed/ })).toBeChecked();
  await expect(page.getByRole("region", { name: "Effect on the forecast" })).toContainText(
    `E2E Panel Spend: lowest $900.00 on ${shown(phoneDay)} → $880.00 on ${shown(phoneDay)}`,
  );
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL(new RegExp(`/register\\?account=${spend}$`));
  await expect(phone).toContainText("-$120.00");
  await expect(phone).toContainText("$880.00");
  await expect(phone.locator("td.estimate")).toHaveCount(0);

  // Mark it Paid.
  await phone.getByRole("link", { name: "E2E Panel Phone" }).click();
  await page.getByRole("radio", { name: /^Paid/ }).check();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(phone).toContainText("Paid");

  // The Calendar and Home show the same numbers.
  await page.goto(`/calendar?account=${spend}&month=${phoneDay.slice(0, 7)}`);
  const cell = page.locator(`td[data-date="${phoneDay}"]`);
  await expect(cell).toContainText("E2E Panel Phone");
  await expect(cell).toContainText("-$120.00");
  await expect(cell).toContainText("$880.00");
  await page.goto(`/?account=${spend}`);
  await expect(page.getByRole("region", { name: "Forecast" }).locator("figcaption")).toContainText(`Lowest $880.00 on ${shown(phoneDay)}`);

  // Did it clear? on Home: Cleared marks the old bill paid and the question goes away.
  const attention = page.getByRole("region", { name: "Needs attention" });
  const old = attention.getByRole("listitem").filter({ hasText: "Did it clear? E2E Panel Old bill" });
  await old.getByRole("button", { name: "Cleared" }).click();
  await expect(old).toHaveCount(0);

  // After Update balances, the new question is offered; Still pending moves it to tomorrow.
  await bill("E2E Panel Late bill", "75", plusDays(now, -1));
  await page.goto("/accounts/balances");
  await page.getByLabel("New balance for E2E Panel Spend").fill("950");
  await page.getByRole("button", { name: "Save balances" }).click();
  await expect(page).toHaveURL(/\/accounts\/did-it-clear$/, { timeout: 20_000 }); // the first visit compiles the page on a cold dev server
  const late = page.getByRole("list", { name: "Did it clear?" }).getByRole("listitem").filter({ hasText: "E2E Panel Late bill" });
  await late.getByRole("button", { name: "Still pending" }).click();
  await expect(late).toHaveCount(0);

  await page.goto(`/register?account=${spend}`);
  const lateRow = register.getByRole("row", { name: /E2E Panel Late bill/ });
  await expect(lateRow).toContainText(shown(plusDays(now, 1)));
  await expect(lateRow).toContainText("$875.00");

  // Reset to rule brings back the estimate: $950 - $75 - $100.
  await register.getByRole("row", { name: /E2E Panel Phone/ }).getByRole("link", { name: "E2E Panel Phone" }).click();
  await page.getByRole("button", { name: "Reset to rule" }).click();
  await expect(page).toHaveURL(new RegExp(`/register\\?account=${spend}$`));
  await expect(phone).toContainText("-$100.00");
  await expect(phone).toContainText("$775.00");
});
