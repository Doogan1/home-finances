#!/bin/sh
# An encrypted, verified backup of the live database, then retention. Run from a
# release folder with env.sh sourced: by `hf backup`, the nightly timer and
# release.sh (before every deploy).
#
# The plaintext dump exists only in backups/.work for the moment it takes to
# encrypt it. Encrypted copies can be read only with the age identity kept on the
# PC (see docs/homelab-deployment.md, "Backups").
set -eu
HF_HOME="${HF_HOME:-$HOME/home-finances}"
recipient="$HF_HOME/age-recipient.txt"
backups="$HF_HOME/backups"
work="$backups/.work"

[ -s "$recipient" ] || { echo "No $recipient; see docs/homelab-deployment.md" >&2; exit 1; }
command -v age > /dev/null || { echo "age is not installed; see docs/homelab-deployment.md" >&2; exit 1; }
mkdir -p "$work"
chmod 700 "$backups" "$work"
# However this script ends (error, kill, Ctrl-C), no plaintext dump or half-written
# encrypted file may stay behind. The EXIT trap also runs after a signal.
trap 'rm -f "$work"/*.dump "$work"/*.partial "$backups"/*.age.partial' EXIT
trap 'exit 1' INT TERM HUP
rm -f "$work"/*.dump "$work"/*.partial

# Verified by backup.mjs itself (readable archive, expected tables). Its notes
# about sensitivity are for people at a terminal, so they are not repeated here.
node scripts/backup.mjs --out "$work" > /dev/null

for dump in "$work"/*.dump; do
  [ -f "$dump" ] || { echo "The backup produced no dump." >&2; exit 1; }
  out="$backups/$(basename "$dump").age"
  age -R "$recipient" -o "$out.partial" "$dump"
  chmod 600 "$out.partial"
  mv "$out.partial" "$out"
  rm -f "$dump"
  echo "Backup written: $out"
done

node scripts/prune-backups.mjs "$backups" --apply
