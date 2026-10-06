// Runner liveness and on-demand launch. The runner is a per-run, temporary process; any
// mutating CLI command makes sure one is running (docs/ARCHITECTURE.md section 2).
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { EXIT } from './constants.mjs';
import { RUNNER_ENTRY, runPaths } from './paths.mjs';
import { nowIso, readJson, sleep, writeJsonAtomic } from './fsutil.mjs';
import { HybridError } from './store.mjs';
import { isAlive } from './proc.mjs';
import { launchDetachedViaWmi } from './wmi.mjs';

const LAUNCH_MODES = ['wmi', 'spawn', 'none'];
const READY_TIMEOUT_MS = 20_000;
const READY_POLL_MS = 250;
const LOG_TAIL_LINES = 10;

// A reader can catch a file the runner is mid-way through writing; treat that as "not there yet".
function readLoose(file) {
  try {
    return readJson(file, { optional: true });
  } catch {
    return null;
  }
}

export async function runnerAlive(home, runId) {
  const rp = runPaths(home, runId);
  const lock = readLoose(rp.runnerLock);
  const runner = readLoose(rp.runner);
  const alive = !!lock && await isAlive({ pid: lock.pid, start_time: lock.start_time });
  return { alive, lock, runner };
}

function logTail(file) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
    return lines.slice(-LOG_TAIL_LINES).join('\n');
  } catch {
    return '(no runner.log)';
  }
}

function launchSpawn(argv, cwd) {
  const child = spawn(process.execPath, argv, { cwd, detached: true, windowsHide: true, stdio: 'ignore' });
  child.on('error', () => { /* surfaced by the readiness poll */ });
  child.unref();
  return {
    return_value: null, pid: child.pid, start_time: null,
    command_line: [process.execPath, ...argv].join(' '), launched_at: nowIso(),
  };
}

export async function ensureRunner(home, runId, env = process.env) {
  const current = await runnerAlive(home, runId);
  if (current.alive) return { already: true, pid: current.lock.pid };

  const mode = env.HYBRID_RUNNER_LAUNCH ?? 'wmi';
  if (!LAUNCH_MODES.includes(mode)) {
    throw new HybridError(`HYBRID_RUNNER_LAUNCH must be one of ${LAUNCH_MODES.join(', ')}`, EXIT.usage, 'usage');
  }
  if (mode === 'none') return { already: false, pid: null, skipped: true };

  const rp = runPaths(home, runId);
  const argv = [RUNNER_ENTRY, '--home', home, '--run', runId];
  let launched;
  try {
    launched = mode === 'wmi'
      ? await launchDetachedViaWmi({ exe: process.execPath, args: argv, cwd: rp.dir })
      : launchSpawn(argv, rp.dir);
  } catch (err) {
    throw new HybridError(`Could not launch the runner (${mode}): ${err.message}`, EXIT.error, 'launch_failed');
  }
  writeJsonAtomic(rp.runnerLaunch, {
    method: mode,
    launched_at: launched.launched_at,
    pid: launched.pid,
    start_time: launched.start_time,
    command_line: launched.command_line,
    return_value: launched.return_value,
  });

  // Any live runner will do: a concurrent CLI may have launched the one that won the lock.
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    const now = await runnerAlive(home, runId);
    if (now.alive) return { already: false, pid: now.lock.pid };
    const r = now.runner;
    if (r && r.pid === launched.pid && (r.status === 'exited' || r.status === 'crashed')) {
      throw new HybridError(
        `Runner ${r.status} right after launch (${r.exit_reason ?? 'no reason recorded'}). runner.log tail:\n${logTail(rp.runnerLog)}`,
        EXIT.error, 'runner_exited',
      );
    }
    if (Date.now() >= deadline) {
      throw new HybridError(
        `Runner (pid ${launched.pid}) did not take runner.lock within ${READY_TIMEOUT_MS / 1000}s; see ${rp.runnerLog}`,
        EXIT.error, 'runner_timeout',
      );
    }
    await sleep(READY_POLL_MS);
  }
}
