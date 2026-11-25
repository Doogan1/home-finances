import { expect, test } from "@playwright/test";
import { inAppContainer, signInViaApi } from "./e2e/helpers";

// Matching bank transactions to a bill, in a real browser. The seed adds one of
// the person's own accounts with a bank attached and four payments to a lawn
// service; the bill itself is added here. Everything is made up.

const ZONE = "America/New_York";
const today = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const plusDays = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const shown = (iso: string) => new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`));

test("a payment is confirmed once, the rest match themselves, and a match can be undone and redone", async ({ page }) => {
  test.setTimeout(120_000); // a cold dev server compiles each page on its first visit
  const now = today();
  const seeded = inAppContainer("seed-payments", process.env.E2E_EMAIL ?? "", now).trim().split("\n").at(-1) ?? "";
  const { accountId } = JSON.parse(seeded) as { accountId: string };

  await signInViaApi(page);
  await page.goto("/");
  const headers = { origin: new URL(page.url()).origin };
  expect((await page.request.post("/api/household/time-zone", { headers, data: { timeZone: ZONE } })).ok()).toBe(true);
  // Weekly from three weeks ago: due 21, 14 and 7 days ago, today, and on.
  const created = await page.request.post("/api/rules", {
    headers,
    data: {
      kind: "BILL",
      name: "E2E Lawn care",
      amount: "60",
      schedule: { recurrence: "WEEKLY", interval: 1, anchorDate: plusDays(now, -21) },
      allocations: [{ accountId, mode: "REMAINDER" }],
    },
  });
  expect(created.status()).toBe(201);
  const { id: ruleId } = (await created.json()) as { id: string };

  // Nothing is linked until the person says so: four questions, newest first.
  await page.goto("/transactions");
  const questions = page.getByRole("list", { name: "Payments to confirm" });
  await expect(questions.getByRole("listitem")).toHaveCount(4);
  const newest = questions.getByRole("listitem").first();
  await expect(newest).toContainText(`Is this E2E Lawn care, due ${shown(plusDays(now, -7))}?`);
  await expect(newest).toContainText(`E2E Greenthumb Lawn, $58.00 out of E2E Bills Checking on ${shown(plusDays(now, -7))}`);
  await expect(questions.getByRole("listitem").last()).toContainText("from before its first date");

  // Home asks too.
  await page.goto(`/?account=${accountId}`);
  const attention = page.getByRole("region", { name: "Needs attention" });
  await expect(attention).toContainText("Is this E2E Lawn care");

  // One Yes teaches the payee; the other three then link themselves.
  await attention.getByRole("listitem").filter({ hasText: shown(plusDays(now, -7)) }).getByRole("button", { name: "Yes" }).click();
  await expect(attention).not.toContainText("Is this E2E Lawn care");
  await page.goto("/transactions");
  await expect(page.getByRole("list", { name: "Payments to confirm" })).toHaveCount(0);
  const rows = page.locator("table tr", { hasText: "E2E Greenthumb Lawn" });
  await expect(rows).toHaveCount(4);
  await expect(rows.getByRole("link", { name: "E2E Lawn care" })).toHaveCount(4);
  await expect(rows.getByText("Auto", { exact: true })).toHaveCount(3);

  // The date reads as paid, with the real amount, and cannot be edited over the match.
  await page.goto(`/occurrences/${ruleId}/${plusDays(now, -14)}`);
  await expect(page.getByText(/Paid/).first()).toBeVisible();
  await expect(page.locator(".lead")).toContainText("$62.50 (confirmed)");
  const payments = page.getByRole("region", { name: "Payments" });
  await expect(payments).toContainText(`E2E Greenthumb Lawn, $62.50 on ${shown(plusDays(now, -13))}`);
  await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);

  // Undo from there: the date goes back to an estimate, and the form returns.
  await payments.getByRole("button", { name: "Undo match" }).click();
  await expect(page.locator(".lead")).toContainText("$60.00 (estimate)");
  await expect(page.getByRole("region", { name: "Payments" })).toHaveCount(0);

  // An undone match is not put back by itself or asked about again; the person rematches it by hand.
  await page.goto("/transactions");
  await expect(page.getByRole("list", { name: "Payments to confirm" })).toHaveCount(0);
  await page.locator("table tr", { hasText: shown(plusDays(now, -13)) }).getByRole("link", { name: "E2E Greenthumb Lawn" }).click();
  await expect(page.getByRole("heading", { name: "E2E Greenthumb Lawn" })).toBeVisible();
  await expect(page.locator(".lead")).toContainText("$62.50 out");
  await expect(page.getByLabel("Which due date")).toHaveValue(plusDays(now, -14));
  await page.getByRole("button", { name: "Match" }).click();
  const match = page.getByRole("region", { name: "Match" });
  await expect(match).toContainText(`Paid E2E Lawn care, due ${shown(plusDays(now, -14))}. Matched by hand.`);

  // The bill's own page shows its past, and what the payments say about its amount.
  await page.goto(`/bills/${ruleId}`);
  const past = page.getByRole("table", { name: "Past" });
  await expect(past.getByRole("row", { name: new RegExp(`^${shown(plusDays(now, -14))}`) })).toContainText("+$2.50 against $60.00");
  await expect(past.getByRole("row", { name: new RegExp(`^${shown(now)}`) })).toContainText("No payment matched (planned $60.00)");
  await expect(past.getByRole("row", { name: /^No due date/ })).toContainText("From before its first date");
  const estimate = page.getByRole("region", { name: "Estimate" });
  await expect(estimate).toContainText("Its payments are typically $63.25, the middle of its last 4 payments ($58.00 to $66.00)");

  // Home says a fixed bill's payments differ; letting it vary makes the forecast follow them.
  await page.goto(`/?account=${accountId}`);
  await expect(attention).toContainText("E2E Lawn care is planned at $60.00, but its last 4 payments were typically $63.25");
  await page.goto(`/bills/${ruleId}`);
  await estimate.getByRole("button", { name: "Let the amount vary" }).click();
  await expect(estimate).toContainText("Coming dates use $63.25");
  await expect(page.getByRole("table", { name: "Next 10" }).getByRole("row").nth(2)).toContainText("$63.25");
  await page.goto(`/?account=${accountId}`);
  await expect(attention).not.toContainText("is planned at");
  await expect(page.getByRole("table", { name: "Next 7 days" }).getByRole("row", { name: /E2E Lawn care/ }).first()).toContainText("-$63.25");
  await page.goto("/bills");
  await expect(page.getByRole("row", { name: /E2E Lawn care/ })).toContainText("about $63.25");
});

test("the payment routes refuse anonymous callers and unknown transactions", async ({ page, request }) => {
  const id = "00000000-0000-4000-8000-000000000000";
  for (const path of ["match", "decline", "unmatch"]) {
    const anonymous = await request.post(`/api/transactions/${id}/${path}`, { data: {} });
    expect(anonymous.status(), path).toBeGreaterThanOrEqual(401);
    expect(anonymous.status(), path).toBeLessThan(404);
  }
  await signInViaApi(page);
  await page.goto("/transactions");
  const headers = { origin: new URL(page.url()).origin };
  expect((await page.request.post(`/api/transactions/${id}/unmatch`, { headers, data: {} })).status()).toBe(409);
  expect((await page.request.post(`/api/transactions/${id}/match`, { headers, data: { ruleId: id, scheduledOn: null } })).status()).toBe(404);
  expect((await page.request.post(`/api/transactions/${id}/match`, { headers, data: { ruleId: id, householdId: id } })).status()).toBe(400);
});
