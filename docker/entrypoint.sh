#!/bin/sh
# Places the `agents` profile on the data volume (image-owned files refreshed on every start,
# your cordis.patch.yml kept), then boots DeepSeek Harness with the Agentry API on the
# container's own address (DSH rejects wildcard binds).
set -eu
profile="$DSH_HOME/profiles/agents"
mkdir -p "$profile/node_modules/@agentry" "$AGENTRY_WORKSPACES" "$AGENTRY_UPLOADS_DIR"
cp /opt/agentry/profile/package.json /opt/agentry/profile/cordis.yml /opt/agentry/profile/pnpm-workspace.yaml "$profile/"
[ -f "$profile/cordis.patch.yml" ] || cp /opt/agentry/profile/cordis.patch.yml "$profile/"
ln -sfn /opt/dsh-agents-api "$profile/node_modules/@agentry/api"

: "${AGENTRY_DATABASE_URL:?set AGENTRY_DATABASE_URL (postgres://user:password@host:port/database)}"
: "${AGENTRY_DEV_KEY:?set AGENTRY_DEV_KEY (the API key clients and Agentry Web sign in with)}"

host=${AGENTRY_BIND_HOST:-$(hostname -i | awk '{print $1}')}
set -- --profile agents --no-open --host "$host" --port "$PORT"
[ -n "${AGENTRY_PUBLIC_URL:-}" ] && set -- "$@" --public-url "$AGENTRY_PUBLIC_URL"
cd /opt/dsh
exec node --import tsx/esm apps/cli/src/bin.ts "$@"
