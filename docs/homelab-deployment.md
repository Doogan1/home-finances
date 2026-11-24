# Running Home Finances on the homelab server

The app runs on the homelab server (Fedora Server, Docker) and is reachable only
over Tailscale, at `https://<server>.<your-tailnet>.ts.net`. Nothing is exposed to
the internet. You deploy from your PC with one command; the server builds and
runs it.

```
PC ──git archive over ssh──▶ ~/home-finances/releases/<id>   (on the server)
                              └─ release.sh: build ─ back up ─ migrate ─ start ─ check
Phone/PC ──Tailscale HTTPS──▶ tailscale serve ──▶ 127.0.0.1:3000 (app) ──▶ db
```

On the server, everything lives in `~/home-finances/`:

| Path | What |
|---|---|
| `prod.env` | all secrets (mode 600). **Keep a copy in your password manager.** |
| `releases/<id>/` | one folder per deployed commit (the 3 newest are kept) |
| `current`, `previous` | links to the running and the previous release |
| `backups/*.dump.age` | encrypted nightly backups |
| `age-recipient.txt` | the public half of the backup key |
| `hf` | everyday helper (see below) |

## First-time setup

Steps marked **(you)** need your password or an admin page; nobody else runs them.

### 1. SSH

On the PC, add to `C:\Users\Drake\.ssh\config`:

```
Host homelab
  HostName 192.168.1.102
  User dolejniczak
  IdentityFile ~/.ssh/homelab
  IdentitiesOnly yes
```

`ssh homelab` should now log in with no password prompt.

**(you)** Turn off password logins on the server. In sshd's drop-in folder the
**first** file to set a value wins, so name yours to sort first:

```sh
sudo sshd -T | grep -i passwordauthentication      # what is in force now
echo 'PasswordAuthentication no' | sudo tee /etc/ssh/sshd_config.d/00-no-passwords.conf
echo 'KbdInteractiveAuthentication no' | sudo tee -a /etc/ssh/sshd_config.d/00-no-passwords.conf
sudo sshd -t && sudo systemctl reload sshd
sudo sshd -T | grep -iE 'passwordauthentication|kbdinteractive'   # both "no"
```

Keep your current session open, and check `ssh homelab` works from a new
window before closing it. From the PC,
`ssh -o PubkeyAuthentication=no homelab` must now be refused without asking for a
password.

### 2. Packages and lingering (you)

```sh
sudo dnf install -y nodejs age
sudo loginctl enable-linger dolejniczak     # lets the nightly backup timer run while you are logged out
```

### 3. Tailscale (you)

On the server:

```sh
sudo dnf config-manager addrepo --from-repofile=https://pkgs.tailscale.com/stable/fedora/tailscale.repo
sudo dnf install -y tailscale
sudo systemctl enable --now tailscaled
sudo tailscale up
sudo tailscale set --operator=dolejniczak   # so `tailscale serve` works without sudo
```

In the Tailscale admin console (DNS page), turn on **MagicDNS** and **HTTPS
Certificates**. Install Tailscale on the PC and on each phone that should reach the
app, and sign in to the same tailnet. Note the server's name, shown as
`<server>.<your-tailnet>.ts.net`.

### 4. The backup key (PC)

```powershell
winget install --id FiloSottile.age
New-Item -ItemType Directory -Force "$env:USERPROFILE\.config\home-finances" | Out-Null
age-keygen -o "$env:USERPROFILE\.config\home-finances\backup-identity.txt"
```

It prints `Public key: age1…`. **Store the identity file's contents in your password
manager:** without it no backup can be opened. Then put the public key on the
server:

```powershell
ssh homelab "mkdir -p home-finances && echo age1...your-public-key... > home-finances/age-recipient.txt"
```

### 5. First deploy

```powershell
npm run deploy
```

The first run uploads the release and stops, because there is no `prod.env` yet.
It prints the command to create it. Run it with your server's Tailscale name:

