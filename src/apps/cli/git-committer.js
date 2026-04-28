'use strict';

const { spawn } = require('child_process');

const DEBOUNCE_MS    = (parseInt(process.env.DEBOUNCE_SECS ?? '30') || 30) * 1000;
const VAULT_DIR        = process.env.VAULT_DIR        ?? '/vault';
const GIT_REMOTE     = process.env.GIT_REMOTE     ?? 'origin';
const GIT_BRANCH     = process.env.GIT_BRANCH     ?? 'main';
const GIT_USER_NAME  = process.env.GIT_USER_NAME;
const GIT_USER_EMAIL = process.env.GIT_USER_EMAIL;

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
        await run('livesync-cli', ['sync']);
        await run('livesync-cli', ['mirror']);
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

    // Initial sync on startup
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
