import { expect, test, type Page } from "@playwright/test";
import { signInViaApi } from "./e2e/helpers";

// Runs after accounts.e2e.spec.ts in the same throwaway household (workers: 1,
// files in name order). Dates are in 2030 so "what's next" is the same
// whenever the tests run.

async function setUp(page: Page) {
  await signInViaApi(page);
  await page.goto("/bills");
  const origin = { origin: new URL(page.url()).origin };
  const zone = await page.request.post("/api/household/time-zone", { headers: origin, data: { timeZone: "America/New_York" } });
  expect(zone.ok()).toBe(true);
  return origin;
}

async function handAccount(page: Page, origin: { origin: string }, name: string, kind: string) {
  const created = await page.request.post("/api/accounts", { headers: origin, data: { name, kind } });
  expect(created.status()).toBe(201);
  return ((await created.json()) as { id: string }).id;
}

test("add an income with a split and a bill, and see them on Bills & income", async ({ page }) => {
  const origin = await setUp(page);
  await handAccount(page, origin, "E2E Rules Spend", "checking");
  await handAccount(page, origin, "E2E Rules Savings", "savings");
  await page.reload();

  await page.getByRole("link", { name: "+ Add income" }).click();
  await expect(page.getByRole("heading", { name: "Add income" })).toBeVisible();
  await page.getByLabel("Name", { exact: true }).fill("E2E Paycheck");
  await page.getByLabel("Amount", { exact: true }).fill("1,926.94");
  await page.getByLabel("Repeats").selectOption("WEEKLY");
  await page.getByLabel("First date", { exact: true }).fill("2030-01-04");
  await page.getByLabel("Account 1").selectOption({ label: "E2E Rules Spend" });
  await page.getByLabel("Share 1").selectOption("PERCENT");
  await page.getByLabel("Value 1").fill("70");
  await page.getByRole("button", { name: "Add an account" }).click();
  await page.getByLabel("Account 2").selectOption({ label: "E2E Rules Savings" });
  await page.getByLabel("Share 2").selectOption("REMAINDER");
  await page.getByRole("button", { name: "Add income" }).click();
  await expect(page).toHaveURL(/\/bills\/[0-9a-f-]{36}$/);

  // The server's refusals reach the form.
  await page.goto("/bills/new?kind=income");
  await page.getByLabel("Name", { exact: true }).fill("E2E Too much");
  await page.getByLabel("Amount", { exact: true }).fill("100");
  await page.getByLabel("First date", { exact: true }).fill("2030-01-04");
  await page.getByLabel("Account 1").selectOption({ label: "E2E Rules Spend" });
  await page.getByLabel("Share 1").selectOption("FIXED");
  await page.getByLabel("Value 1").fill("500");
  await page.getByRole("button", { name: "Add an account" }).click();
  await page.getByLabel("Account 2").selectOption({ label: "E2E Rules Savings" });
  await page.getByLabel("Share 2").selectOption("REMAINDER");
  await page.getByRole("button", { name: "Add income" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "The splits add up to more than the amount." })).toBeVisible();

  await page.goto("/bills/new?kind=bill");
  await expect(page.getByRole("heading", { name: "Add a bill" })).toBeVisible();
  await page.getByLabel("Name", { exact: true }).fill("E2E Mortgage");
  await page.getByLabel("Amount", { exact: true }).fill("1,840.91");
  await page.getByLabel("Repeats").selectOption("MONTHLY");
  await page.getByLabel("First date", { exact: true }).fill("2030-01-01");
  await page.getByLabel("Paid from").selectOption({ label: "E2E Rules Spend" });
  await page.getByRole("button", { name: "Add bill" }).click();
  await expect(page).toHaveURL(/\/bills\/[0-9a-f-]{36}$/);

  await page.goto("/bills");
  const paycheck = page.getByRole("table", { name: "Income" }).getByRole("row", { name: /E2E Paycheck/ });
  await expect(paycheck).toContainText("Every Friday");
  await expect(paycheck).toContainText("70% E2E Rules Spend · rest E2E Rules Savings");
  await expect(paycheck).toContainText("$1,926.94");
  await expect(paycheck).toContainText("$8,350.07");
  const mortgage = page.getByRole("table", { name: "Paid from checking and savings" }).getByRole("row", { name: /E2E Mortgage/ });
  await expect(mortgage).toContainText("Monthly, 1st");
  await expect(mortgage).toContainText("$1,840.91");
  await expect(page.getByRole("row", { name: /E2E Too much/ })).toHaveCount(0);
});

