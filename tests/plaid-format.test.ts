import { describe, expect, it } from "vitest";
import {
  describeAge,
  describeConnection,
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
