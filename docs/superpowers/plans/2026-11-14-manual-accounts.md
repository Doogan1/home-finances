# Hand-entered accounts and balances Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the household add accounts by hand (with an Owner label and a cushion), record their balances as of a date, all at once, and set the household's time zone. This is build step 1 of the bills and forecast design.

**Architecture:** `Account` loses its hard dependency on Plaid (its two Plaid fields become optional, both-or-neither). `BalanceSnapshot` gains a `MANUAL` source with a calendar `asOfDate`. Pure helpers parse dates and money; a server-only service in `src/features/accounts/` does the writes inside household-scoped queries; five small POST routes follow the existing guard pattern (`authorizeMutation` first, strict bodies, `no-store`). The Accounts page lists both kinds of account; a new Update balances page enters many balances in one form.

**Tech Stack:** Next.js 16 App Router (Server Components and route handlers), Prisma 7 with `@prisma/adapter-pg`, PostgreSQL 17, zod 4, Vitest (unit and integration), Playwright.

**Spec:** `docs/superpowers/specs/2026-11-14-bills-and-forecast-design.md` (this plan covers its build step 1; steps 2 to 6 are outlined at the end and get their own plans).

## Global Constraints

- Money is stored as `Decimal(19, 4)` and handled as exact decimal **strings** in application code; never JavaScript floating-point arithmetic.
- Calendar dates are `@db.Date`, which Prisma reads and writes as a `Date` at UTC midnight. Application code passes them around as `"YYYY-MM-DD"` strings.
- No default time zone is assumed. `Household.timeZone` is nullable and asked for.
- Every mutating route starts with `authorizeMutation(request)` before reading the body or touching the database (enforced by `tests/security-static.test.ts`).
- Every response from the new routes is `cache-control: no-store` (use `jsonNoStore`).
- The household id comes only from the session; every query filters on it.
- Plaid-linked accounts never take manual snapshots and their names are not editable here.
- Currency for hand-entered accounts is `USD`.
- Run commands inside the app container (`docker compose exec app …`) unless the step says "on the host". After a migration, `docker compose restart app`.
- Read `node_modules/next/dist/docs/` for any Next.js API you are unsure of (this is Next.js 16).
- Commit only when the user says so; the commit steps below are where commits belong.

## File Structure

| File | Responsibility |
|---|---|
| `prisma/schema.prisma` (modify) | `Household.timeZone`; optional Plaid fields and new columns on `Account`; `MANUAL`, `asOfDate`, `note` on `BalanceSnapshot` |
| `prisma/migrations/20261114120000_manual_accounts/migration.sql` (create) | Columns and the new enum value |
| `prisma/migrations/20261114120100_manual_account_checks/migration.sql` (create) | Check constraints (separate, because a new enum value cannot be used in the transaction that adds it) |
| `src/lib/calendar-date.ts` (create) | Parse, format and compute "today" for calendar dates; validate time zones |
| `src/lib/money.ts` (create) | Parse typed money into a canonical decimal string |
| `src/lib/http.ts` (create) | `jsonNoStore`, `readJson`, `badRequest`, moved from the Plaid module |
| `src/features/plaid/http.ts` (modify) | Re-export the moved helpers |
| `src/features/accounts/input.ts` (create) | zod schemas for the request bodies, and account kinds |
| `src/features/accounts/manual.ts` (create) | Server-only writes: create, update, archive, record balances, set time zone |
| `src/features/accounts/http.ts` (create) | Map `AccountInputError` to responses |
| `src/features/plaid/queries.ts` (modify) | `listAccountsWithLatestBalance` includes hand-entered accounts and orders snapshots by as-of date |
| `src/app/api/accounts/route.ts` (create) | POST create |
| `src/app/api/accounts/[id]/update/route.ts` (create) | POST update |
| `src/app/api/accounts/[id]/archive/route.ts` (create) | POST archive |
| `src/app/api/balances/route.ts` (create) | POST record many balances |
| `src/app/api/household/time-zone/route.ts` (create) | POST set time zone |
| `src/components/post-json.ts` (create) | Client fetch helper, moved out of `plaid-api.ts` |
| `src/components/accounts/*.tsx` (create) | Client forms: time zone, new account, edit account, balances |
| `src/app/accounts/page.tsx` (modify) | Both kinds of account, with the forms |
| `src/app/accounts/balances/page.tsx` (create) | Update balances |
| `src/app/page.tsx` (modify) | Link to Update balances |
| `scripts/e2e-user.mts` (modify) | Delete hand-entered accounts of throwaway households |
| `tests/calendar-date.test.ts`, `tests/money.test.ts`, `tests/accounts-input.test.ts` (create) | Unit |
| `tests/manual-accounts.integration.test.ts` (create) | Constraints and service, real database |
| `tests/accounts-routes.integration.test.ts` (create) | Routes, household boundary, origin, anonymous |
| `tests/accounts.e2e.spec.ts` (create) | Browser flow |
| `docs/local-development.md`, `README.md` (modify) | Document the feature |

---

### Task 1: Calendar dates and money parsing

**Files:**
- Create: `src/lib/calendar-date.ts`, `src/lib/money.ts`
- Test: `tests/calendar-date.test.ts`, `tests/money.test.ts`

**Interfaces:**
- Produces:
  - `type IsoDate = string`
  - `parseIsoDate(value: string): Date | null`: a real calendar date as UTC midnight, or null
  - `toIsoDate(date: Date): IsoDate`
  - `todayIn(timeZone: string, now?: Date): IsoDate`
  - `daysBetween(from: IsoDate, to: IsoDate): number` (to minus from)
  - `isTimeZone(value: string): boolean`
  - `parseMoney(input: string, options: { allowNegative: boolean }): string | null`: canonical decimal string ("1234.5", "-12", "0") or null

- [ ] **Step 1: Write the failing tests**

`tests/calendar-date.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { daysBetween, isTimeZone, parseIsoDate, toIsoDate, todayIn } from "@/lib/calendar-date";

describe("parseIsoDate", () => {
  it("reads a real date as UTC midnight", () => {
    expect(parseIsoDate("2026-11-14")?.toISOString()).toBe("2026-11-14T00:00:00.000Z");
    expect(parseIsoDate("2028-02-29")?.toISOString()).toBe("2028-02-29T00:00:00.000Z");
  });

  it("refuses impossible dates and other formats", () => {
    for (const bad of ["2026-02-29", "2026-13-01", "2026-11-31", "2026-1-5", "11/14/2026", "2026-11-14T00:00:00Z", "", "0050-01-01"]) {
      expect(parseIsoDate(bad), bad).toBeNull();
    }
  });
});

describe("toIsoDate and daysBetween", () => {
  it("round-trips and counts calendar days", () => {
    expect(toIsoDate(parseIsoDate("2026-12-01")!)).toBe("2026-12-01");
    expect(daysBetween("2026-11-14", "2026-11-21")).toBe(7);
    expect(daysBetween("2026-11-21", "2026-11-14")).toBe(-7);
    // Across the US daylight-saving change (Nov 1, 2026): still whole days.
    expect(daysBetween("2026-10-31", "2026-11-02")).toBe(2);
  });
});

describe("todayIn", () => {
  it("uses the household's time zone, not the server's", () => {
    const now = new Date("2026-11-15T03:30:00Z"); // 10:30 pm on Nov 14 in New York
    expect(todayIn("America/New_York", now)).toBe("2026-11-14");
    expect(todayIn("Europe/Berlin", now)).toBe("2026-11-15");
  });
});

describe("isTimeZone", () => {
  it("accepts IANA names and refuses anything else", () => {
    expect(isTimeZone("America/New_York")).toBe(true);
    expect(isTimeZone("America/Detroit")).toBe(true);
    for (const bad of ["", "Mars/Olympus_Mons", "EST5EDT; drop table", "america/new_york"]) {
      expect(isTimeZone(bad), bad).toBe(false);
    }
  });
});
```

`tests/money.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseMoney } from "@/lib/money";

describe("parseMoney", () => {
  it("normalises what people type", () => {
    expect(parseMoney("2431.07", { allowNegative: false })).toBe("2431.07");
    expect(parseMoney(" $1,500 ", { allowNegative: false })).toBe("1500");
    expect(parseMoney("0012.5", { allowNegative: false })).toBe("12.5");
    expect(parseMoney("0", { allowNegative: false })).toBe("0");
    expect(parseMoney("-$12.40", { allowNegative: true })).toBe("-12.40");
    expect(parseMoney("-0", { allowNegative: true })).toBe("0");
  });

  it("refuses more than two decimal places, bad grouping and junk", () => {
    for (const bad of ["12.345", "1,23", "1,2345", "1.2.3", "abc", "", "$", "1e5", "Infinity", "12.", ".5", "1234567890123456"]) {
      expect(parseMoney(bad, { allowNegative: true }), bad).toBeNull();
    }
  });

  it("refuses negatives unless allowed", () => {
    expect(parseMoney("-5", { allowNegative: false })).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `docker compose exec app npx vitest run tests/calendar-date.test.ts tests/money.test.ts`
Expected: FAIL, "Failed to resolve import" for both modules.

- [ ] **Step 3: Implement**

`src/lib/calendar-date.ts`:

```ts
/**
 * Calendar dates ("2026-11-14") with no time of day: due dates, paydays, the
 * date a balance was true. Postgres stores them in `date` columns, which Prisma
 * reads and writes as a Date at UTC midnight, so every conversion here is in UTC.
 * "Today" is the exception: it depends on where the household lives.
 */

export type IsoDate = string;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export function parseIsoDate(value: string): Date | null {
  const match = ISO_DATE.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < 1900) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  const real = date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  return real ? date : null;
}

export function toIsoDate(date: Date): IsoDate {
  return date.toISOString().slice(0, 10);
}

/** Whole calendar days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  const a = parseIsoDate(from);
  const b = parseIsoDate(to);
  if (!a || !b) throw new RangeError("daysBetween needs two valid dates");
  return Math.round((b.getTime() - a.getTime()) / DAY_MS);
}

/** The household's current calendar date. */
export function todayIn(timeZone: string, now: Date = new Date()): IsoDate {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: "year" | "month" | "day") => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

const TIME_ZONES = new Set(Intl.supportedValuesOf("timeZone"));

/** An IANA time zone name exactly as the runtime lists it. */
export function isTimeZone(value: string): boolean {
  return TIME_ZONES.has(value);
}
```

`src/lib/money.ts`:

```ts
/**
 * Turns money as people type it ("$1,500", "2431.07", "-12.40") into a canonical
 * decimal string for Prisma's Decimal columns. Strings only, so no amount ever
 * passes through floating point. At most two decimal places and 15 whole digits
 * (what Decimal(19, 4) holds); thousands separators must be real groups of three.
 */

