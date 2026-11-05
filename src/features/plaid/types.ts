import type { ItemStatus, PlaidEnvironment, PrismaClient } from "@/generated/prisma/client";

/**
 * Types shared by the Plaid feature. Nothing here touches the network or the
 * database, so it is safe to import from anywhere.
 */

// ---------------------------------------------------------------------------
// Provider-facing shapes (what the gateway returns, already sanitised)
// ---------------------------------------------------------------------------

/** Balances are exact decimal strings; `null` means "the provider did not report it". */
export type ProviderBalances = {
  available: string | null;
  current: string | null;
  limit: string | null;
};

export type ProviderAccount = {
  externalAccountId: string;
  name: string;
  officialName: string | null;
  /** Last digits only, as Plaid reports them. */
  mask: string | null;
  type: string;
  subtype: string | null;
  currency: string;
  balances: ProviderBalances;
  providerUpdatedAt: Date | null;
};

/**
 * One transaction as Plaid reports it, reduced to what the app keeps. Amounts
 * keep Plaid's sign convention (positive = money out of the account, negative =
 * money in) as exact decimal strings.
 */
export type ProviderTransaction = {
  providerTransactionId: string;
  externalAccountId: string;
  amount: string;
  currency: string;
  /** Calendar dates as YYYY-MM-DD; they have no time zone. */
  date: string;
  authorizedDate: string | null;
  pending: boolean;
  /** For a posted transaction: the pending one it replaces. */
  pendingProviderTransactionId: string | null;
  description: string;
  merchantName: string | null;
};

export type SyncUpdateStatus = "NOT_READY" | "INITIAL_UPDATE_COMPLETE" | "HISTORICAL_UPDATE_COMPLETE" | "UNKNOWN";

export type SyncPage = {
  added: ProviderTransaction[];
  modified: ProviderTransaction[];
  removed: { providerTransactionId: string; externalAccountId: string }[];
  /** Empty while Plaid has no data yet; such a cursor must never be saved. */
  nextCursor: string;
  hasMore: boolean;
  status: SyncUpdateStatus;
  /** Accounts that appear in this page (not necessarily all of the Item's). */
  accounts: ProviderAccount[];
  requestId: string | null;
};

export type ProviderAccounts = {
  providerItemId: string;
  institutionId: string | null;
  institutionName: string | null;
  accounts: ProviderAccount[];
  requestId: string | null;
};

/**
 * The only operations the app performs against Plaid. The real implementation
 * wraps the official SDK (client.ts); tests substitute a fake SDK underneath it.
 */
export interface PlaidGateway {
  /**
   * `accessToken` switches to update mode (reconnecting an existing Item): no
   * products or history are requested because the Item already has them.
   * `redirectUri` is sent only when OAuth redirects are configured.
   */
  createLinkToken(input: {
    clientUserId: string;
    historyDays: number;
    redirectUri?: string;
    accessToken?: string;
    /**
     * Update mode only: show Plaid's account-selection step so the person can add
     * or change which accounts are shared. This is how accounts are added to an
     * existing connection; linking the same bank again as a new connection would
     * use another trial slot and, at PNC, invalidates the first connection.
     */
    selectAccounts?: boolean;
  }): Promise<{
    linkToken: string;
    expiration: Date | null;
  }>;
  exchangePublicToken(publicToken: string): Promise<{ accessToken: string; providerItemId: string }>;
  getAccounts(accessToken: string): Promise<ProviderAccounts>;
  removeItem(accessToken: string): Promise<void>;
  /** One page of /transactions/sync. `cursor` null means "from the beginning". */
  syncTransactions(accessToken: string, cursor: string | null, count: number): Promise<SyncPage>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type PlaidErrorKind =
  | "login_required"
  | "invalid_public_token"
  | "missing_entitlement"
  | "rate_limited"
  | "timeout"
  | "unavailable"
  | "misconfigured"
  /** The data changed while pages were being read; the whole batch must restart. */
  | "mutation_during_pagination"
  /** Plaid no longer knows this Item or token (e.g. it was already removed). */
  | "item_gone"
  | "unknown";

/**
 * A failed call to Plaid, reduced to what is safe to keep: a category, Plaid's
 * error code and its request id (useful when contacting Plaid support).
 *
 * The SDK's own errors (axios errors) embed the original request, including the
 * client secret and any access token. They are therefore never stored as
 * `cause`, never rethrown, and never logged: this class is the only thing that
 * leaves the gateway.
 */
export class PlaidProviderError extends Error {
  readonly kind: PlaidErrorKind;
  readonly code: string | null;
  readonly requestId: string | null;

