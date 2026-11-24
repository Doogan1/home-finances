import { describe, expect, it } from "vitest";
import { attachAccountInput, createAccountInput, recordBalancesInput, timeZoneInput, updateAccountInput } from "@/features/accounts/input";

const ID_A = "00000000-0000-4000-8000-00000000000a";
const ID_B = "00000000-0000-4000-8000-00000000000b";

describe("createAccountInput", () => {
  it("accepts a minimal account and normalises the optional fields", () => {
    expect(createAccountInput.parse({ name: " Ally Spend ", kind: "checking" })).toEqual({
      name: "Ally Spend",
      kind: "checking",
      ownerLabel: null,
      cushion: null,
    });
    expect(createAccountInput.parse({ name: "Ally Spend", kind: "checking", ownerLabel: "Shared", cushion: "$1,500" })).toMatchObject({
      ownerLabel: "Shared",
      cushion: "1500",
    });
  });

  it("refuses unknown kinds, negative cushions, empty names and extra fields", () => {
    for (const bad of [
      { name: "x", kind: "brokerage" },
      { name: "x", kind: "checking", cushion: "-5" },
      { name: "   ", kind: "checking" },
      { name: "x", kind: "checking", householdId: ID_A },
    ]) {
      expect(createAccountInput.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("updateAccountInput", () => {
  it("treats empty strings as clearing a field", () => {
    expect(updateAccountInput.parse({ ownerLabel: "", cushion: "" })).toEqual({ ownerLabel: null, cushion: null });
  });

  it("needs at least one field", () => {
    expect(updateAccountInput.safeParse({}).success).toBe(false);
  });
});

describe("recordBalancesInput", () => {
  it("accepts several balances, including a negative one", () => {
    const parsed = recordBalancesInput.parse({
      asOfDate: "2026-11-21",
      entries: [
        { accountId: ID_A, balance: "2,431.07" },
        { accountId: ID_B, balance: "-12.40" },
      ],
    });
    expect(parsed.entries.map((e) => e.balance)).toEqual(["2431.07", "-12.40"]);
    expect(parsed.note).toBeNull();
  });

  it("refuses an impossible date, the same account twice, and an empty list", () => {
    const entry = { accountId: ID_A, balance: "1" };
    expect(recordBalancesInput.safeParse({ asOfDate: "2026-02-30", entries: [entry] }).success).toBe(false);
    expect(recordBalancesInput.safeParse({ asOfDate: "2026-11-21", entries: [entry, entry] }).success).toBe(false);
    expect(recordBalancesInput.safeParse({ asOfDate: "2026-11-21", entries: [] }).success).toBe(false);
  });

  it("allows 40 entries and refuses 41", () => {
    const entries = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ accountId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, balance: "1" }));
    expect(recordBalancesInput.safeParse({ asOfDate: "2026-11-21", entries: entries(40) }).success).toBe(true);
    expect(recordBalancesInput.safeParse({ asOfDate: "2026-11-21", entries: entries(41) }).success).toBe(false);
  });
});

describe("timeZoneInput", () => {
  it("accepts only IANA names", () => {
    expect(timeZoneInput.safeParse({ timeZone: "America/New_York" }).success).toBe(true);
    expect(timeZoneInput.safeParse({ timeZone: "Eastern" }).success).toBe(false);
  });
});

describe("attachAccountInput", () => {
  it("takes exactly one bank account id", () => {
    expect(attachAccountInput.parse({ plaidAccountId: ID_A })).toEqual({ plaidAccountId: ID_A });
    for (const bad of [{}, { plaidAccountId: "nope" }, { plaidAccountId: ID_A, householdId: ID_B }, { accountId: ID_A }]) {
      expect(attachAccountInput.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});
