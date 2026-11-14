# Bills, income and cash-flow forecast: design

Date: 2026-11-14. Status: agreed in conversation, waiting for review of this write-up.

## Why

The household currently plans in a spreadsheet (`Home_Finances_Simplified_v2.xlsx`).
Its `Bill Schedule` is a list of pasted rows (86 of them, keyed like
`MORT-20261201`), and the person's own state (Status, Confirmed amount, a changed
date) lives in those same rows. Regenerating a month, or extending into the future,
means overwriting that state or writing a script. This design replaces the
spreadsheet's bills, pay and forecast with app features in which occurrences are
**computed** from rules and only the person's edits are stored, so nothing ever
needs regenerating.

## Scope

In this version:

- Hand-entered accounts (with an Owner label) and hand-entered balance snapshots.
- Rules for bills and income, with versions ("Change from…", "Stop on…").
- A cash-flow forecast per cash account, computed on demand.
- Screens: Home (overview), Register, Calendar, Bills & income, a rule's page, an
  occurrence panel, Update balances.
- A one-time import of the workbook.
- Later in the same version, once a real bank is linked: attaching a Plaid account
  to a hand-entered one.

Not in this version: savings goals, historical debt, card statement/balance
modelling, weekend or holiday date shifting, matching Plaid transactions to bills,
background jobs.

## Decisions made in conversation

| Question | Decision |
|---|---|
| First version's core | Bills and forecast (Bills → Schedule → Cash Flow → Dashboard) |
| Recurrence | Every N weeks/months; day-of-month past the month's end means the last day; start and end dates (versions) |
| Credit-card payments | A bill with an estimated amount; the confirmed amount replaces it per occurrence |
| Income | The same kind of rule as bills, with splits across accounts |
| Plaid account later | Attached to the existing hand-entered account (same id, history kept) |
| Engine | Computed when viewed (no stored occurrences, no regeneration) |
| Planned bill dated on/before the latest snapshot | Assumed included in the snapshot; shown as "Did it clear?" |
| Home screen | Overview (forecast chart, Needs attention, next 7 days); Register and Calendar as detail views |
| Owner | Kept as a label on accounts |
| Initial data | One-time import from the workbook, with review |

## Data model

### Changes to existing tables

**`Household`** gains `timeZone` (IANA name, such as `America/New_York`). It decides
what "today" is. It is nullable so the migration can add it to the existing
household; the forecast and the Update balances screen ask for it until it is set,
and no default is assumed.

**`Account`**

- `plaidItemId` and `externalAccountId` become nullable. A check constraint requires
  both or neither: an account is hand-entered (`both null`) or Plaid-linked.
- New: `ownerLabel` (nullable text: "Drake", "Alexis", "Shared"), `includeInForecast`
  (boolean, default true for depository accounts), `cushion` (nullable decimal; the
  balance below which the forecast warns), `archivedAt` (nullable).
- Credit accounts are never forecast, whatever `includeInForecast` says.
- The relation to `PlaidItem` currently cascades on delete. Before attaching is
  built (build step 6) this changes so that deleting a Plaid connection detaches an
  attached account (clears the two Plaid fields) instead of deleting it and its
  history. Accounts that only ever came from Plaid keep today's behaviour.
- New: `importRef` (nullable text; unique per household, `@@unique([householdId, importRef])`).
  Set only by the workbook import, so the import mapping's "importRef = Account ID"
  has a column. It arrives with build step 4.

**`BalanceSnapshot`**

- `BalanceSource` gains `MANUAL`.
- New: `asOfDate` (`@db.Date`, nullable; required when the source is `MANUAL`, by a
  check constraint) and `note` (nullable).
- The forecast uses `asOfDate`, or for Plaid snapshots the household-local date of
  `observedAt`. Among snapshots on the same date, the latest `observedAt` wins.
