# Sourced (". deploy/server/env.sh <release dir>") by the other server scripts,
# from inside that release folder. Points every `docker compose` and backup
# command at the production stack. See docs/homelab-deployment.md.

HF_HOME="${HF_HOME:-$HOME/home-finances}"
export HF_HOME
export COMPOSE_PROJECT_NAME=home-finances
export COMPOSE_FILE=compose.prod.yaml
export COMPOSE_ENV_FILES="$HF_HOME/prod.env"
# Restores re-apply grants with the one-off migrate job (scripts/lib/backup.mjs).
export HF_MIGRATE_SERVICE=migrate
# The image tag: the release folder's name (12 hex characters of the commit).
RELEASE="$(basename "$(cd "$1" && pwd -P)")"
export RELEASE
