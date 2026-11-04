/**
 * Display helpers for money, times and connection state. Pure functions with no
 * server-only imports, so pages, client components and tests can all use them.
 */

const NOT_REPORTED = "Not reported";

/**
 * Formats an exact decimal string for display. `null` means the bank did not
 * report the figure, which is different from zero and is shown as such.
 * The string goes straight to Intl, so no precision is lost to floating point.
 */
export function formatMoney(amount: string | null, currency: string): string {
  if (amount === null) return NOT_REPORTED;
  // Intl will happily "format" any three-letter code, rounding to two decimals,
  // which would silently lose precision for unofficial currencies. Only real
  // ISO currencies go through it; anything else keeps the exact amount.
  if (!KNOWN_CURRENCIES.has(currency)) return `${amount} ${currency}`;
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
    // Intl accepts exact decimal strings; the cast only satisfies older typings.
    amount as unknown as number,
  );
}

const KNOWN_CURRENCIES = new Set(Intl.supportedValuesOf("currency"));

/** "••••1234" from the last digits Plaid reports; never anything longer. */
export function maskAccount(mask: string | null): string {
  const digits = (mask ?? "").replace(/[^A-Za-z0-9]/g, "").slice(-4);
  return digits ? `••••${digits}` : "••••";
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Balances older than this are flagged as possibly out of date. */
export const STALE_AFTER_MS = DAY;

export function describeAge(observed: Date, now: Date): string {
  const age = Math.max(0, now.getTime() - observed.getTime());
  if (age < MINUTE) return "just now";
  if (age < HOUR) return `${Math.floor(age / MINUTE)} min ago`;
  if (age < DAY) return `${Math.floor(age / HOUR)} h ago`;
  return `${Math.floor(age / DAY)} d ago`;
}

/** Unambiguous absolute time (UTC), e.g. "Nov 2, 2026, 12:00 UTC". */
export function formatTimestamp(date: Date): string {
  const text = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date);
  return `${text} UTC`;
}

export type ConnectionStatusView = {
  label: string;
  tone: "ok" | "warn" | "error" | "muted";
  /** What the person can do about it, if anything. */
  advice: string | null;
};

type ItemStatusName = "PENDING" | "ACTIVE" | "LOGIN_REQUIRED" | "ERROR" | "DISCONNECTED";

const ERROR_ADVICE: Record<string, string> = {
  timeout: "Plaid did not answer in time.",
  unavailable: "Plaid or the bank is temporarily unavailable.",
  rate_limited: "Plaid asked us to slow down.",
  persistence_failed: "The accounts could not be saved.",
  token_unreadable: "The stored connection key can no longer be read; reconnect this bank.",
  INSTITUTION_DOWN: "The bank is temporarily unavailable.",
  INSTITUTION_NOT_RESPONDING: "The bank is not responding.",
  INSTITUTION_NOT_AVAILABLE: "The bank is not available right now.",
  ITEM_LOGIN_REQUIRED: "The bank needs you to sign in again.",
  RATE_LIMIT: "Plaid asked us to slow down.",
};

/** Plain-language state for a connection. Raw provider codes are not shown. */
export function describeConnection(status: ItemStatusName, errorCode: string | null): ConnectionStatusView {
  const detail = errorCode ? (ERROR_ADVICE[errorCode] ?? "The last attempt failed.") : null;
  switch (status) {
    case "ACTIVE":
      return { label: "Connected", tone: "ok", advice: null };
    case "PENDING":
      return {
        label: "Accounts not loaded yet",
        tone: "warn",
        advice: `${detail ?? "The bank is linked but its accounts have not been fetched."} Use “Fetch accounts” to try again.`,
      };
    case "LOGIN_REQUIRED":
      return { label: "Sign-in needed", tone: "error", advice: "The bank needs you to sign in again. Use “Reconnect”." };
    case "ERROR":
      return { label: "Problem", tone: "error", advice: detail };
    case "DISCONNECTED":
      return {
        label: "Disconnected",
        tone: "muted",
        advice:
          errorCode === "removal_unconfirmed"
            ? "Disconnected here, but Plaid could not confirm it removed the connection. Check the Plaid Dashboard so billing stops. Saved history is kept until you delete it."
            : "Disconnected. Saved accounts and balances stay here until you delete them.",
      };
  }
}

