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

// ---------- shared: read .env into a key→value map ----------
function readEnvFile(envFile) {
    const text = fsSync.readFileSync(envFile, 'utf8');
    const out = {};
    for (const line of text.split('\n')) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (m) out[m[1]] = m[2];
    }
    return out;
}

// ---------- shared: generate setup URI and write it to disk ----------
async function generateSetupUri(envFile) {
    const env = readEnvFile(envFile);
    const required = ['VAULT_PATH', 'PUBLIC_HOST', 'COUCHDB_PORT',
                      'COUCHDB_USER', 'COUCHDB_PASSWORD', 'COUCHDB_DBNAME', 'LIVESYNC_PASSPHRASE'];
    for (const k of required) {
        if (!env[k]) {
            console.error(`[setup-uri] ${envFile} is missing required key ${k}.`);
            console.error('[setup-uri] Delete the env file and re-run for fresh setup, or add the key manually.');
            return null;
        }
    }

    // Always rebuild settings.public.json from env values — the in-container
    // settings.json gets mutated by livesync's first sync, so we don't trust it.
    const publicSettings = {
        couchDB_URI: `http://${env.PUBLIC_HOST}:${env.COUCHDB_PORT}`,
        couchDB_USER: env.COUCHDB_USER,
        couchDB_PASSWORD: env.COUCHDB_PASSWORD,
        couchDB_DBNAME: env.COUCHDB_DBNAME,
        passphrase: env.LIVESYNC_PASSPHRASE,
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
    const settingsDir = path.join(env.VAULT_PATH, '.livesync');
    await fs.mkdir(settingsDir, { recursive: true });
    const publicSettingsPath = path.join(settingsDir, 'settings.public.json');
    await fs.writeFile(publicSettingsPath, JSON.stringify(publicSettings, null, 2), { mode: 0o600 });

    const oneTime = crypto.randomBytes(6).toString('base64url');

    // The entrypoint script auto-prepends LIVESYNC_DB_PATH (=/data), so do NOT
    // pass /data ourselves — it would become commandArgs[0] (the passphrase).
    const proc = spawnSync('docker',
        ['compose', '-f', COMPOSE_FILE, '--env-file', envFile,
         'run', '--rm', '--no-deps',
         '--entrypoint', 'livesync-cli',
         'git-committer',
         '--settings', '/data/.livesync/settings.public.json',
         'gen-setup-uri', oneTime],
        { encoding: 'utf8' });

    // Always remove the public settings file — secrets shouldn't linger.
    await fs.unlink(publicSettingsPath).catch(() => {});

    if (proc.status !== 0) {
        console.error('[setup-uri] gen-setup-uri failed:', proc.stderr || proc.stdout);
        return null;
    }
    const uri = proc.stdout.trim();
    if (!uri.startsWith('obsidian://setuplivesync?')) {
        console.error('[setup-uri] unexpected output from gen-setup-uri:', uri.slice(0, 200));
        return null;
    }

    // Write URI + passphrase next to the env file so the user can copy it
    // without dealing with truncated terminal output.
    const envDir = path.dirname(envFile);
    const uriFile = path.join(envDir, 'setup-uri.txt');
    const body = [
        '# Self-hosted LiveSync setup URI',
        '# Paste this into Obsidian → Self-hosted LiveSync → Setup wizard → Use existing setup URI',
        '# When prompted for the URI passphrase, use the value below.',
        '',
        `PASSPHRASE: ${oneTime}`,
        '',
        'URI:',
        uri,
        '',
    ].join('\n');
    await fs.writeFile(uriFile, body, { mode: 0o600 });

    console.log('');
    console.log('=== Obsidian setup URI ===');
    console.log(`File:        ${uriFile}`);
    console.log(`CouchDB URL: http://${env.PUBLIC_HOST}:${env.COUCHDB_PORT}`);
    console.log(`Passphrase:  ${oneTime}`);
    console.log('');
    console.log('To get the URI:');
    console.log(`  cat ${uriFile}`);
    console.log('');
    return { uri, oneTime, uriFile };
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

    // 4. Always regenerate the setup URI so the user has a fresh one available.
    await generateSetupUri(envFile);
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

    // 5. paths (default to subdirs of workDir) and identity.
    // The vault directory is the single dir that holds notes + livesync DB
    // + settings + .git. (livesync-cli conflates "vault" and "database-path".)
    const vaultPath  = path.resolve(workDir, await answer('SETUP_VAULT_PATH',         'Vault host path (holds notes, .git, and livesync DB)', { defaultValue: 'vault' }));
    const couchData  = path.resolve(workDir, await answer('SETUP_COUCHDB_DATA_PATH',  'CouchDB data host path',  { defaultValue: 'couchdb-data' }));
    const gitName    = await answer('SETUP_GIT_NAME',  'Git author name',  { defaultValue: 'livesync-bot' });
    const gitEmail   = await answer('SETUP_GIT_EMAIL', 'Git author email', { defaultValue: 'livesync-bot@example.com' });
    const debounce   = await answer('SETUP_DEBOUNCE',  'Debounce seconds', { defaultValue: '30' });

    // 6. generate secrets
    const couchPassword = crypto.randomBytes(24).toString('base64url');
    const livesyncPass  = crypto.randomBytes(36).toString('base64url');

    // The setup script reaches CouchDB via the host port mapping while configuring it.
    const localCouchUrl  = `http://127.0.0.1:${couchPort}`;
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

    // 8. write livesync settings.json into the vault dir's .livesync subdir.
    //    Uses the docker-internal URL so git-committer can reach CouchDB
    //    via the bridge network.
    const settingsDir = path.join(vaultPath, '.livesync');
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

    // (settings.public.json is built later inside generateSetupUri() from
    // env vars — that way it always reflects the latest values.)

    // 9. clone Codeberg repo (or use existing vault if it's already a git repo)
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

    // 9b. ensure livesync internal dirs are gitignored inside the vault repo.
    //     Without this, git-committer would commit settings.json (with secrets)
    //     and the leveldb files into Codeberg.
    const vaultGitignore = path.join(vaultPath, '.gitignore');
    let gitignoreText = '';
    try { gitignoreText = await fs.readFile(vaultGitignore, 'utf8'); } catch { /* missing */ }
    const ignoreEntries = ['/.livesync/', '/data-*-livesync-v2/', '/runtime/'];
    let changed = false;
    for (const entry of ignoreEntries) {
        if (!gitignoreText.split('\n').some((l) => l.trim() === entry)) {
            gitignoreText += (gitignoreText && !gitignoreText.endsWith('\n') ? '\n' : '') + entry + '\n';
            changed = true;
        }
    }
    if (changed) {
        await fs.writeFile(vaultGitignore, gitignoreText);
        console.log('[setup] added livesync entries to vault .gitignore');
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

    // 9. configure CouchDB. CORS origins must be explicit (NOT '*') because
    //    Access-Control-Allow-Credentials: true requires non-wildcard origins.
    //    Origins are the ones the LiveSync plugin uses on each platform:
    //    desktop = app://obsidian.md, mobile = capacitor://localhost,
    //    browser/test = http://localhost.
    const auth = `${COUCHDB_USER}:${couchPassword}`;
    const cfg = [
        ['/_node/_local/_config/chttpd/enable_cors', 'true'],
        ['/_node/_local/_config/cors/origins', 'app://obsidian.md,capacitor://localhost,http://localhost'],
        ['/_node/_local/_config/cors/credentials', 'true'],
        ['/_node/_local/_config/cors/methods', 'GET,PUT,POST,HEAD,DELETE'],
        ['/_node/_local/_config/cors/headers', 'accept,authorization,content-type,origin,referer'],
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

    // 10. Build the git-committer image (without starting) so we can use it
    //     to generate the setup URI before the container's first sync runs.
    console.log('[setup] building git-committer image...');
    const buildRes = spawnSync('docker',
        ['compose', '-f', COMPOSE_FILE, '--env-file', ENV_FILE, 'build', 'git-committer'],
        { stdio: 'inherit' });
    if (buildRes.status !== 0) { console.error('[setup] git-committer build failed'); process.exit(1); }

    // 11. Start git-committer
    console.log('[setup] starting git-committer...');
    const cup = spawnSync('docker',
        ['compose', '-f', COMPOSE_FILE, '--env-file', ENV_FILE, 'up', '-d', 'git-committer'],
        { stdio: 'inherit' });
    if (cup.status !== 0) { console.error('[setup] git-committer start failed'); process.exit(1); }

    console.log('\n=== Stack is up ===');

    // 12. Generate setup URI (writes it to setup-uri.txt next to .env.full-stack)
    const result = await generateSetupUri(ENV_FILE);
    if (!result) { process.exit(1); }
}

main().catch((e) => { console.error('[setup] fatal:', e.message); process.exit(1); });
