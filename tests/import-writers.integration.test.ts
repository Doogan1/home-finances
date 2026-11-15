import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { createAccountInput, recordBalancesInput } from "@/features/accounts/input";
import { createManualAccount, recordBalancesIn } from "@/features/accounts/manual";
import { changeFromInput, createRuleInput } from "@/features/rules/input";
import { changeRuleFromIn, createRuleIn } from "@/features/rules/service";
import { seedPerson } from "./helpers/plaid-fixtures";
import { createTestClient, truncateAll } from "./helpers/test-db";

const { ownerUrl, appUrl } = inject("testDatabase");
let owner: PrismaClient;
let app: PrismaClient;
let householdId: string;

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
  ({ householdId } = await seedPerson(owner, "owner@example.test"));
  await owner.household.update({ where: { id: householdId }, data: { timeZone: "America/New_York" } });
});

const checking = (name = "Everyday checking") => createAccountInput.parse({ name, kind: "checking" });

describe("Account.importRef", () => {
  it("is unique per household, optional, and free across households", async () => {
    await createManualAccount(app, householdId, checking(), { importRef: "ASPEND" });
    await expect(createManualAccount(app, householdId, checking("Other"), { importRef: "ASPEND" })).rejects.toThrow();
    await createManualAccount(app, householdId, checking("No ref one"));
    await createManualAccount(app, householdId, checking("No ref two"));
    const other = await seedPerson(owner, "other@example.test");
    await expect(createManualAccount(app, other.householdId, checking(), { importRef: "ASPEND" })).resolves.toBeTruthy();
    const refs = await owner.account.findMany({ where: { householdId }, select: { importRef: true }, orderBy: { name: "asc" } });
    expect(refs.map((r) => r.importRef)).toEqual(["ASPEND", null, null]);
  });
});

describe("writers that join the caller's transaction", () => {
  it("write nothing when the caller's transaction fails later", async () => {
    await expect(
      app.$transaction(async (tx) => {
        const { id } = await createManualAccount(tx, householdId, checking(), { importRef: "ASPEND" });
        await recordBalancesIn(tx, householdId, recordBalancesInput.parse({ asOfDate: "2026-11-02", entries: [{ accountId: id, balance: "10" }] }), new Date("2026-11-14T17:00:00Z"));
        const rule = await createRuleIn(
          tx,
          householdId,
          createRuleInput.parse({
            kind: "BILL",
            name: "Home loan",
            amount: "1200",
            effectiveFrom: "2026-11-02",
            schedule: { recurrence: "MONTHLY", interval: 1, anchorDate: "2026-12-01", dayOfMonth: 1 },
            allocations: [{ accountId: id, mode: "REMAINDER" }],
          }),
          { importRef: "MORT" },
        );
        await changeRuleFromIn(tx, householdId, rule.id, changeFromInput.parse({ from: "2027-01-01", amount: "1250", allocations: [{ accountId: id, mode: "REMAINDER" }] }));
        expect(await tx.ruleVersion.count()).toBe(2);
        expect((await tx.rule.findUniqueOrThrow({ where: { id: rule.id } })).importRef).toBe("MORT");
        throw new Error("later step failed");
      }),
    ).rejects.toThrow("later step failed");
    expect(await owner.account.count()).toBe(0);
    expect(await owner.balanceSnapshot.count()).toBe(0);
    expect(await owner.rule.count()).toBe(0);
  });

  it("keep their own refusals", async () => {
    await owner.household.update({ where: { id: householdId }, data: { timeZone: null } });
    const { id } = await createManualAccount(app, householdId, checking());
    await expect(
      app.$transaction((tx) => recordBalancesIn(tx, householdId, recordBalancesInput.parse({ asOfDate: "2026-11-02", entries: [{ accountId: id, balance: "1" }] }))),
    ).rejects.toThrow("time_zone_required");
  });
});
