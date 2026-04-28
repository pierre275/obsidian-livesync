#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { spawn, spawnSync } = require('node:child_process');

const REPO_ROOT = __dirname;
const COMPOSE_FILE = path.join(REPO_ROOT, 'docker-compose.full-stack.yml');
const COUCHDB_USER = 'admin';
const COUCHDB_DBNAME = 'livesync';

// ---------- prompt helpers ----------
function ask(question, { hidden = false, defaultValue } = {}) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const promptText = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `;

        if (!hidden) {
            rl.question(promptText, (answer) => {
                rl.close();
                resolve(answer.trim() || defaultValue || '');
            });
            return;
        }

        // Hidden input
        process.stdout.write(promptText);
        const stdin = process.stdin;
        const wasRaw = stdin.isRaw;
        stdin.setRawMode?.(true);
        stdin.resume();
        stdin.setEncoding('utf8');
        let buf = '';
        const onData = (ch) => {
            if (ch === '\r' || ch === '\n' || ch === '') {
                stdin.setRawMode?.(wasRaw ?? false);
                stdin.pause();
                stdin.removeListener('data', onData);
                process.stdout.write('\n');
                rl.close();
                resolve(buf);
            } else if (ch === '') {
                process.exit(130);
            } else if (ch === '' || ch === '\b') {
                if (buf.length > 0) buf = buf.slice(0, -1);
            } else {
                buf += ch;
            }
        };
        stdin.on('data', onData);
    });
}

// ---------- non-interactive mode helper ----------
const NON_INTERACTIVE = process.env.SETUP_NONINTERACTIVE === '1';

async function answer(envVar, prompt, opts = {}) {
    if (NON_INTERACTIVE) {
        return process.env[envVar] ?? opts.defaultValue ?? '';
    }
    return ask(prompt, opts);
}

// ---------- repo URL parser ----------
function parseCodebergRepo(input) {
    const trimmed = input.trim().replace(/\.git$/, '');
    let userRepo;
    if (trimmed.startsWith('http')) {
        const u = new URL(trimmed);
        if (u.hostname !== 'codeberg.org') {
            throw new Error(`Expected codeberg.org URL, got ${u.hostname}`);
        }
        userRepo = u.pathname.replace(/^\//, '');
    } else if (trimmed.includes('/')) {
        userRepo = trimmed;
    } else {
        throw new Error(`Cannot parse repo URL: ${input}`);
    }
    const [user, repo] = userRepo.split('/');
    if (!user || !repo) throw new Error(`Cannot parse owner/repo from: ${input}`);
    return { username: user, repo: userRepo };
}

// ---------- prerequisite checks ----------
function checkCommand(cmd, args) {
    const r = spawnSync(cmd, args, { stdio: 'ignore' });
    return r.status === 0;
}

async function pathExists(p) {
    try { await fs.stat(p); return true; } catch { return false; }
}

// ---------- HTTP helpers ----------
async function couchPut(baseUrl, urlPath, body, basicAuth) {
    return fetch(`${baseUrl}${urlPath}`, {
        method: 'PUT',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Basic ${Buffer.from(basicAuth).toString('base64')}`,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
}

async function waitForCouch(baseUrl, timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`${baseUrl}/`);
            if (res.ok) return;
        } catch {}
        await new Promise((r) => setTimeout(r, 1500));
    }
    throw new Error(`CouchDB did not become ready within ${timeoutMs}ms`);
}

// ---------- update mode ----------
// If .env.full-stack already exists in cwd or in the dir passed as argv[2],
// skip all prompts and just `git pull && docker compose up -d --build`.
async function updateMode(envFile) {
    console.log('=== Self-hosted LiveSync stack: UPDATE mode ===');
    console.log(`Detected existing ${envFile} — pulling latest code and rebuilding.\n`);

    // 1. git pull in the repo
    console.log('[update] git pull...');
    const pullRes = spawnSync('git', ['-C', REPO_ROOT, 'pull', '--ff-only'], { stdio: 'inherit' });
    if (pullRes.status !== 0) { console.error('[update] git pull failed'); process.exit(1); }

    // 2. submodule update (in case lib pointer moved)
    spawnSync('git', ['-C', REPO_ROOT, 'submodule', 'update', '--init', 'src/lib'], { stdio: 'inherit' });

    // 3. rebuild + restart all services
    console.log('[update] rebuilding and restarting stack...');
    const upRes = spawnSync('docker',
        ['compose', '-f', COMPOSE_FILE, '--env-file', envFile, 'up', '-d', '--build'],
        { stdio: 'inherit' });
    if (upRes.status !== 0) { console.error('[update] docker compose up failed'); process.exit(1); }

    console.log('\n=== Stack updated and running ===');
    process.exit(0);
}

