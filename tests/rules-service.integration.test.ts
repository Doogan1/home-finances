import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { archiveManualAccount, setHouseholdTimeZone } from "@/features/accounts/manual";
import { changeFromInput, createRuleInput, editVersionInput, stopInput, updateRuleInput } from "@/features/rules/input";
import { getRule, listAccountChoices, listRules } from "@/features/rules/queries";
import { archiveRule, changeRuleFrom, createRule, editRuleVersion, stopRule, updateRule } from "@/features/rules/service";
import { addDays } from "@/lib/calendar-date";
import { seedConnection, seedPerson } from "./helpers/plaid-fixtures";
import { createTestClient, truncateAll } from "./helpers/test-db";

const { ownerUrl, appUrl } = inject("testDatabase");
const NOW = new Date("2026-11-14T17:00:00Z"); // Nov 14 in New York
const d = (iso: string) => new Date(`${iso}T00:00:00Z`);

let owner: PrismaClient;
let app: PrismaClient;
let householdId: string;
let spend: string;
let pnc: string;
let savings: string;
let card: string;

beforeAll(() => {
  owner = createTestClient(ownerUrl);
  app = createTestClient(appUrl);
});
afterAll(async () => {
  await owner.$disconnect();
  await app.$disconnect();
});

async function account(name: string, type = "depository", subtype = "checking") {
  const created = await owner.account.create({ data: { householdId, name, type, subtype, currency: "USD" } });
  return created.id;
}

beforeEach(async () => {
  await truncateAll(owner);
  ({ householdId } = await seedPerson(owner, "owner@example.test"));
  spend = await account("Ally Spend");
  pnc = await account("PNC");
  savings = await account("Ally Savings", "depository", "savings");
  card = await account("Amex", "credit", "credit card");
});

const split = () => [
  { accountId: spend, mode: "PERCENT", value: "70" },
  { accountId: pnc, mode: "PERCENT", value: "15" },
  { accountId: savings, mode: "REMAINDER" },
];
const paycheck = (patch: Record<string, unknown> = {}) =>
  createRuleInput.parse({
    kind: "INCOME",
    name: "Drake paycheck",
    amount: "1926.94",
    schedule: { recurrence: "WEEKLY", interval: 1, anchorDate: "2026-11-20" },
    allocations: split(),
    ...patch,
  });
const mortgage = (patch: Record<string, unknown> = {}) =>
  createRuleInput.parse({
    kind: "BILL",
    name: "Mortgage",
    amount: "1840.91",
    schedule: { recurrence: "MONTHLY", interval: 1, anchorDate: "2026-12-01", dayOfMonth: 1 },
    allocations: [{ accountId: spend, mode: "REMAINDER" }],
    ...patch,
  });
const changeTo = (patch: Record<string, unknown> = {}) =>
  changeFromInput.parse({ from: "2027-01-01", amount: "1826.94", allocations: split(), ...patch });
const weekly = { recurrence: "WEEKLY", interval: 1, anchorDate: "2026-11-20" };

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ name: "RuleInputError", code });
}

