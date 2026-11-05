# Running the app over https on your own computer

**Why:** Plaid requires an `https` redirect address for real (OAuth) banks such as
PNC. Its only exception is Sandbox, which accepts `http://localhost`. This setup
puts a small TLS proxy in front of the app so `https://localhost:3000` works,
without deploying anything or exposing anything to the internet.

It is **opt-in**. Normal development stays on plain `http://localhost:3000`.

## What it does

```text
your browser ──https──▶ proxy (Caddy, 127.0.0.1 only) ──http, private network──▶ app ──▶ database
```

- The proxy is the **only** thing published to your computer, on `127.0.0.1`
  (loopback), so other machines on your network cannot reach it. With this
  setup the app itself is no longer published at all.
- It uses a certificate you make (below). Nothing is fetched from the internet and
  no port 80 is opened.
- Session cookies become `Secure`, and the app's origin check uses the https
  address, exactly as it would in a real deployment.

## Set it up

1. **Install `mkcert`** (a small tool that makes certificates your own computer
   trusts). For example `winget install FiloSottile.mkcert`, or Scoop/Chocolatey.
   This installs software, so it is yours to do.

2. **Create and trust a local certificate authority** (once):

   ```bash
   mkcert -install
   ```

   Read this one: it adds a certificate authority to your Windows trust store, and
   anything signed by it is trusted by your browsers. Its private key (find the folder
   with `mkcert -CAROOT`) must stay private on your computer, and you can remove it
   any time with `mkcert -uninstall`. If you prefer not to have a local authority,
   see "Without a local certificate authority" below.

3. **Make the certificate** for the app, in the folder this repository expects:

   ```bash
   mkdir certs
   mkcert -cert-file certs/localhost.pem -key-file certs/localhost-key.pem localhost 127.0.0.1 ::1
   ```

   `certs/` is ignored by git and by the Docker build. It holds a private key; do
   not copy it anywhere.

4. **Edit `.env`** so the app knows its own address (the login origin check compares
   against it exactly):

   ```text
   APP_URL=https://localhost:3000
   PLAID_REDIRECT_URI=https://localhost:3000/plaid/oauth
   ```

5. **Register that exact redirect address** in the Plaid Dashboard (Developers →
   API → Allowed redirect URIs). Plaid expects the address you send to be on that
   list (step 7 below tells you).

6. **Start with the HTTPS file added:**

   ```bash
   docker compose -f compose.yaml -f compose.https.yaml up -d
   ```

   Open <https://localhost:3000> and sign in again (the cookie is different over
   https). To avoid typing both files every time, set
   `COMPOSE_FILE=compose.yaml;compose.https.yaml` in `.env` (on Windows the
   separator is `;`, on Linux/macOS `:`).

7. **Try it with Sandbox first.** With your Sandbox keys, Connections → *Connect a
   bank*. Creating the link token with a `PLAID_REDIRECT_URI` is itself a check:
   Plaid refuses it if the address is not registered, so success means Plaid
   accepts your redirect address. (Sandbox in a desktop browser uses a popup and
   does not visit the redirect page, so this does not prove the OAuth return trip.)

Then run `docker compose exec app npm run preflight` to see what is still missing
before a real bank.

## Going back to plain http

Remove the two lines from `.env` (or set `APP_URL=http://localhost:3000` and clear
`PLAID_REDIRECT_URI`) and run:

```bash
docker compose up -d --remove-orphans
```

## Testing over https

The test commands default to `http://localhost:3000`. To run the browser suite over
https, with a self-signed certificate Playwright's browser does not trust:

```powershell
$env:E2E_BASE_URL="https://localhost:3000"; $env:E2E_IGNORE_HTTPS_ERRORS="1"; npm run test:e2e
```

## Without a local certificate authority

Because you own `mallard-digital.com`, a subdomain such as
`finance.mallard-digital.com` could be pointed, in DNS, at `127.0.0.1`, with a real
certificate obtained by the DNS challenge. Browsers then trust it with no local
authority, the app still runs only on your computer, and the redirect address
becomes `https://finance.mallard-digital.com:3000/plaid/oauth`. **This is described
but has not been built or tried here.** Caveats: you need control of the domain's
DNS, and some routers and DNS filters refuse names that resolve to local addresses.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| The browser warns the certificate is not trusted | `mkcert -install` was not run, or restart the browser after running it |
| The proxy keeps restarting | `docker compose logs proxy`; usually `certs/localhost.pem` or `certs/localhost-key.pem` is missing |
| "Not allowed from this origin" at sign-in | `APP_URL` does not match the address in the browser exactly (scheme and port) |
| Port 3000 is busy | Set `APP_PORT=3001` and use `https://localhost:3001` in `APP_URL` and `PLAID_REDIRECT_URI` (and register that address) |
| `http://localhost:3000` no longer works | Expected: only the https proxy is published in this mode |
