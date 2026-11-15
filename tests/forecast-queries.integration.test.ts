import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { buildForecast } from "@/features/forecast/engine";
import { loadForecastInput } from "@/features/forecast/queries";
import { createRuleInput } from "@/features/rules/input";
import { archiveRule, createRule } from "@/features/rules/service";
import { seedPerson } from "./helpers/plaid-fixtures";
import { createTestClient, truncateAll } from "./helpers/test-db";

const { ownerUrl, appUrl } = inject("testDatabase");
const NY = "America/New_York";
const TODAY = "2026-11-14";
const d = (iso: string) => new Date(`${iso}T00:00:00Z`);

let owner: PrismaClient;
let app: PrismaClient;
let householdId: string;
let spend: string;
let card: string;

beforeAll(() => {
  owner = createTestClient(ownerUrl);
  app = createTestClient(appUrl);
});
afterAll(async () => {
  await owner.$disconnect();
  await app.$disconnect();
});

async function account(name: string, patch: Record<string, unknown> = {}, home: string = householdId) {
  const created = await owner.account.create({
    data: { householdId: home, name, type: "depository", subtype: "checking", currency: "USD", ...patch },
  });
  return created.id;
}
const manual = (accountId: string, asOf: string, observedAt: string, current: string) =>
  owner.balanceSnapshot.create({
    data: { accountId, asOfDate: d(asOf), observedAt: new Date(observedAt), current, currency: "USD", source: "MANUAL" },
  });
const fromBank = (accountId: string, observedAt: string, current: string | null) =>
  owner.balanceSnapshot.create({
    data: { accountId, observedAt: new Date(observedAt), current, currency: "USD", source: "ACCOUNTS_GET" },
  });
const mortgage = (accountId: string, name = "Mortgage") =>
  createRuleInput.parse({
    kind: "BILL",
    name,
    amount: "1840.91",
    schedule: { recurrence: "MONTHLY", interval: 1, anchorDate: "2026-12-01", dayOfMonth: 1 },
    allocations: [{ accountId, mode: "REMAINDER" }],
  });
const load = (environment: "SANDBOX" | "PRODUCTION" = "SANDBOX") =>
  loadForecastInput(app, householdId, { environment, timeZone: NY, today: TODAY });

beforeEach(async () => {
  await truncateAll(owner);
  ({ householdId } = await seedPerson(owner, "owner@example.test"));
  spend = await account("Ally Spend", { cushion: "1500" });
  card = await account("Amex", { type: "credit", subtype: "credit card", includeInForecast: false });
});

describe("loadForecastInput", () => {
  it("reads the household's accounts, latest balances, running rules and their edits", async () => {
    await manual(spend, "2026-11-14", "2026-11-14T15:00:00Z", "2000");
    await manual(spend, "2026-11-10", "2026-11-14T16:00:00Z", "1000"); // typed later, for an earlier date
    const { id: mortgageId } = await createRule(app, householdId, mortgage(spend));
    const { id: gymId } = await createRule(app, householdId, mortgage(spend, "Old gym"));
    await owner.occurrenceOverride.create({ data: { householdId, ruleId: mortgageId, scheduledOn: d("2026-12-01"), confirmedAmount: "1900" } });
    await owner.occurrenceOverride.create({ data: { householdId, ruleId: gymId, scheduledOn: d("2026-12-01"), status: "SKIPPED" } });
    await archiveRule(app, householdId, gymId);

    const input = await load();
    expect(input.today).toBe(TODAY);
    expect(input.days).toBe(90);
    expect(input.accounts.map((a) => [a.name, a.type, a.cushion, a.includeInForecast, a.archived, a.active])).toEqual([
      ["Ally Spend", "depository", "1500", true, false, true],
      ["Amex", "credit", null, false, false, true],
    ]);
    expect(input.snapshots.get(spend)).toMatchObject({ date: "2026-11-14", balance: "2000" });
    expect(input.snapshots.has(card)).toBe(false);
    // Archived rules, and their edits, are left out.
    expect(input.rules.map((r) => r.name)).toEqual(["Mortgage"]);
    expect(input.overrides).toEqual([
      { ruleId: mortgageId, scheduledOn: "2026-12-01", status: "PLANNED", confirmedAmount: "1900", movedTo: null },
    ]);
  });

  it("picks the latest balance across both kinds, ignoring balances the bank did not report", async () => {
    const item = await owner.plaidItem.create({
      data: { householdId, environment: "SANDBOX", plaidItemId: "item_forecast", status: "ACTIVE" },
    });
    const bank = await account("Bank checking", { plaidItemId: item.id, externalAccountId: "ext_1" });
    await fromBank(bank, "2026-11-13T15:00:00Z", "5");
    await manual(bank, "2026-11-14", "2026-11-14T20:00:00Z", "10");
    await fromBank(bank, "2026-11-15T03:00:00Z", "20"); // still Nov 14 in New York, and observed last
    await fromBank(bank, "2026-11-15T04:00:00Z", null); // not reported, which is never a zero

    const input = await load();
    expect(input.snapshots.get(bank)).toMatchObject({ date: "2026-11-14", balance: "20" });
  });

  it("leaves out other households and connections in the other Plaid environment", async () => {
    const other = await seedPerson(owner, "other@example.test");
    const theirs = await account("Their checking", {}, other.householdId);
    await manual(theirs, "2026-11-14", "2026-11-14T15:00:00Z", "99");
    const { id: theirRule } = await createRule(app, other.householdId, mortgage(theirs, "Their mortgage"));
    await owner.occurrenceOverride.create({
      data: { householdId: other.householdId, ruleId: theirRule, scheduledOn: d("2026-12-01"), confirmedAmount: "1900" },
    });
    const live = await owner.plaidItem.create({
      data: { householdId, environment: "PRODUCTION", plaidItemId: "item_live", status: "ACTIVE" },
    });
    const liveChecking = await account("Live checking", { plaidItemId: live.id, externalAccountId: "ext_live" });
    await fromBank(liveChecking, "2026-11-14T15:00:00Z", "50");

    const sandbox = await load("SANDBOX");
    expect(sandbox.accounts.map((a) => a.name)).toEqual(["Ally Spend", "Amex"]);
    expect([...sandbox.snapshots.keys()]).toEqual([]);
    expect(sandbox.rules).toEqual([]);
    expect(sandbox.overrides).toEqual([]);

    const production = await load("PRODUCTION");
    expect(production.accounts.map((a) => a.name)).toEqual(["Ally Spend", "Amex", "Live checking"]);
    expect(production.snapshots.get(liveChecking)?.balance).toBe("50");
  });

  it("feeds the engine", async () => {
    await manual(spend, "2026-11-14", "2026-11-14T15:00:00Z", "2000");
    const { id } = await createRule(app, householdId, mortgage(spend));
    await owner.occurrenceOverride.create({ data: { householdId, ruleId: id, scheduledOn: d("2026-12-01"), confirmedAmount: "1900" } });

    const forecast = buildForecast(await load());
    const series = forecast.accounts[0];
    if (series.kind !== "forecast") throw new Error("Ally Spend should have a series");
    expect(series.days.find((day) => day.date === "2026-12-01")?.closing).toBe(10000n);
    expect(series.days.find((day) => day.date === "2027-01-01")?.closing).toBe(10000n - 184091n);
  });
});