- For a credit account, `current` is the amount owed (Plaid's convention).

### New tables

```prisma
enum RuleKind { INCOME BILL }
enum Recurrence { ONCE WEEKLY MONTHLY TWICE_MONTHLY }
enum AllocationMode { PERCENT FIXED REMAINDER }
enum OccurrenceStatus { PLANNED CONFIRMED PAID SKIPPED }

model Rule {
  id            String    @id @default(uuid()) @db.Uuid
  householdId   String    @db.Uuid
  name          String
  kind          RuleKind
  category      String?
  notes         String?
  // Label only in this version: the card a card-payment bill pays ("→ Amex").
  paysAccountId String?   @db.Uuid
  // The workbook's id (MORT, NANNY, ...) for imported rules; unique per household.
  importRef     String?
  archivedAt    DateTime?
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt
  versions      RuleVersion[]
  overrides     OccurrenceOverride[]
  @@unique([householdId, importRef])
  @@index([householdId])
}

model RuleVersion {
  id            String     @id @default(uuid()) @db.Uuid
  ruleId        String     @db.Uuid
  effectiveFrom DateTime   @db.Date
  effectiveTo   DateTime?  @db.Date   // null = open-ended
  amount        Decimal    @db.Decimal(19, 4)
  recurrence    Recurrence
  interval      Int        @default(1)
  anchorDate    DateTime   @db.Date
  dayOfMonth    Int?
  secondDay     Int?
  note          String?
  createdAt     DateTime   @default(now())
  allocations   Allocation[]
  @@index([ruleId, effectiveFrom])
}

model Allocation {
  id            String         @id @default(uuid()) @db.Uuid
  ruleVersionId String         @db.Uuid
  accountId     String         @db.Uuid
  mode          AllocationMode
  value         Decimal?       @db.Decimal(19, 4)  // percent (0–100) or amount; null for REMAINDER
  @@unique([ruleVersionId, accountId])
}

model OccurrenceOverride {
  id              String           @id @default(uuid()) @db.Uuid
  householdId     String           @db.Uuid
  ruleId          String           @db.Uuid
  scheduledOn     DateTime         @db.Date   // the date the rule produced
  status          OccurrenceStatus @default(PLANNED)
  confirmedAmount Decimal?         @db.Decimal(19, 4)
  movedTo         DateTime?        @db.Date
  note            String?
  updatedAt       DateTime         @updatedAt
  updatedByUserId String?          @db.Uuid
  @@unique([ruleId, scheduledOn])
  @@index([householdId])
}
```

(Field lists are the design; exact relation and `onDelete` clauses are settled in the
implementation plan. Deleting a rule is not offered: rules are archived, so their
history and edits stay.)

### Rules enforced by the database

These are added in the migration SQL, so a bug elsewhere cannot get past them:

- Rule versions of one rule never overlap (exclusion constraint over a date range;
  needs the `btree_gist` extension, created by the owner role in the migration).
- `effectiveTo` is null or not before `effectiveFrom`; `anchorDate` is not before
  `effectiveFrom`.
- `amount` > 0; `interval` ≥ 1; `dayOfMonth` and `secondDay` in 1–31.
- `TWICE_MONTHLY`: `interval` = 1, `dayOfMonth` in 1–27 and `secondDay` >
  `dayOfMonth`, so the two dates can never fall on the same day.
- `WEEKLY` and `ONCE`: `dayOfMonth` and `secondDay` are null.
- Allocation: `PERCENT` value in (0, 100]; `FIXED` value > 0; `REMAINDER` value
  null; at most one `REMAINDER` per version (partial unique index).
- Override: `confirmedAmount` > 0 when present.
- Manual snapshots have an `asOfDate`; account Plaid fields are both set or both null.

### Rules enforced by the server

These involve several rows, so they are checked in the route, in the same
transaction as the write:

- Every version has at least one allocation. A version with more than one has
  exactly one `REMAINDER`, and its percentages and fixed amounts leave a remainder of
  at least zero.
- A bill version has exactly one allocation (`REMAINDER`): the account it is paid
  from. If that account is a credit card, the bill is informational (no cash effect).
- Income may not be allocated to a credit account.
- Every account used belongs to the same household and is not archived. Archiving an
  account that an open-ended or future version still uses is refused, naming the rules.
- Amounts have at most two decimal places.
- For `MONTHLY`, `anchorDate` must be a date the rule produces (its day equals
  `dayOfMonth`, after the month-end rule).

## Recurrence

A version produces dates within `[effectiveFrom, effectiveTo]` (inclusive; open-ended
means "up to the end of the requested window"):

- `ONCE`: `anchorDate`.
- `WEEKLY`: `anchorDate + 7 × interval × k` for k = 0, 1, 2, …
- `MONTHLY`: in the months `anchor month + interval × k`, on `dayOfMonth`, or the
  month's last day when the month is shorter (31 means "last day of the month").
- `TWICE_MONTHLY`: every month, on `dayOfMonth` and on `secondDay` (with the same
  month-end rule for `secondDay`).

Semiannual is `MONTHLY` with interval 6; quarterly 3; annual 12; biweekly is `WEEKLY`
with interval 2.

An occurrence's identity is `(ruleId, scheduledOn)`. The versions of a rule share it,
which is why a Paid mark survives a "Change from…".

**Change from date D** (one action, one transaction): set the current version's
`effectiveTo` to D − 1 and insert a copy, with the edited fields, from D. Its
`anchorDate` is the first date on or after D in the old pattern, unless the
recurrence itself is changed. **Stop on date D** sets `effectiveTo` = D. **Edit this
version** changes a version in place (for fixing mistakes).

Per-date edits whose `scheduledOn` the rule no longer produces (after an edit) are
kept and listed under Needs attention, never deleted silently.

## Forecast

Input: the household's rules (with versions and allocations), overrides, the latest
snapshot per account, the household's "today" and a window (default 90 days from
today). It is a pure function with no database access. Output per cash account: a
daily series with opening balance, items and end-of-day balance, plus flags.

