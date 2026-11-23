import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { setHouseholdTimeZone } from "@/features/accounts/manual";
import { answerClearQuestion, openClearQuestions } from "@/features/forecast/did-it-clear";
import { buildForecast, type AccountSeries } from "@/features/forecast/engine";
import { loadForecastInput } from "@/features/forecast/queries";
import { clearAnswerInput, createRuleInput } from "@/features/rules/input";
import { createRule } from "@/features/rules/service";
import { seedPerson } from "./helpers/plaid-fixtures";
import { createTestClient, truncateAll } from "./helpers/test-db";

const { ownerUrl, appUrl } = inject("testDatabase");
const NY = "America/New_York";
const NOW = new Date("2026-11-14T17:00:00Z"); // Nov 14 in New York
const OPTIONS = { environment: "SANDBOX" as const, now: NOW };
const d = (iso: string) => new Date(`${iso}T00:00:00Z`);

let owner: PrismaClient;
let app: PrismaClient;
let householdId: string;
let userId: string;
let spend: string;
let ruleId: string;

beforeAll(() => {
  owner = createTestClient(ownerUrl);
  app = createTestClient(appUrl);
});
afterAll(async () => {
  await owner.$disconnect();
  await app.$disconnect();
});

beforeEach(async () => {
  await truncateAll(owner);
  ({ householdId, userId } = await seedPerson(owner, "owner@example.test"));
  await setHouseholdTimeZone(app, householdId, NY);
  spend = (await owner.account.create({ data: { householdId, name: "Ally Spend", type: "depository", subtype: "checking", currency: "USD" } })).id;
  await owner.balanceSnapshot.create({
    data: { accountId: spend, asOfDate: d("2026-11-14"), observedAt: NOW, current: "2000", currency: "USD", source: "MANUAL" },
  });
  ruleId = (
    await createRule(
      app,
      householdId,
      createRuleInput.parse({
        kind: "BILL",
        name: "Electric",
        amount: "400",
        schedule: { recurrence: "ONCE", anchorDate: "2026-11-10" },
        allocations: [{ accountId: spend, mode: "REMAINDER" }],
      }),
    )
  ).id;
});

const answer = (value: "cleared" | "pending", accountId = spend, home = householdId) =>
  answerClearQuestion(app, home, userId, ruleId, "2026-11-10", clearAnswerInput.parse({ accountId, answer: value }), OPTIONS);

describe("Did it clear?", () => {
  it("lists the open question for the account's balance", async () => {
    const [question, ...rest] = await openClearQuestions(app, householdId, OPTIONS);
    expect(rest).toEqual([]);
    expect(question).toMatchObject({ occurrence: { ruleId, scheduledOn: "2026-11-10" }, account: { id: spend }, snapshotDate: "2026-11-14", cents: -40000n });
  });

  it("Cleared marks it Paid, and then it is no longer a question", async () => {
    await answer("cleared");
    expect(await owner.occurrenceOverride.findFirstOrThrow({ where: { ruleId } })).toMatchObject({ status: "PAID", movedTo: null, updatedByUserId: userId });
    expect(await openClearQuestions(app, householdId, OPTIONS)).toEqual([]);
    await expect(answer("cleared")).rejects.toMatchObject({ code: "question_not_found" });
  });

  it("Still pending moves it to the day after the balance, so the forecast counts it then", async () => {
    await answer("pending");
    expect(await owner.occurrenceOverride.findFirstOrThrow({ where: { ruleId } })).toMatchObject({ status: "PLANNED", movedTo: d("2026-11-15") });

    const input = await loadForecastInput(app, householdId, { environment: "SANDBOX", timeZone: NY, today: "2026-11-14" });
    const series = buildForecast(input).accounts.find((a): a is AccountSeries => a.kind === "forecast");
    expect(series?.days.find((day) => day.date === "2026-11-15")?.closing).toBe(160000n);
  });

  it("keeps what the edit already said when the answer is Still pending", async () => {
    await owner.occurrenceOverride.create({
      data: { householdId, ruleId, scheduledOn: d("2026-11-10"), status: "CONFIRMED", confirmedAmount: "410", note: "bill came" },
    });
    await answer("pending");
    const row = await owner.occurrenceOverride.findFirstOrThrow({ where: { ruleId } });
    expect(row).toMatchObject({ status: "CONFIRMED", note: "bill came", movedTo: d("2026-11-15") });
    expect(row.confirmedAmount?.toFixed()).toBe("410");
  });

  it("answers only a question that is open: not for another account, another household, or before a time zone", async () => {
    const other = (await owner.account.create({ data: { householdId, name: "PNC", type: "depository", subtype: "checking", currency: "USD" } })).id;
    await expect(answer("cleared", other)).rejects.toMatchObject({ code: "question_not_found" });

    const outsider = await seedPerson(owner, "other@example.test");
    await expect(answer("cleared", spend, outsider.householdId)).rejects.toMatchObject({ code: "question_not_found" });
    expect(await openClearQuestions(app, outsider.householdId, OPTIONS)).toEqual([]);
    expect(await owner.occurrenceOverride.count()).toBe(0);
  });
});
