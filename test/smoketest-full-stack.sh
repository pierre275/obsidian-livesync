#!/usr/bin/env bash
# Smoketest for the full-stack setup.
# Uses a local bare git repo as a Codeberg substitute.
# Requires: docker, docker compose, git, node, curl.
#
# Scope: this smoketest validates INFRASTRUCTURE STANDUP only:
#   - both containers build and start
#   - CouchDB is reachable from the git-committer container
#   - the git-committer initial commit cycle runs (sync+mirror+git)
#
# It does NOT validate the watch loop end-to-end. That requires Obsidian
# clients populating CouchDB with properly-encrypted documents, which is
# beyond the scope of this script.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEST_DIR="$(mktemp -d -t livesync-smoketest-XXXXXX)"

# Use a bridge-network override so the test works on Docker Desktop too.
COMPOSE=( docker compose
    -f "$ROOT/docker-compose.full-stack.yml"
    -f "$ROOT/test/docker-compose.smoketest.override.yml"
    -p livesync-smoketest
    --env-file "$ROOT/.env.full-stack" )

cleanup() {
    echo "[smoketest] tearing down..."
    "${COMPOSE[@]}" down -v 2>/dev/null || true
    rm -f "$ROOT/.env.full-stack"
    rm -rf "$TEST_DIR"
}
trap cleanup EXIT

echo "[smoketest] test dir: $TEST_DIR"

# --- create a local "Codeberg" bare repo ---
BARE_REPO="$TEST_DIR/codeberg-fake.git"
git init --bare "$BARE_REPO" --initial-branch=main >/dev/null

# Seed the bare repo with one commit so it has a main branch
SEED_DIR="$TEST_DIR/seed"
git clone "$BARE_REPO" "$SEED_DIR" 2>/dev/null
( cd "$SEED_DIR" \
  && git -c user.name=seed -c user.email=seed@example.com commit --allow-empty -m "seed" -q \
  && git push -q origin main )

# Generate test secrets
export COUCHDB_PASS="$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)"
export LIVESYNC_PASS="$(openssl rand -base64 36 | tr -d '/+=' | head -c 48)"

VAULT_PATH="$TEST_DIR/vault"
DATA_PATH="$TEST_DIR/livesync-data"
COUCHDB_DATA_PATH="$TEST_DIR/couchdb-data"

# Clone our local fake repo into the vault path
git clone "$BARE_REPO" "$VAULT_PATH" 2>/dev/null

mkdir -p "$DATA_PATH/.livesync" "$COUCHDB_DATA_PATH"
cat > "$ROOT/.env.full-stack" <<EOF
COUCHDB_USER=admin
COUCHDB_PASSWORD=$COUCHDB_PASS
COUCHDB_DBNAME=livesync
COUCHDB_DATA_PATH=$COUCHDB_DATA_PATH
LIVESYNC_PASSPHRASE=$LIVESYNC_PASS
VAULT_PATH=$VAULT_PATH
LIVESYNC_DATA_PATH=$DATA_PATH
DEBOUNCE_SECS=5
VAULT_DIR=/vault
GIT_REMOTE=origin
GIT_BRANCH=main
GIT_USER_NAME=smoketest-bot
GIT_USER_EMAIL=smoketest@example.com
CODEBERG_USERNAME=
CODEBERG_TOKEN=
CODEBERG_REPO=
EOF
chmod 600 "$ROOT/.env.full-stack"

# Minimal settings.json — settings.json uses the docker-network service
# name `couchdb` since the git-committer container reaches CouchDB via the
# bridge network in this test.
cat > "$DATA_PATH/.livesync/settings.json" <<EOF
{
  "couchDB_URI": "http://couchdb:5984",
  "couchDB_USER": "admin",
  "couchDB_PASSWORD": "$COUCHDB_PASS",
  "couchDB_DBNAME": "livesync",
  "passphrase": "$LIVESYNC_PASS",
  "encrypt": true,
  "isConfigured": true,
  "usePluginSync": false
}
EOF
chmod 600 "$DATA_PATH/.livesync/settings.json"

# --- start CouchDB ---
echo "[smoketest] starting CouchDB..."
"${COMPOSE[@]}" up -d --build couchdb

echo -n "[smoketest] waiting for CouchDB"
for i in $(seq 1 60); do
    if curl -sf http://localhost:5984/ >/dev/null 2>&1; then
        echo " ok"
        break
    fi
    echo -n "."
    sleep 1
