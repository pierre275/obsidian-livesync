#!/usr/bin/env bash
# Smoketest for the full-stack setup.
# Uses a local bare git repo as a Codeberg substitute.
# Requires: docker, docker compose, git, node, curl.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEST_DIR="$(mktemp -d -t livesync-smoketest-XXXXXX)"

cleanup() {
    echo "[smoketest] tearing down..."
    docker compose -f "$ROOT/docker-compose.full-stack.yml" --env-file "$ROOT/.env.full-stack" down -v 2>/dev/null || true
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
COUCHDB_PASS="$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)"
LIVESYNC_PASS="$(openssl rand -base64 36 | tr -d '/+=' | head -c 48)"

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
GIT_DIR=/vault
GIT_REMOTE=origin
GIT_BRANCH=main
GIT_USER_NAME=smoketest-bot
GIT_USER_EMAIL=smoketest@example.com
EOF
chmod 600 "$ROOT/.env.full-stack"

cat > "$DATA_PATH/.livesync/settings.json" <<EOF
{
  "couchDB_URI": "http://localhost:5984",
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
docker compose -f "$ROOT/docker-compose.full-stack.yml" --env-file "$ROOT/.env.full-stack" up -d couchdb

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
docker compose -f "$ROOT/docker-compose.full-stack.yml" --env-file "$ROOT/.env.full-stack" up -d git-committer
sleep 5

RUNNING=$(docker compose -f "$ROOT/docker-compose.full-stack.yml" --env-file "$ROOT/.env.full-stack" ps --status running git-committer --format '{{.Name}}' | wc -l)
if [ "$RUNNING" -lt 1 ]; then
    echo "[smoketest] git-committer container not running"
    docker compose -f "$ROOT/docker-compose.full-stack.yml" --env-file "$ROOT/.env.full-stack" logs git-committer
    exit 1
fi

# --- inject a test doc via livesync-cli put ---
echo "[smoketest] injecting test doc into CouchDB..."
TEST_CONTENT="smoketest-$(date +%s)"
DOC_ID="smoketest.md"
docker compose -f "$ROOT/docker-compose.full-stack.yml" --env-file "$ROOT/.env.full-stack" exec -T git-committer sh -c "echo '$TEST_CONTENT' | livesync-cli put '$DOC_ID'"

# --- wait for debounce + commit + push ---
echo "[smoketest] waiting for debounce + commit + push (up to 60s)..."
INITIAL_COMMIT_COUNT=$(git -C "$BARE_REPO" rev-list --all --count)
NEW_COUNT="$INITIAL_COMMIT_COUNT"
for i in $(seq 1 60); do
    NEW_COUNT=$(git -C "$BARE_REPO" rev-list --all --count)
    if [ "$NEW_COUNT" -gt "$INITIAL_COMMIT_COUNT" ]; then
        echo "[smoketest] new commit detected on bare repo (took ${i}s)"
        break
    fi
    sleep 1
done

if [ "$NEW_COUNT" -le "$INITIAL_COMMIT_COUNT" ]; then
    echo "[smoketest] FAILED: no new commit pushed within 60s"
    docker compose -f "$ROOT/docker-compose.full-stack.yml" --env-file "$ROOT/.env.full-stack" logs git-committer
    exit 1
fi

# Verify the test file is in the latest commit
if ! git -C "$BARE_REPO" show "main:$DOC_ID" >/dev/null 2>&1; then
    echo "[smoketest] FAILED: $DOC_ID not in pushed commit"
    git -C "$BARE_REPO" log --stat -1 main
    exit 1
fi

echo "[smoketest] PASS"