describe("creating a rule", () => {
  it("stores the first version and the splits in the order given", async () => {
    const { id } = await createRule(app, householdId, paycheck());
    const rule = await getRule(app, householdId, id);
    expect(rule).toMatchObject({ name: "Drake paycheck", kind: "INCOME", archivedAt: null, paysAccount: null });
    expect(rule?.versions).toEqual([
      {
        id: expect.any(String),
        effectiveFrom: "2026-11-20",
        effectiveTo: null,
        amount: "1926.94",
        recurrence: "WEEKLY",
        interval: 1,
        anchorDate: "2026-11-20",
        dayOfMonth: null,
        secondDay: null,
        note: null,
        allocations: [
          { accountId: spend, mode: "PERCENT", value: "70" },
          { accountId: pnc, mode: "PERCENT", value: "15" },
          { accountId: savings, mode: "REMAINDER", value: null },
        ],
      },
    ]);
  });

  it("records the card a card-payment bill pays", async () => {
    const { id } = await createRule(app, householdId, mortgage({ name: "Amex payment", paysAccountId: card }));
    expect((await getRule(app, householdId, id))?.paysAccount).toEqual({ id: card, name: "Amex" });
  });

  it("refuses accounts it can't use and splits that don't work, writing nothing", async () => {
    const other = await seedPerson(owner, "other@example.test");
    const foreign = await owner.account.create({
      data: { householdId: other.householdId, name: "Theirs", type: "depository", subtype: "checking", currency: "USD" },
    });
    const archived = await account("Old checking");
    await owner.account.update({ where: { id: archived }, data: { archivedAt: new Date() } });
    const item = await seedConnection(owner, householdId);
    const linked = await owner.account.findFirstOrThrow({ where: { plaidItemId: item.id } });
    const only = (accountId: string) => [{ accountId, mode: "REMAINDER" }];

    await expectCode(createRule(app, householdId, mortgage({ allocations: only(foreign.id) })), "account_not_found");
    await expectCode(createRule(app, householdId, mortgage({ allocations: only(archived) })), "account_archived");
    await expectCode(createRule(app, householdId, mortgage({ allocations: only(linked.id) })), "account_linked");
    await expectCode(createRule(app, householdId, paycheck({ allocations: only(card) })), "income_to_credit");
    await expectCode(createRule(app, householdId, mortgage({ allocations: split() })), "bill_needs_one_account");
    await expectCode(
      createRule(app, householdId, paycheck({ allocations: [{ accountId: spend, mode: "FIXED", value: "2000" }, ...only(savings)] })),
      "over_allocated",
    );
    await expectCode(
      createRule(app, householdId, mortgage({ schedule: { recurrence: "MONTHLY", interval: 1, anchorDate: "2026-12-02", dayOfMonth: 1 } })),
      "anchor_not_on_day",
    );
    await expectCode(createRule(app, householdId, mortgage({ effectiveFrom: "2026-12-05" })), "anchor_before_start");
    await expectCode(createRule(app, householdId, mortgage({ paysAccountId: spend })), "pays_account_invalid");
    await expectCode(createRule(app, householdId, paycheck({ paysAccountId: card })), "pays_account_invalid");
    expect(await owner.rule.count()).toBe(0);
  });
});

describe("Change from…", () => {
  it("ends the current version the day before, starts the copy on the next date, and keeps per-date edits", async () => {
    const { id } = await createRule(app, householdId, paycheck());
    await owner.occurrenceOverride.create({ data: { householdId, ruleId: id, scheduledOn: d("2026-12-25"), status: "PAID" } });
    await owner.occurrenceOverride.create({
      data: { householdId, ruleId: id, scheduledOn: d("2027-01-08"), status: "CONFIRMED", confirmedAmount: "1826.94" },
    });

    await changeRuleFrom(app, householdId, id, changeTo({ note: "401(k) starts" }));

    const versions = (await getRule(app, householdId, id))?.versions ?? [];
    expect(versions.map((v) => [v.effectiveFrom, v.effectiveTo, v.amount, v.anchorDate, v.note])).toEqual([
      ["2026-11-20", "2026-12-31", "1926.94", "2026-11-20", null],
      ["2027-01-01", null, "1826.94", "2027-01-01", "401(k) starts"],
    ]);
    expect(await owner.occurrenceOverride.count({ where: { ruleId: id } })).toBe(2);
  });

  it("refuses a change on or before the latest start, or after a stop, and changes nothing", async () => {
    const { id } = await createRule(app, householdId, paycheck());
    await expectCode(changeRuleFrom(app, householdId, id, changeTo({ from: "2026-11-20" })), "change_not_after_start");
    await stopRule(app, householdId, id, stopInput.parse({ on: "2026-12-31" }));
    await expectCode(changeRuleFrom(app, householdId, id, changeTo({ from: "2027-02-05" })), "rule_ended");
    const versions = (await getRule(app, householdId, id))?.versions ?? [];
    expect(versions.map((v) => [v.effectiveFrom, v.effectiveTo])).toEqual([["2026-11-20", "2026-12-31"]]);
  });

  it("runs two changes to one rule one after the other, so versions never overlap", async () => {
    const { id } = await createRule(app, householdId, paycheck());
    const results = await Promise.allSettled([
      changeRuleFrom(app, householdId, id, changeTo({ from: "2027-01-01" })),
      changeRuleFrom(app, householdId, id, changeTo({ from: "2027-02-05", amount: "1800" })),
    ]);
    for (const result of results) {
      if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "change_not_after_start" });
    }
    const versions = (await getRule(app, householdId, id))?.versions ?? [];
    expect(versions).toHaveLength(1 + results.filter((r) => r.status === "fulfilled").length);
    for (let i = 1; i < versions.length; i++) {
      expect(versions[i - 1].effectiveTo).toBe(addDays(versions[i].effectiveFrom, -1));
    }
  });
});

