import "server-only";
import type { PlaidEnvironment, Prisma, PrismaClient } from "@/generated/prisma/client";
import { layerPayments } from "@/features/payments/layer";
import { listPayments, matchRules, toLayerPayment } from "@/features/payments/queries";
import { listHouseholdOverrides, listRules } from "@/features/rules/queries";
import type { IsoDate } from "@/lib/calendar-date";
import { FORECAST_DAYS, type ForecastInput } from "./engine";
import { latestSnapshots, type SnapshotRow } from "./snapshots";

/**
 * Everything the forecast reads for one household: the accounts the Accounts
 * page shows (hand-entered, and those from connections in the active Plaid
 * environment), each one's latest balance, the rules that are not archived,
 * and their per-date edits with matched bank payments laid over them (a paid
 * date is Paid, for the real amount, on the real day). A rule whose amount
 * varies carries what its payments typically were. The engine itself never
 * touches the database.
 */
export async function loadForecastInput(
  db: PrismaClient | Prisma.TransactionClient,
  householdId: string,
  options: { environment: PlaidEnvironment; timeZone: string; today: IsoDate; days?: number },
): Promise<ForecastInput> {
  const visible = { householdId, OR: [{ plaidItemId: null }, { plaidItem: { environment: options.environment } }] };
  const snapshot = { accountId: true, asOfDate: true, observedAt: true, current: true } as const;
  const [accounts, typed, fromBank, rules, edits, payments] = await Promise.all([
    db.account.findMany({
      where: visible,
      select: { id: true, name: true, type: true, subtype: true, includeInForecast: true, cushion: true, archivedAt: true, active: true },
      orderBy: { name: "asc" },
    }),
    // The latest of each kind per account; latestSnapshots compares the two.
    // Hand-entered balances go by the date they were true, bank ones by when
    // they were observed. A balance that was not reported is never a zero.
    db.balanceSnapshot.findMany({
      where: { account: visible, source: "MANUAL", current: { not: null } },
      distinct: ["accountId"],
      orderBy: [{ accountId: "asc" }, { asOfDate: "desc" }, { observedAt: "desc" }],
      select: snapshot,
    }),
    db.balanceSnapshot.findMany({
      where: { account: visible, source: { not: "MANUAL" }, current: { not: null } },
      distinct: ["accountId"],
      orderBy: [{ accountId: "asc" }, { observedAt: "desc" }],
      select: snapshot,
    }),
    listRules(db, householdId),
    listHouseholdOverrides(db, householdId),
    listPayments(db, householdId, options),
  ]);
  const forecastRules = matchRules(rules, payments, options.today).map(({ id, name, kind, versions, typical }) =>
    typical ? { id, name, kind, versions, typical } : { id, name, kind, versions },
  );
  const overrides = layerPayments(
    forecastRules,
    edits.map(({ ruleId, scheduledOn, status, confirmedAmount, movedTo }) => ({ ruleId, scheduledOn, status, confirmedAmount, movedTo })),
    payments.map(toLayerPayment),
  );

  const rows: SnapshotRow[] = [...typed, ...fromBank].flatMap((row) =>
    row.current === null
      ? []
      : [{ accountId: row.accountId, asOfDate: row.asOfDate, observedAt: row.observedAt, current: row.current.toFixed() }],
  );
  return {
    today: options.today,
    days: options.days ?? FORECAST_DAYS,
    accounts: accounts.map((a) => ({
      id: a.id,
      name: a.name,
      type: a.type,
      subtype: a.subtype,
      includeInForecast: a.includeInForecast,
      cushion: a.cushion?.toFixed() ?? null,
      archived: a.archivedAt !== null,
      active: a.active,
    })),
    snapshots: latestSnapshots(rows, options.timeZone),
    rules: forecastRules,
    overrides,
  };
}
