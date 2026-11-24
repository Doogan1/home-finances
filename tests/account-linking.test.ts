import { describe, expect, it } from "vitest";
import { acceptsManualBalances, attachKind, attachTargets, isHandManaged } from "@/features/accounts/linking";

const at = new Date("2026-11-20T12:00:00Z");
const handEntered = { plaidItemId: null, attachedAt: null };
const attached = { plaidItemId: "item-1", attachedAt: at };
const bankOnly = { plaidItemId: "item-1", attachedAt: null };

describe("isHandManaged", () => {
  it("is true for hand-entered and attached accounts, false for one that only came from a bank", () => {
    expect([isHandManaged(handEntered), isHandManaged(attached), isHandManaged(bankOnly)]).toEqual([true, true, false]);
  });
});

describe("acceptsManualBalances", () => {
  it("takes typed balances for a hand-entered account, and for an attached one once its bank is disconnected", () => {
    expect(acceptsManualBalances({ ...handEntered, connectionStatus: null })).toBe(true);
    expect(acceptsManualBalances({ ...attached, connectionStatus: "ACTIVE" })).toBe(false);
    expect(acceptsManualBalances({ ...attached, connectionStatus: "LOGIN_REQUIRED" })).toBe(false);
    expect(acceptsManualBalances({ ...attached, connectionStatus: "DISCONNECTED" })).toBe(true);
    expect(acceptsManualBalances({ ...bankOnly, connectionStatus: "DISCONNECTED" })).toBe(false);
  });
});

describe("attachKind", () => {
  it("pairs cash with cash and cards with cards; nothing else can be attached", () => {
    expect(["depository", "credit", "loan", "investment", "other"].map(attachKind)).toEqual(["depository", "credit", null, null, null]);
  });
});

describe("attachTargets", () => {
  const candidate = (id: string, type: string, patch: Partial<{ archivedAt: Date | null; plaidItemId: string | null }> = {}) => ({
    id,
    name: id,
    type,
    archivedAt: null,
    plaidItemId: null,
    ...patch,
  });
  const candidates = [
    candidate("Ally Savings", "depository"),
    candidate("Ally Spend", "depository"),
    candidate("Amex", "credit"),
    candidate("Old checking", "depository", { archivedAt: at }),
    candidate("Linked", "depository", { plaidItemId: "item-2" }),
  ];

  it("offers open, unlinked accounts of the same kind, in the order given", () => {
    expect(attachTargets("depository", candidates).map((c) => c.id)).toEqual(["Ally Savings", "Ally Spend"]);
    expect(attachTargets("credit", candidates).map((c) => c.id)).toEqual(["Amex"]);
    expect(attachTargets("loan", candidates)).toEqual([]);
  });
});
