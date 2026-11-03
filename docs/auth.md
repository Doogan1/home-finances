# Authentication and authorization (Task 3)

Home Finances is a closed, single-household app. Nobody can register through
the website: accounts are created on the command line by whoever runs the
stack. This document records what was chosen, why, and how to operate it.

## Choice: Better Auth

**Better Auth 1.7.15** handles sessions, cookies, sign-in and sign-out.
Passwords are hashed with **Argon2id** through `@node-rs/argon2` 2.2.2.

Why a library: the Next.js authentication guide (in
`node_modules/next/dist/docs/01-app/02-guides/authentication.md`) recommends one
over a hand-built solution, and the implementation plan asks for library-managed
sessions rather than hand-rolled cookies. Better Auth was picked from the
Next.js-compatible list because it:

- declares support for Next 16 and Prisma 7 (peer dependencies),
- keeps sessions in our PostgreSQL, so logout and revocation really delete the
  session on the server,
- has first-party origin (CSRF) checking and database-backed rate limiting,
- lets us supply our own password hashing, which is how Argon2id is used.

Alternatives considered: `iron-session`/`jose` only seal cookies, so session
storage, revocation, throttling and CSRF would all be hand-built; Auth.js is
oriented toward OAuth providers; Clerk is a hosted service, which conflicts with
the local-first goal.

### Trade-offs to know about

- Better Auth stores the **raw session token** in `Session.token`. The browser
  cookie holds the token **signed with `AUTH_SECRET`**, so a database read alone
  cannot forge a cookie, but a leak of both the database and `AUTH_SECRET` would
  allow session hijacking. Treat database dumps and `.env` as sensitive.
- It owns the `User`, `Session`, `AuthAccount`, `Verification` and `RateLimit`
  tables. We renamed its "account" table `AuthAccount` because `Account` already
  means a bank account here. `Verification` is required by its startup schema
  check but unused (no email verification or password reset).
- Its origin check is **off by default when `NODE_ENV=test`**. `createAuth` sets
  `disableCSRFCheck: false` and `disableOriginCheck: false` explicitly so that
  cannot happen by accident, and an integration test fails if it does.
- Its origin check applies to requests that carry cookies and to sign-in. A
  cross-origin sign-out without a cookie is a harmless no-op.

## How a request is authorized

```text
browser ──cookie──▶ proxy.ts ──▶ page / route handler ──▶ requireHousehold()
                    (cookie present?)                      (verify signature, find session row,
                                                            check expiry, find household membership)
```

- `src/proxy.ts` only checks that a session cookie exists, to redirect anonymous
  visitors with a real HTTP 307. **It is not the security boundary.**
- Every page, action and route handler must call `requireHousehold()` (or
  `requireHouseholdOrRedirect()` in pages) itself. The household id used in
  queries comes from that result, **never** from the browser.
- Custom mutation routes (Plaid link, exchange, sync, ...) start with
  `authorizeMutation(request)`, which checks `Origin` first (403) and then the
  session (401), before any database or provider work.
- Data helpers take the household id as a parameter and put it in the query, for
  example `findHouseholdPlaidItem(db, householdId, itemId)`. Another household's
  record is indistinguishable from a nonexistent one.

## Accounts: the bootstrap command

Run in a real terminal (the password is typed at a hidden prompt; it is never an
argument, environment variable or file):

```bash
docker compose exec app npm run auth:bootstrap
```

It creates the household and its first member (the owner). It refuses to run if
a household already exists. To add another person to the same household:

```bash
docker compose exec app npm run auth:bootstrap -- --add-member
```

Passwords must be 12–128 characters. There is no default password and no
password-reset flow; to change a password, delete the user's `AuthAccount` and
`User` rows and add them again (a reset command is out of scope for now).

## Cookies and sessions

| Setting | Value |
| --- | --- |
| Cookie flags | `HttpOnly`, `SameSite=Lax`, `Path=/` |
| `Secure` | On whenever `APP_URL` is `https://`. Plain `http://` is accepted **only** for `localhost`/`127.0.0.1`; any other `http` URL makes the app refuse to start auth rather than send cookies in clear text. |
| Lifetime | 7 days, extended at most once per day while in use |
| Logout | Deletes the session row; a copied cookie stops working immediately |
| Revoking everything | Delete rows from `Session` |

**Loopback development exception:** over `http://localhost:3000` the cookie is
not `Secure`. Browsers treat localhost as a secure context, so this is the only
place the flag is relaxed.

## Throttling

Failed and successful sign-ins to `/api/auth/sign-in/email` are limited to **5
per minute**, counted in the `RateLimit` table (so counters survive restarts).
The app does not trust `X-Forwarded-For`, so all attempts share a single
counter. For a one-household app that is the safe choice (an attacker cannot
dodge it by inventing addresses), with the cost that someone hammering the login
page can lock the owner out for up to a minute. When a trusted reverse proxy is
added (see the future-deployment notes in Task 7), configure
`advanced.ipAddress` with that proxy's address header.

## Tests

| Command | What it covers |
| --- | --- |
| `docker compose exec app npm test` | Argon2id hashing and policy, origin/cookie-security rules |
| `docker compose exec app npm run test:integration` | Real database: closed registration, bootstrap, sign-in, cookie flags, generic failures, throttling, forged/expired/revoked sessions, logout, cross-origin mutation, cross-household isolation, request guards |
| `npm run test:e2e` (on the host, stack running) | Real browser: anonymous redirect, sign-in/out, cookie replay after logout, throttling |

The browser tests run from the host against `http://localhost:3000`. They create
a labelled throwaway user (`e2e.<hex>@example.test`, household
`E2E test household ...`) in the development database through
`scripts/e2e-user.mts`, and delete it afterwards. They also clear the sign-in
counters at the start and end. First-time setup: `npx playwright install chromium`.
