#!/bin/sh
# Installed by release.sh as ~/home-finances/hf. Everyday commands for the
# running release:
#
#   ~/home-finances/hf compose ps | logs app | exec db ...   (any docker compose command)
#   ~/home-finances/hf backup                                (encrypted backup now)
#   ~/home-finances/hf restore <dump> [--target <db>] [--replace-live --confirm home_finances]
#   ~/home-finances/hf prune [--apply]                       (apply backup retention)
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
  *)
    echo "Usage: hf compose <args> | backup | restore <dump> [...] | prune [--apply]" >&2
    exit 1
    ;;
esac