  constructor(kind: PlaidErrorKind, code: string | null, requestId: string | null) {
    super(`Plaid request failed (${kind})`);
    this.name = "PlaidProviderError";
    this.kind = kind;
    this.code = code;
    this.requestId = requestId;
  }
}

export class PlaidNotConfiguredError extends Error {
  constructor() {
    super("Plaid credentials are not configured");
    this.name = "PlaidNotConfiguredError";
  }
}

export type PlaidFlowErrorCode =
  | "attempt_not_found"
  | "attempt_expired"
  | "attempt_used"
  | "connection_not_found"
  | "invalid_public_token"
  | "duplicate_item"
  | "persistence_failed"
  | "not_disconnected"
  | "sync_in_progress"
  | "sync_throttled"
  | "reconnect_required"
  | "token_unreadable"
  | "provider_error";

/** A failure in the link/refresh flow, with a code the routes map to a status. */
export class PlaidFlowError extends Error {
  readonly code: PlaidFlowErrorCode;
  readonly provider?: PlaidProviderError;
  /** For sync_throttled: how long until the next manual sync is allowed. */
  readonly retryAfterSeconds?: number;

  constructor(code: PlaidFlowErrorCode, provider?: PlaidProviderError, extra?: { retryAfterSeconds?: number }) {
    super(`Plaid flow failed (${code})`);
    this.name = "PlaidFlowError";
    this.code = code;
    this.provider = provider;
    this.retryAfterSeconds = extra?.retryAfterSeconds;
  }
}

// ---------------------------------------------------------------------------
// Service dependencies
// ---------------------------------------------------------------------------

export type TokenVault = {
  encrypt(token: string, context: string): string;
  decrypt(ciphertext: string, context: string): string;
};

/** Everything the link and account services need, injected so tests can fake it. */
export type LinkDeps = {
  db: PrismaClient;
  plaid: PlaidGateway;
  environment: PlaidEnvironment;
  tokens: TokenVault;
  /** Registered OAuth redirect URI; when set, link tokens carry it and are kept (encrypted) for the return page. */
  redirectUri?: string | null;
  now?: () => Date;
};

// ---------------------------------------------------------------------------
// Results returned to routes (and so, possibly, to the browser)
// ---------------------------------------------------------------------------

export type LinkAttemptStart = { attemptId: string; linkToken: string };

/** Deliberately minimal: no token, no cursor, no provider ids. */
export type ExchangeResult = { connectionId: string; status: ItemStatus };

export type DisconnectResult = {
  status: "DISCONNECTED";
  /** False when Plaid could not confirm the removal; the person should check the Plaid Dashboard. */
  removalConfirmed: boolean;
};

/** `errorCode` is a safe provider/app code when the fetch failed, otherwise null. */
export type RefreshResult = { status: ItemStatus; accountCount: number; errorCode: string | null };

// ---------------------------------------------------------------------------
// Transaction sync
// ---------------------------------------------------------------------------

/** Limits and timing for a sync. Defaults live in sync.ts; tests shrink them. */
export type SyncTuning = {
  /** Updates requested per page (Plaid allows 1 to 500). */
  pageSize: number;
  /** Pages held in memory before giving up, which bounds the staged batch. */
  maxPages: number;
  /** Times the whole batch restarts after the data changed mid-read. */
  maxRestarts: number;
  /** Tries per page for transient errors (timeouts, outages, rate limits). */
  maxAttempts: number;
  /** How long a sync may hold an Item before others may take over. */
  leaseMs: number;
  backoffMs: (attempt: number) => number;
  sleep: (ms: number) => Promise<void>;
};

export type SyncDeps = LinkDeps & { sync?: Partial<SyncTuning> };

export type SyncOptions = {
  /** Refuse (sync_throttled) if the previous run started more recently than this. Web only. */
  minIntervalMs?: number;
};

/**
 * What a sync reports. Deliberately has no cursor, token or provider ids: it is
 * safe to show in a page, print in a terminal or return from a route.
 */
export type SyncSummary = {
  runId: string;
  status: "SUCCEEDED" | "FAILED";
  added: number;
  modified: number;
  removed: number;
  completedAt: Date;
  /** Safe code when status is FAILED, otherwise null. */
  errorCode: string | null;
  /** Plaid's statement about data completeness, e.g. NOT_READY. */
  providerStatus: string | null;
};
