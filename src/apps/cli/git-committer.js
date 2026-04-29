'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const DEBOUNCE_MS      = (parseInt(process.env.DEBOUNCE_SECS ?? '30') || 30) * 1000;
const VAULT_DIR        = process.env.VAULT_DIR        ?? '/vault';
const GIT_REMOTE       = process.env.GIT_REMOTE       ?? 'origin';
const GIT_BRANCH       = process.env.GIT_BRANCH       ?? 'main';
const GIT_USER_NAME    = process.env.GIT_USER_NAME;
const GIT_USER_EMAIL   = process.env.GIT_USER_EMAIL;
const LIVESYNC_DB_PATH = process.env.LIVESYNC_DB_PATH ?? '/data';
const COUCHDB_URI      = process.env.COUCHDB_URI ?? '';
const COUCHDB_USER     = process.env.COUCHDB_USER ?? '';
const COUCHDB_PASSWORD = process.env.COUCHDB_PASSWORD ?? '';
const COUCHDB_DBNAME   = process.env.COUCHDB_DBNAME ?? '';
const LIVESYNC_PASSPHRASE = process.env.LIVESYNC_PASSPHRASE ?? '';

const SETTINGS_PATH = path.join(LIVESYNC_DB_PATH, '.livesync', 'settings.json');

/**
 * livesync-cli sync mutates settings.json on first run — wiping plain
 * couchDB_URI/USER/PASSWORD/DBNAME and replacing them with encrypted
 * versions tied to runtime state. On subsequent runs livesync may fail
 * to recover the connection. To make sync deterministic across container
 * restarts we rewrite the plain fields from env vars before every sync.
 *
 * Only applied when COUCHDB_URI is set (env-driven mode).
 */
function ensureSettingsFromEnv() {
    if (!COUCHDB_URI) return;
    let settings = {};
    try {
        settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    } catch { /* will create */ }

    settings.couchDB_URI      = COUCHDB_URI;
    settings.couchDB_USER     = COUCHDB_USER;
    settings.couchDB_PASSWORD = COUCHDB_PASSWORD;
    settings.couchDB_DBNAME   = COUCHDB_DBNAME;
    if (LIVESYNC_PASSPHRASE) settings.passphrase = LIVESYNC_PASSPHRASE;
    settings.encrypt = true;
    settings.isConfigured = true;
    // Match modern Obsidian plugin defaults so we can decrypt data written by
    // current LiveSync clients. Without these, decryption falls back to v1
    // and AES jobs fail against v2 ciphertexts produced by recent plugin builds.
    settings.E2EEAlgorithm        = process.env.E2EE_ALGORITHM        ?? 'v2';
    settings.hashAlg              = process.env.HASH_ALG              ?? 'xxhash64';
    settings.chunkSplitterVersion = process.env.CHUNK_SPLITTER_VERSION ?? 'v3-rabin-karp';
    if (process.env.DB_NAME_SUFFIX) {
        settings.additionalSuffixOfDatabaseName = process.env.DB_NAME_SUFFIX;
    }
    // The bot is a one-way materialiser: it should never block on conflicts.
    // Force-write whichever revision wins so notes always reach the git repo;
    // conflict resolution happens on the human-driven Obsidian side.
    settings.writeDocumentsIfConflicted = true;
    settings.resolveConflictsByNewerFile = true;
    // livesync stores credentials encrypted with a key cached in localStorage
    // when configPassphraseStore is empty. Setting LOCK_LOCAL_STORAGE keeps the
    // plain fields authoritative each run.
    settings.configPassphraseStore = 'LOCK_LOCAL_STORAGE';
    delete settings.encryptedCouchDBConnection;
    delete settings.encryptedPassphrase;

    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), { mode: 0o600 });
}