describe("Stop on… and Edit this version", () => {
  it("stops the latest version, and refuses a day before it starts", async () => {
    const { id } = await createRule(app, householdId, paycheck());
    await changeRuleFrom(app, householdId, id, changeTo());
    await expectCode(stopRule(app, householdId, id, stopInput.parse({ on: "2026-12-31" })), "stop_before_version_start");
    await stopRule(app, householdId, id, stopInput.parse({ on: "2027-03-05" }));
    const versions = (await getRule(app, householdId, id))?.versions ?? [];
    expect(versions.map((v) => v.effectiveTo)).toEqual(["2026-12-31", "2027-03-05"]);
  });

  it("edits a version in place, replacing its splits and keeping per-date edits", async () => {
    const { id } = await createRule(app, householdId, paycheck());
    const [first] = (await getRule(app, householdId, id))?.versions ?? [];
    await owner.occurrenceOverride.create({ data: { householdId, ruleId: id, scheduledOn: d("2026-11-27"), status: "PAID" } });

    await editRuleVersion(
      app,
      householdId,
      id,
      first.id,
      editVersionInput.parse({ amount: "1900", schedule: weekly, allocations: [{ accountId: spend, mode: "REMAINDER" }] }),
    );

    const versions = (await getRule(app, householdId, id))?.versions ?? [];
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ id: first.id, amount: "1900", allocations: [{ accountId: spend, mode: "REMAINDER", value: null }] });
    expect(await owner.allocation.count()).toBe(1);
    expect(await owner.occurrenceOverride.count()).toBe(1);
  });

  it("changes only the latest version's end, which is how a stop is undone", async () => {
    const { id } = await createRule(app, householdId, paycheck());
    await changeRuleFrom(app, householdId, id, changeTo());
    const [first, second] = (await getRule(app, householdId, id))?.versions ?? [];
    const body = (effectiveTo: string | null) =>
      editVersionInput.parse({ amount: "1926.94", schedule: weekly, allocations: split(), effectiveTo });
    await expectCode(editRuleVersion(app, householdId, id, first.id, body("2027-01-15")), "only_latest_version_can_end");

    await stopRule(app, householdId, id, stopInput.parse({ on: "2027-03-05" }));
    await editRuleVersion(
      app,
      householdId,
      id,
      second.id,
      editVersionInput.parse({
        amount: "1826.94",
        schedule: { recurrence: "WEEKLY", interval: 1, anchorDate: "2027-01-01" },
        allocations: split(),
        effectiveTo: null,
      }),
    );
    expect((await getRule(app, householdId, id))?.versions.map((v) => v.effectiveTo)).toEqual(["2026-12-31", null]);
  });

  it("refuses a version from another rule", async () => {
    const a = await createRule(app, householdId, paycheck());
    const b = await createRule(app, householdId, mortgage());
    const [bVersion] = (await getRule(app, householdId, b.id))?.versions ?? [];
    await expectCode(
      editRuleVersion(app, householdId, a.id, bVersion.id, editVersionInput.parse({ amount: "1", schedule: weekly, allocations: split() })),
      "version_not_found",
    );
  });
});