done
curl -sf http://localhost:5984/ >/dev/null 2>&1 || { echo " FAILED"; exit 1; }

# Configure CouchDB
echo "[smoketest] configuring CouchDB..."
AUTH="admin:$COUCHDB_PASS"
for kv in \
    "/_node/_local/_config/chttpd/enable_cors|true" \
    "/_node/_local/_config/cors/origins|*" \
    "/_node/_local/_config/cors/credentials|true" \
    "/_node/_local/_config/couchdb/single_node|true"; do
    p="${kv%|*}"; v="${kv#*|}"
    curl -sf -u "$AUTH" -X PUT "http://localhost:5984$p" -d "\"$v\"" -H "Content-Type: application/json" >/dev/null
done
for db in _users _replicator livesync; do
    curl -s -u "$AUTH" -X PUT "http://localhost:5984/$db" >/dev/null
done

# --- pre-configure the bare repo as origin (no Codeberg env vars → git-committer.js skips remote rewrite) ---
git -C "$VAULT_PATH" remote set-url origin "$BARE_REPO"

# --- start git-committer ---
echo "[smoketest] starting git-committer..."
"${COMPOSE[@]}" up -d --build git-committer
sleep 5

RUNNING=$("${COMPOSE[@]}" ps --status running git-committer --format '{{.Name}}' | wc -l)
if [ "$RUNNING" -lt 1 ]; then
    echo "[smoketest] git-committer container not running"
    "${COMPOSE[@]}" logs git-committer
    exit 1
fi

# --- verify the container stays running after startup runs the initial commit ---
echo "[smoketest] waiting 25s for container to stabilize and run initial commit..."
sleep 25

STATE=$("${COMPOSE[@]}" ps git-committer --format '{{.State}}' 2>/dev/null || echo "missing")
if [ "$STATE" != "running" ]; then
    echo "[smoketest] FAILED: git-committer container is not running (state=$STATE)"
    "${COMPOSE[@]}" logs git-committer | tail -40
    exit 1
fi

# --- verify CouchDB is reachable from inside the git-committer container (Node, no curl needed) ---
echo "[smoketest] verifying git-committer can reach CouchDB..."
REACH=$("${COMPOSE[@]}" exec -T git-committer node -e '
fetch("http://couchdb:5984/livesync", {
  headers: { "Authorization": "Basic " + Buffer.from("admin:" + process.env.COUCHDB_PASS).toString("base64") }
}).then(r => { console.log("status:" + r.status); }).catch(e => { console.log("error:" + e.message); });
' COUCHDB_PASS="$COUCHDB_PASS" 2>&1)
echo "[smoketest] couchdb reach: $REACH"
# Any HTTP status (200/401/404) proves the container can reach CouchDB.
# A non-status: line means we hit a network or DNS error.
if ! echo "$REACH" | grep -qE "status:[0-9]+"; then
    echo "[smoketest] FAILED: git-committer cannot reach CouchDB on the bridge network"
    "${COMPOSE[@]}" logs git-committer | tail -30
    exit 1
fi

# --- verify the initial commit cycle ran (look for "Initialized, NOW TRACKING!" in logs) ---
echo "[smoketest] verifying initial mirror/commit cycle ran..."
LOGS=$("${COMPOSE[@]}" logs git-committer 2>&1)
if ! echo "$LOGS" | grep -q "Mirror.*Initialized, NOW TRACKING"; then
    echo "[smoketest] FAILED: initial mirror/commit cycle did not complete"
    echo "$LOGS" | tail -40
    exit 1
fi
if ! echo "$LOGS" | grep -qE "git-committer.*(no changes to commit|committed and pushed)"; then
    echo "[smoketest] FAILED: initial git step did not run"
    echo "$LOGS" | tail -40
    exit 1
fi

echo ""
echo "[smoketest] PASS — infrastructure verified:"
echo "  + CouchDB container started and configured"
echo "  + git-committer image built and container running"
echo "  + git-committer can reach CouchDB on the bridge network"
echo "  + initial sync+mirror+git cycle ran successfully"
echo ""
echo "Note: end-to-end watch-loop verification requires Obsidian to populate"
echo "CouchDB with properly-formatted documents. This smoketest validates"
echo "infrastructure standup only."