function run(cmd, args) {
    return new Promise((resolve, reject) => {
        const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'] });
        let out = '';
        proc.stdout.on('data', (d) => { out += d; });
        proc.on('close', (code) => {
            if (code === 0) resolve(out.trim());
            else reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`));
        });
        proc.on('error', reject);
    });
}

let running = false;

async function commit() {
    if (running) {
        console.log('[git-committer] commit already in progress, skipping');
        return;
    }
    running = true;
    try {
        ensureSettingsFromEnv();
        // sync sometimes exits with code 1 even when replication succeeded
        // (livesync's CLI returns non-zero on partial states). Don't fail
        // the whole cycle — mirror reads from the local DB and will pick
        // up whatever sync managed to replicate.
        try {
            await run('livesync-cli', ['sync']);
        } catch (e) {
            console.error('[git-committer] sync exited non-zero — continuing with mirror anyway:', e.message);
        }
        await run('livesync-cli', ['mirror']);
        // mirror only handles regular notes; internal files (.obsidian/*) live
        // under the `i:` doc prefix which mirror skips. mirror-internal walks
        // them and writes to disk so the bot's git commit picks them up.
        try {
            await run('livesync-cli', ['mirror-internal']);
        } catch (e) {
            console.error('[git-committer] mirror-internal failed (non-fatal):', e.message);
        }
        await run('git', ['-C', VAULT_DIR, 'add', '.']);
        const status = await run('git', ['-C', VAULT_DIR, 'status', '--porcelain']);
        if (!status) {
            console.log('[git-committer] no changes to commit');
            return;
        }
        const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
        await run('git', ['-C', VAULT_DIR, 'commit', '-m', `sync ${ts}`]);
        await run('git', ['-C', VAULT_DIR, 'push', GIT_REMOTE, GIT_BRANCH]);
        console.log(`[git-committer] committed and pushed at ${ts}`);
    } catch (e) {
        console.error('[git-committer] commit failed:', e.message);
    } finally {
        running = false;
    }
}

async function main() {
    if (!GIT_USER_NAME || !GIT_USER_EMAIL) {
        console.error('[git-committer] error: GIT_USER_NAME and GIT_USER_EMAIL env vars are required');
        process.exit(1);
    }

    // Trust the vault dir — host UID that cloned the repo will not match
    // the container UID. Use '*' wildcard since this single-purpose
    // container only operates on $VAULT_DIR anyway.
    await run('git', ['config', '--global', '--add', 'safe.directory', '*']);

    // Configure git identity inside the repo
    await run('git', ['-C', VAULT_DIR, 'config', 'user.name', GIT_USER_NAME]);
    await run('git', ['-C', VAULT_DIR, 'config', 'user.email', GIT_USER_EMAIL]);

    // Configure Codeberg remote with embedded PAT (if env vars provided)
    const CODEBERG_TOKEN = process.env.CODEBERG_TOKEN;
    const CODEBERG_REPO  = process.env.CODEBERG_REPO;
    if (CODEBERG_TOKEN && CODEBERG_REPO) {
        const remoteUrl = `https://oauth2:${CODEBERG_TOKEN}@codeberg.org/${CODEBERG_REPO}.git`;
        try {
            await run('git', ['-C', VAULT_DIR, 'remote', 'set-url', GIT_REMOTE, remoteUrl]);
            console.log(`[git-committer] remote ${GIT_REMOTE} updated to codeberg.org/${CODEBERG_REPO}`);
        } catch {
            await run('git', ['-C', VAULT_DIR, 'remote', 'add', GIT_REMOTE, remoteUrl]);
            console.log(`[git-committer] remote ${GIT_REMOTE} added → codeberg.org/${CODEBERG_REPO}`);
        }
    }

    // Initial sync on startup. commit() catches its own errors and logs them
    // — failures here don't crash the container; the watch loop will retry.
    console.log('[git-committer] startup: running initial sync + mirror + commit');
    await commit();

    // Spawn watch and respawn on exit (network blips, server restarts, etc.).
    let timer = null;
    function spawnWatch() {
        const watch = spawn('livesync-cli', ['watch'], { stdio: ['ignore', 'pipe', 'inherit'] });

        watch.stdout.on('data', () => {
            clearTimeout(timer);
            timer = setTimeout(() => commit().catch(console.error), DEBOUNCE_MS);
        });

        watch.on('exit', (code) => {
            console.error(`[git-committer] livesync-cli watch exited with code ${code} — respawning in 5s`);
            setTimeout(spawnWatch, 5000);
        });

        watch.on('error', (err) => {
            console.error('[git-committer] spawn error for livesync-cli watch:', err.message);
            setTimeout(spawnWatch, 5000);
        });
    }
    spawnWatch();
}

main().catch((e) => {
    console.error('[git-committer] fatal:', e.message);
    process.exit(1);
});