const PLAIN = /^\d{1,15}(\.\d{1,2})?$/;
const GROUPED = /^\d{1,3}(,\d{3})+(\.\d{1,2})?$/;

export function parseMoney(input: string, options: { allowNegative: boolean }): string | null {
  let text = input.trim();
  let negative = false;
  if (text.startsWith("-")) {
    negative = true;
    text = text.slice(1);
  }
  if (text.startsWith("$")) text = text.slice(1);
  if (!PLAIN.test(text) && !GROUPED.test(text)) return null;

  const digits = text.replace(/,/g, "");
  if (digits.split(".")[0].length > 15) return null;
  const normalised = digits.replace(/^0+(?=\d)/, "");
  const isZero = /^0(\.0{1,2})?$/.test(normalised);
  if (negative && !isZero && !options.allowNegative) return null;
  return negative && !isZero ? `-${normalised}` : isZero ? "0" : normalised;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `docker compose exec app npx vitest run tests/calendar-date.test.ts tests/money.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/calendar-date.ts src/lib/money.ts tests/calendar-date.test.ts tests/money.test.ts
git commit -m "Add calendar-date and money parsing helpers"
```

---

### Task 2: Schema, migrations and the Plaid code that reads accounts

**Files:**
- Modify: `prisma/schema.prisma` (models `Household`, `Account`, enum `BalanceSource`, model `BalanceSnapshot`)
- Create: `prisma/migrations/20261114120000_manual_accounts/migration.sql`, `prisma/migrations/20261114120100_manual_account_checks/migration.sql`
- Modify: `src/features/plaid/queries.ts` (`listAccountsWithLatestBalance`), `scripts/e2e-user.mts` (the `delete` command)
- Test: `tests/manual-accounts.integration.test.ts` (constraint part)

**Interfaces:**
- Produces (generated Prisma types): `Account.plaidItemId: string | null`, `Account.externalAccountId: string | null`, `Account.ownerLabel: string | null`, `Account.includeInForecast: boolean`, `Account.cushion: Decimal | null`, `Account.archivedAt: Date | null`, `Household.timeZone: string | null`, `BalanceSnapshot.asOfDate: Date | null`, `BalanceSnapshot.note: string | null`, `BalanceSource` includes `"MANUAL"`.
- `listAccountsWithLatestBalance(db, householdId, environment)` keeps its signature; it now also returns hand-entered accounts (`plaidItem: null`), and `balances[0]` is the latest by `asOfDate` and then `observedAt`.

- [ ] **Step 1: Write the failing constraint tests**

Create `tests/manual-accounts.integration.test.ts` with only this first block (Task 3 adds more):

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { seedConnection, seedPerson } from "./helpers/plaid-fixtures";
import { createTestClient, truncateAll } from "./helpers/test-db";

const { ownerUrl, appUrl } = inject("testDatabase");
let owner: PrismaClient;
let app: PrismaClient;
let householdId: string;

beforeAll(() => {
  owner = createTestClient(ownerUrl);
  app = createTestClient(appUrl);
});
afterAll(async () => {
  await owner.$disconnect();
  await app.$disconnect();
});
beforeEach(async () => {
  await truncateAll(owner);
  ({ householdId } = await seedPerson(owner, "owner@example.test"));
});

async function manualAccount(data: Record<string, unknown> = {}) {
  return app.account.create({
    data: { householdId, name: "Ally Spend", type: "depository", subtype: "checking", currency: "USD", ...data },
  });
}

describe("database rules for hand-entered accounts", () => {
  it("allows an account with no Plaid link", async () => {
    const account = await manualAccount();
    expect(account.plaidItemId).toBeNull();
    expect(account.includeInForecast).toBe(true);
  });

  it("refuses half a Plaid link", async () => {
    await expect(manualAccount({ externalAccountId: "acc_1" })).rejects.toThrow(/Account_plaid_link_complete/);
  });

  it("refuses a negative cushion", async () => {
    await expect(manualAccount({ cushion: "-1" })).rejects.toThrow(/Account_cushion_not_negative/);
  });

  it("refuses a manual snapshot without an as-of date", async () => {
    const account = await manualAccount();
    await expect(
      app.balanceSnapshot.create({
        data: { accountId: account.id, observedAt: new Date(), current: "10", currency: "USD", source: "MANUAL" },
      }),
    ).rejects.toThrow(/BalanceSnapshot_manual_has_date/);
  });

  it("refuses an empty or oversized household time zone", async () => {
    for (const timeZone of ["", "x".repeat(65)]) {
      await expect(app.household.update({ where: { id: householdId }, data: { timeZone } })).rejects.toThrow(/Household_timeZone_length/);
    }
  });

  it("still lets Plaid accounts and snapshots be written as before", async () => {
    const { accountIds } = await seedConnection(owner, householdId);
    await app.balanceSnapshot.create({
      data: { accountId: accountIds[0], observedAt: new Date(), current: "10", currency: "USD", source: "ACCOUNTS_GET" },
    });
    expect(await app.balanceSnapshot.count()).toBeGreaterThan(0);
  });
});
```

Before running, check what `seedPerson` and `seedConnection` return (`tests/helpers/plaid-fixtures.ts:29` and `:43`). If `seedConnection` does not return `accountIds`, read the account ids with `owner.account.findMany({ where: { householdId }, select: { id: true } })` instead, and keep the rest of the test unchanged.

- [ ] **Step 2: Run to verify it fails**

Run: `docker compose exec app npx vitest run --config vitest.integration.config.mts tests/manual-accounts.integration.test.ts`
Expected: FAIL. The first test fails because `householdId`/`name` without `plaidItemId` violates NOT NULL (or a type error on the missing Plaid fields).

- [ ] **Step 3: Change the schema**

In `prisma/schema.prisma`:

```prisma
model Household {
  id        String   @id @default(uuid()) @db.Uuid
  name      String
  // IANA name ("America/New_York"); decides what "today" is. Asked for, never assumed.
  timeZone  String?
  createdAt DateTime @default(now())
  // (relations unchanged)
}
```

In `model Account`, replace the two Plaid fields and the relation, and add four fields:

```prisma
  // Both set for an account that came from Plaid; both null for one entered by
  // hand (a check constraint forbids one without the other).
  plaidItemId       String?   @db.Uuid
  externalAccountId String?
  // ...name, officialName, mask, type, subtype, currency, active, unavailableSince unchanged...
  // A label only ("Drake", "Alexis", "Shared"); not a user reference.
  ownerLabel        String?
  // Credit accounts are never forecast, whatever this says.
  includeInForecast Boolean   @default(true)
  // The balance below which the forecast warns. Null means no warning.
  cushion           Decimal?  @db.Decimal(19, 4)
  // Hand-entered accounts are archived, never deleted, so their history stays.
  archivedAt        DateTime?

  plaidItem    PlaidItem?        @relation(fields: [plaidItemId], references: [id], onDelete: Cascade)
```

Leave the `@@unique` lines, `transactions` and `balances` unchanged.

```prisma
enum BalanceSource {
  ACCOUNTS_GET
  BALANCE_GET
  // Typed in by a person, true at the end of `asOfDate`.
  MANUAL
}
```

In `model BalanceSnapshot`, after `source`:

```prisma
  // The calendar date the balance was true (end of day). Required for MANUAL.
  asOfDate          DateTime?     @db.Date
  note              String?
```

- [ ] **Step 4: Write the migrations**

`prisma/migrations/20261114120000_manual_accounts/migration.sql`:

```sql
-- Build step 1 of the bills and forecast design: accounts can be entered by
-- hand, and balances can be recorded by hand as of a calendar date.
-- Purely additive except that Account's two Plaid fields become optional.
-- Check constraints are in the next migration: Postgres refuses to use an enum
-- value in the same transaction that adds it.

-- AlterEnum
ALTER TYPE "BalanceSource" ADD VALUE 'MANUAL';

-- AlterTable
ALTER TABLE "Household" ADD COLUMN "timeZone" TEXT;

-- AlterTable
ALTER TABLE "Account" ALTER COLUMN "plaidItemId" DROP NOT NULL,
ALTER COLUMN "externalAccountId" DROP NOT NULL,
ADD COLUMN "ownerLabel" TEXT,
ADD COLUMN "includeInForecast" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "cushion" DECIMAL(19,4),
ADD COLUMN "archivedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "BalanceSnapshot" ADD COLUMN "asOfDate" DATE,
ADD COLUMN "note" TEXT;
```

`prisma/migrations/20261114120100_manual_account_checks/migration.sql`:

```sql
-- Rules the database enforces for hand-entered accounts and balances, so that a
-- bug elsewhere cannot get past them. Prisma does not model check constraints;
-- they live only here.

ALTER TABLE "Account" ADD CONSTRAINT "Account_plaid_link_complete"
  CHECK (("plaidItemId" IS NULL) = ("externalAccountId" IS NULL));

ALTER TABLE "Account" ADD CONSTRAINT "Account_cushion_not_negative"
  CHECK ("cushion" IS NULL OR "cushion" >= 0);

ALTER TABLE "BalanceSnapshot" ADD CONSTRAINT "BalanceSnapshot_manual_has_date"
  CHECK ("source" <> 'MANUAL' OR "asOfDate" IS NOT NULL);

ALTER TABLE "Household" ADD CONSTRAINT "Household_timeZone_length"
  CHECK ("timeZone" IS NULL OR length("timeZone") BETWEEN 1 AND 64);
```

- [ ] **Step 5: Apply, regenerate and check the migrations match the schema**

Run:

```bash
docker compose exec app npm run db:migrate
docker compose exec app npx prisma generate
docker compose exec app npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script
docker compose restart app
```

Expected: migrations applied; the `migrate diff` output is empty (or only `-- This is an empty migration.`). If it prints statements, the hand-written SQL differs from the schema: fix the SQL, not the schema. (The integration tests build their own databases from the migrations, so this also proves both migrations apply from scratch.)

- [ ] **Step 6: Fix code that assumed every account has a connection**

Run: `docker compose exec app npm run typecheck`
Expected errors are only where `account.plaidItem` is read as non-null: `src/app/accounts/page.tsx` (rewritten in Task 5; for now change `account.plaidItem.x` to `account.plaidItem?.x`) and possibly `src/app/transactions/page.tsx` (use `?.`; transactions always belong to Plaid accounts, so the displayed text does not change). Fix each with optional chaining only.

Then change `listAccountsWithLatestBalance` in `src/features/plaid/queries.ts`:

```ts
/**
 * Every account the page may show: those entered by hand, plus those from
 * connections in the active Plaid environment (so Sandbox and live data are
 * never shown together). The newest balance comes first: by the date it was
 * true for hand-entered balances, then by when it was observed.
 */
export function listAccountsWithLatestBalance(
  db: PrismaClient,
  householdId: string,
  environment: PlaidEnvironment,
) {
  return db.account.findMany({
    where: { householdId, OR: [{ plaidItemId: null }, { plaidItem: { environment } }] },
    include: {
      plaidItem: { select: { id: true, institutionName: true, status: true } },
      balances: {
        orderBy: [{ asOfDate: { sort: "desc", nulls: "last" } }, { observedAt: "desc" }],
        take: 1,
      },
    },
    orderBy: [{ archivedAt: { sort: "desc", nulls: "first" } }, { plaidItem: { createdAt: "asc" } }, { name: "asc" }],
  });
}
```

In `scripts/e2e-user.mts`, in the `delete` branch, before `db.household.deleteMany`, add:

```ts
      // Hand-entered accounts belong to the household, not to a connection.
      await db.account.deleteMany({ where: { householdId: { in: householdIds } } });
```

- [ ] **Step 7: Run the tests**

Run:

```bash
docker compose exec app npx vitest run --config vitest.integration.config.mts tests/manual-accounts.integration.test.ts
docker compose exec app npm run typecheck
docker compose exec app npm run test:integration
```

Expected: the new file passes; typecheck clean; the whole integration suite still passes (218 before this task, plus the new ones).

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20261114120000_manual_accounts prisma/migrations/20261114120100_manual_account_checks src/features/plaid/queries.ts src/app/accounts/page.tsx src/app/transactions/page.tsx scripts/e2e-user.mts tests/manual-accounts.integration.test.ts
git commit -m "Allow accounts without a Plaid connection, and manual balance snapshots"
```

---

### Task 3: Input schemas and the account service

**Files:**
- Create: `src/features/accounts/input.ts`, `src/features/accounts/manual.ts`
- Test: `tests/accounts-input.test.ts`; extend `tests/manual-accounts.integration.test.ts`

**Interfaces:**
- Consumes: `parseIsoDate`, `isTimeZone`, `todayIn` (Task 1); `parseMoney` (Task 1); the schema (Task 2).
- Produces:
  - `ACCOUNT_KINDS: Record<AccountKind, { type: "depository" | "credit"; subtype: string; label: string }>` with `type AccountKind = "checking" | "savings" | "credit_card"`
  - zod schemas `createAccountInput`, `updateAccountInput`, `recordBalancesInput`, `timeZoneInput`, and their output types `CreateAccountInput`, `UpdateAccountInput`, `RecordBalancesInput`, `TimeZoneInput`
  - `class AccountInputError extends Error { code: AccountErrorCode }`, `type AccountErrorCode = "account_not_found" | "not_manual" | "archived" | "time_zone_required" | "future_date"`
  - `createManualAccount(db, householdId, input: CreateAccountInput): Promise<{ id: string }>`
  - `updateAccount(db, householdId, accountId, input: UpdateAccountInput): Promise<void>`
  - `archiveManualAccount(db, householdId, accountId): Promise<void>`
  - `recordBalances(db, householdId, input: RecordBalancesInput, now?: Date): Promise<{ recorded: number }>`
  - `setHouseholdTimeZone(db, householdId, timeZone: string): Promise<void>`

- [ ] **Step 1: Write the failing unit tests for the schemas**

`tests/accounts-input.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createAccountInput, recordBalancesInput, timeZoneInput, updateAccountInput } from "@/features/accounts/input";

const ID_A = "00000000-0000-4000-8000-00000000000a";
const ID_B = "00000000-0000-4000-8000-00000000000b";

describe("createAccountInput", () => {
  it("accepts a minimal account and normalises the optional fields", () => {
    expect(createAccountInput.parse({ name: " Ally Spend ", kind: "checking" })).toEqual({
      name: "Ally Spend",
      kind: "checking",
      ownerLabel: null,
      cushion: null,
    });
    expect(createAccountInput.parse({ name: "Ally Spend", kind: "checking", ownerLabel: "Shared", cushion: "$1,500" })).toMatchObject({
      ownerLabel: "Shared",
      cushion: "1500",
    });
  });

  it("refuses unknown kinds, negative cushions, empty names and extra fields", () => {
    for (const bad of [
      { name: "x", kind: "brokerage" },
      { name: "x", kind: "checking", cushion: "-5" },
      { name: "   ", kind: "checking" },
      { name: "x", kind: "checking", householdId: ID_A },
    ]) {
      expect(createAccountInput.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("updateAccountInput", () => {
  it("treats empty strings as clearing a field", () => {
    expect(updateAccountInput.parse({ ownerLabel: "", cushion: "" })).toEqual({ ownerLabel: null, cushion: null });
  });

  it("needs at least one field", () => {
    expect(updateAccountInput.safeParse({}).success).toBe(false);
  });
});

describe("recordBalancesInput", () => {
  it("accepts several balances, including a negative one", () => {
    const parsed = recordBalancesInput.parse({
      asOfDate: "2026-11-21",
      entries: [
        { accountId: ID_A, balance: "2,431.07" },
        { accountId: ID_B, balance: "-12.40" },
      ],
    });
    expect(parsed.entries.map((e) => e.balance)).toEqual(["2431.07", "-12.40"]);
    expect(parsed.note).toBeNull();
  });

  it("refuses an impossible date, the same account twice, and an empty list", () => {
    const entry = { accountId: ID_A, balance: "1" };
    expect(recordBalancesInput.safeParse({ asOfDate: "2026-02-30", entries: [entry] }).success).toBe(false);
    expect(recordBalancesInput.safeParse({ asOfDate: "2026-11-21", entries: [entry, entry] }).success).toBe(false);
    expect(recordBalancesInput.safeParse({ asOfDate: "2026-11-21", entries: [] }).success).toBe(false);
  });
});

describe("timeZoneInput", () => {
  it("accepts only IANA names", () => {
    expect(timeZoneInput.safeParse({ timeZone: "America/New_York" }).success).toBe(true);
    expect(timeZoneInput.safeParse({ timeZone: "Eastern" }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `docker compose exec app npx vitest run tests/accounts-input.test.ts`
Expected: FAIL, "Failed to resolve import".

- [ ] **Step 3: Implement the schemas**

`src/features/accounts/input.ts`:

```ts
import { z } from "zod";
import { isTimeZone, parseIsoDate } from "@/lib/calendar-date";
import { parseMoney } from "@/lib/money";

/**
 * Request bodies for the hand-entered account routes. Strict objects: an
 * unexpected field (a household id, say) is a 400, never quietly ignored.
 * Money leaves here as a canonical decimal string; dates as "YYYY-MM-DD".
 */

export const ACCOUNT_KINDS = {
  checking: { type: "depository", subtype: "checking", label: "Checking" },
  savings: { type: "depository", subtype: "savings", label: "Savings" },
  credit_card: { type: "credit", subtype: "credit card", label: "Credit card" },
} as const;
export type AccountKind = keyof typeof ACCOUNT_KINDS;

function money(allowNegative: boolean) {
  return z
    .string()
    .max(32)
    .transform((value, ctx) => {
      const parsed = parseMoney(value, { allowNegative });
      if (parsed === null) {
        ctx.addIssue({ code: "custom", message: "Not an amount" });
        return z.NEVER;
      }
      return parsed;
    });
}

/** "" (a cleared field) becomes null; anything else must be an amount. */
const optionalCushion = z.union([z.literal("").transform(() => null), money(false)]);
const optionalLabel = z
  .string()
  .trim()
  .max(40)
  .transform((value) => (value === "" ? null : value));
const name = z.string().trim().min(1).max(80);

const isoDate = z
  .string()
  .max(10)
  .refine((value) => parseIsoDate(value) !== null, "Not a date");

export const createAccountInput = z
  .strictObject({
    name,
    kind: z.enum(["checking", "savings", "credit_card"]),
    ownerLabel: optionalLabel.optional(),
    cushion: optionalCushion.optional(),
  })
  .transform((input) => ({ ...input, ownerLabel: input.ownerLabel ?? null, cushion: input.cushion ?? null }));
export type CreateAccountInput = z.infer<typeof createAccountInput>;

export const updateAccountInput = z
  .strictObject({
    name: name.optional(),
    ownerLabel: optionalLabel.optional(),
    cushion: optionalCushion.optional(),
    includeInForecast: z.boolean().optional(),
  })
  .refine((input) => Object.keys(input).length > 0, "Nothing to change");
export type UpdateAccountInput = z.infer<typeof updateAccountInput>;

export const recordBalancesInput = z
  .strictObject({
    asOfDate: isoDate,
    note: z.string().trim().max(200).optional(),
    entries: z
      .array(z.strictObject({ accountId: z.uuid(), balance: money(true) }))
      .min(1)
      .max(50),
  })
  .refine((input) => new Set(input.entries.map((e) => e.accountId)).size === input.entries.length, "An account appears twice")
  .transform((input) => ({ ...input, note: input.note ? input.note : null }));
export type RecordBalancesInput = z.infer<typeof recordBalancesInput>;

export const timeZoneInput = z.strictObject({
  timeZone: z.string().max(64).refine(isTimeZone, "Not a time zone"),
});
export type TimeZoneInput = z.infer<typeof timeZoneInput>;
```

- [ ] **Step 4: Run the unit tests**

Run: `docker compose exec app npx vitest run tests/accounts-input.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing service tests**

Append to `tests/manual-accounts.integration.test.ts` (add the imports at the top of the file):

```ts
import {
  AccountInputError,
  archiveManualAccount,
  createManualAccount,
  recordBalances,
  setHouseholdTimeZone,
  updateAccount,
} from "@/features/accounts/manual";
import { recordBalancesInput } from "@/features/accounts/input";
import { listAccountsWithLatestBalance } from "@/features/plaid/queries";

const balances = (asOfDate: string, entries: { accountId: string; balance: string }[]) =>
  recordBalancesInput.parse({ asOfDate, entries });

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toSatisfy((error) => error instanceof AccountInputError && error.code === code);
}

describe("the account service", () => {
  it("creates hand-entered accounts with sensible forecast defaults", async () => {
    const spend = await createManualAccount(app, householdId, { name: "Ally Spend", kind: "checking", ownerLabel: "Shared", cushion: "1500" });
    const card = await createManualAccount(app, householdId, { name: "Amex", kind: "credit_card", ownerLabel: null, cushion: null });

    const rows = await owner.account.findMany({ where: { householdId }, orderBy: { name: "asc" } });
    expect(rows.map((r) => [r.name, r.type, r.subtype, r.ownerLabel, r.cushion?.toFixed(), r.includeInForecast])).toEqual([
      ["Ally Spend", "depository", "checking", "Shared", "1500", true],
      ["Amex", "credit", "credit card", null, undefined, false],
    ]);
    expect([spend.id, card.id]).toHaveLength(2);
  });

  it("records several balances as of a date, in one transaction", async () => {
    await setHouseholdTimeZone(app, householdId, "America/New_York");
    const a = await createManualAccount(app, householdId, { name: "Ally Spend", kind: "checking", ownerLabel: null, cushion: null });
    const b = await createManualAccount(app, householdId, { name: "PNC Checking", kind: "checking", ownerLabel: "Drake", cushion: null });

    const result = await recordBalances(app, householdId, balances("2026-11-14", [
      { accountId: a.id, balance: "500" },
      { accountId: b.id, balance: "2305.88" },
    ]), new Date("2026-11-14T18:00:00Z"));

    expect(result).toEqual({ recorded: 2 });
    const rows = await owner.balanceSnapshot.findMany({ orderBy: { current: "asc" } });
    expect(rows.map((r) => [r.source, r.asOfDate?.toISOString().slice(0, 10), r.current?.toFixed()])).toEqual([
      ["MANUAL", "2026-11-14", "500"],
      ["MANUAL", "2026-11-14", "2305.88"],
    ]);
  });

  it("decides 'the future' in the household's time zone", async () => {
    await setHouseholdTimeZone(app, householdId, "America/New_York");
    const a = await createManualAccount(app, householdId, { name: "Ally Spend", kind: "checking", ownerLabel: null, cushion: null });
    const lateEvening = new Date("2026-11-15T03:30:00Z"); // still Nov 14 in New York

    await expect(recordBalances(app, householdId, balances("2026-11-14", [{ accountId: a.id, balance: "1" }]), lateEvening)).resolves.toEqual({ recorded: 1 });
    await expectCode(recordBalances(app, householdId, balances("2026-11-15", [{ accountId: a.id, balance: "1" }]), lateEvening), "future_date");
  });

  it("refuses balances until a time zone is set", async () => {
    const a = await createManualAccount(app, householdId, { name: "Ally Spend", kind: "checking", ownerLabel: null, cushion: null });
    await expectCode(recordBalances(app, householdId, balances("2026-11-14", [{ accountId: a.id, balance: "1" }])), "time_zone_required");
  });

  it("writes nothing when any account is foreign, Plaid-linked or archived", async () => {
    await setHouseholdTimeZone(app, householdId, "America/New_York");
    const mine = await createManualAccount(app, householdId, { name: "Mine", kind: "checking", ownerLabel: null, cushion: null });
    const other = await seedPerson(owner, "other@example.test");
    const theirs = await createManualAccount(app, other.householdId, { name: "Theirs", kind: "checking", ownerLabel: null, cushion: null });
    await seedConnection(owner, householdId);
    const plaid = await owner.account.findFirstOrThrow({ where: { householdId, plaidItemId: { not: null } } });
    const archived = await createManualAccount(app, householdId, { name: "Old", kind: "savings", ownerLabel: null, cushion: null });
    await archiveManualAccount(app, householdId, archived.id);

    const at = new Date("2026-11-14T18:00:00Z");
    for (const [accountId, code] of [[theirs.id, "account_not_found"], [plaid.id, "not_manual"], [archived.id, "archived"]] as const) {
      await expectCode(recordBalances(app, householdId, balances("2026-11-14", [{ accountId: mine.id, balance: "1" }, { accountId, balance: "2" }]), at), code);
    }
    expect(await owner.balanceSnapshot.count({ where: { source: "MANUAL" } })).toBe(0);
  });

  it("lets a Plaid account's label and cushion change, but not its name", async () => {
    await seedConnection(owner, householdId);
    const plaid = await owner.account.findFirstOrThrow({ where: { householdId, plaidItemId: { not: null } } });

    await updateAccount(app, householdId, plaid.id, { ownerLabel: "Drake", cushion: "200" });
    await expectCode(updateAccount(app, householdId, plaid.id, { name: "Renamed" }), "not_manual");
    await expectCode(archiveManualAccount(app, householdId, plaid.id), "not_manual");

    const after = await owner.account.findUniqueOrThrow({ where: { id: plaid.id } });
    expect([after.name, after.ownerLabel, after.cushion?.toFixed()]).toEqual([plaid.name, "Drake", "200"]);
  });

  it("does not let one household touch another's account", async () => {
    const other = await seedPerson(owner, "other@example.test");
    const theirs = await createManualAccount(app, other.householdId, { name: "Theirs", kind: "checking", ownerLabel: null, cushion: null });
    await expectCode(updateAccount(app, householdId, theirs.id, { ownerLabel: "x" }), "account_not_found");
    await expectCode(archiveManualAccount(app, householdId, theirs.id), "account_not_found");
  });

  it("archives without losing history, and archiving twice is harmless", async () => {
    await setHouseholdTimeZone(app, householdId, "America/New_York");
    const a = await createManualAccount(app, householdId, { name: "Old savings", kind: "savings", ownerLabel: null, cushion: null });
    await recordBalances(app, householdId, balances("2026-11-14", [{ accountId: a.id, balance: "10" }]), new Date("2026-11-14T18:00:00Z"));
    await archiveManualAccount(app, householdId, a.id);
    const first = await owner.account.findUniqueOrThrow({ where: { id: a.id } });
    await archiveManualAccount(app, householdId, a.id);
    const second = await owner.account.findUniqueOrThrow({ where: { id: a.id } });

    expect(first.archivedAt).not.toBeNull();
    expect(second.archivedAt).toEqual(first.archivedAt);
    expect(await owner.balanceSnapshot.count({ where: { accountId: a.id } })).toBe(1);
    await expectCode(updateAccount(app, householdId, a.id, { ownerLabel: "x" }), "archived");
  });

  it("shows the balance with the latest as-of date, even if a backdated one was entered later", async () => {
    await setHouseholdTimeZone(app, householdId, "America/New_York");
    const a = await createManualAccount(app, householdId, { name: "Ally Spend", kind: "checking", ownerLabel: null, cushion: null });
    await recordBalances(app, householdId, balances("2026-11-14", [{ accountId: a.id, balance: "500" }]), new Date("2026-11-14T18:00:00Z"));
    await recordBalances(app, householdId, balances("2026-11-10", [{ accountId: a.id, balance: "123" }]), new Date("2026-11-14T19:00:00Z"));

    const [account] = await listAccountsWithLatestBalance(app, householdId, "SANDBOX");
    expect(account.plaidItem).toBeNull();
    expect(account.balances[0].current?.toFixed()).toBe("500");
  });
});
```

- [ ] **Step 6: Run to verify they fail**

Run: `docker compose exec app npx vitest run --config vitest.integration.config.mts tests/manual-accounts.integration.test.ts`
Expected: FAIL, "Failed to resolve import ... features/accounts/manual".

- [ ] **Step 7: Implement the service**

`src/features/accounts/manual.ts`:

```ts
import "server-only";
import type { PrismaClient } from "@/generated/prisma/client";
import { parseIsoDate, todayIn } from "@/lib/calendar-date";
import { ACCOUNT_KINDS, type CreateAccountInput, type RecordBalancesInput, type UpdateAccountInput } from "./input";

/**
 * Writes for hand-entered accounts and balances. Every function takes the
 * household id from the caller's session and filters on it, so an id from the
 * browser can only ever reach this household's rows. Plaid-linked accounts
 * keep their Plaid-owned fields: they cannot be renamed, archived or given
 * manual balances here.
 */

export type AccountErrorCode = "account_not_found" | "not_manual" | "archived" | "time_zone_required" | "future_date";

export class AccountInputError extends Error {
  constructor(readonly code: AccountErrorCode) {
    super(code);
    this.name = "AccountInputError";
  }
}

export async function createManualAccount(db: PrismaClient, householdId: string, input: CreateAccountInput) {
  const kind = ACCOUNT_KINDS[input.kind];
  return db.account.create({
    data: {
      householdId,
      name: input.name,
      type: kind.type,
      subtype: kind.subtype,
      currency: "USD",
      ownerLabel: input.ownerLabel,
      cushion: input.cushion,
      includeInForecast: kind.type !== "credit",
    },
    select: { id: true },
  });
}

async function findOwned(db: PrismaClient, householdId: string, accountId: string) {
  const account = await db.account.findFirst({
    where: { id: accountId, householdId },
    select: { id: true, plaidItemId: true, archivedAt: true },
  });
  if (!account) throw new AccountInputError("account_not_found");
  return account;
}

export async function updateAccount(db: PrismaClient, householdId: string, accountId: string, input: UpdateAccountInput) {
  const account = await findOwned(db, householdId, accountId);
  if (account.archivedAt) throw new AccountInputError("archived");
  if (input.name !== undefined && account.plaidItemId !== null) throw new AccountInputError("not_manual");
  await db.account.update({
    where: { id: account.id },
    data: {
      name: input.name,
      ownerLabel: input.ownerLabel,
      cushion: input.cushion,
      includeInForecast: input.includeInForecast,
    },
  });
}

export async function archiveManualAccount(db: PrismaClient, householdId: string, accountId: string) {
  const account = await findOwned(db, householdId, accountId);
  if (account.plaidItemId !== null) throw new AccountInputError("not_manual");
  // Guarded so archiving twice keeps the first date.
  await db.account.updateMany({ where: { id: account.id, archivedAt: null }, data: { archivedAt: new Date() } });
}

export async function setHouseholdTimeZone(db: PrismaClient, householdId: string, timeZone: string) {
  await db.household.update({ where: { id: householdId }, data: { timeZone } });
}

export async function recordBalances(
  db: PrismaClient,
  householdId: string,
  input: RecordBalancesInput,
  now: Date = new Date(),
) {
  const household = await db.household.findUniqueOrThrow({ where: { id: householdId }, select: { timeZone: true } });
  if (!household.timeZone) throw new AccountInputError("time_zone_required");
  // ISO dates compare correctly as strings.
  if (input.asOfDate > todayIn(household.timeZone, now)) throw new AccountInputError("future_date");
  const asOfDate = parseIsoDate(input.asOfDate);
  if (!asOfDate) throw new AccountInputError("future_date");

  const ids = input.entries.map((entry) => entry.accountId);
  return db.$transaction(async (tx) => {
    const accounts = await tx.account.findMany({
      where: { id: { in: ids }, householdId },
      select: { id: true, plaidItemId: true, archivedAt: true, currency: true },
    });
    if (accounts.length !== ids.length) throw new AccountInputError("account_not_found");
    if (accounts.some((a) => a.plaidItemId !== null)) throw new AccountInputError("not_manual");
    if (accounts.some((a) => a.archivedAt !== null)) throw new AccountInputError("archived");

    const currency = new Map(accounts.map((a) => [a.id, a.currency]));
    await tx.balanceSnapshot.createMany({
      data: input.entries.map((entry) => ({
        accountId: entry.accountId,
        observedAt: now,
        asOfDate,
        current: entry.balance,
        currency: currency.get(entry.accountId) ?? "USD",
        source: "MANUAL" as const,
        note: input.note,
      })),
    });
    return { recorded: input.entries.length };
  });
}
```

Note the order of checks in `writes nothing when any account is foreign…`: a foreign id makes `accounts.length` short, so it reports `account_not_found` before the Plaid check, which is what the test expects.

- [ ] **Step 8: Run the tests**

Run: `docker compose exec app npx vitest run --config vitest.integration.config.mts tests/manual-accounts.integration.test.ts`
Expected: PASS (all of Task 2's and Task 3's tests).

- [ ] **Step 9: Commit**

```bash
git add src/features/accounts/input.ts src/features/accounts/manual.ts tests/accounts-input.test.ts tests/manual-accounts.integration.test.ts
git commit -m "Add the service for hand-entered accounts and balances"
```

---

### Task 4: Routes

**Files:**
- Create: `src/lib/http.ts`, `src/features/accounts/http.ts`, `src/app/api/accounts/route.ts`, `src/app/api/accounts/[id]/update/route.ts`, `src/app/api/accounts/[id]/archive/route.ts`, `src/app/api/balances/route.ts`, `src/app/api/household/time-zone/route.ts`
- Modify: `src/features/plaid/http.ts` (lines 1-46: move three helpers out)
- Test: `tests/accounts-routes.integration.test.ts`

**Interfaces:**
- Consumes: everything from Task 3; `authorizeMutation` (`src/lib/auth/household.ts`).
- Produces (HTTP, all POST, JSON, `no-store`):
  - `/api/accounts` body `createAccountInput` → 201 `{ id }`
  - `/api/accounts/{id}/update` body `updateAccountInput` → 200 `{ ok: true }`
  - `/api/accounts/{id}/archive` body `{}` → 200 `{ ok: true }`
  - `/api/balances` body `recordBalancesInput` → 200 `{ recorded }`
  - `/api/household/time-zone` body `timeZoneInput` → 200 `{ ok: true }`
  - Errors: 400 `invalid_request`; 401 anonymous; 403 wrong origin (from `authorizeMutation`); `account_not_found` 404; `not_manual` 409; `archived` 409; `time_zone_required` 409; `future_date` 400.

- [ ] **Step 1: Move the generic HTTP helpers**

Create `src/lib/http.ts` containing exactly `MAX_BODY_BYTES`, `jsonNoStore`, `readJson` and `badRequest` from `src/features/plaid/http.ts` (cut them, with their comments, unchanged), plus `import "server-only";` and `import { z } from "zod";` at the top. In `src/features/plaid/http.ts`, replace them with:

```ts
import { jsonNoStore } from "@/lib/http";

// Generic JSON helpers live in src/lib/http.ts; re-exported for existing callers.
export { badRequest, jsonNoStore, readJson } from "@/lib/http";
```

Run: `docker compose exec app npm run typecheck && docker compose exec app npm test`
Expected: clean, all unit tests pass (nothing else changed).

- [ ] **Step 2: Write the failing route tests**

`tests/accounts-routes.integration.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { createAuth, type Auth } from "@/lib/auth/auth";
import { createHouseholdWithOwner } from "../scripts/lib/users.mjs";
import { seedConnection } from "./helpers/plaid-fixtures";
import { createTestClient, truncateAll } from "./helpers/test-db";

// Same approach as plaid-lifecycle-routes.integration.test.ts: routes are called
// as plain functions with real sessions from the throwaway database.

const BASE_URL = "http://localhost:3000";
const PASSWORD = "correct horse battery staple";

const state = vi.hoisted(() => ({
  auth: undefined as unknown as Auth,
  db: undefined as unknown as PrismaClient,
  headers: new Headers(),
}));

vi.mock("next/headers", () => ({ headers: async () => state.headers }));
vi.mock("@/lib/config", () => ({ getServerConfig: () => ({ appUrl: BASE_URL }) }));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/auth/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/auth")>()),
  getAuth: () => state.auth,
}));

const { POST: createAccount } = await import("@/app/api/accounts/route");
const { POST: updateAccount } = await import("@/app/api/accounts/[id]/update/route");
const { POST: archiveAccount } = await import("@/app/api/accounts/[id]/archive/route");
const { POST: recordBalances } = await import("@/app/api/balances/route");
const { POST: setTimeZone } = await import("@/app/api/household/time-zone/route");

const { ownerUrl, appUrl } = inject("testDatabase");
let owner: PrismaClient;

beforeAll(() => {
  owner = createTestClient(ownerUrl);
  state.db = createTestClient(appUrl);
});
afterAll(async () => {
  await owner.$disconnect();
  await state.db.$disconnect();
});
beforeEach(async () => {
  await truncateAll(owner);
  state.auth = createAuth({ db: state.db, secret: "accounts-secret-".padEnd(48, "a"), baseURL: BASE_URL });
  state.headers = new Headers();
});

async function signIn(email: string) {
  const { householdId } = await createHouseholdWithOwner(owner, { householdName: email, name: "Owner", email, password: PASSWORD });
  const response = await state.auth.handler(
    new Request(`${BASE_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE_URL },
      body: JSON.stringify({ email, password: PASSWORD }),
    }),
  );
  const cookie = response.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  state.headers = new Headers({ cookie });
  return { householdId, cookie };
}