```powershell
ssh homelab "node home-finances/releases/<id>/scripts/setup-env.mjs --out home-finances/prod.env --app-url https://<server>.<your-tailnet>.ts.net"
```

Copy `prod.env` into your password manager (`ssh homelab cat home-finances/prod.env`).
Then run `npm run deploy` again. It builds, migrates an empty database and starts the app.

### 6. Put HTTPS in front

```powershell
ssh homelab "tailscale serve --bg 3000"
ssh homelab "tailscale serve status"
```

`https://<server>.<your-tailnet>.ts.net` now reaches the app from any device on
your tailnet. The setting survives reboots.

### 7. Move the real data from the PC (once)

The household's data is in the PC's database. Move it, then use only the server
from then on:

If you connected any bank (even Sandbox) on the PC, disconnect it in the app first:
its saved token is encrypted with the PC's key and cannot be read on the server.
Reconnect on the server afterwards.

```powershell
npm run backup
scp backups\<the file it printed> homelab:home-finances/incoming.dump
ssh homelab "home-finances/hf compose stop app && home-finances/hf restore ~/home-finances/incoming.dump --replace-live --confirm home_finances && home-finances/hf compose up -d --wait app; rm -f ~/home-finances/incoming.dump"
```

The restore prints the name of the empty database it replaced
(`home_finances_replaced_…`); drop it with
``ssh homelab "home-finances/hf compose exec db sh -c 'dropdb -U `$POSTGRES_USER home_finances_replaced_…'"``.
Sign in with your usual email and password (sessions are not copied). Delete the
local dump from `backups\` when you are satisfied.

From now on, enter data **only** on the server. The PC's database is a stale copy
for development.

## Everyday

| Do | Command (PC) |
|---|---|
| Deploy what is on main | `npm run deploy` (refuses unless main is clean, pushed and CI is green) |
| Deploy before CI finishes | `npm run deploy -- --skip-ci` |
| Go back one release | `npm run deploy -- --rollback` |
| Copy backups to this PC | `npm run backup:pull` |
| See the app's logs | `ssh homelab home-finances/hf compose logs --tail 100 app` |
| Back up right now | `ssh homelab home-finances/hf backup` |
| Run the pre-flight checklist | `ssh homelab home-finances/hf preflight` |

A deploy takes a backup first, runs migrations, starts the new app and waits for
its health check. If the new app does not come up, the previous one is restarted.

**Rollback undoes the app, not the database.** Migrations are written to be
additive, so the previous app normally runs fine on the newer schema. If a
release ever needs its database change undone, restore the backup taken just
before it (below). Rollback starts the previous release's own compose file, so if a
release ever changes the `db` service (for example the PostgreSQL version), do not
roll back past it.

If the connection drops or a deploy is interrupted, run `npm run deploy` again (it
is safe to repeat). If the app is down meanwhile,
`ssh homelab home-finances/hf compose up -d --wait app` starts the release
`current` names. If a deploy reports an error after "Starting the new app"
succeeded, the release is live and rerunning `npm run deploy` finishes the cleanup.

## Backups

- Every night at about 03:30 the server writes an encrypted, verified backup to
  `~/home-finances/backups/`. It keeps the last 48 hours, one per day for 7 days
  and one per week for 4 weeks.
- `npm run backup:pull` copies new ones into `backups\homelab\` on the PC. It warns
  (exit code 2) if the newest is over 36 hours old. To run it daily (you), in
  PowerShell:
  `schtasks /Create /SC DAILY /ST 12:00 /TN "Home Finances backup pull" /TR "cmd /c cd /d C:\Users\Drake\home-finances && npm run backup:pull"`
  The task's "Last Run Result" in Task Scheduler shows 0x2 when the newest backup is
  over 36 hours old and 0x1 when the pull failed. Check it weekly, or run
  `npm run backup:pull` by hand.
- The backups do not include `TOKEN_ENCRYPTION_KEY`; that is in `prod.env`, which
  you keep in your password manager.
- The backup refuses to run if `age` is not installed, so it never writes an unencrypted dump.
- If a backup fails, it removes its plaintext dump, so none is left behind.

### Test a restore (do this once now, then every few months)

```powershell
age -d -i "$env:USERPROFILE\.config\home-finances\backup-identity.txt" -o restore-test.dump backups\homelab\<newest>.dump.age
scp restore-test.dump homelab:home-finances/restore-test.dump; Remove-Item restore-test.dump
ssh homelab "home-finances/hf restore ~/home-finances/restore-test.dump; rm -f ~/home-finances/restore-test.dump"
```

(`hf` runs from the release folder, so give `hf restore` a full path, as here.)

It restores into a separate database and compares it with the live one; the live
database is not touched. Drop the copy with the command it prints.

### Replace the live database from a backup

```powershell
age -d -i "$env:USERPROFILE\.config\home-finances\backup-identity.txt" -o restore-live.dump backups\homelab\<the backup>.dump.age
scp restore-live.dump homelab:home-finances/restore-live.dump; Remove-Item restore-live.dump
ssh homelab "home-finances/hf compose stop app && home-finances/hf restore ~/home-finances/restore-live.dump --replace-live --confirm home_finances && home-finances/hf compose up -d --wait app; rm -f ~/home-finances/restore-live.dump"
```

The database you had stays as `home_finances_replaced_…` until you drop it.

## Going live with a real bank

Plaid production access is a deliberate, one-time switch. Do it in this order.

**Ruling (2026-11-23): this server's database is the real-data database.** The
general advice in [local-development.md](local-development.md#going-live-real-banks-a-deliberate-opt-in)
to keep real data in a separate database is met here by removing the server's one
Sandbox connection before switching (step 2); the pre-flight then finds no Sandbox
data. The server also keeps its own `TOKEN_ENCRYPTION_KEY`: it was made on the
server, and the only token it ever protected was a Sandbox one, already erased.

1. **Deploy** the release that has attach (`npm run deploy`).
2. **Remove the Sandbox connection** while the server is still on Sandbox (Sandbox
   connections are hidden once it is on production): Connections → the
   disconnected Sandbox bank → *Delete saved history…* → type `DELETE`. It needs
   no Plaid credentials. Leftover Sandbox link attempts hold no token and are kept
   for the record.
3. **In the Plaid Dashboard (you):** production access is enabled for
   Transactions, your bank shows as available on the OAuth institutions page, and
   `https://<server>.<your-tailnet>.ts.net/plaid/oauth` is added to the allowed
   redirect URIs.
