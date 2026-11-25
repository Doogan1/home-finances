import { expect, test } from "@playwright/test";
import { signInViaApi } from "./e2e/helpers";

// Runs after connections.e2e.spec.ts in the same throwaway household (workers: 1,
// files in name order). The forecast starts from the real today, so every date
// here is worked out from it, in the household's time zone.

const ZONE = "America/New_York";
const today = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const plusDays = (iso: string, days: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const shown = (iso: string) =>
  new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`));

test("Home shows each account's forecast, what needs attention and the next 7 days", async ({ page }) => {
  await signInViaApi(page);
  await page.goto("/");
  const headers = { origin: new URL(page.url()).origin };
  const post = (url: string, data: unknown) => page.request.post(url, { headers, data });

  expect((await post("/api/household/time-zone", { timeZone: ZONE })).ok()).toBe(true);
  const create = async (data: Record<string, unknown>) => {
    const response = await post("/api/accounts", data);
    expect(response.status()).toBe(201);
    return ((await response.json()) as { id: string }).id;
  };
  const spend = await create({ name: "E2E Home Spend", kind: "checking", cushion: "1,500" });
  const savings = await create({ name: "E2E Home Savings", kind: "savings" });
  const card = await create({ name: "E2E Home Card", kind: "credit_card" });

  const now = today();
  const balances = await post("/api/balances", {
    asOfDate: now,
    entries: [
      { accountId: spend, balance: "2,000" },
      { accountId: savings, balance: "500" },
    ],
  });
  expect(balances.ok()).toBe(true);

  const rule = async (data: Record<string, unknown>) => expect((await post("/api/rules", data)).status()).toBe(201);
  // Every week from two days from now: $1,000, 70% to Spend and the rest to Savings.
  await rule({
    kind: "INCOME",
    name: "E2E Home Paycheck",
    amount: "1,000",
    schedule: { recurrence: "WEEKLY", interval: 1, anchorDate: plusDays(now, 2) },
    allocations: [
      { accountId: spend, mode: "PERCENT", value: "70" },
      { accountId: savings, mode: "REMAINDER" },
    ],
  });
  // Five days from now Spend drops to $2,000 + $700 - $2,500 = $200, below its $1,500 cushion.
  await rule({
    kind: "BILL",
    name: "E2E Home Big bill",
    amount: "2,500",
    schedule: { recurrence: "ONCE", anchorDate: plusDays(now, 5) },
    allocations: [{ accountId: spend, mode: "REMAINDER" }],
  });
  // Paid from a card, so no cash moves and it is not in the next 7 days.
  await rule({
    kind: "BILL",
    name: "E2E Home Card bill",
    amount: "50",
    schedule: { recurrence: "ONCE", anchorDate: plusDays(now, 3) },
    allocations: [{ accountId: card, mode: "REMAINDER" }],
  });

  await page.goto(`/?account=${spend}`);
  const forecast = page.getByRole("region", { name: "Forecast" });
  await expect(forecast.getByRole("img", { name: /^E2E Home Spend: end-of-day balance/ })).toBeVisible();
  await expect(forecast.locator("figcaption")).toContainText(`Lowest $200.00 on ${shown(plusDays(now, 5))}`);
  await expect(forecast.locator("figcaption")).toContainText("cushion $1,500.00");

  // The chart has a dollar scale, and a day can be read with the keyboard or by pointing.
  await expect(forecast.locator(".chart-axis")).toContainText("$2k");
  const day = forecast.getByRole("slider", { name: "Day" });
  await day.focus();
  await page.keyboard.press("ArrowRight");
  await expect(day).toHaveAttribute("aria-valuetext", `${shown(now)}: $2,000.00`);
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");
  const readout = forecast.locator(".chart-readout");
  await expect(readout).toContainText(`${shown(plusDays(now, 5))} $200.00`);
  await expect(readout).toContainText("E2E Home Big bill -$2,500.00");
  await day.click({ position: { x: 3, y: 20 } });
  await expect(readout).toContainText(`${shown(now)} $2,000.00`);

  const attention = page.getByRole("region", { name: "Needs attention" });
  await expect(attention).toContainText(`E2E Home Spend goes below its cushion on ${shown(plusDays(now, 5))}`);
  await expect(attention).toContainText("E2E Home Paycheck");

  const next = page.getByRole("table", { name: "Next 7 days" });
  const paycheck = next.getByRole("row", { name: /E2E Home Paycheck/ });
  await expect(paycheck).toContainText(shown(plusDays(now, 2)));
  await expect(paycheck).toContainText("E2E Home Spend +$700.00 · E2E Home Savings +$300.00");
  await expect(paycheck).toContainText("+$1,000.00");
  await expect(next.getByRole("row", { name: /E2E Home Big bill/ })).toContainText("-$2,500.00");
  await expect(next.getByRole("row", { name: /E2E Home Card bill/ })).toHaveCount(0);

  await forecast.getByRole("navigation", { name: "Accounts in the forecast" }).getByRole("link", { name: "E2E Home Savings" }).click();
  await expect(page).toHaveURL(new RegExp(`account=${savings}$`));
  await expect(forecast.getByRole("img", { name: /^E2E Home Savings: end-of-day balance/ })).toBeVisible();
  await expect(forecast.locator("figcaption")).toContainText(`Lowest $500.00 on ${shown(now)}`);
});
