import type { IsoDate } from "@/lib/calendar-date";

/**
 * Links into the occurrence panel, and the one place its "back" address is
 * checked: only this app's own views, never another site, and only the
 * `account` and `month` parameters those views read.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const VIEWS = new Set(["/", "/register", "/calendar", "/accounts/did-it-clear"]);
const BASE = "http://app.invalid";

export function safeBack(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith("/")) return "/";
  let url: URL;
  try {
    url = new URL(raw, BASE);
  } catch {
    return "/";
  }
  if (url.origin !== BASE) return "/";
  const bill = /^\/bills\/(.+)$/.exec(url.pathname);
  if (bill) return UUID.test(bill[1]) ? url.pathname : "/";
  if (!VIEWS.has(url.pathname)) return "/";

  const kept = new URLSearchParams();
  const account = url.searchParams.get("account");
  const month = url.searchParams.get("month");
  if (account && UUID.test(account)) kept.set("account", account);
  if (url.pathname === "/calendar" && month && MONTH.test(month)) kept.set("month", month);
  const query = kept.toString();
  return query ? `${url.pathname}?${query}` : url.pathname;
}

export function occurrenceHref(ruleId: string, scheduledOn: IsoDate, back: string): string {
  return `/occurrences/${ruleId}/${scheduledOn}?back=${encodeURIComponent(safeBack(back))}`;
}
