import { vi } from "vitest";
import type { PlaidApi } from "plaid";

// A stand-in for the official SDK's PlaidApi. Only the methods the app uses
// exist, each a spy returning the same `{ data }` envelope axios gives the real
// SDK. Nothing here talks to Plaid, and every value is synthetic.

export const SECRET_IN_SDK_ERRORS = "secret-synthetic-do-not-leak";
export const ACCESS_TOKEN = "access-sandbox-synthetic-0001";
export const PUBLIC_TOKEN = "public-sandbox-synthetic-0001";
export const LINK_TOKEN = "link-sandbox-synthetic-0001";

export type FakePlaidApi = Pick<
  PlaidApi,
  "linkTokenCreate" | "itemPublicTokenExchange" | "accountsGet" | "itemRemove"
>;

/**
 * Shaped like the AxiosError the real SDK throws: the response carries Plaid's
 * error body, but `config` carries the original request, which contains the
 * client secret and any access token. Code that logs or re-throws such an
 * error unmodified leaks credentials; the tests below check that it does not.
 */
export function sdkError(
  status: number,
  body: { error_type: string; error_code: string; request_id?: string },
): Error {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    response: { status, data: { request_id: "req_error_1", ...body } },
    config: {
      headers: { "PLAID-SECRET": SECRET_IN_SDK_ERRORS },
      data: JSON.stringify({ secret: SECRET_IN_SDK_ERRORS, access_token: ACCESS_TOKEN }),
    },
  });
}

export function networkError(code: "ECONNABORTED" | "ETIMEDOUT" | "ECONNRESET"): Error {
  return Object.assign(new Error(`timeout of 15000ms exceeded`), {
    isAxiosError: true,
    code,
    config: { data: JSON.stringify({ secret: SECRET_IN_SDK_ERRORS }) },
  });
}

type FakeAccount = {
  account_id: string;
  name: string;
  official_name?: string | null;
  mask?: string | null;
  type: string;
  subtype?: string | null;
  balances: {
    available: number | null;
    current: number | null;
    limit: number | null;
    iso_currency_code: string | null;
    unofficial_currency_code: string | null;
    last_updated_datetime?: string | null;
  };
};

export function account(overrides: Partial<FakeAccount> & { account_id: string }): FakeAccount {
  return {
    name: "Plaid Checking",
    official_name: "Plaid Gold Standard 0% Interest Checking",
    mask: "0000",
    type: "depository",
    subtype: "checking",
    balances: {
      available: 100,
      current: 110,
      limit: null,
      iso_currency_code: "USD",
      unofficial_currency_code: null,
    },
    ...overrides,
  };
}

export function accountsGetResponse(
  accounts: FakeAccount[] = [account({ account_id: "acct_checking" })],
  item: { item_id?: string; institution_id?: string | null; institution_name?: string | null } = {},
) {
  return {
    accounts,
    item: {
      item_id: "item_synthetic_1",
      institution_id: "ins_synthetic",
      institution_name: "First Platypus Bank",
      ...item,
    },
    request_id: "req_accounts_1",
  };
}

export function createFakePlaidApi() {
  const api = {
    linkTokenCreate: vi.fn<(request: unknown) => Promise<{ data: unknown }>>(async () => ({
      data: { link_token: LINK_TOKEN, expiration: "2026-11-02T20:00:00Z", request_id: "req_link_1" },
    })),
    itemPublicTokenExchange: vi.fn<(request: unknown) => Promise<{ data: unknown }>>(async () => ({
      data: { access_token: ACCESS_TOKEN, item_id: "item_synthetic_1", request_id: "req_exchange_1" },
    })),
    accountsGet: vi.fn<(request: unknown) => Promise<{ data: unknown }>>(async () => ({ data: accountsGetResponse() })),
    itemRemove: vi.fn<(request: unknown) => Promise<{ data: unknown }>>(async () => ({ data: { request_id: "req_remove_1" } })),
  };
  return api;
}

export function asPlaidApi(api: ReturnType<typeof createFakePlaidApi>): FakePlaidApi {
  return api as unknown as FakePlaidApi;
}
