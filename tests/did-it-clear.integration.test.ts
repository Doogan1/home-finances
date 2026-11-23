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

  it("refuses Still pending once it was answered Cleared, leaving the row as it was", async () => {
    await answer("cleared");
    await expect(answer("pending")).rejects.toMatchObject({ code: "question_not_found" });
    expect(await owner.occurrenceOverride.findFirstOrThrow({ where: { ruleId } })).toMatchObject({ status: "PAID", movedTo: null });
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
  it("refuses Still pending when the day after the balance is more than 62 days from the scheduled date, leaving the row as it was", async () => {
    const far = (
      await createRule(
        app,
        householdId,
        createRuleInput.parse({
          kind: "BILL",
          name: "Water",
          amount: "50",
          schedule: { recurrence: "ONCE", anchorDate: "2026-09-01" },
          allocations: [{ accountId: spend, mode: "REMAINDER" }],
        }),
      )
    ).id;
    // Already moved to Oct 10, so it is still a question; Nov 15 is 75 days after Sep 1.
    await owner.occurrenceOverride.create({ data: { householdId, ruleId: far, scheduledOn: d("2026-09-01"), movedTo: d("2026-10-10") } });
    const before = await owner.occurrenceOverride.findFirstOrThrow({ where: { ruleId: far } });
    await expect(
      answerClearQuestion(app, householdId, userId, far, "2026-09-01", clearAnswerInput.parse({ accountId: spend, answer: "pending" }), OPTIONS),
    ).rejects.toMatchObject({ code: "move_out_of_range" });
    expect(await owner.occurrenceOverride.findFirstOrThrow({ where: { ruleId: far } })).toEqual(before);
  });

  it("stores no move when the day after the balance is the scheduled date itself", async () => {
    const early = (
      await createRule(
        app,
        householdId,
        createRuleInput.parse({
          kind: "BILL",
          name: "Gas",
          amount: "30",
          schedule: { recurrence: "ONCE", anchorDate: "2026-11-15" },
          allocations: [{ accountId: spend, mode: "REMAINDER" }],
        }),
      )
    ).id;
    // Moved earlier to Nov 12, so it is a question; Nov 15 is where it was scheduled.
    await owner.occurrenceOverride.create({ data: { householdId, ruleId: early, scheduledOn: d("2026-11-15"), movedTo: d("2026-11-12") } });
    await answerClearQuestion(app, householdId, userId, early, "2026-11-15", clearAnswerInput.parse({ accountId: spend, answer: "pending" }), OPTIONS);
    expect(await owner.occurrenceOverride.findFirstOrThrow({ where: { ruleId: early } })).toMatchObject({ movedTo: null });
  });
});
