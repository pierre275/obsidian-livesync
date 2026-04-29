#!/usr/bin/env bash
# Local full-stack for end-to-end debugging.
# Spins up CouchDB + git-committer with the patched code, points at a local
# bare git repo (no Codeberg). Prints a LiveSync setup URI you can paste into
# Obsidian on your phone or another machine.
#
# Run from the repo root (the dir containing docker-compose.full-stack.yml).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK_DIR="${WORK_DIR:-/tmp/livesync-local}"
LAN_IP="${LAN_IP:-localhost}"
COUCHDB_PORT="${COUCHDB_PORT:-5984}"
PROJECT="livesync-local"

COMPOSE=( docker compose
    -f "$ROOT/docker-compose.full-stack.yml"
    -f "$ROOT/test/docker-compose.local-override.yml"
    -p "$PROJECT"
    --env-file "$ROOT/.env.full-stack" )

echo "[local] work dir: $WORK_DIR"
mkdir -p "$WORK_DIR"

# bare repo (acts as your "Codeberg")
BARE_REPO="$WORK_DIR/bare-repo.git"
if [ ! -d "$BARE_REPO" ]; then
    git init --bare "$BARE_REPO" --initial-branch=main >/dev/null
    SEED="$WORK_DIR/seed"
    git clone "$BARE_REPO" "$SEED" 2>/dev/null
    ( cd "$SEED" \
      && git -c user.name=seed -c user.email=seed@example.com commit --allow-empty -m "seed" -q \
      && git push -q origin main )
    rm -rf "$SEED"
fi

VAULT_PATH="$WORK_DIR/vault"
COUCHDB_DATA="$WORK_DIR/couchdb-data"

# clone the bare repo into the vault dir
if [ ! -d "$VAULT_PATH/.git" ]; then
    rm -rf "$VAULT_PATH"
    git clone "$BARE_REPO" "$VAULT_PATH" 2>/dev/null
fi

mkdir -p "$COUCHDB_DATA"

# generate strong passphrases the first time, then re-use them
ENV_FILE="$ROOT/.env.full-stack"
if [ ! -f "$ENV_FILE" ]; then
    COUCHDB_PASS="${COUCHDB_PASS:-livesync123}"
    LIVESYNC_PASS="${LIVESYNC_PASS:-secret}"
    cat > "$ENV_FILE" <<EOF
COUCHDB_USER=admin
COUCHDB_PASSWORD=$COUCHDB_PASS
COUCHDB_DBNAME=livesync
COUCHDB_DATA_PATH=$COUCHDB_DATA
LIVESYNC_PASSPHRASE=$LIVESYNC_PASS
VAULT_PATH=$VAULT_PATH
DEBOUNCE_SECS=10
VAULT_DIR=/data
GIT_REMOTE=origin
GIT_BRANCH=main
GIT_USER_NAME=local-bot
GIT_USER_EMAIL=local-bot@example.com
COUCHDB_PORT=$COUCHDB_PORT
PUBLIC_HOST=$LAN_IP
CODEBERG_USERNAME=
CODEBERG_TOKEN=
CODEBERG_REPO=
EOF
    chmod 600 "$ENV_FILE"
    echo "[local] generated $ENV_FILE"
else
    echo "[local] re-using existing $ENV_FILE"
fi

set -a
source "$ENV_FILE"
set +a

# minimal settings.json so livesync-cli can connect even before first sync
mkdir -p "$VAULT_PATH/.livesync"
cat > "$VAULT_PATH/.livesync/settings.json" <<EOF
{
  "couchDB_URI": "http://couchdb:5984",
  "couchDB_USER": "$COUCHDB_USER",
  "couchDB_PASSWORD": "$COUCHDB_PASSWORD",
  "couchDB_DBNAME": "$COUCHDB_DBNAME",
  "passphrase": "$LIVESYNC_PASSPHRASE",
  "encrypt": true,
  "isConfigured": true,
  "usePluginSync": false
}
EOF
chmod 600 "$VAULT_PATH/.livesync/settings.json"