describe("details, archiving and the household boundary", () => {
  it("renames, sets the card paid, and archives once", async () => {
    const { id } = await createRule(app, householdId, mortgage());
    await updateRule(app, householdId, id, updateRuleInput.parse({ name: "Home loan", category: "Housing", paysAccountId: null }));
    expect(await getRule(app, householdId, id)).toMatchObject({ name: "Home loan", category: "Housing" });

    await archiveRule(app, householdId, id);
    const first = (await owner.rule.findUniqueOrThrow({ where: { id } })).archivedAt;
    await archiveRule(app, householdId, id);
    expect((await owner.rule.findUniqueOrThrow({ where: { id } })).archivedAt).toEqual(first);
    await expectCode(changeRuleFrom(app, householdId, id, changeTo({ allocations: [{ accountId: spend, mode: "REMAINDER" }] })), "rule_archived");
  });

  it("never reaches another household's rules", async () => {
    const { id } = await createRule(app, householdId, paycheck());
    const [version] = (await getRule(app, householdId, id))?.versions ?? [];
    const other = (await seedPerson(owner, "other@example.test")).householdId;
    const body = editVersionInput.parse({ amount: "1", schedule: weekly, allocations: split() });

    await expectCode(updateRule(app, other, id, updateRuleInput.parse({ name: "Mine now" })), "rule_not_found");
    await expectCode(changeRuleFrom(app, other, id, changeTo()), "rule_not_found");
    await expectCode(stopRule(app, other, id, stopInput.parse({ on: "2027-01-01" })), "rule_not_found");
    await expectCode(editRuleVersion(app, other, id, version.id, body), "rule_not_found");
    await expectCode(archiveRule(app, other, id), "rule_not_found");
    expect(await getRule(app, other, id)).toBeNull();
    expect(await listRules(app, other)).toEqual([]);
    expect((await getRule(app, householdId, id))?.name).toBe("Drake paycheck");
  });

  it("lists rules by name, and offers only hand-entered, open accounts", async () => {
    await createRule(app, householdId, mortgage());
    await createRule(app, householdId, paycheck());
    expect((await listRules(app, householdId)).map((r) => r.name)).toEqual(["Drake paycheck", "Mortgage"]);
    await seedConnection(owner, householdId);
    const archived = await account("Old checking");
    await owner.account.update({ where: { id: archived }, data: { archivedAt: new Date() } });
    expect((await listAccountChoices(app, householdId)).map((a) => a.name)).toEqual(["Ally Savings", "Ally Spend", "Amex", "PNC"]);
  });
});

describe("archiving an account a rule uses", () => {
  it("is refused while a rule still runs, naming the rules", async () => {
    await setHouseholdTimeZone(app, householdId, "America/New_York");
    await createRule(app, householdId, mortgage());
    await createRule(app, householdId, paycheck());
    await expect(archiveManualAccount(app, householdId, spend, NOW)).rejects.toMatchObject({
      code: "in_use",
      ruleNames: ["Drake paycheck", "Mortgage"],
    });
    expect((await owner.account.findUniqueOrThrow({ where: { id: spend } })).archivedAt).toBeNull();
  });

  it("is allowed once the rules have stopped before today, or are archived", async () => {
    const oldChecking = await account("Old checking");
    const old = await createRule(
      app,
      householdId,
      mortgage({
        name: "Old internet",
        schedule: { recurrence: "MONTHLY", interval: 1, anchorDate: "2026-01-01", dayOfMonth: 1 },
        allocations: [{ accountId: oldChecking, mode: "REMAINDER" }],
      }),
    );
    await stopRule(app, householdId, old.id, stopInput.parse({ on: "2026-10-01" }));
    // Without a time zone there is no "today", so the stopped rule still counts.
    await expect(archiveManualAccount(app, householdId, oldChecking, NOW)).rejects.toMatchObject({ code: "in_use" });

    await setHouseholdTimeZone(app, householdId, "America/New_York");
    await archiveManualAccount(app, householdId, oldChecking, NOW);
    expect((await owner.account.findUniqueOrThrow({ where: { id: oldChecking } })).archivedAt).not.toBeNull();

    const { id } = await createRule(app, householdId, mortgage({ name: "Water", allocations: [{ accountId: pnc, mode: "REMAINDER" }] }));
    await archiveRule(app, householdId, id);
    await archiveManualAccount(app, householdId, pnc, NOW);
    expect((await owner.account.findUniqueOrThrow({ where: { id: pnc } })).archivedAt).not.toBeNull();
  });
});
