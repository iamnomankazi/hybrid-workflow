// Job host: owns exactly one Codex process for one attempt. Spawned detached by the runner so a
// runner crash leaves it running; it spawns Codex NON-detached so libuv's kill-on-close job
// object makes "kill the host" also kill Codex. Writes host.json (identities) strictly before
// exit.json (outcome). Usage: node job-host.mjs <attemptDir>
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { SCHEMAS } from '../constants.mjs';
import { nowIso, readJson, sleep, writeJsonAtomic } from '../fsutil.mjs';
import { queryProcesses } from '../proc.mjs';

const attemptDir = path.resolve(process.argv[2] ?? '');
const file = (name) => path.join(attemptDir, name);
const IDENTITY_ATTEMPTS = 3;

function hostLog(message) {
  try {
    fs.appendFileSync(file('host.log'), `${nowIso()} ${message}\n`);
  } catch { /* nowhere left to report */ }
}

// Both identities in ONE query. A Codex that already exited yields null (it needs no identity).
async function readIdentities(codexPid) {
  let lastError;
  for (let i = 0; i < IDENTITY_ATTEMPTS; i++) {
    try {
      const records = await queryProcesses(codexPid ? [process.pid, codexPid] : [process.pid]);
      const toIdentity = (pid) => {
        const r = records.get(pid);
        return r?.start_time ? { pid, start_time: r.start_time } : null;
      };
      const host = toIdentity(process.pid);
      if (host) return { host, codex: toIdentity(codexPid) };
      lastError = new Error('host process not found by CIM query');
    } catch (err) {
      lastError = err;
    }
    await sleep(300);
  }
  throw lastError;
}

function spawnCodex(launch) {
  const fds = [];
  try {
    for (const [name, flags] of [[launch.stdin_file, 'r'], [launch.stdout_file, 'a'], [launch.stderr_file, 'a']]) {
      fds.push(fs.openSync(name, flags));
    }
    const child = spawn(launch.exe, launch.args, {
      cwd: launch.cwd, env: launch.env, windowsHide: true, stdio: fds,
    });
    // Attached synchronously: spawn failures surface as an 'error' event on the next tick.
    const started = new Promise((resolve) => {
      child.once('spawn', () => resolve(null));
      child.once('error', resolve);
    });
    const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    child.on('error', (err) => hostLog(`codex process error: ${err.message}`));
    return { child, started, exited };
  } finally {
    for (const fd of fds) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  }
}

async function main() {
  const launch = readJson(file('launch.json'));
  const { child, started, exited } = spawnCodex(launch);
  const spawnError = await started;
  const spawnedAt = nowIso();

  let identities = null;
  let identityError = null;
  try {
    identities = await readIdentities(spawnError ? null : child.pid);
  } catch (err) {
    identityError = err;
    hostLog(`could not record process identities: ${err.message}`);
  }
  writeJsonAtomic(file('host.json'), {
    schema: SCHEMAS.host,
    host: identities?.host ?? null,
    codex: spawnError ? null : (identities?.codex ?? null),
    spawned_at: spawnedAt,
  });

  if (spawnError || identityError) {
    // Without recorded identities the runner could never track this Codex: do not leave one running.
    if (identityError && !spawnError) child.kill();
    writeJsonAtomic(file('exit.json'), {
      schema: SCHEMAS.exit,
      spawn_error: (spawnError ?? identityError).message,
      ended_at: nowIso(),
    });
    return;
  }

  const { code, signal } = await exited;
  writeJsonAtomic(file('exit.json'), { schema: SCHEMAS.exit, code, signal, ended_at: nowIso() });
}

main().then(
  () => process.exit(0),
  (err) => {
    hostLog(`fatal: ${err.stack ?? err.message}`);
    process.exit(1);
  },
);
