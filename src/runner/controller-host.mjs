// Controller host: owns one temporary Sol controller (codex exec) for one run. Launched detached
// as the user by `hybrid controller start`, so it outlives the Claude session that started it.
// While Codex runs it heartbeats controller.json (the runner does not idle out while that is
// fresh) and re-ensures the runner as the user: the controller's sandbox account cannot launch it.
// If the run closes or another session takes it over, it stops the controller's process tree.
// Usage: node controller-host.mjs <controllerDir>
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { SCHEMAS } from '../constants.mjs';
import { nowIso, readJson, sleep, writeJsonAtomic } from '../fsutil.mjs';
import { runPaths } from '../paths.mjs';
import { getIdentity, killTree } from '../proc.mjs';
import { ensureRunner } from '../launcher.mjs';

const dir = path.resolve(process.argv[2] ?? '');
const launch = readJson(path.join(dir, 'launch.json'));
const rp = runPaths(launch.home, launch.run_id);

function hostLog(message) {
  try {
    fs.appendFileSync(path.join(dir, 'host.log'), `${nowIso()} ${message}\n`);
  } catch { /* nowhere left to report */ }
}

let record = {
  schema: SCHEMAS.controller,
  run_id: launch.run_id,
  session_id: launch.session_id,
  start_epoch: launch.start_epoch,
  dir,
  host: null,
  codex: null,
  thread_id: null,
  status: 'starting',
  started_at: nowIso(),
  heartbeat_at: nowIso(),
  keepalive_ms: launch.keepalive_ms,
  ended_at: null,
  exit: null,
  stop_reason: null,
};

function save(patch = {}) {
  record = { ...record, ...patch, heartbeat_at: nowIso() };
  writeJsonAtomic(rp.controller, record);
  writeJsonAtomic(path.join(dir, 'controller.json'), record);
}

// The Claude session's identity must not leak into the controller; HYBRID_* are set explicitly.
function codexEnv() {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!/^(CLAUDE|ANTHROPIC|HYBRID_)/i.test(name)) env[name] = value;
  }
  return { ...env, HYBRID_HOME: launch.home, HYBRID_SESSION_ID: launch.session_id, HYBRID_RUNNER_LAUNCH: 'none' };
}

function threadId() {
  try {
    const first = fs.readFileSync(launch.stdout_file, 'utf8').split(/\r?\n/, 1)[0];
    const event = JSON.parse(first);
    return event.type === 'thread.started' ? event.thread_id : null;
  } catch {
    return null;
  }
}

// Why the controller must stop now, or null.
function stopReason() {
  let run;
  try {
    run = readJson(rp.run);
  } catch (err) {
    hostLog(`could not read run.json: ${err.message}`);
    return null;
  }
  if (run.status !== 'open') return 'run_closed';
  if (run.owner.epoch > launch.start_epoch && run.owner.session_id !== launch.session_id) return 'taken_over';
  return null;
}

async function keepRunner() {
  try {
    const r = await ensureRunner(launch.home, launch.run_id, { ...process.env, HYBRID_RUNNER_LAUNCH: launch.runner_launch });
    if (!r.already && !r.skipped) hostLog(`runner started, pid ${r.pid}`);
  } catch (err) {
    hostLog(`could not ensure the runner: ${err.message}`);
  }
}

async function main() {
  save();
  const fds = [
    fs.openSync(launch.stdin_file, 'r'), fs.openSync(launch.stdout_file, 'a'), fs.openSync(launch.stderr_file, 'a'),
  ];
  let child;
  try {
    child = spawn(launch.exe, launch.args, { cwd: launch.cwd, env: codexEnv(), windowsHide: true, stdio: fds });
  } finally {
    for (const fd of fds) fs.closeSync(fd);
  }
  const spawnError = await new Promise((resolve) => {
    child.once('spawn', () => resolve(null));
    child.once('error', resolve);
  });
  if (spawnError) {
    save({ status: 'exited', ended_at: nowIso(), stop_reason: 'spawn_error', exit: { spawn_error: spawnError.message } });
    return;
  }
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  const [host, codex] = await Promise.all([getIdentity(process.pid), getIdentity(child.pid)]);
  save({ status: 'running', host, codex });
  hostLog(`controller started: codex pid ${child.pid}, session ${launch.session_id}`);

  let stopping = null;
  for (;;) {
    const done = await Promise.race([exited, sleep(launch.keepalive_ms).then(() => null)]);
    if (done) {
      save({
        status: 'exited', ended_at: nowIso(), exit: done, stop_reason: stopping, thread_id: threadId(),
      });
      hostLog(`controller exited: code ${done.code} signal ${done.signal} (${stopping ?? 'finished'})`);
      return;
    }
    record.thread_id ??= threadId();
    const reason = stopping ? null : stopReason();
    if (reason) {
      stopping = reason;
      hostLog(`stopping the controller: ${reason}`);
      const killed = codex ? await killTree(codex) : null;
      if (!killed?.killed) child.kill();
      save();
      continue;
    }
    save();
    if (!stopping) await keepRunner();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    hostLog(`fatal: ${err.stack ?? err.message}`);
    try {
      save({ status: 'exited', ended_at: nowIso(), stop_reason: 'host_error' });
    } catch { /* already logged */ }
    process.exit(1);
  },
);