4. **Edit `prod.env` on the server (you)**, for example `ssh -t homelab nano home-finances/prod.env`.
   Never paste these values anywhere else:

   ```text
   PLAID_ENV=production
   PLAID_LIVE_OPT_IN=yes
   PLAID_CLIENT_ID=<production client id>
   PLAID_SECRET=<production secret>
   PLAID_REDIRECT_URI=https://<server>.<your-tailnet>.ts.net/plaid/oauth
   ```

   Update the copy in your password manager.
5. **Restart the app** so it reads them: `ssh homelab home-finances/hf compose up -d --wait app`
   (Compose recreates the container when its settings changed). The app refuses to
   start if `PLAID_ENV=production` is set without `PLAID_LIVE_OPT_IN=yes`.
6. **Back up and run the checklist:** `ssh homelab home-finances/hf backup`, then
   `ssh homelab home-finances/hf preflight`. It must report 0 failing. Go through
   the "check" items yourself.
7. **Link the bank** (Connections → *Connect a bank*), choosing every account you
   want the first time. Then, for each account it brought in, *Use for…* the
   hand-entered account it is, and *Attach*. *Sync now* on Transactions fetches the
   transactions.
8. **Back up again:** `ssh homelab home-finances/hf backup`.

## Not done yet

- **Content-Security-Policy** is still not set. That is acceptable while only your
  tailnet can reach the app; add and test one before any internet exposure.
- The server user is in the `docker` group, which is equivalent to root on that
  machine. Treat SSH access to it accordingly.