function post(body: unknown, origin: string | null = BASE_URL): Request {
  return new Request(`${BASE_URL}/api/x`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
const withId = (id: string) => ({ params: Promise.resolve({ id }) });

async function json(response: Response) {
  expect(response.headers.get("cache-control")).toContain("no-store");
  return response.json() as Promise<Record<string, unknown>>;
}

describe("hand-entered account routes", () => {
  it("creates an account, sets the time zone and records a balance", async () => {
    const { householdId } = await signIn("a@example.test");

    const created = await createAccount(post({ name: "Ally Spend", kind: "checking", ownerLabel: "Shared", cushion: "1500" }));
    expect(created.status).toBe(201);
    const { id } = (await json(created)) as { id: string };

    expect((await setTimeZone(post({ timeZone: "America/New_York" }))).status).toBe(200);
    const recorded = await recordBalances(post({ asOfDate: "2026-11-14", entries: [{ accountId: id, balance: "500" }] }));
    expect(recorded.status).toBe(200);
    expect(await json(recorded)).toEqual({ recorded: 1 });

    const account = await owner.account.findUniqueOrThrow({ where: { id }, include: { balances: true } });
    expect([account.householdId, account.ownerLabel, account.balances[0].current?.toFixed()]).toEqual([householdId, "Shared", "500"]);
  });

  it("refuses bad bodies with 400 and writes nothing", async () => {
    await signIn("a@example.test");
    for (const body of ["not json", { name: "x" }, { name: "x", kind: "checking", householdId: "00000000-0000-4000-8000-000000000000" }]) {
      const response = await createAccount(post(body));
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(await owner.account.count()).toBe(0);
  });

  it("explains a missing time zone and a future date", async () => {
    await signIn("a@example.test");
    const { id } = (await (await createAccount(post({ name: "Ally Spend", kind: "checking" }))).json()) as { id: string };

    const noZone = await recordBalances(post({ asOfDate: "2026-11-14", entries: [{ accountId: id, balance: "1" }] }));
    expect([noZone.status, (await json(noZone)).error]).toEqual([409, "time_zone_required"]);

    await setTimeZone(post({ timeZone: "America/New_York" }));
    const future = await recordBalances(post({ asOfDate: "2999-01-01", entries: [{ accountId: id, balance: "1" }] }));
    expect([future.status, (await json(future)).error]).toEqual([400, "future_date"]);
  });

  it("answers 404 for another household's account, and 409 for a Plaid account's name", async () => {
    const a = await signIn("a@example.test");
    const { id: aAccount } = (await (await createAccount(post({ name: "A's", kind: "checking" }))).json()) as { id: string };
    await seedConnection(owner, a.householdId);
    const plaid = await owner.account.findFirstOrThrow({ where: { householdId: a.householdId, plaidItemId: { not: null } } });

    const renamePlaid = await updateAccount(post({ name: "Renamed" }), withId(plaid.id));
    expect([renamePlaid.status, (await json(renamePlaid)).error]).toEqual([409, "not_manual"]);

    await signIn("b@example.test");
    for (const response of [
      await updateAccount(post({ ownerLabel: "x" }), withId(aAccount)),
      await archiveAccount(post({}), withId(aAccount)),
      await updateAccount(post({ ownerLabel: "x" }), withId("not-a-uuid")),
    ]) {
      expect(response.status).toBe(404);
    }
    expect((await owner.account.findUniqueOrThrow({ where: { id: aAccount } })).archivedAt).toBeNull();
  });

  it("refuses anonymous callers (401) and other origins (403) on every route", async () => {
    const calls = [
      () => createAccount(post({ name: "x", kind: "checking" }, "https://evil.example")),
      () => recordBalances(post({ asOfDate: "2026-11-14", entries: [] }, "https://evil.example")),
      () => setTimeZone(post({ timeZone: "America/New_York" }, "https://evil.example")),
      () => updateAccount(post({ ownerLabel: "x" }, "https://evil.example"), withId("00000000-0000-4000-8000-000000000000")),
      () => archiveAccount(post({}, "https://evil.example"), withId("00000000-0000-4000-8000-000000000000")),
    ];
    await signIn("a@example.test");
    for (const call of calls) expect((await call()).status).toBe(403);

    state.headers = new Headers();
    expect((await createAccount(post({ name: "x", kind: "checking" }))).status).toBe(401);
    expect((await recordBalances(post({ asOfDate: "2026-11-14", entries: [] }))).status).toBe(401);
    expect(await owner.account.count()).toBe(0);
  });
});
```

Before running, open `tests/plaid-lifecycle-routes.integration.test.ts` and check the status `authorizeMutation` returns for a wrong origin (`checkMutationOrigin` in `src/lib/auth/origin.ts`). If it is not 403, use that status in the last test.

- [ ] **Step 3: Run to verify it fails**

Run: `docker compose exec app npx vitest run --config vitest.integration.config.mts tests/accounts-routes.integration.test.ts`
Expected: FAIL, "Failed to resolve import ... app/api/accounts/route".

- [ ] **Step 4: Implement the error mapping and the routes**

`src/features/accounts/http.ts`:

```ts
import "server-only";
import { jsonNoStore } from "@/lib/http";
import { AccountInputError, type AccountErrorCode } from "./manual";

const MAPPED: Record<AccountErrorCode, { status: number; message: string }> = {
  account_not_found: { status: 404, message: "That account was not found." },
  not_manual: { status: 409, message: "That account comes from a connected bank, so it can't be changed this way." },
  archived: { status: 409, message: "That account is archived." },
  time_zone_required: { status: 409, message: "Set your household's time zone first." },
  future_date: { status: 400, message: "That date is in the future." },
};

/** Fixed messages only; internal errors are logged by name, never by content. */
export function accountErrorResponse(error: unknown, route: string): Response {
  if (error instanceof AccountInputError) {
    const mapped = MAPPED[error.code];
    return jsonNoStore({ error: error.code, message: mapped.message }, mapped.status);
  }
  console.error(`[accounts] ${route} failed unexpectedly`, { name: error instanceof Error ? error.name : typeof error });
  return jsonNoStore({ error: "internal_error", message: "Something went wrong." }, 500);
}

export const accountNotFound = () => accountErrorResponse(new AccountInputError("account_not_found"), "lookup");
```

`src/app/api/accounts/route.ts`:

```ts
import { accountErrorResponse } from "@/features/accounts/http";
import { createAccountInput } from "@/features/accounts/input";
import { createManualAccount } from "@/features/accounts/manual";
import { authorizeMutation } from "@/lib/auth/household";
import { getDb } from "@/lib/db";
import { badRequest, jsonNoStore, readJson } from "@/lib/http";

// Adds an account entered by hand (one not linked through Plaid).
export async function POST(request: Request) {
  const authorization = await authorizeMutation(request);
  if (!authorization.ok) return authorization.response;

  const body = await readJson(request, createAccountInput);
  if (!body) return badRequest();
  try {
    const { id } = await createManualAccount(getDb(), authorization.context.householdId, body);
    return jsonNoStore({ id }, 201);
  } catch (error) {
    return accountErrorResponse(error, "accounts.create");
  }
}
```

`src/app/api/accounts/[id]/update/route.ts`:

```ts
import { z } from "zod";
import { accountErrorResponse, accountNotFound } from "@/features/accounts/http";
import { updateAccountInput } from "@/features/accounts/input";
import { updateAccount } from "@/features/accounts/manual";
import { authorizeMutation } from "@/lib/auth/household";
import { getDb } from "@/lib/db";
import { badRequest, jsonNoStore, readJson } from "@/lib/http";

// Changes an account's name (hand-entered only), owner label, cushion or forecast setting.
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const authorization = await authorizeMutation(request);
  if (!authorization.ok) return authorization.response;

  const id = z.uuid().safeParse((await context.params).id);
  if (!id.success) return accountNotFound();
  const body = await readJson(request, updateAccountInput);
  if (!body) return badRequest();
  try {
    await updateAccount(getDb(), authorization.context.householdId, id.data, body);
    return jsonNoStore({ ok: true });
  } catch (error) {
    return accountErrorResponse(error, "accounts.update");
  }
}
```

`src/app/api/accounts/[id]/archive/route.ts`:

```ts
import { z } from "zod";
import { accountErrorResponse, accountNotFound } from "@/features/accounts/http";
import { archiveManualAccount } from "@/features/accounts/manual";
import { authorizeMutation } from "@/lib/auth/household";
import { getDb } from "@/lib/db";
import { badRequest, jsonNoStore, readJson } from "@/lib/http";

// Archives a hand-entered account. Its balances stay as history.
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const authorization = await authorizeMutation(request);
  if (!authorization.ok) return authorization.response;

  const id = z.uuid().safeParse((await context.params).id);
  if (!id.success) return accountNotFound();
  if (!(await readJson(request, z.strictObject({})))) return badRequest();
  try {
    await archiveManualAccount(getDb(), authorization.context.householdId, id.data);
    return jsonNoStore({ ok: true });
  } catch (error) {
    return accountErrorResponse(error, "accounts.archive");
  }
}
```

`src/app/api/balances/route.ts`:

```ts
import { accountErrorResponse } from "@/features/accounts/http";
import { recordBalancesInput } from "@/features/accounts/input";
import { recordBalances } from "@/features/accounts/manual";
import { authorizeMutation } from "@/lib/auth/household";
import { getDb } from "@/lib/db";
import { badRequest, jsonNoStore, readJson } from "@/lib/http";

// Records the balances of several hand-entered accounts as of one date, all or nothing.
export async function POST(request: Request) {
  const authorization = await authorizeMutation(request);
  if (!authorization.ok) return authorization.response;

  const body = await readJson(request, recordBalancesInput);
  if (!body) return badRequest();
  try {
    return jsonNoStore(await recordBalances(getDb(), authorization.context.householdId, body));
  } catch (error) {
    return accountErrorResponse(error, "balances.record");
  }
}
```

`src/app/api/household/time-zone/route.ts`:

```ts
import { accountErrorResponse } from "@/features/accounts/http";
import { timeZoneInput } from "@/features/accounts/input";
import { setHouseholdTimeZone } from "@/features/accounts/manual";
import { authorizeMutation } from "@/lib/auth/household";
import { getDb } from "@/lib/db";
import { badRequest, jsonNoStore, readJson } from "@/lib/http";

// Sets the household's time zone, which decides what "today" is.
export async function POST(request: Request) {
  const authorization = await authorizeMutation(request);
  if (!authorization.ok) return authorization.response;

  const body = await readJson(request, timeZoneInput);
  if (!body) return badRequest();
  try {
    await setHouseholdTimeZone(getDb(), authorization.context.householdId, body.timeZone);
    return jsonNoStore({ ok: true });
  } catch (error) {
    return accountErrorResponse(error, "household.timeZone");
  }
}
```

- [ ] **Step 5: Run the route tests and the static security rules**

Run:

```bash
docker compose exec app npx vitest run --config vitest.integration.config.mts tests/accounts-routes.integration.test.ts
docker compose exec app npx vitest run tests/security-static.test.ts
```

Expected: PASS. The static test finds the five new routes automatically and confirms each calls `authorizeMutation(request)` before `readJson` or `getDb`.

- [ ] **Step 6: Check the tests catch a missing guard**

Temporarily delete the two `authorizeMutation` lines (and the `authorization.context.householdId` use, replaced by a literal uuid) from `src/app/api/balances/route.ts` and run both commands from Step 5. Expected: both FAIL (the route test gets something other than 403/401, and the static test names the file). Put the lines back exactly as in Step 4 and confirm both pass again.

- [ ] **Step 7: Commit**

```bash
git add src/lib/http.ts src/features/plaid/http.ts src/features/accounts/http.ts src/app/api/accounts src/app/api/balances src/app/api/household tests/accounts-routes.integration.test.ts
git commit -m "Add routes for hand-entered accounts, balances and the household time zone"
```

---

### Task 5: Pages and forms

**Files:**
- Create: `src/components/post-json.ts`, `src/components/accounts/time-zone-form.tsx`, `src/components/accounts/new-account-form.tsx`, `src/components/accounts/account-editor.tsx`, `src/components/accounts/balances-form.tsx`, `src/app/accounts/balances/page.tsx`
- Modify: `src/components/plaid-api.ts` (move `postJson` out, re-export it), `src/app/accounts/page.tsx`, `src/app/page.tsx`, `src/app/globals.css` (two small classes)
- Test: `tests/accounts.e2e.spec.ts`

**Interfaces:**
- Consumes: the routes from Task 4; `listAccountsWithLatestBalance` (Task 2); `formatMoney`, `formatDate`, `formatTimestamp`, `describeAge`, `maskAccount`, `STALE_AFTER_MS` (`src/features/plaid/format.ts`); `todayIn`, `toIsoDate`, `daysBetween` (Task 1); `ACCOUNT_KINDS` (Task 3).
- Produces: pages `/accounts` and `/accounts/balances`.

- [ ] **Step 1: Write the failing browser test**

`tests/accounts.e2e.spec.ts`:

```ts
import { expect, test } from "@playwright/test";
import { signInViaApi } from "./e2e/helpers";

// Runs against the throwaway E2E household (tests/e2e/global-setup.ts), which
// starts with no time zone and three synthetic Plaid connections.

test("add an account by hand, record its balance, then archive it", async ({ page }) => {
  await signInViaApi(page);
  await page.goto("/accounts");

  // No time zone yet: the page asks for one before balances can be entered.
  await page.getByLabel("Household time zone").selectOption("America/New_York");
  await page.getByRole("button", { name: "Save time zone" }).click();
  await expect(page.getByText("Time zone: America/New_York")).toBeVisible();

  await page.getByRole("button", { name: "Add an account" }).click();
  await page.getByLabel("Name").fill("E2E Hand Checking");
  await page.getByLabel("Kind").selectOption("checking");
  await page.getByLabel("Owner").fill("Shared");
  await page.getByLabel("Cushion").fill("1,500");
  await page.getByRole("button", { name: "Add account" }).click();
  const card = page.locator(".card", { hasText: "E2E Hand Checking" });
  await expect(card).toContainText("Entered by hand");
  await expect(card).toContainText("Shared");
  await expect(card).toContainText("No balance recorded yet.");

  await page.getByRole("link", { name: "Update balances" }).first().click();
  await expect(page).toHaveURL(/\/accounts\/balances$/);
  // Plaid-linked accounts are not offered here.
  await expect(page.getByText("E2E Checking", { exact: true })).toHaveCount(0);
  await page.getByLabel("New balance for E2E Hand Checking").fill("2,431.07");
  await page.getByRole("button", { name: "Save balances" }).click();

  await expect(page).toHaveURL(/\/accounts$/);
  await expect(card).toContainText("$2,431.07");
  await expect(card).toContainText("As of");

  page.once("dialog", (dialog) => void dialog.accept());
  await card.getByRole("button", { name: "Archive" }).click();
  await expect(card).toContainText("Archived");
  await page.goto("/accounts/balances");
  await expect(page.getByLabel("New balance for E2E Hand Checking")).toHaveCount(0);
});

test("an unreadable amount and a future date are refused with a message", async ({ page }) => {
  await signInViaApi(page);
  await page.goto("/accounts/balances");
  const origin = { origin: new URL(page.url()).origin };
  // The previous test (same household) set the time zone and archived its
  // account, so add a fresh one through the API to keep this test independent.
  const created = await page.request.post("/api/accounts", { headers: origin, data: { name: "E2E Hand Savings", kind: "savings" } });
  expect(created.status()).toBe(201);
  const { id } = (await created.json()) as { id: string };
  await page.reload();

  await page.getByLabel("New balance for E2E Hand Savings").fill("12.345");
  await page.getByRole("button", { name: "Save balances" }).click();
  await expect(page.getByRole("alert")).toContainText("E2E Hand Savings");

  // The date field's `max` stops the browser from sending a future date, so
  // the server's own refusal is checked directly.
  const future = await page.request.post("/api/balances", {
    headers: origin,
    data: { asOfDate: "2999-01-01", entries: [{ accountId: id, balance: "10" }] },
  });
  expect(future.status()).toBe(400);
  expect(((await future.json()) as { message: string }).message).toBe("That date is in the future.");
});
```

The second test relies on the first having set the time zone (both run in the same throwaway household). Check `playwright.config.ts` runs tests in one worker and in file order, as the existing suites rely on; if it does not, set the time zone through `page.request.post("/api/household/time-zone", …)` at the start of the second test instead.

- [ ] **Step 2: Run to verify it fails**

Run (on the host, with the dev stack up): `npx playwright test tests/accounts.e2e.spec.ts`
Expected: FAIL, the time zone field is not found.

- [ ] **Step 3: Move `postJson`**

Create `src/components/post-json.ts` with the `ApiError` type and the `postJson` function cut from `src/components/plaid-api.ts`, unchanged, under this comment:

```ts
// Small client-side helper for the app's own JSON routes (never a third party).
```

In `src/components/plaid-api.ts` replace them with `export { postJson } from "./post-json";`.

- [ ] **Step 4: Add the client forms**

`src/components/accounts/time-zone-form.tsx`:

```tsx
"use client";

import { useRouter } from "next/navigation";
import { useState, useSyncExternalStore } from "react";
import { postJson } from "../post-json";

const subscribeToNothing = () => () => {};
const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const noZone = () => null;

/**
 * Offers every IANA zone (the list comes from the server, so server and browser
 * render the same options), preselecting the browser's own zone once it is
 * known. Nothing is saved until the person confirms.
 */
export function TimeZoneForm({ current, zones }: { current: string | null; zones: string[] }) {
  const router = useRouter();
  // null while server-rendering, the browser's zone after hydration.
  const guessed = useSyncExternalStore(subscribeToNothing, browserZone, noZone);
  const [chosen, setChosen] = useState<string | null>(current);
  const value = chosen ?? (guessed && zones.includes(guessed) ? guessed : "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!value) return setError("Choose a time zone.");
    setSaving(true);
    const result = await postJson("/api/household/time-zone", { timeZone: value });
    setSaving(false);
    if (!result.ok) return setError(result.message);
    setError(null);
    router.refresh();
  }

  return (
    <form className="form inline-form" onSubmit={save}>
      <label>
        Household time zone
        <select value={value} onChange={(e) => setChosen(e.target.value)}>
          {!value && <option value="">Choose…</option>}
          {zones.map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" disabled={saving}>
        Save time zone
      </button>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </form>
  );
}
```

`src/components/accounts/new-account-form.tsx`:

```tsx
"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "../post-json";

export function NewAccountForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}>
        Add an account
      </button>
    );
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setSaving(true);
    const result = await postJson("/api/accounts", {
      name: String(data.get("name") ?? ""),
      kind: String(data.get("kind") ?? ""),
      ownerLabel: String(data.get("ownerLabel") ?? ""),
      cushion: String(data.get("cushion") ?? ""),
    });
    setSaving(false);
    if (!result.ok) return setError(result.message);
    setOpen(false);
    setError(null);
    router.refresh();
  }

  return (
    <form className="form card" onSubmit={submit}>
      <label>
        Name
        <input name="name" required maxLength={80} />
      </label>
      <label>
        Kind
        <select name="kind" defaultValue="checking">
          <option value="checking">Checking</option>
          <option value="savings">Savings</option>
          <option value="credit_card">Credit card</option>
        </select>
      </label>
      <label>
        Owner <span className="muted">(a label, such as Drake, Alexis or Shared)</span>
        <input name="ownerLabel" maxLength={40} />
      </label>
      <label>
        Cushion <span className="muted">(warn when the forecast goes below this; optional)</span>
        <input name="cushion" inputMode="decimal" />
      </label>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="submit" disabled={saving}>
          Add account
        </button>
        <button type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
```

`src/components/accounts/account-editor.tsx`:

```tsx
"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "../post-json";

type Props = {
  id: string;
  manual: boolean;
  isCredit: boolean;
  name: string;
  ownerLabel: string | null;
  cushion: string | null;
  includeInForecast: boolean;
};

/** Edit and Archive for one account. Plaid-linked accounts keep their bank's name and cannot be archived here. */
export function AccountEditor(props: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const body: Record<string, unknown> = {
      ownerLabel: String(data.get("ownerLabel") ?? ""),
      cushion: String(data.get("cushion") ?? ""),
    };
    if (props.manual) body.name = String(data.get("name") ?? "");
    if (!props.isCredit) body.includeInForecast = data.get("includeInForecast") === "on";
    const result = await postJson(`/api/accounts/${props.id}/update`, body);
    if (!result.ok) return setError(result.message);
    setOpen(false);
    setError(null);
    router.refresh();
  }

  async function archive() {
    if (!window.confirm(`Archive ${props.name}? Its balance history is kept.`)) return;
    const result = await postJson(`/api/accounts/${props.id}/archive`, {});
    if (!result.ok) return setError(result.message);
    router.refresh();
  }

  if (!open) {
    return (
      <div className="actions">
        <button type="button" onClick={() => setOpen(true)}>
          Edit
        </button>
        {props.manual && (
          <button type="button" onClick={archive}>
            Archive
          </button>
        )}
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <form className="form" onSubmit={save}>
      {props.manual && (
        <label>
          Name
          <input name="name" defaultValue={props.name} required maxLength={80} />
        </label>
      )}
      <label>
        Owner
        <input name="ownerLabel" defaultValue={props.ownerLabel ?? ""} maxLength={40} />
      </label>
      <label>
        Cushion
        <input name="cushion" defaultValue={props.cushion ?? ""} inputMode="decimal" />
      </label>
      {!props.isCredit && (
        <label className="checkbox">
          <input type="checkbox" name="includeInForecast" defaultChecked={props.includeInForecast} /> Include in the forecast
        </label>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="submit">Save</button>
        <button type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
```

`src/components/accounts/balances-form.tsx`:

```tsx
"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { parseMoney } from "@/lib/money";
import { postJson } from "../post-json";

export type BalanceRow = {
  id: string;
  name: string;
  ownerLabel: string | null;
  owedLabel: boolean;
  last: { amount: string; asOf: string } | null;
};

/** One "as of" date, one field per account; a blank field means "no change". */
export function BalancesForm({ rows, today }: { rows: BalanceRow[]; today: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const entries: { accountId: string; balance: string }[] = [];
    for (const row of rows) {
      const typed = String(data.get(row.id) ?? "").trim();
      if (typed === "") continue;
      // Checked here only to name the field; the server checks again.
      if (parseMoney(typed, { allowNegative: true }) === null) {
        return setError(`"${typed}" for ${row.name} is not an amount (use at most two decimal places).`);
      }
      entries.push({ accountId: row.id, balance: typed });
    }
    if (entries.length === 0) return setError("Enter at least one balance.");

    setSaving(true);
    const result = await postJson("/api/balances", {
      asOfDate: String(data.get("asOfDate") ?? ""),
      note: String(data.get("note") ?? ""),
      entries,
    });
    setSaving(false);
    if (!result.ok) return setError(result.message);
    router.push("/accounts");
    router.refresh();
  }

  return (
    <form className="form" onSubmit={submit}>
      <label>
        As of <span className="muted">(the balance at the end of this day)</span>
        <input type="date" name="asOfDate" defaultValue={today} max={today} required />
      </label>
      <table className="table">
        <thead>
          <tr>
            <th>Account</th>
            <th>Owner</th>
            <th className="num">Last balance</th>
            <th>New balance</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>
                {row.name}
                {row.owedLabel && <span className="muted"> (owed)</span>}
              </td>
              <td>{row.ownerLabel ?? ""}</td>
              <td className="num">{row.last ? `${row.last.amount} · ${row.last.asOf}` : "none yet"}</td>
              <td>
                <input name={row.id} inputMode="decimal" aria-label={`New balance for ${row.name}`} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <label>
        Note <span className="muted">(optional)</span>
        <input name="note" maxLength={200} />
      </label>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <button type="submit" disabled={saving}>
        Save balances
      </button>
    </form>
  );
}
```

Note: the "Last balance" column passes pre-formatted strings from the server page (below), so the client never formats Decimals itself.

- [ ] **Step 5: Rewrite the Accounts page and add Update balances**

Replace the `Accounts` component in `src/app/accounts/page.tsx` (keep `AccountsPage`, `metadata` and `balanceLabels`):

```tsx
async function Accounts() {
  const { householdId } = await requireHouseholdOrRedirect();
  const db = getDb();
  const [household, accounts] = await Promise.all([
    db.household.findUniqueOrThrow({ where: { id: householdId }, select: { timeZone: true } }),
    listAccountsWithLatestBalance(db, householdId, getPlaidEnvironment()),
  ]);
  const now = new Date();
  const today = household.timeZone ? todayIn(household.timeZone, now) : null;

  return (
    <>
      <section className="notice">
        {household.timeZone ? (
          <p>
            Time zone: {household.timeZone} · <Link href="/accounts/balances">Update balances</Link>
          </p>
        ) : (
          <p>Choose your household&apos;s time zone. It decides what &quot;today&quot; is for balances and the forecast.</p>
        )}
        <TimeZoneForm current={household.timeZone} zones={Intl.supportedValuesOf("timeZone")} />
      </section>
      <NewAccountForm />
      {accounts.length === 0 ? (
        <p className="muted">
          No accounts yet. Add one by hand, or <Link href="/connections">connect a bank</Link>.
        </p>
      ) : (
        <ul className="cards">
          {accounts.map((account) => {
            const balance = account.balances[0] ?? null;
            const labels = balanceLabels(account.type);
            const manual = account.plaidItem === null;
            const archived = account.archivedAt !== null;
            const manualAsOf = balance?.asOfDate ? toIsoDate(balance.asOfDate) : null;
            const stale = balance
              ? manualAsOf
                ? today !== null && daysBetween(manualAsOf, today) > 7
                : now.getTime() - balance.observedAt.getTime() > STALE_AFTER_MS
              : false;
            return (
              <li key={account.id} className="card">
                <h2>
                  {account.name} {!manual && <span className="muted">{maskAccount(account.mask)}</span>}
                  {account.ownerLabel && <span className="chip">{account.ownerLabel}</span>}
                  {archived && <span className="chip chip-muted">Archived</span>}
                  {!manual && !account.active && (
                    <span className="chip chip-muted">
                      {account.plaidItem?.status === "DISCONNECTED" ? "Disconnected · history kept" : "Not reported by bank"}
                    </span>
                  )}
                </h2>
                <p className="muted">
                  {manual ? "Entered by hand" : (account.plaidItem?.institutionName ?? "Bank")} · {account.subtype ?? account.type}
                  {account.cushion !== null && <> · cushion {formatMoney(account.cushion.toFixed(), account.currency)}</>}
                </p>
                {balance ? (
                  <>
                    <dl className="balances">
                      <div>
                        <dt>{labels.current}</dt>
                        <dd>{formatMoney(balance.current?.toFixed() ?? null, balance.currency)}</dd>
                      </div>
                      {!manual && (
                        <div>
                          <dt>{labels.available}</dt>
                          <dd>{formatMoney(balance.available?.toFixed() ?? null, balance.currency)}</dd>
                        </div>
                      )}
                      {balance.limit !== null && (
                        <div>
                          <dt>{labels.limit}</dt>
                          <dd>{formatMoney(balance.limit.toFixed(), balance.currency)}</dd>
                        </div>
                      )}
                    </dl>
                    <p className="muted">
                      As of{" "}
                      {balance.asOfDate ? (
                        <time dateTime={manualAsOf ?? undefined}>{formatDate(balance.asOfDate)}</time>
                      ) : (
                        <>
                          <time dateTime={balance.observedAt.toISOString()}>{formatTimestamp(balance.observedAt)}</time> (
                          {describeAge(balance.observedAt, now)})
                        </>
                      )}
                      {stale && <span className="chip chip-warn">May be out of date</span>}
                      {balance.note && <> · {balance.note}</>}
                    </p>
                  </>
                ) : (
                  <p className="muted">No balance recorded yet.</p>
                )}
                {!archived && (
                  <AccountEditor
                    id={account.id}
                    manual={manual}
                    isCredit={account.type === "credit"}
                    name={account.name}
                    ownerLabel={account.ownerLabel}
                    cushion={account.cushion?.toFixed() ?? null}
                    includeInForecast={account.includeInForecast}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
```

Add the imports this needs: `formatDate` from `@/features/plaid/format`; `daysBetween`, `toIsoDate`, `todayIn` from `@/lib/calendar-date`; `AccountEditor`, `NewAccountForm`, `TimeZoneForm` from `@/components/accounts/…`. Remove the `unavailableSince` sentence from the old Plaid branch only if typecheck flags it as unused; otherwise keep it after the "As of" line exactly as it was.

`src/app/accounts/balances/page.tsx`:

```tsx
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { BalancesForm, type BalanceRow } from "@/components/accounts/balances-form";
import { TimeZoneForm } from "@/components/accounts/time-zone-form";
import { formatDate, formatMoney } from "@/features/plaid/format";
import { requireHouseholdOrRedirect } from "@/lib/auth/household";
import { todayIn } from "@/lib/calendar-date";
import { getDb } from "@/lib/db";

export const metadata: Metadata = { title: "Update balances · Home Finances" };

export default function UpdateBalancesPage() {
  return (
    <main>
      <p>
        <Link href="/accounts">← Accounts</Link>
      </p>
      <h1>Update balances</h1>
      <Suspense fallback={<p className="muted">Loading…</p>}>
        <Balances />
      </Suspense>
    </main>
  );
}

async function Balances() {
  const { householdId } = await requireHouseholdOrRedirect();
  const db = getDb();
  const [household, accounts] = await Promise.all([
    db.household.findUniqueOrThrow({ where: { id: householdId }, select: { timeZone: true } }),
    // Hand-entered, not archived. Plaid-linked accounts get their balances from the bank.
    db.account.findMany({
      where: { householdId, plaidItemId: null, archivedAt: null },
      include: { balances: { orderBy: [{ asOfDate: { sort: "desc", nulls: "last" } }, { observedAt: "desc" }], take: 1 } },
      orderBy: { name: "asc" },
    }),
  ]);

  if (!household.timeZone) {
    return (
      <section className="notice">
        <p>Choose your household&apos;s time zone first. It decides what &quot;today&quot; is.</p>
        <TimeZoneForm current={null} zones={Intl.supportedValuesOf("timeZone")} />
      </section>
    );
  }
  if (accounts.length === 0) {
    return (
      <p className="muted">
        No hand-entered accounts yet. <Link href="/accounts">Add one</Link> first.
      </p>
    );
  }

  const rows: BalanceRow[] = accounts.map((account) => {
    const last = account.balances[0];
    return {
      id: account.id,
      name: account.name,
      ownerLabel: account.ownerLabel,
      owedLabel: account.type === "credit",
      last:
        last && last.asOfDate
          ? { amount: formatMoney(last.current?.toFixed() ?? null, last.currency), asOf: formatDate(last.asOfDate) }
          : null,
    };
  });
  return <BalancesForm rows={rows} today={todayIn(household.timeZone)} />;
}
```

In `src/app/page.tsx`, add a list item after Accounts:

```tsx
        <li>
          <Link href="/accounts/balances">Update balances</Link> — record hand-entered balances as of a date
        </li>
```

In `src/app/globals.css`, at the end:

```css
.inline-form {
  flex-direction: row;
  flex-wrap: wrap;
  align-items: end;
}

.form .checkbox {
  flex-direction: row;
  align-items: center;
  gap: 0.4rem;
}
```

Before adding them, read `.form` and `.form label` in `globals.css` (lines 61-82). If `.form` is not a flex column, adjust these two rules to match how it lays out (the goal: the time zone select and its button on one line; the checkbox beside its text).

- [ ] **Step 6: Run the checks**

Run:

```bash
docker compose exec app npm run lint
docker compose exec app npm run typecheck
npx playwright test tests/accounts.e2e.spec.ts
npx playwright test
```

(The last two on the host.) Expected: lint and typecheck clean; the new browser tests pass; the whole browser suite passes (39 before, 41 after). If an existing Accounts test fails because the page now shows a time zone notice or an "Add an account" button, update only that test's locator, not the page.

- [ ] **Step 7: Look at it**

Open <http://localhost:3000/accounts> (or the https address if that mode is on) signed in as the real user: the time zone form, the Plaid Sandbox accounts as before, Add an account, Edit. Do not add real accounts yet unless the user wants to; the import (build step 4) will create them.

- [ ] **Step 8: Commit**

```bash
git add src/components src/app/accounts src/app/page.tsx src/app/globals.css tests/accounts.e2e.spec.ts
git commit -m "Add hand-entered accounts and the Update balances page"
```

---

### Task 6: Docs and full verification

**Files:**
- Modify: `docs/local-development.md` (table of common tasks), `README.md` (feature list and layout lines)

- [ ] **Step 1: Document**

In `docs/local-development.md`, in the table of common tasks, add:

```markdown
| Add an account by hand | Accounts → **Add an account** |
| Record balances by hand | Accounts → **Update balances** (one date, many accounts) |
```

In `README.md`, where the features and the source layout are listed, add one line each for hand-entered accounts and balances (`src/features/accounts/`), matching the surrounding style. Mention that hand-entered balances are real financial data, so backups matter from now on.

- [ ] **Step 2: Run everything**

Run:

```bash
docker compose exec app npm run lint
docker compose exec app npm run typecheck
docker compose exec app npm test
docker compose exec app npm run test:integration
docker compose exec app npm run build
```

On the host:

```bash
npx playwright test
npm run test:backup
npm run verify:image
```

Expected: all pass. Record the counts (unit, integration, browser) for the summary. `test:backup` proves a backup and restore still round-trips with the new columns and the check constraints; `verify:image` proves the production image builds and the browser suite passes against it.

- [ ] **Step 3: Check the safeguards are tested**

One at a time, make each change, run the named test, confirm it FAILS, and undo it:

1. In the second migration, delete the `Account_plaid_link_complete` constraint → `tests/manual-accounts.integration.test.ts` ("refuses half a Plaid link") fails. (Integration databases are rebuilt from the migrations on each run.)
2. In `recordBalances`, remove the `future_date` check → "decides 'the future' in the household's time zone" fails.
3. In `recordBalances`, drop `householdId` from the `findMany` filter → "writes nothing when any account is foreign…" fails.

- [ ] **Step 4: Commit**

```bash
git add docs/local-development.md README.md
git commit -m "Document hand-entered accounts and balances"
```

---

## Steps 2 to 6 (outline; each gets its own plan when step 1 is done)

**Step 2: Rules.** Tables `Rule`, `RuleVersion`, `Allocation`, `OccurrenceOverride` exactly as in the spec's data model, with the database rules in a separate check-constraint migration (including the `btree_gist` exclusion constraint against overlapping versions). A server-only `src/features/rules/` service: create rule (first version and allocations together), Change from (end plus copy in one transaction), Stop on, Edit this version, archive; the multi-row validation rules from the spec ("Rules enforced by the server"). Screens: Bills & income list (grouped; "≈ per month"), a rule's page with the version timeline, the Change from dialog with its preview. Recurrence lives in a pure `src/features/forecast/recurrence.ts` built here because the rule page's "next 10 occurrences" and the preview need it: `occurrences(version, from, to): IsoDate[]`, tested exhaustively at month ends, leap years, every-N anchors and version boundaries.

**Step 3: Forecast engine and Home.** Pure `src/features/forecast/engine.ts`: input (rules with versions and allocations, overrides, latest snapshot per account, today, window) → per-account daily series and flags, following the spec's seven forecast rules; split rounding with the remainder; "Did it clear?" selection. Fixed test cases from the workbook (Ally Spend −$334.13 at the end of Dec 1, −$627.30 at the end of Dec 2, with the November card rows at $0). Home: 90-day chart per cash account against its cushion, Needs attention, next 7 days.

**Step 4: Workbook import.** `scripts/import-workbook.mts` (run as `npm run import:workbook -- imports/<file>.xlsx`), reading the file with a maintained xlsx library chosen at that point; `imports/` ignored by git and Docker. Dry run by default; questions answered in `imports/choices.json`; `--apply` in one transaction, refusing a second import by `importRef`. The mapping table and the Bill Schedule / Cash Flow checks from the spec. It reminds the person to back up first.

**Step 5: Register, Calendar and the occurrence panel.** Register (running balance per item), Calendar (month grid, end-of-day balances), the occurrence panel (status, confirmed amount, move, note, effect on the lowest point, Reset to rule), and the "Did it clear?" answers on Update balances.

**Step 6: Attaching a Plaid account.** First change the `Account` → `PlaidItem` relation so deleting a connection detaches an attached account instead of deleting it (and its history); tests for both kinds. Then the attach flow: choose the hand-entered account a newly linked Plaid account is; move the Plaid account's snapshots and transactions onto it and copy its Plaid fields, in one transaction. Before linking a real bank: disconnect and remove the Sandbox connection, and check what Sandbox rows remain.