/** A calendar date with no time zone (a transaction date), e.g. "Nov 1, 2026". */
export function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(date);
}

export type SyncStateView = {
  headline: string;
  tone: "ok" | "warn" | "error" | "muted";
  detail: string | null;
};

type LastRun = {
  status: "RUNNING" | "SUCCEEDED" | "FAILED";
  errorCode: string | null;
  providerStatus: string | null;
  addedCount: number;
  modifiedCount: number;
  removedCount: number;
  startedAt: Date;
  finishedAt: Date | null;
} | null;

const SYNC_FAILURES: Record<string, string> = {
  timeout: "Plaid did not answer in time, so nothing was changed. Try again in a moment.",
  unavailable: "Plaid or the bank is temporarily unavailable, so nothing was changed. Try again later.",
  rate_limited: "Plaid asked us to slow down, so nothing was changed. Try again in a minute.",
  INSTITUTION_DOWN: "The bank is temporarily unavailable, so nothing was changed. Try again later.",
  INSTITUTION_NOT_RESPONDING: "The bank is not responding, so nothing was changed. Try again later.",
  TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION:
    "The bank's data kept changing while it was being read, so nothing was changed. Try again.",
  lease_lost: "Another sync took over, so this one was discarded. Nothing was changed.",
  cursor_conflict: "Another sync changed things while this one ran, so it was discarded. Try again.",
  sync_too_large: "There is more history than one sync can safely apply. Nothing was changed.",
  persistence_failed: "The results could not be saved, so nothing was changed. Try again.",
  unknown_account: "Plaid sent transactions for an account that is not known here, so nothing was changed.",
  INVALID_API_KEYS: "Plaid rejected the server's credentials. Check the Plaid settings.",
};

/**
 * What to tell the person about a connection's transactions, from its last sync
 * run. Distinguishes "no data yet" (not an error), "needs a sign-in" and a
 * temporary failure; raw provider codes are never shown.
 */
export function describeSync(
  input: { connectionStatus: ItemStatusName; lastRun: LastRun; lastSuccessfulSyncAt: Date | null },
  now: Date,
): SyncStateView {
  const { connectionStatus, lastRun, lastSuccessfulSyncAt } = input;

  if (connectionStatus === "LOGIN_REQUIRED") {
    return { headline: "Sign-in needed", tone: "error", detail: "Reconnect this bank on the Connections page before syncing." };
  }
  if (!lastRun) {
    return { headline: "Not synced yet", tone: "muted", detail: "Use “Sync now” to fetch this bank's transactions." };
  }
  if (lastRun.status === "RUNNING") {
    return { headline: "Syncing…", tone: "muted", detail: null };
  }
  if (lastRun.status === "FAILED") {
    const known = lastRun.errorCode ? SYNC_FAILURES[lastRun.errorCode] : undefined;
    const since = lastSuccessfulSyncAt ? ` Last successful sync: ${describeAge(lastSuccessfulSyncAt, now)}.` : "";
    if (lastRun.errorCode === "ITEM_LOGIN_REQUIRED") {
      return {
        headline: "Sign-in needed",
        tone: "error",
        detail: "The bank needs you to sign in again. Reconnect it on the Connections page.",
      };
    }
    return {
      headline: "Last sync failed",
      tone: "error",
      detail: `${known ?? "The last sync did not complete, so nothing was changed. Try again."}${since}`,
    };
  }

  if (lastRun.providerStatus === "NOT_READY") {
    return {
      headline: "No transactions yet",
      tone: "warn",
      detail:
        "Plaid is still preparing this bank's transactions. That can take a few minutes after connecting; it is not an error. Sync again shortly.",
    };
  }
  const when = lastRun.finishedAt ? describeAge(lastRun.finishedAt, now) : "recently";
  const changes = `${lastRun.addedCount} new, ${lastRun.modifiedCount} changed, ${lastRun.removedCount} removed`;
  if (lastRun.providerStatus === "INITIAL_UPDATE_COMPLETE") {
    return {
      headline: "Recent transactions loaded",
      tone: "ok",
      detail: `Older history is still arriving from the bank. Last sync ${when} (${changes}).`,
    };
  }
  return { headline: "Up to date", tone: "ok", detail: `Last sync ${when} (${changes}).` };
}
