import { describe, expect, it } from "vitest";
import {
  describeAge,
  describeSync,
  describeConnection,
  formatDate,
  formatMoney,
  formatTimestamp,
  maskAccount,
} from "@/features/plaid/format";

describe("formatMoney", () => {
  it("formats exact decimals without float drift", () => {
    expect(formatMoney("1234.5", "USD")).toBe("$1,234.50");
    expect(formatMoney("0.1", "USD")).toBe("$0.10");
    expect(formatMoney("12345678901234.56", "USD")).toBe("$12,345,678,901,234.56");
    expect(formatMoney("-42.1", "USD")).toBe("-$42.10");
  });

  it("shows an unreported figure as not reported, never as zero", () => {
    expect(formatMoney(null, "USD")).toBe("Not reported");
    expect(formatMoney("0", "USD")).toBe("$0.00");
  });

  it("falls back to the raw amount and code for currencies Intl does not know", () => {
    expect(formatMoney("1.5", "BTC")).toBe("1.5 BTC");
  });
});

describe("maskAccount", () => {
  it("shows at most the last four characters", () => {
    expect(maskAccount("0000")).toBe("••••0000");
    expect(maskAccount("123456789")).toBe("••••6789");
    expect(maskAccount(null)).toBe("••••");
    expect(maskAccount("")).toBe("••••");
  });
});

describe("time display", () => {
  const now = new Date("2026-11-02T12:00:00Z");

  it.each([
    ["2026-11-02T11:59:50Z", "just now"],
    ["2026-11-02T11:15:00Z", "45 min ago"],
    ["2026-11-02T07:00:00Z", "5 h ago"],
    ["2026-10-30T12:00:00Z", "3 d ago"],
  ])("describes %s as %s", (observed, text) => {
    expect(describeAge(new Date(observed), now)).toBe(text);
  });

  it("never reports a negative age for a future timestamp", () => {
    expect(describeAge(new Date("2026-11-02T13:00:00Z"), now)).toBe("just now");
  });

  it("prints absolute times in labelled UTC", () => {
    expect(formatTimestamp(now)).toBe("Nov 2, 2026, 12:00 PM UTC");
  });
});

describe("describeConnection", () => {
  it("never exposes raw provider codes", () => {
    const view = describeConnection("PENDING", "SOME_UNKNOWN_PLAID_CODE");

    expect(JSON.stringify(view)).not.toContain("SOME_UNKNOWN_PLAID_CODE");
    expect(view.tone).toBe("warn");
  });

  it("tells the person how to fix a connection that needs a sign-in", () => {
    expect(describeConnection("LOGIN_REQUIRED", "ITEM_LOGIN_REQUIRED").advice).toContain("Reconnect");
  });

  it("explains what disconnecting kept, and warns when removal was not confirmed", () => {
    expect(describeConnection("DISCONNECTED", null).advice).toContain("stay here until you delete");
    const unconfirmed = describeConnection("DISCONNECTED", "removal_unconfirmed");
    expect(unconfirmed.advice).toContain("Plaid Dashboard");
    expect(unconfirmed.advice).not.toContain("removal_unconfirmed");
  });

  it("explains known failures in plain language", () => {
    expect(describeConnection("PENDING", "timeout").advice).toContain("did not answer in time");
    expect(describeConnection("LOGIN_REQUIRED", "ITEM_LOGIN_REQUIRED").tone).toBe("error");
    expect(describeConnection("ACTIVE", null)).toEqual({ label: "Connected", tone: "ok", advice: null });
  });
});

describe("formatDate", () => {
  it("shows a calendar date exactly as stored, whatever the server time zone", () => {
    expect(formatDate(new Date("2026-11-01T00:00:00.000Z"))).toBe("Nov 1, 2026");
    expect(formatDate(new Date("2026-12-31T00:00:00.000Z"))).toBe("Dec 31, 2026");
  });
});

describe("describeSync", () => {
  const now = new Date("2026-11-03T12:00:00Z");
  const run = (overrides: Record<string, unknown> = {}) => ({
    status: "SUCCEEDED" as const,
    errorCode: null,
    providerStatus: "HISTORICAL_UPDATE_COMPLETE",
    addedCount: 3,
    modifiedCount: 1,
    removedCount: 0,
    startedAt: new Date("2026-11-03T10:00:00Z"),
    finishedAt: new Date("2026-11-03T09:59:00Z"),
    ...overrides,
  });
  const describeIt = (
    lastRun: ReturnType<typeof run> | null,
    connectionStatus: Parameters<typeof describeSync>[0]["connectionStatus"] = "ACTIVE",
    last: Date | null = null,
  ) =>
    describeSync({ connectionStatus, lastRun, lastSuccessfulSyncAt: last }, now);

  it("says plainly when nothing has been synced", () => {
    expect(describeIt(null)).toMatchObject({ headline: "Not synced yet", tone: "muted" });
  });

  it("treats 'no data yet' as a normal waiting state, not an error", () => {
    const view = describeIt(run({ providerStatus: "NOT_READY", addedCount: 0, modifiedCount: 0 }));

    expect(view.headline).toBe("No transactions yet");
    expect(view.tone).toBe("warn");
    expect(view.detail).toContain("not an error");
  });

  it("reports a healthy sync with its counts and age", () => {
    const view = describeIt(run());

    expect(view).toMatchObject({ headline: "Up to date", tone: "ok" });
    expect(view.detail).toContain("2 h ago");
    expect(view.detail).toContain("3 new, 1 changed, 0 removed");
  });

  it("notes when older history is still arriving", () => {
    expect(describeIt(run({ providerStatus: "INITIAL_UPDATE_COMPLETE" })).headline).toBe("Recent transactions loaded");
  });

  it("separates a reconnect-required state from a temporary failure", () => {
    expect(describeIt(run({ status: "FAILED", errorCode: "ITEM_LOGIN_REQUIRED" }))).toMatchObject({ headline: "Sign-in needed" });
    expect(describeIt(run(), "LOGIN_REQUIRED")).toMatchObject({ headline: "Sign-in needed", tone: "error" });

    const transient = describeIt(run({ status: "FAILED", errorCode: "timeout" }), "ACTIVE", new Date("2026-11-02T12:00:00Z"));
    expect(transient.headline).toBe("Last sync failed");
    expect(transient.detail).toContain("nothing was changed");
    expect(transient.detail).toContain("Last successful sync: 1 d ago");
  });

  it("never shows a raw provider code", () => {
    const view = describeIt(run({ status: "FAILED", errorCode: "SOME_NEW_PLAID_CODE" }));

    expect(JSON.stringify(view)).not.toContain("SOME_NEW_PLAID_CODE");
  });
});