test("change an income from a date, stop it, undo the stop, then archive it", async ({ page }) => {
  const origin = await setUp(page);
  const spend = await handAccount(page, origin, "E2E Change Spend", "checking");
  const savings = await handAccount(page, origin, "E2E Change Savings", "savings");
  const created = await page.request.post("/api/rules", {
    headers: origin,
    data: {
      kind: "INCOME",
      name: "E2E Salary",
      amount: "1,926.94",
      schedule: { recurrence: "WEEKLY", interval: 1, anchorDate: "2030-01-04" },
      allocations: [
        { accountId: spend, mode: "PERCENT", value: "70" },
        { accountId: savings, mode: "REMAINDER" },
      ],
    },
  });
  expect(created.status()).toBe(201);
  const { id } = (await created.json()) as { id: string };
  await page.goto(`/bills/${id}`);

  await expect(page.getByRole("heading", { name: "E2E Salary" })).toBeVisible();
  const versions = page.getByRole("list", { name: "Versions" });
  await expect(versions).toContainText("Jan 4, 2030 → (no end)");
  await expect(versions).toContainText("$1,926.94 · Every Friday · 70% E2E Change Spend · rest E2E Change Savings");
  const first = page.getByRole("table", { name: "Next 10" }).getByRole("row").nth(1);
  await expect(first).toContainText("Jan 4, 2030");
  await expect(first).toContainText("E2E Change Spend $1,348.86");
  await expect(first).toContainText("Planned");

  await page.getByRole("button", { name: "Change from…" }).click();
  await page.getByLabel("Starting").fill("2030-02-01");
  await page.getByLabel("Amount", { exact: true }).fill("1,826.94");
  await expect(page.getByText("E2E Change Spend gets $70.00 less each time.")).toBeVisible();
  await page.getByRole("button", { name: "Save change" }).click();
  await expect(versions).toContainText("Jan 4, 2030 → Jan 31, 2030");
  await expect(versions).toContainText("Feb 1, 2030 → (no end)");

  await page.getByRole("button", { name: "Stop on…" }).click();
  await page.getByLabel("Stop on").fill("2030-03-01");
  await expect(page.getByText("Last date: Mar 1, 2030")).toBeVisible();
  await page.getByRole("button", { name: "Save stop date" }).click();
  await expect(versions).toContainText("Feb 1, 2030 → Mar 1, 2030");

  // A mistaken stop is undone by clearing the latest version's end.
  await page.getByRole("button", { name: "Edit this version" }).last().click();
  await page.getByLabel("Ends on").fill("");
  await page.getByRole("button", { name: "Save version" }).click();
  await expect(versions).toContainText("Feb 1, 2030 → (no end)");

  // While it runs, the accounts it uses can't be archived.
  const refused = await page.request.post(`/api/accounts/${spend}/archive`, { headers: origin, data: {} });
  expect(refused.status()).toBe(409);
  expect(((await refused.json()) as { message: string }).message).toContain("E2E Salary");

  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(page).toHaveURL(/\/bills$/);
  await expect(page.getByRole("link", { name: "E2E Salary" })).toHaveCount(0);
  await page.goto("/bills?show=all");
  await expect(page.getByRole("row", { name: /E2E Salary/ })).toContainText("Archived");
});