1. **Start.** Each forecast account starts from its latest snapshot (end of its
   date). An account with no snapshot is not forecast and shows "Needs a balance".
2. **Which occurrences count.** For each account, occurrences whose effective date
   (`movedTo` if set, otherwise `scheduledOn`) is after that account's snapshot date,
   and whose status is not `SKIPPED`. Paid occurrences after the snapshot still
   count: Paid means the money has left, and the snapshot predates it. (This differs
   from the workbook, which treats Paid as $0.)
3. **Amount.** `confirmedAmount` if set, otherwise the version's amount, marked as an
   estimate.
4. **Splits.** Each allocation's share: `PERCENT` rounded half-up to the cent;
   `FIXED` as given; `REMAINDER` gets what is left, so the shares always add up to
   the amount exactly. Bills take their amount from their one account.
5. **Days.** Balances are end-of-day; items on the same day net out.
6. **Credit accounts** are not forecast. A bill paid from one has no cash effect.
7. **Flags per day:** below zero, below the account's cushion.

**Needs attention** (Home):

- days below the cushion, and below zero (with the lowest point);
- estimates due in the next 14 days;
- "Did it clear?": occurrences dated on or before the account's latest snapshot,
  within the 45 days before it, still `PLANNED` or `CONFIRMED`. Cleared sets `PAID`;
  Still pending sets `movedTo` to the day after the snapshot;
- snapshots older than 7 days;
- per-date edits whose date the rule no longer produces.

All money arithmetic uses decimals (no JavaScript floating point), as the existing
code does. Dates are calendar dates with no time of day.

## Screens

Navigation: Home · Register · Calendar · Bills & income · Accounts · Connections.

- **Home.** A 90-day chart per cash account against its cushion (one account at a
  time, Ally Spend first), Needs attention, and the next 7 days.
- **Register.** A checkbook-style list per account: each item with the running
  balance after it. Low and negative days are tinted, and estimates are italic.
  Clicking an item opens the occurrence panel.
- **Calendar.** A month grid with items on their days and the end-of-day balance.
  Clicking an item opens the occurrence panel.
- **Bills & income.** Rules grouped as Income / Paid from checking / On cards (shown,
  not counted as cash), with schedule, accounts, amount and an approximate monthly
  amount (weekly × 52 ÷ 12). Filters: Active / Ended / All.
- **A rule's page.** Its versions as a timeline; Change from… (with a preview of the
  next occurrences and the change per account), Stop on…, Edit this version; the next
  10 occurrences with any edits.
- **Occurrence panel.** Status, confirmed amount, move this one, note; the effect on
  the account's lowest point; Save and Reset to rule (which deletes the edit).
- **Accounts / Update balances.** Every account with its owner, last balance and
  date; one "as of" date and a new-balance field per account (blank means no
  change); saving then offers the "Did it clear?" questions. Plaid-linked accounts
  are shown read-only.

All writes go through the same session, origin and household checks as the existing
Plaid routes, with strict request bodies.

## Workbook import

A command, not part of the app's pages:

```bash
docker compose exec app npm run import:workbook -- imports/Home_Finances_Simplified_v2.xlsx
```

- The file is copied into `imports/` in the repository, which is ignored by git and by
  the Docker build. The importer reads only that file and never contacts anything.
- **Dry run by default.** It prints what it would create and every question it
  cannot answer from the workbook, and writes nothing. `--apply` writes it all in one
  transaction, and refuses if any question is unanswered, or if the household
  already has imported rows (matched by `importRef`), so it cannot run twice.
- Answers to its questions go in a small `imports/choices.json` (also ignored).
- It reminds the person to run a backup before `--apply`.

**Mapping:**

