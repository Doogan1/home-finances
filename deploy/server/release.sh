#!/bin/sh
# Runs ON the server, called by `npm run deploy` on the PC (scripts/deploy.mjs).
#
#   release.sh <release id>   build, back up, migrate, start; restart the previous
#                             release if the new one does not become healthy
#   release.sh --rollback     go back to the previous release (the app only:
#                             database migrations are not undone)
set -eu
HF_HOME="${HF_HOME:-$HOME/home-finances}"
say() { printf '\n==> %s\n' "$*"; }
fail() { printf '\nDeploy stopped: %s\n' "$*" >&2; exit 1; }
resolved() { readlink -f "$1"; }

[ -s "$HF_HOME/prod.env" ] || fail "there is no $HF_HOME/prod.env yet. Create it with:
  node $HF_HOME/releases/${1:-<id>}/scripts/setup-env.mjs --out $HF_HOME/prod.env --app-url https://<this server>.<your tailnet>.ts.net
(see docs/homelab-deployment.md, first-time setup), then deploy again."

# Start the app of a release folder and wait for its health check.
start_app() {
  ( cd "$1" && . ./deploy/server/env.sh "$1" && docker compose up -d --wait --wait-timeout 180 app )
}

install_helpers() {
  install -m 700 ./deploy/server/hf.sh "$HF_HOME/hf"
  units="$HOME/.config/systemd/user"
  mkdir -p "$units"
  cp ./deploy/server/systemd/home-finances-backup.service ./deploy/server/systemd/home-finances-backup.timer "$units/"
  # Never fatal: the release is already live by now.
  { systemctl --user daemon-reload && systemctl --user enable --now home-finances-backup.timer; } > /dev/null 2>&1 \
    || echo "Note: could not enable the nightly backup timer (is lingering enabled? see the doc)." >&2
}

if [ "${1:-}" = "--rollback" ]; then
  [ -L "$HF_HOME/previous" ] || fail "there is no previous release to go back to"
  previous="$(resolved "$HF_HOME/previous")"
  current="$(resolved "$HF_HOME/current")"
  say "Going back to $(basename "$previous")"
  start_app "$previous" || fail "the previous release did not become healthy either (hf compose logs app)"
  ln -sfn "$previous" "$HF_HOME/current"
  ln -sfn "$current" "$HF_HOME/previous"
  say "Running $(basename "$previous"). Database migrations from $(basename "$current") were NOT undone."
  exit 0
fi

id="${1:?usage: release.sh <release id> | release.sh --rollback}"
case "$id" in *[!0-9a-f]* | "") fail "not a release id: $id" ;; esac
release="$HF_HOME/releases/$id"
[ -d "$release" ] || fail "no release folder $release"
cd "$release"
. ./deploy/server/env.sh "$release"
mkdir -p "$HF_HOME/backups"

say "Building the images for $id"
docker compose --profile ops build app migrate

say "Starting the database"
docker compose up -d --wait db

if [ -L "$HF_HOME/current" ]; then
  say "Backing up before changing anything"
  sh ./deploy/server/backup.sh || fail "the backup failed, so nothing was changed"
fi

say "Applying database migrations"
docker compose run --rm migrate || fail "migrations failed; the running app was not touched"

say "Starting the new app"
if ! docker compose up -d --wait --wait-timeout 180 app; then
  if [ -L "$HF_HOME/current" ] && [ "$(resolved "$HF_HOME/current")" != "$release" ]; then
    say "The new app did not become healthy; restarting the previous release"
    start_app "$(resolved "$HF_HOME/current")" || echo "The previous release did not come back either." >&2
  fi
  fail "release $id did not become healthy (see: ~/home-finances/hf compose logs app)"
fi

if [ -L "$HF_HOME/current" ] && [ "$(resolved "$HF_HOME/current")" != "$release" ]; then
  ln -sfn "$(resolved "$HF_HOME/current")" "$HF_HOME/previous"
fi
ln -sfn "$release" "$HF_HOME/current"
install_helpers

say "Removing old releases (keeping the 3 newest, the current and the previous)"
keep_current="$(basename "$(resolved "$HF_HOME/current")")"
keep_previous=""
[ -L "$HF_HOME/previous" ] && keep_previous="$(basename "$(resolved "$HF_HOME/previous")")"
ls -1t "$HF_HOME/releases" | grep -E '^[0-9a-f]{12}$' | tail -n +4 | while read -r old; do
  if [ "$old" = "$keep_current" ] || [ "$old" = "$keep_previous" ]; then continue; fi
  rm -rf "${HF_HOME:?}/releases/$old"
  docker image rm "home-finances:$old" "home-finances-tools:$old" > /dev/null 2>&1 || true
done
docker image prune -f > /dev/null

say "Release $id is live"
