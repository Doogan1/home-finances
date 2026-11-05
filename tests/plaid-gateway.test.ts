import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { createPlaidGateway } from "@/features/plaid/client";
import { PlaidProviderError } from "@/features/plaid/types";
import {
  ACCESS_TOKEN,
  LINK_TOKEN,
  PUBLIC_TOKEN,
  SECRET_IN_SDK_ERRORS,
  account,
  accountsGetResponse,
  asPlaidApi,
  createFakePlaidApi,
  networkError,
  sdkError,
} from "./helpers/fake-plaid";

function gatewayWith(api = createFakePlaidApi()) {
  return { api, gateway: createPlaidGateway(asPlaidApi(api)) };
}

describe("createLinkToken", () => {
  it("asks for Transactions only, with explicit history, and an opaque user id", async () => {
    const { api, gateway } = gatewayWith();

    const result = await gateway.createLinkToken({ clientUserId: "household-uuid", historyDays: 90 });

    expect(result.linkToken).toBe(LINK_TOKEN);
    const request = api.linkTokenCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(request).toMatchObject({
      client_name: "Home Finances",
      country_codes: ["US"],
      language: "en",
      user: { client_user_id: "household-uuid" },
      products: ["transactions"],
      transactions: { days_requested: 90 },
    });
    // Auth is not added merely to read balances, and no redirect/webhook yet.
    expect(JSON.stringify(request)).not.toMatch(/"auth"/i);
    expect(request).not.toHaveProperty("redirect_uri");
    expect(request).not.toHaveProperty("webhook");
  });
});

describe("createLinkToken options", () => {
  it("adds the redirect URI only when one is given", async () => {
    const { api, gateway } = gatewayWith();

    await gateway.createLinkToken({ clientUserId: "h", historyDays: 90, redirectUri: "http://localhost:3000/plaid/oauth" });
    await gateway.createLinkToken({ clientUserId: "h", historyDays: 90 });

    expect(api.linkTokenCreate.mock.calls[0][0]).toMatchObject({ redirect_uri: "http://localhost:3000/plaid/oauth" });
    expect(api.linkTokenCreate.mock.calls[1][0]).not.toHaveProperty("redirect_uri");
  });

  it("creates an update-mode token from an access token, with no products or history request", async () => {
    const { api, gateway } = gatewayWith();

    await gateway.createLinkToken({ clientUserId: "h", historyDays: 90, accessToken: ACCESS_TOKEN });

    const request = api.linkTokenCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(request).toMatchObject({ access_token: ACCESS_TOKEN, user: { client_user_id: "h" } });
    expect(request).not.toHaveProperty("products");
    expect(request).not.toHaveProperty("transactions");
  });
});

describe("account selection in update mode", () => {
  it("lets the person add or change accounts only when asked, and only for an existing connection", async () => {
    const { api, gateway } = gatewayWith();

    await gateway.createLinkToken({ clientUserId: "h", historyDays: 90, accessToken: ACCESS_TOKEN, selectAccounts: true });
    await gateway.createLinkToken({ clientUserId: "h", historyDays: 90, accessToken: ACCESS_TOKEN });
    await gateway.createLinkToken({ clientUserId: "h", historyDays: 90, accessToken: ACCESS_TOKEN, selectAccounts: false });
    // A brand-new connection already asks which accounts to share; the option does not apply.
    await gateway.createLinkToken({ clientUserId: "h", historyDays: 90, selectAccounts: true });

    const requests = api.linkTokenCreate.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(requests[0]).toMatchObject({ update: { account_selection_enabled: true } });
    expect(requests[1]).not.toHaveProperty("update");
    expect(requests[2]).not.toHaveProperty("update");
    expect(requests[3]).not.toHaveProperty("update");
  });
});

describe("exchangePublicToken", () => {
  it("returns the access token and Plaid's item id", async () => {
    const { gateway } = gatewayWith();

    await expect(gateway.exchangePublicToken(PUBLIC_TOKEN)).resolves.toEqual({
      accessToken: ACCESS_TOKEN,
      providerItemId: "item_synthetic_1",
    });
  });
});

describe("getAccounts", () => {
  it("converts balances to exact decimal strings and keeps null as null", async () => {
    const api = createFakePlaidApi();
    api.accountsGet.mockResolvedValueOnce({
      data: accountsGetResponse([
        account({
          account_id: "a1",
          balances: {
            available: null,
            current: 1234.5,
            limit: 0.000001,
            iso_currency_code: "USD",
            unofficial_currency_code: null,
            last_updated_datetime: "2026-11-02T12:00:00Z",
          },
        }),
        account({
          account_id: "a2",
          balances: {
            available: -42.1,
            current: 1e21,
            limit: null,
            iso_currency_code: null,
            unofficial_currency_code: "BTC",
          },
        }),
      ]),
    });
    const { gateway } = gatewayWith(api);

    const result = await gateway.getAccounts(ACCESS_TOKEN);

    expect(result.providerItemId).toBe("item_synthetic_1");
    expect(result.institutionName).toBe("First Platypus Bank");
    const [first, second] = result.accounts;
    expect(first.balances).toEqual({ available: null, current: "1234.5", limit: "0.000001" });
    expect(first.providerUpdatedAt?.toISOString()).toBe("2026-11-02T12:00:00.000Z");
    expect(first.currency).toBe("USD");
    // No exponent notation, no float artefacts, unofficial currency is kept.
    expect(second.balances).toEqual({ available: "-42.1", current: "1000000000000000000000", limit: null });
    expect(second.currency).toBe("BTC");
    expect(second.providerUpdatedAt).toBeNull();
  });

  it("uses the 'no currency' code when the provider reports none", async () => {
    const api = createFakePlaidApi();
    api.accountsGet.mockResolvedValueOnce({
      data: accountsGetResponse([
        account({
          account_id: "a1",
          balances: { available: 1, current: 1, limit: null, iso_currency_code: null, unofficial_currency_code: null },
        }),
      ]),
    });

    const result = await gatewayWith(api).gateway.getAccounts(ACCESS_TOKEN);

    expect(result.accounts[0].currency).toBe("XXX");
  });
});

