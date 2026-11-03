import "server-only";
import {
  CountryCode,
  Configuration,
  PlaidApi,
  PlaidEnvironments,
  Products,
} from "plaid";
import { Prisma } from "@/generated/prisma/client";
import { getServerConfig } from "@/lib/config";
import {
  PlaidNotConfiguredError,
  PlaidProviderError,
  type PlaidErrorKind,
  type PlaidGateway,
  type ProviderAccount,
} from "./types";

/**
 * The only module that talks to the official Plaid SDK. Everything above it
 * (link flow, account refresh, routes) sees sanitised results and
 * PlaidProviderError, never an SDK error or an access token it did not ask for.
 */

const REQUEST_TIMEOUT_MS = 15_000;
const PLAID_API_VERSION = "2020-09-14";
// ISO 4217 "no currency": used only if Plaid reports neither code.
const NO_CURRENCY = "XXX";

type PlaidApiMethods = Pick<
  PlaidApi,
  "linkTokenCreate" | "itemPublicTokenExchange" | "accountsGet" | "itemRemove"
>;

export function createPlaidApi(options: {
  clientId: string;
  secret: string;
  environment: "sandbox" | "production";
}): PlaidApi {
  return new PlaidApi(
    new Configuration({
      basePath: PlaidEnvironments[options.environment],
      baseOptions: {
        // Without a timeout a stalled connection would hold a request open indefinitely.
        timeout: REQUEST_TIMEOUT_MS,
        headers: {
          "PLAID-CLIENT-ID": options.clientId,
          "PLAID-SECRET": options.secret,
          "Plaid-Version": PLAID_API_VERSION,
        },
      },
    }),
  );
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

type SdkErrorShape = {
  code?: unknown;
  response?: { status?: unknown; data?: { error_type?: unknown; error_code?: unknown; request_id?: unknown } };
};

const NETWORK_CODES = new Set([
  "ECONNABORTED",
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
]);
const LOGIN_REQUIRED_CODES = new Set([
  "ITEM_LOGIN_REQUIRED",
  "PENDING_EXPIRATION",
  "PENDING_DISCONNECT",
  "USER_PERMISSION_REVOKED",
]);
const ENTITLEMENT_CODES = new Set(["INVALID_PRODUCT", "PRODUCT_NOT_ENABLED", "PRODUCTS_NOT_SUPPORTED"]);
const MISCONFIGURED_CODES = new Set([
  "INVALID_API_KEYS",
  "INVALID_CLIENT_ID",
  "INVALID_SECRET",
  "UNAUTHORIZED_ENVIRONMENT",
]);

const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** Reduce any thrown value to a PlaidProviderError that is safe to keep. */
export function toProviderError(error: unknown): PlaidProviderError {
  const sdk = (typeof error === "object" && error !== null ? error : {}) as SdkErrorShape;
  const data = sdk.response?.data;
  const status = typeof sdk.response?.status === "number" ? sdk.response.status : null;
  const code = asString(data?.error_code);
  const type = asString(data?.error_type);
  const requestId = asString(data?.request_id);

  let kind: PlaidErrorKind = "unknown";
  if (code && LOGIN_REQUIRED_CODES.has(code)) kind = "login_required";
  else if (code === "INVALID_PUBLIC_TOKEN") kind = "invalid_public_token";
  else if (code && ENTITLEMENT_CODES.has(code)) kind = "missing_entitlement";
  else if (code && MISCONFIGURED_CODES.has(code)) kind = "misconfigured";
  else if (type === "RATE_LIMIT_EXCEEDED" || status === 429) kind = "rate_limited";
  else if (type === "INSTITUTION_ERROR" || code === "INTERNAL_SERVER_ERROR" || (status !== null && status >= 500)) {
    kind = "unavailable";
  } else if (!sdk.response && typeof sdk.code === "string" && NETWORK_CODES.has(sdk.code)) {
    // No usable answer from Plaid at all (timed out, reset, unreachable).
    kind = "timeout";
  }

  return new PlaidProviderError(kind, code, requestId);
}

async function call<T>(request: () => Promise<{ data: T }>): Promise<T> {
  try {
    return (await request()).data;
  } catch (error) {
    // Deliberately not chained as `cause`: see PlaidProviderError.
    throw toProviderError(error);
  }
}

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------

/** Exact decimal text for a provider number; no exponent, no float artefacts. */
function toDecimalString(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return new Prisma.Decimal(value).toFixed();
}

export function createPlaidGateway(api: PlaidApiMethods): PlaidGateway {
  return {
    async createLinkToken({ clientUserId, historyDays }) {
      const data = await call(() =>
        api.linkTokenCreate({
          client_name: "Home Finances",
          language: "en",
          country_codes: [CountryCode.Us],
          user: { client_user_id: clientUserId },
          // Transactions only. Auth is not added just to read balances.
          products: [Products.Transactions],
          transactions: { days_requested: historyDays },
        }),
      );
      return {
        linkToken: data.link_token,
        expiration: data.expiration ? new Date(data.expiration) : null,
      };
    },

    async exchangePublicToken(publicToken) {
      const data = await call(() => api.itemPublicTokenExchange({ public_token: publicToken }));
      return { accessToken: data.access_token, providerItemId: data.item_id };
    },

    async getAccounts(accessToken) {
      const data = await call(() => api.accountsGet({ access_token: accessToken }));
      const accounts: ProviderAccount[] = data.accounts.map((account) => ({
        externalAccountId: account.account_id,
        name: account.name,
        officialName: account.official_name ?? null,
        mask: account.mask ?? null,
        type: String(account.type),
        subtype: account.subtype ? String(account.subtype) : null,
        currency: account.balances.iso_currency_code ?? account.balances.unofficial_currency_code ?? NO_CURRENCY,
        balances: {
          available: toDecimalString(account.balances.available),
          current: toDecimalString(account.balances.current),
          limit: toDecimalString(account.balances.limit),
        },
        providerUpdatedAt: account.balances.last_updated_datetime
          ? new Date(account.balances.last_updated_datetime)
          : null,
      }));
      return {
        providerItemId: data.item.item_id,
        institutionId: data.item.institution_id ?? null,
        institutionName: data.item.institution_name ?? null,
        accounts,
        requestId: data.request_id ?? null,
      };
    },

    async removeItem(accessToken) {
      await call(() => api.itemRemove({ access_token: accessToken }));
    },
  };
}

let cachedGateway: PlaidGateway | undefined;

/** The process-wide gateway built from validated config; throws if Plaid is not configured. */
export function getPlaidGateway(): PlaidGateway {
  if (!cachedGateway) {
    const { plaid, plaidEnv } = getServerConfig();
    if (!plaid) throw new PlaidNotConfiguredError();
    cachedGateway = createPlaidGateway(
      createPlaidApi({ clientId: plaid.clientId, secret: plaid.secret, environment: plaidEnv }),
    );
  }
  return cachedGateway;
}
