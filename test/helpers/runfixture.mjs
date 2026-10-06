// Test fixture: a temp HYBRID_HOME, a temp git repo and a valid run.json, plus helpers that do
// exactly what the CLI will (write spec/capsule, then an inbox request) and wait on runner state.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HYBRID_VERSION, SCHEMAS } from '../../src/constants.mjs';
import { buildRunConfig, loadMachineConfig } from '../../src/config.mjs';
import { ensureDir, nowIso, readJson, readText, sha256, writeFileExclusive, writeJsonAtomic } from '../../src/fsutil.mjs';
import * as git from '../../src/git.mjs';
import { attemptPaths, homePaths, jobPaths, runPaths, RUNNER_ENTRY } from '../../src/paths.mjs';
import { findProcessesReferencing, killTree } from '../../src/proc.mjs';
import { validateSpec } from '../../src/spec.mjs';
import {
  generateRunId, listJobIds, readJobResult, readJobState, readRequestOutcome, readTransitions, writeRequest,
} from '../../src/store.mjs';

export const FAKE_CODEX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'fake-codex.mjs');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor(fn, { timeoutMs = 30_000, intervalMs = 100, label = 'condition', onTimeout } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value;
    try {
      value = await fn();
    } catch { /* transient read during a write; retry */ }
    if (value) return value;
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}${onTimeout ? `\n${onTimeout()}` : ''}`);
    }
    await sleep(intervalMs);
  }
}

function unlinkLinks(dir, depth = 0) {
  if (depth > 4) return;
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const p = path.join(dir, name);
    let st;
    try {
      st = fs.lstatSync(p);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) fs.unlinkSync(p);
    else if (st.isDirectory() && name !== '.git') unlinkLinks(p, depth + 1);
  }
}

export async function createFixture({ jobs = [], configOverrides = {}, runOverrides = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hwr-'));
  const home = path.join(root, 'home');
  const repo = path.join(root, 'repo');
  const worktreeRoot = path.join(root, 'wt');
  const profile = path.join(root, 'profile');
  for (const dir of [home, repo, profile]) ensureDir(dir);

  const gitExe = git.resolveGitExe();
  const ctx = { gitExe, hooksDir: git.ensureEmptyHooksDir(homePaths(home).emptyHooks) };
  const g = (args, opts) => git.runGit(ctx, args, opts).stdout.trim();
  g(['init', '-q', '-b', 'main', repo]);
  for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.invalid'], ['core.autocrlf', 'false'], ['commit.gpgsign', 'false']]) {
    g(['-C', repo, 'config', k, v]);
  }
  const files = {
    'README.md': 'hello\n', 'AGENTS.md': 'agents\n', 'src/a.txt': 'a\n', 'src/b.txt': 'b\n', '.gitignore': 'node_modules/\n',
  };
  for (const [rel, content] of Object.entries(files)) {
    ensureDir(path.dirname(path.join(repo, rel)));
    fs.writeFileSync(path.join(repo, rel), content);
  }
  g(['-C', repo, 'add', '-A']);
  g(['-C', repo, 'commit', '-q', '-m', 'init']);
  const baseCommit = g(['-C', repo, 'rev-parse', 'HEAD']);

  const machine = loadMachineConfig(home);
  machine.codex_exe = process.execPath;
  machine.codex_prefix_args = [FAKE_CODEX];
  machine.worktree_root = worktreeRoot;
  const config = {
    ...buildRunConfig(machine),
    minute_ms: 1000,
    poll_ms: 200,
    liveness_check_ms: 2000,
    heartbeat_ms: 500,
    runner_idle_exit_minutes: 30,
    ...configOverrides,
  };

  const runId = generateRunId();
  const rp = runPaths(home, runId);
  for (const dir of [rp.dir, rp.inbox, rp.jobs]) ensureDir(dir);
  const run = {
    schema: SCHEMAS.run,
    run_id: runId,
    status: 'open',
    created_at: nowIso(),
    closed_at: null,
    goal: 'test run',
    repo: { alias: 'test', path: repo, prepare: { node_modules: 'none' } },
    base_ref: 'HEAD',
    base_commit: baseCommit,
    owner: { session_id: 'test', epoch: 1, acquired_at: nowIso() },
    owner_history: [],
    versions: { hybrid: HYBRID_VERSION, node: process.version, git: git.gitVersion(ctx), codex: 'codex-cli 0.0.0-fake' },
    tools: { node_exe: process.execPath, git_exe: gitExe },
    config,
    ...runOverrides,
  };
  writeJsonAtomic(rp.run, run);

  const runners = [];
  let jobCounter = 0;

  const fx = {
    root, home, repo, runId, worktreeRoot, baseCommit, run, rp, ctx, profile,
    jobDir: (jobId) => jobPaths(home, runId, jobId).dir,
    attempt: (jobId, n = 1) => attemptPaths(home, runId, jobId, n),
    worktree: (jobId) => path.join(worktreeRoot, runId, jobId),
    readState: (jobId) => readJobState(home, runId, jobId),
    readResult: (jobId) => readJobResult(home, runId, jobId),
    readFeed: () => readTransitions(home, runId).records,
    readRunnerJson: () => readJson(rp.runner, { optional: true }),
    readRunnerLog: () => readText(rp.runnerLog, { optional: true }) ?? '',
    jobIds: () => listJobIds(home, runId),

    // What the CLI does: write-once spec + capsule, then a submit request.
    submit(rawSpec, capsuleText = 'Do the task.', { epoch = 1, jobId } = {}) {
      const id = jobId ?? rawSpec.job_id ?? `j${String(++jobCounter).padStart(3, '0')}`;
      const raw = { preset: 'sol-low-smoke', write_scope: ['src/'], ...rawSpec, job_id: id, capsule: capsuleText };
      const checked = validateSpec(raw, {
        presets: config.presets,
        defaultTimeoutMinutes: config.default_timeout_minutes,
        maxTimeoutMinutes: config.max_timeout_minutes,
        defaultStallMinutes: config.stall_minutes,
        capsuleText,
      });
      if (!checked.ok) throw new Error(`fixture spec invalid: ${checked.errors.join('; ')}`);
      const jp = jobPaths(home, runId, id);
      ensureDir(jp.dir);
      writeFileExclusive(jp.capsule, capsuleText);
      writeFileExclusive(jp.spec, `${JSON.stringify({
        ...checked.spec,
        job_id: id,
        run_id: runId,
        capsule_sha256: sha256(capsuleText),
        submitted_at: nowIso(),
        submitted_epoch: 1,
        submitted_by: 'test',
      }, null, 2)}\n`);
      const request = writeRequest(home, runId, { type: 'submit', epoch, session_id: 'test', job_id: id });
      return { jobId: id, request };
    },
    cancel: (jobId, epoch = 1) => writeRequest(home, runId, { type: 'cancel', epoch, session_id: 'test', job_id: jobId }),
    resume: (jobId, note = '', epoch = 1) => writeRequest(home, runId, {
      type: 'resume', epoch, session_id: 'test', job_id: jobId, payload: { note },
    }),
    unhold: (epoch = 1) => writeRequest(home, runId, { type: 'unhold', epoch, session_id: 'test' }),
    shutdown: (epoch = 1) => writeRequest(home, runId, { type: 'shutdown', epoch, session_id: 'test' }),
    requestOutcome: (id) => readRequestOutcome(home, runId, id),

    startRunner({ env = {} } = {}) {
      const log = fs.openSync(path.join(root, 'runner-stdio.log'), 'a');
      const child = spawn(process.execPath, [RUNNER_ENTRY, '--home', home, '--run', runId], {
        detached: false,
        windowsHide: true,
        stdio: ['ignore', log, log],
        // The runner's worker env is built from this one; USERPROFILE keeps rollout lookups and git config inside root.
        env: { ...process.env, USERPROFILE: profile, ...env },
      });
      fs.closeSync(log);
      child.exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
      runners.push(child);
      return child;
    },

    diagnostics(jobId) {
      const lines = [`runner.json: ${JSON.stringify(fx.readRunnerJson())}`];
      if (jobId) lines.push(`state: ${JSON.stringify(fx.readState(jobId))}`);
      lines.push(`runner.log tail:\n${fx.readRunnerLog().split('\n').slice(-25).join('\n')}`);
      return lines.join('\n');
    },

    // predicate: a state name or a function(state) -> truthy
    waitForState(jobId, predicate, timeoutMs = 30_000) {
      const test = typeof predicate === 'string' ? (s) => s.state === predicate : predicate;
      return waitFor(() => {
        const s = fx.readState(jobId);
        return s && test(s) ? s : null;
      }, { timeoutMs, label: `job ${jobId} state ${typeof predicate === 'string' ? predicate : 'predicate'}`, onTimeout: () => fx.diagnostics(jobId) });
    },

    waitForRequest: (id, timeoutMs = 20_000) => waitFor(() => fx.requestOutcome(id), { timeoutMs, label: `request ${id}`, onTimeout: () => fx.diagnostics() }),

    async cleanup() {
      for (const child of runners) {
        try { child.kill(); } catch { /* gone */ }
      }
      // Runners first so nothing new is launched while the rest are killed.
      const killAll = async () => {
        const found = await findProcessesReferencing(root).catch(() => []);
        const isRunner = (r) => Number((r.command_line ?? '').includes('main.mjs'));
        found.sort((a, b) => isRunner(b) - isRunner(a));
        for (const rec of found) {
          if (!rec.start_time) continue;
          try { await killTree({ pid: rec.pid, start_time: rec.start_time }); } catch { /* best effort */ }
        }
        return found.length;
      };
      await killAll();
      unlinkLinks(worktreeRoot);
      for (let i = 0; i < 4; i++) {
        try {
          fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
          return;
        } catch {
          await killAll(); // something still holds a handle inside root
        }
      }
    },
  };

  for (const job of jobs) fx.submit(job.spec ?? job, job.capsule ?? 'Do the task.');
  return fx;
}