describe("error mapping", () => {
  const cases: [string, Error, string, string | null][] = [
    ["login required", sdkError(400, { error_type: "ITEM_ERROR", error_code: "ITEM_LOGIN_REQUIRED" }), "login_required", "ITEM_LOGIN_REQUIRED"],
    ["bad public token", sdkError(400, { error_type: "INVALID_INPUT", error_code: "INVALID_PUBLIC_TOKEN" }), "invalid_public_token", "INVALID_PUBLIC_TOKEN"],
    ["missing entitlement", sdkError(400, { error_type: "INVALID_INPUT", error_code: "INVALID_PRODUCT" }), "missing_entitlement", "INVALID_PRODUCT"],
    ["rate limited", sdkError(429, { error_type: "RATE_LIMIT_EXCEEDED", error_code: "ACCOUNTS_GET_LIMIT" }), "rate_limited", "ACCOUNTS_GET_LIMIT"],
    ["institution down", sdkError(400, { error_type: "INSTITUTION_ERROR", error_code: "INSTITUTION_DOWN" }), "unavailable", "INSTITUTION_DOWN"],
    ["server error", sdkError(500, { error_type: "API_ERROR", error_code: "INTERNAL_SERVER_ERROR" }), "unavailable", "INTERNAL_SERVER_ERROR"],
    ["bad credentials", sdkError(400, { error_type: "INVALID_INPUT", error_code: "INVALID_API_KEYS" }), "misconfigured", "INVALID_API_KEYS"],
    ["item already removed", sdkError(400, { error_type: "ITEM_ERROR", error_code: "ITEM_NOT_FOUND" }), "item_gone", "ITEM_NOT_FOUND"],
    ["access token no longer valid", sdkError(400, { error_type: "INVALID_INPUT", error_code: "INVALID_ACCESS_TOKEN" }), "item_gone", "INVALID_ACCESS_TOKEN"],
    ["client timeout", networkError("ECONNABORTED"), "timeout", null],
    ["connection reset", networkError("ECONNRESET"), "timeout", null],
    ["unrecognised", sdkError(400, { error_type: "SOMETHING_NEW", error_code: "NEW_THING" }), "unknown", "NEW_THING"],
    ["not even an axios error", new Error("boom"), "unknown", null],
  ];

  it.each(cases)("%s", async (_name, error, kind, code) => {
    const api = createFakePlaidApi();
    api.accountsGet.mockRejectedValueOnce(error);

    const thrown = await gatewayWith(api).gateway.getAccounts(ACCESS_TOKEN).catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(PlaidProviderError);
    expect((thrown as PlaidProviderError).kind).toBe(kind);
    expect((thrown as PlaidProviderError).code).toBe(code);
  });

  it("carries Plaid's request id for support, and nothing that can leak a credential", async () => {
    const api = createFakePlaidApi();
    api.itemPublicTokenExchange.mockRejectedValueOnce(
      sdkError(400, { error_type: "INVALID_INPUT", error_code: "INVALID_PUBLIC_TOKEN", request_id: "req_support_42" }),
    );

    const thrown = (await gatewayWith(api)
      .gateway.exchangePublicToken(PUBLIC_TOKEN)
      .catch((e: unknown) => e)) as PlaidProviderError;

    expect(thrown.requestId).toBe("req_support_42");
    // Every way an error can end up in a log or a response.
    const rendered = [
      thrown.message,
      thrown.stack ?? "",
      JSON.stringify(thrown),
      inspect(thrown, { depth: 10, showHidden: true }),
      String(thrown),
    ].join("\n");
    expect(rendered).not.toContain(SECRET_IN_SDK_ERRORS);
    expect(rendered).not.toContain(ACCESS_TOKEN);
    expect(rendered).not.toContain(PUBLIC_TOKEN);
    expect(thrown.cause).toBeUndefined();
  });
});

describe("removeItem", () => {
  it("calls item/remove with the access token", async () => {
    const { api, gateway } = gatewayWith();

    await gateway.removeItem(ACCESS_TOKEN);

    expect(api.itemRemove).toHaveBeenCalledWith({ access_token: ACCESS_TOKEN });
  });
});
