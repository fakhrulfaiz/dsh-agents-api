#!/usr/bin/env bash
# Agentry API for development (DSH profile "agents") on http://127.0.0.1:3080.
# Every key comes from this repo's git-ignored .env (AGENTRY_DEV_KEY, AGENTRY_SANDBOX_URL/KEY, ...).
# Start Agentry Sandbox first (agentry-sandbox/scripts/dev.sh) when AGENTRY_SANDBOX_URL is set.
set -eo pipefail
export PATH=$HOME/.nvm/versions/node/v24.19.0/bin:$PATH
ROOT=$(cd "$(dirname "$0")/.." && pwd)
export DSH_ROOT=${DSH_ROOT:-$HOME/code/dsh-pinned}

set -a; source "$ROOT/.env"; set +a
: "${AGENTRY_DEV_KEY:?set AGENTRY_DEV_KEY in $ROOT/.env}"
# Only the sandbox service needs these; keep them out of the API's environment.
unset AGENTRY_SANDBOX_SECRET AGENTRY_SANDBOX_ADMIN_KEY

if [ -z "${AGENTRY_DATABASE_URL:-}" ]; then
  PGPASS=$(docker inspect agentry-postgres --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p')
  export AGENTRY_DATABASE_URL="postgres://agentry:${PGPASS}@127.0.0.1:55432/agentry"
fi
export AGENTRY_DEBUG_ERRORS=${AGENTRY_DEBUG_ERRORS:-1}

cd "$ROOT"
echo "Building @agentry/api ..."
pnpm build
cd "$DSH_ROOT"
exec pnpm dsh --profile agents
