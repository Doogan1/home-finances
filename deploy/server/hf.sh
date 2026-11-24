#!/bin/sh
# Installed by release.sh as ~/home-finances/hf. Everyday commands for the
# running release:
#
#   ~/home-finances/hf compose ps | logs app | exec db ...   (any docker compose command)
#   ~/home-finances/hf backup                                (encrypted backup now)
#   ~/home-finances/hf restore <dump> [--target <db>] [--replace-live --confirm home_finances]
#   ~/home-finances/hf prune [--apply]                       (apply backup retention)
#   ~/home-finances/hf preflight                             (the checklist for linking a real bank)
set -eu
HF_HOME="${HF_HOME:-$HOME/home-finances}"
[ -L "$HF_HOME/current" ] || { echo "Nothing is deployed yet." >&2; exit 1; }
cd "$HF_HOME/current"
. ./deploy/server/env.sh "$HF_HOME/current"

command="${1:-}"
[ $# -gt 0 ] && shift
case "$command" in
  compose) exec docker compose "$@" ;;
  backup) exec sh ./deploy/server/backup.sh ;;
  restore) exec node scripts/restore.mjs "$@" ;;
  prune) exec node scripts/prune-backups.mjs "$HF_HOME/backups" "$@" ;;
  preflight)
    # The backups are on this machine, not in the container, so their age is worked out here.
    newest="$(ls -1t "$HF_HOME"/backups/*.dump.age 2>/dev/null | head -n 1 || true)"
    if [ -n "$newest" ]; then
      if modified="$(stat -c %Y "$newest" 2>/dev/null)"; then
        age=$(( ($(date +%s) - modified) / 3600 ))
        [ "$age" -ge 0 ] || age=0
        exec docker compose run --rm preflight npm run preflight -- --backup-age-hours "$age"
      fi
    fi
    exec docker compose run --rm preflight npm run preflight
    ;;
  *)
    echo "Usage: hf compose <args> | backup | restore <dump> [...] | prune [--apply] | preflight" >&2
    exit 1
    ;;
esac