# bring up CouchDB
echo "[local] starting CouchDB..."
"${COMPOSE[@]}" up -d couchdb

echo -n "[local] waiting for CouchDB"
for i in $(seq 1 60); do
    if curl -sf -u "$COUCHDB_USER:$COUCHDB_PASSWORD" "http://localhost:$COUCHDB_PORT/_up" >/dev/null 2>&1; then
        echo " ok"
        break
    fi
    echo -n "."
    sleep 1
done

# configure CouchDB (CORS + dbs)
AUTH="$COUCHDB_USER:$COUCHDB_PASSWORD"
for kv in \
    "/_node/_local/_config/chttpd/enable_cors|true" \
    "/_node/_local/_config/cors/origins|*" \
    "/_node/_local/_config/cors/credentials|true" \
    "/_node/_local/_config/couchdb/single_node|true"; do
    p="${kv%|*}"; v="${kv#*|}"
    curl -sf -u "$AUTH" -X PUT "http://localhost:$COUCHDB_PORT$p" -d "\"$v\"" -H "Content-Type: application/json" >/dev/null
done
for db in _users _replicator "$COUCHDB_DBNAME"; do
    curl -s -u "$AUTH" -X PUT "http://localhost:$COUCHDB_PORT/$db" >/dev/null
done

# point bare repo as origin (no Codeberg env vars → git-committer.js skips remote rewrite)
git -C "$VAULT_PATH" remote set-url origin "$BARE_REPO" 2>/dev/null || \
    git -C "$VAULT_PATH" remote add origin "$BARE_REPO"

# build + start the bot with the patched code
echo "[local] building + starting git-committer (patched)..."
"${COMPOSE[@]}" build git-committer
"${COMPOSE[@]}" up -d git-committer

# generate setup URI from a settings file that uses the host-reachable URL
echo ""
echo "[local] generating setup URI for Obsidian..."
URI_GEN_DIR="$WORK_DIR/uri-gen"
mkdir -p "$URI_GEN_DIR/.livesync"
cat > "$URI_GEN_DIR/.livesync/settings.json" <<EOF
{
  "couchDB_URI": "http://$LAN_IP:$COUCHDB_PORT",
  "couchDB_USER": "$COUCHDB_USER",
  "couchDB_PASSWORD": "$COUCHDB_PASSWORD",
  "couchDB_DBNAME": "$COUCHDB_DBNAME",
  "passphrase": "$LIVESYNC_PASSPHRASE",
  "encrypt": true,
  "isConfigured": true,
  "usePluginSync": false
}
EOF

URI_PASS="${URI_PASS:-test}"
URI_FILE="$WORK_DIR/setup-uri.txt"
"${COMPOSE[@]}" run --rm \
    -v "$URI_GEN_DIR:/tmp/uri" \
    --entrypoint livesync-cli \
    git-committer /tmp/uri gen-setup-uri "$URI_PASS" 2>/dev/null \
    | grep '^obsidian://' \
    | sed -e 's/[[:space:]]*$//' > "$URI_FILE"

echo ""
echo "================================================================"
echo "  Stack is up."
echo "================================================================"
echo "  Vault path:         $VAULT_PATH"
echo "  Bare repo (remote): $BARE_REPO"
echo "  CouchDB:            http://$LAN_IP:$COUCHDB_PORT"
echo "  CouchDB user:       $COUCHDB_USER"
echo "  CouchDB password:   $COUCHDB_PASSWORD"
echo "  Database name:      $COUCHDB_DBNAME"
echo "  Data passphrase:    $LIVESYNC_PASSPHRASE"
echo "  URI passphrase:     $URI_PASS  (← enter this in the Obsidian Setup wizard)"
echo ""
echo "  Setup URI saved to: $URI_FILE"
echo "  Copy to clipboard:  pbcopy < $URI_FILE"
echo "================================================================"
echo ""
echo "Tail bot logs:"
echo "  ${COMPOSE[*]} logs -f --tail 50 git-committer"
echo ""
echo "Tear down:"
echo "  ${COMPOSE[*]} down -v && rm -rf $WORK_DIR $ENV_FILE"