| Workbook | Becomes |
|---|---|
| `Accounts` | Hand-entered accounts. Type Checking/Savings → depository; Credit card → credit. Owner → `ownerLabel`. `importRef` = Account ID. |
| `Accounts` latest balances + `Balance History` | `MANUAL` snapshots, one per account and date (duplicates on the same account and date are merged, newest value wins, and reported). |
| `Settings` cushion (1,500) | Ally Spend's `cushion`. |
| `Settings` pay rows | Two income rules: Drake weekly from the first payday, Alexis twice monthly on the two days; splits as given, savings as `REMAINDER`. `effectiveFrom` = forecast start. Optional future-change rows become a second version when filled in. |
| `Bills` | Bill rules, `effectiveFrom` = forecast start. Monthly → `MONTHLY` on the due day, anchored on its first `Bill Schedule` date; Weekly → `WEEKLY` anchored on its first schedule date; Semiannual → `MONTHLY` interval 6 anchored on its first schedule date. |
| `Bills` "Included in card payment" | Allocated to a card account: the workbook does not say which card for each, so these are questions. |
| `Bill Schedule` | Not copied. Used as a **check**: the imported rules must produce the same dates and amounts for Nov 2026 to Apr 2027, and every difference is reported. Rows with an amount different from the rule (the $0 Citi and PNC card rows in November) become questions: skip that occurrence, record a confirmed amount, or use the rule's amount. |
| `Cash Flow` | Not copied. If the file holds saved values, the engine's end-of-day Ally Spend and PNC balances are compared with them and differences are reported. |
| `START HERE`, `Dashboard`, `Savings Goals`, `Historical Debt` | Not imported in this version. |

After an import every imported rule is shown for review; the workbook's open
questions (unconfirmed first payday, estimated card payments) stay visible as
estimates rather than being decided by the import.

## Testing

- **Unit (no database), most of the tests:** recurrence at month ends in leap and
  ordinary years, every-N from an anchor, twice-monthly limits, version boundaries
  (including an occurrence exactly on a change date), split rounding, Paid / Skipped
  / moved occurrences on either side of a snapshot, "Did it clear?" selection, and the
  workbook's own figures as fixed cases (from the Nov 14 snapshots, with the
  November Citi and PNC card payments at $0 as the schedule has them: Ally Spend
  −$334.13 at the end of Dec 1 and −$627.30 at the end of Dec 2).
- **Integration (real throwaway database):** every constraint above, the routes and
  the household boundary, Change from… atomicity, archiving refusals, importer dry
  run versus `--apply`, and refusing a second import.
- **Browser:** add a rule; Change from…; mark Paid and confirm an amount; Update
  balances and answer "Did it clear?"; Home, Register and Calendar showing the same
  numbers.
- **Checking the tests:** deliberately break a few safeguards (overlapping versions,
  remainder rounding, the snapshot cut-off) and confirm a test fails.

## Build order

Each step is usable on its own and committed separately.

1. Hand-entered accounts and balance snapshots: schema changes, Accounts and Update
   balances, household time zone.
2. Rules: tables and constraints, Bills & income, the rule's page, Change from…,
   Stop on….
3. Forecast engine and Home.
4. Workbook import. (It needs steps 1 to 3 and checks its result against the
   engine; after it, the app has the real data.)
5. Register, Calendar, the occurrence panel, mark Paid, "Did it clear?".
6. When a real bank is linked: change the Plaid delete behaviour for attached
   accounts, then attach a Plaid account to a hand-entered one. Notes for this step:
   - The both-or-neither check means detach cannot use `onDelete: SetNull` (it would
     null one column at a time); detach clears both fields explicitly.
   - Transaction references Account by FK on `(accountId, plaidItemId)` and
     `Transaction.plaidItemId` is NOT NULL, so detach must move or delete the
     account's transactions first, in the same database transaction.
   - Attach must free the `[plaidItemId, externalAccountId]` unique key first.
   - Steps 3 and 6 share one "latest snapshot" helper using the effective date
     (`asOfDate`, or the household-local date of `observedAt` for Plaid snapshots;
     the later `observedAt` wins ties). The current `asOfDate`-nulls-last ordering is
     only correct while no account mixes snapshot kinds.

## Note on real data

Hand-entered and imported figures are the household's real finances, so the
database and its backups become sensitive from step 1. They stay in the current
database. Before a real bank is linked, the Sandbox connection is disconnected and
then removed through the existing Disconnect and Remove actions, so the preflight's
"no Sandbox data" check can pass; whether that leaves any other Sandbox rows (such as
link attempts) behind is checked then.