// ---------- main flow ----------
async function main() {
    if (!checkCommand('docker', ['--version'])) {
        console.error('[setup] docker is required but not found in PATH');
        process.exit(1);
    }
    if (!checkCommand('docker', ['compose', 'version'])) {
        console.error('[setup] docker compose plugin is required');
        process.exit(1);
    }
    if (!checkCommand('git', ['--version'])) {
        console.error('[setup] git is required but not found in PATH');
        process.exit(1);
    }

    // Auto-detect update mode: look for an existing .env.full-stack in
    // (a) explicit argv[2] dir, (b) cwd, or (c) common location.
    const candidateDirs = [process.argv[2], process.cwd()].filter(Boolean);
    for (const dir of candidateDirs) {
        const candidate = path.join(path.resolve(dir), '.env.full-stack');
        if (await pathExists(candidate)) {
            await updateMode(candidate);
            return;
        }
    }

    console.log('=== Self-hosted LiveSync stack setup ===\n');

    // 1. Codeberg repo URL
    const repoInput = await answer('SETUP_REPO_URL', 'Codeberg repo URL (e.g. https://codeberg.org/user/repo)');
    const { username: cbUser, repo: cbRepo } = parseCodebergRepo(repoInput);

    // 2. Codeberg PAT
    const cbToken = await answer('SETUP_PAT', 'Codeberg PAT', { hidden: true });
    if (!cbToken) { console.error('[setup] PAT is required'); process.exit(1); }

    // Validate PAT (skipped in smoketest mode)
    if (process.env.SETUP_SKIP_PAT_VALIDATION !== '1') {
        process.stdout.write('Validating Codeberg PAT... ');
        const validateRes = await fetch(`https://codeberg.org/api/v1/repos/${cbRepo}`, {
            headers: { Authorization: `token ${cbToken}` },
        });
        if (!validateRes.ok) {
            console.error(`\n[setup] Codeberg API returned ${validateRes.status}. Check the repo URL and PAT.`);
            process.exit(1);
        }
        console.log('ok');
    }

    // 3. Working directory — where to put .env.full-stack and (by default) the data dirs.
    const workDir   = path.resolve(await answer('SETUP_WORK_DIR', 'Working directory for stack data and .env.full-stack', { defaultValue: process.cwd() }));
    await fs.mkdir(workDir, { recursive: true });
    const ENV_FILE  = path.join(workDir, '.env.full-stack');
    if (await pathExists(ENV_FILE)) {
        console.error(`[setup] ${ENV_FILE} already exists. Delete it before re-running.`);
        process.exit(1);
    }

    // 4. Public hostname / IP and externally-reachable CouchDB port.
    const publicHost  = await answer('SETUP_PUBLIC_HOST', 'Public hostname or IPv4 address (how Obsidian clients reach this server)');
    if (!publicHost) { console.error('[setup] public host is required'); process.exit(1); }
    const couchPort   = await answer('SETUP_COUCHDB_PORT', 'External port to expose CouchDB on');
    if (!couchPort || !/^\d+$/.test(couchPort)) { console.error('[setup] CouchDB port must be a number'); process.exit(1); }

    // 5. paths (default to subdirs of workDir) and identity
    const vaultPath  = path.resolve(workDir, await answer('SETUP_VAULT_PATH',         'Vault host path',         { defaultValue: 'vault' }));
    const dataPath   = path.resolve(workDir, await answer('SETUP_DATA_PATH',          'LiveSync data host path', { defaultValue: 'livesync-data' }));
    const couchData  = path.resolve(workDir, await answer('SETUP_COUCHDB_DATA_PATH',  'CouchDB data host path',  { defaultValue: 'couchdb-data' }));
    const gitName    = await answer('SETUP_GIT_NAME',  'Git author name',  { defaultValue: 'livesync-bot' });
    const gitEmail   = await answer('SETUP_GIT_EMAIL', 'Git author email', { defaultValue: 'livesync-bot@example.com' });
    const debounce   = await answer('SETUP_DEBOUNCE',  'Debounce seconds', { defaultValue: '30' });

    // 6. generate secrets
    const couchPassword = crypto.randomBytes(24).toString('base64url');
    const livesyncPass  = crypto.randomBytes(36).toString('base64url');

    // The setup script reaches CouchDB via the host port mapping while configuring it.
    const localCouchUrl  = `http://127.0.0.1:${couchPort}`;
    // Obsidian clients reach CouchDB via the public hostname + external port.
    const publicCouchUrl = `http://${publicHost}:${couchPort}`;
    // git-committer reaches CouchDB via the docker bridge network (service name).
    const internalCouchUrl = `http://couchdb:5984`;

    // 7. write .env.full-stack
    const envBody = [
        `COUCHDB_USER=${COUCHDB_USER}`,
        `COUCHDB_PASSWORD=${couchPassword}`,
        `COUCHDB_DBNAME=${COUCHDB_DBNAME}`,
        `COUCHDB_DATA_PATH=${couchData}`,
        `COUCHDB_PORT=${couchPort}`,
        `PUBLIC_HOST=${publicHost}`,
        `LIVESYNC_PASSPHRASE=${livesyncPass}`,
        `VAULT_PATH=${vaultPath}`,
        `LIVESYNC_DATA_PATH=${dataPath}`,
        `DEBOUNCE_SECS=${debounce}`,
        `VAULT_DIR=/vault`,
        `GIT_REMOTE=origin`,
        `GIT_BRANCH=main`,
        `GIT_USER_NAME=${gitName}`,
        `GIT_USER_EMAIL=${gitEmail}`,
        `CODEBERG_USERNAME=${cbUser}`,
        `CODEBERG_TOKEN=${cbToken}`,
        `CODEBERG_REPO=${cbRepo}`,
        '',
    ].join('\n');
    await fs.writeFile(ENV_FILE, envBody, { mode: 0o600 });
    console.log(`[setup] wrote ${ENV_FILE} (mode 0600)`);

    // 8. write livesync settings.json — uses the docker-internal URL so git-committer
    //    can reach CouchDB via the bridge network.
    const settingsDir = path.join(dataPath, '.livesync');
    await fs.mkdir(settingsDir, { recursive: true });
    const settingsPath = path.join(settingsDir, 'settings.json');
    const settings = {
        couchDB_URI: internalCouchUrl,
        couchDB_USER: COUCHDB_USER,
        couchDB_PASSWORD: couchPassword,
        couchDB_DBNAME: COUCHDB_DBNAME,
        passphrase: livesyncPass,
        encrypt: true,
        usePathObfuscation: false,
        useDynamicIterationCount: false,
        liveSync: false,
        syncOnSave: false,
        syncOnStart: false,
        syncOnFileOpen: false,
        usePluginSync: false,
        isConfigured: true,
    };
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), { mode: 0o600 });
    console.log(`[setup] wrote ${settingsPath} (mode 0600)`);

    // Also write a public-facing settings file used only to generate the setup URI
    // (Obsidian clients connect from outside, so they need the public URL).
    const publicSettingsPath = path.join(settingsDir, 'settings.public.json');
    await fs.writeFile(publicSettingsPath, JSON.stringify({ ...settings, couchDB_URI: publicCouchUrl }, null, 2), { mode: 0o600 });

    // 7. clone Codeberg repo
    if (await pathExists(vaultPath)) {
        const isGit = await pathExists(path.join(vaultPath, '.git'));
        if (!isGit) {
            console.error(`[setup] ${vaultPath} exists and is not a git repo. Aborting.`);
            process.exit(1);
        }
        console.log(`[setup] vault path already a git repo — skipping clone`);
    } else {
        const cloneUrl = `https://oauth2:${cbToken}@codeberg.org/${cbRepo}.git`;
        const cloneRes = spawnSync('git', ['clone', cloneUrl, vaultPath], { stdio: 'inherit' });
        if (cloneRes.status !== 0) { console.error('[setup] git clone failed'); process.exit(1); }
    }

    // 8. start CouchDB
    console.log('[setup] starting CouchDB...');
    const upRes = spawnSync('docker',
        ['compose', '-f', COMPOSE_FILE, '--env-file', ENV_FILE, 'up', '-d', 'couchdb'],
        { stdio: 'inherit' });
    if (upRes.status !== 0) { console.error('[setup] docker compose up failed'); process.exit(1); }

    process.stdout.write('[setup] waiting for CouchDB to be ready...');
    await waitForCouch(localCouchUrl);
    console.log(' ok');

    // 9. configure CouchDB
    const auth = `${COUCHDB_USER}:${couchPassword}`;
    const cfg = [
        ['/_node/_local/_config/chttpd/enable_cors', 'true'],
        ['/_node/_local/_config/cors/origins', '*'],
        ['/_node/_local/_config/cors/credentials', 'true'],
        ['/_node/_local/_config/cors/methods', 'GET, PUT, POST, HEAD, DELETE'],
        ['/_node/_local/_config/cors/headers', 'accept, authorization, content-type, origin, referer, x-csrf-token'],
        ['/_node/_local/_config/couchdb/single_node', 'true'],
    ];
    for (const [p, v] of cfg) {
        const r = await couchPut(localCouchUrl, p, v, auth);
        if (!r.ok) { console.error(`[setup] PUT ${p} → ${r.status}`); process.exit(1); }
    }
    for (const db of ['_users', '_replicator', COUCHDB_DBNAME]) {
        const r = await couchPut(localCouchUrl, `/${db}`, undefined, auth);
        if (!r.ok && r.status !== 412) {
            console.error(`[setup] PUT /${db} → ${r.status}`); process.exit(1);
        }
    }
    console.log('[setup] CouchDB configured');

    // 10. Build the git-committer image (without starting) so we can use it to
    //     generate the setup URI BEFORE the container's first sync runs and
    //     mutates settings.json.
    console.log('[setup] building git-committer image...');
    const buildRes = spawnSync('docker',
        ['compose', '-f', COMPOSE_FILE, '--env-file', ENV_FILE, 'build', 'git-committer'],
        { stdio: 'inherit' });
    if (buildRes.status !== 0) { console.error('[setup] git-committer build failed'); process.exit(1); }

    // 11. Generate setup URI for Obsidian. Uses settings.public.json (with the
    //     public-facing CouchDB URL) — Obsidian clients connect from outside.
    const oneTimePass = crypto.randomBytes(6).toString('base64url');
    const setupRes = spawnSync('docker',
        ['compose', '-f', COMPOSE_FILE, '--env-file', ENV_FILE,
         'run', '--rm', '--no-deps',
         '--entrypoint', 'livesync-cli',
         'git-committer',
         '--settings', '/data/.livesync/settings.public.json',
         'gen-setup-uri', oneTimePass],
        { encoding: 'utf8' });
    if (setupRes.status !== 0) {
        console.error('[setup] gen-setup-uri failed:', setupRes.stderr);
        process.exit(1);
    }
    const setupUri = setupRes.stdout.trim();
    // Remove the public settings file — secrets shouldn't linger on disk.
    await fs.unlink(publicSettingsPath).catch(() => {});

    // 12. Now start git-committer
    console.log('[setup] starting git-committer...');
    const cup = spawnSync('docker',
        ['compose', '-f', COMPOSE_FILE, '--env-file', ENV_FILE, 'up', '-d', 'git-committer'],
        { stdio: 'inherit' });
    if (cup.status !== 0) { console.error('[setup] git-committer start failed'); process.exit(1); }

    console.log('\n=== Stack is up ===\n');
    console.log(`CouchDB exposed at: ${publicCouchUrl}`);
    console.log('');
    console.log('Paste this into the Obsidian Self-hosted LiveSync plugin (Setup wizard → Use existing setup URI):');
    console.log('');
    console.log(setupUri);
    console.log('');
    console.log(`When prompted for the URI passphrase, use: ${oneTimePass}`);
    console.log('');
}

main().catch((e) => { console.error('[setup] fatal:', e.message); process.exit(1); });
