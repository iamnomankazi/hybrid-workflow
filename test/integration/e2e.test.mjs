// End-to-end tests: the real CLI (bin/hybrid.mjs) driving the real runner, job host and
// test/fixtures/fake-codex.mjs against a temp HYBRID_HOME and a temp git repo.
// Run sequentially:  node --test --test-concurrency=1 test/integration/e2e.test.mjs
// Every group owns its own temp root (home, repo, worktrees, USERPROFILE), so groups cannot
// interfere with each other or with the real machine state.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as git from '../../src/git.mjs';
import { readJson } from '../../src/fsutil.mjs';
import { jobPaths, attemptPaths, runPaths } from '../../src/paths.mjs';
import {
  TASKKILL_EXE, areAlive, findProcessesReferencing, isAlive, killTree, queryProcesses,
} from '../../src/proc.mjs';
import { FAKE_CODEX, waitFor } from '../helpers/runfixture.mjs';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'hybrid.mjs');
const SESSION = 'sess-e2e';
const TERMINAL = ['completed', 'failed', 'interrupted', 'cancelled', 'paused_quota', 'paused_auth', 'rejected'];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const scenario = (name, ...extra) => [`FAKE_SCENARIO: ${name}`, ...extra].join('\n');

class Env {
  static async create({ wmi = false } = {}) {
    const env = new Env();
    env.wmi = wmi;
    env.root = fs.mkdtempSync(path.join(os.tmpdir(), 'hwe-'));
    env.home = path.join(env.root, 'home');
    env.repo = path.join(env.root, 'repo');
    env.wt = path.join(env.root, 'wt');
    env.profile = path.join(env.root, 'profile');
    env.specs = path.join(env.root, 'specs');
    for (const dir of [env.home, env.repo, env.profile, env.specs]) fs.mkdirSync(dir, { recursive: true });

    env.gitCtx = { gitExe: git.resolveGitExe(), hooksDir: git.ensureEmptyHooksDir(path.join(env.root, 'hooks')) };
    env.git = (...args) => git.runGit(env.gitCtx, ['-C', env.repo, ...args]).stdout.trim();
    git.runGit(env.gitCtx, ['init', '-q', '-b', 'main', env.repo]);
    for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.invalid'], ['core.autocrlf', 'false'], ['commit.gpgsign', 'false']]) {
      env.git('config', k, v);
    }
    const files = { 'README.md': 'hello\n', 'AGENTS.md': 'agents\n', 'src/a.txt': 'a\n', 'src/b.txt': 'b\n', '.gitignore': 'node_modules/\n' };
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(env.repo, rel)), { recursive: true });
      fs.writeFileSync(path.join(env.repo, rel), content);
    }
    env.git('add', '-A');
    env.git('commit', '-q', '-m', 'init');
    env.baseCommit = env.git('rev-parse', 'HEAD');

    // Machine config: register the repo through the CLI, then point it at the fake Codex.
    await env.cliJson(['repo', 'add', 'proj', env.repo]);
    const cfgFile = path.join(env.home, 'config.json');
    const cfg = readJson(cfgFile);
    Object.assign(cfg, {
      codex_exe: process.execPath,
      codex_prefix_args: [FAKE_CODEX],
      worktree_root: env.wt,
      poll_ms: 200,
      liveness_check_ms: 2000,
      heartbeat_ms: 500,
    });
    fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
    return env;
  }

  childEnv() {
    const e = {
      ...process.env,
      HYBRID_HOME: this.home,
      HYBRID_SESSION_ID: SESSION,
      HYBRID_RUNNER_LAUNCH: 'spawn',
      USERPROFILE: this.profile,
    };
    if (this.wmi) delete e.HYBRID_RUNNER_LAUNCH;
    return e;
  }

  // Resolves { code, stdout, stderr, json } for any exit code; json is stdout parsed when possible.
  cli(args, { env = {}, timeoutMs = 180_000 } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [BIN, ...args], { env: { ...this.childEnv(), ...env }, windowsHide: true });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`CLI timed out: ${args.join(' ')}\nstdout: ${stdout}\nstderr: ${stderr}`));
      }, timeoutMs);
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', (err) => { clearTimeout(timer); reject(err); });
      child.on('close', (code) => {
        clearTimeout(timer);
        let json = null;
        try {
          json = JSON.parse(stdout);
        } catch { /* not JSON */ }
        resolve({ code, stdout, stderr, json });
      });
    });
  }

  // Runs `args --json`, asserts the expected exit code and returns the parsed stdout document.
  async cliJson(args, { expect = 0, ...opts } = {}) {
    const r = await this.cli([...args, '--json'], opts);
    assert.equal(r.code, expect, `hybrid ${args.join(' ')} exited ${r.code} (expected ${expect})\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    if (expect === 0) assert.ok(r.json !== null, `hybrid ${args.join(' ')}: stdout is not JSON: ${r.stdout}`);
    return r.json;
  }

  writeSpec(name, spec, capsule = null) {
    if (capsule !== null) fs.writeFileSync(path.join(this.specs, `${name}.md`), capsule);
    const file = path.join(this.specs, `${name}.json`);
    fs.writeFileSync(file, JSON.stringify(spec));
    return file;
  }

  async startRun(goal = 'e2e') {
    const out = await this.cliJson(['run', 'start', '--repo', 'proj', '--goal', goal]);
    this.runId = out.run_id;
    this.epoch = out.epoch;
    this.rp = runPaths(this.home, this.runId);
    return out;
  }

  jp(jobId) { return jobPaths(this.home, this.runId, jobId); }
  ap(jobId, n = 1) { return attemptPaths(this.home, this.runId, jobId, n); }
  readState(jobId) { return readJson(this.jp(jobId).state, { optional: true }); }
  readRunner() { return readJson(this.rp.runner, { optional: true }); }
  readLock() { return readJson(this.rp.runnerLock, { optional: true }); }
  feed() {
    try {
      return fs.readFileSync(this.rp.transitions, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  }

  // Submits an inline-capsule job through the CLI (epoch defaults to the run's start epoch).
  async submit(jobId, capsule, { preset = 'sol-high-impl', write_scope = ['out/'], epoch = this.epoch, ...extra } = {}) {
    const spec = { job_id: jobId, preset, write_scope, capsule, ...extra };
    if (preset.endsWith('review')) delete spec.write_scope;
    const file = this.writeSpec(jobId, spec);
    const out = await this.cliJson(['submit', file, '--epoch', String(epoch)]);
    assert.equal(out.outcome, 'accepted', JSON.stringify(out));
    return out;
  }

  async statusJob(jobId) { return this.cliJson(['status', jobId]); }

  // Polls `hybrid status <job>` until the predicate holds.
  waitJob(jobId, predicate, { timeoutMs = 90_000, label } = {}) {
    const test = typeof predicate === 'string' ? (s) => s.state === predicate : predicate;
    let last = null;
    return waitFor(async () => {
      last = await this.statusJob(jobId);
      return test(last) ? last : null;
    }, {
      timeoutMs,
      intervalMs: 300,
      label: label ?? `job ${jobId}`,
      onTimeout: () => `last status: ${JSON.stringify(last)}\nrunner.log tail:\n${this.runnerLogTail()}`,
    });
  }

  // Both identities are recorded once Codex is running; returns them from state.json.
  async waitRunningWithCodex(jobId) {
    await this.waitJob(jobId, 'running');
    return waitFor(() => {
      const s = this.readState(jobId);
      return s?.process?.host && s?.process?.codex && s.codex_session_id ? s : null;
    }, { timeoutMs: 60_000, label: `identities of ${jobId}`, onTimeout: () => this.runnerLogTail() });
  }

  runnerLogTail() {
    try {
      return fs.readFileSync(this.rp.runnerLog, 'utf8').split('\n').slice(-25).join('\n');
    } catch {
      return '(no runner.log)';
    }
  }

  async cursor() { return (await this.cliJson(['status', '--changed'])).cursor; }

  async wait(since, { timeout = '60s', debounce = '1s', expect = 0 } = {}) {
    return this.cliJson(['wait', '--since', String(since), '--timeout', timeout, '--debounce', debounce], { expect });
  }

  async cleanup() {
    // Close the run if it is closable; failures are fine (jobs may still be active).
    if (this.runId && !this.cleanedClose) {
      await this.cli(['run', 'close', '--epoch', String(this.epoch)], { timeoutMs: 60_000 }).catch(() => {});
    }
    const killAll = async () => {
      const found = await findProcessesReferencing(this.root).catch(() => []);
      found.sort((a, b) => Number((b.command_line ?? '').includes('main.mjs')) - Number((a.command_line ?? '').includes('main.mjs')));
      for (const rec of found) {
        if (rec.start_time) await killTree({ pid: rec.pid, start_time: rec.start_time }).catch(() => {});
      }
      return found.length;
    };
    await killAll();
    for (let i = 0; i < 4; i++) {
      try {
        fs.rmSync(this.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
        return;
      } catch {
        await killAll();
      }
    }
  }
}

// ----------------------------------------------------------------------------------------------
describe('happy path: submit, wait, result, patch, decide, close, gc', () => {
  let env;
  before(async () => { env = await Env.create(); });
  after(async () => { await env?.cleanup(); });

  test('full job lifecycle through the CLI', { timeout: 300_000 }, async () => {
    const started = await env.startRun('e2e happy path');
    assert.equal(started.epoch, 1);
    assert.equal(started.base_commit, env.baseCommit);
    assert.ok(Number.isInteger(started.runner_pid), 'spawn launch reports a runner pid');
    await waitFor(() => env.readLock(), { label: 'runner.lock' });

    const c0 = await env.cursor();
    assert.equal(typeof c0, 'number');

    // spec file + capsule file next to it (capsule_file is relative to the spec).
    const specFile = env.writeSpec('happy', {
      job_id: 'happy', title: 'write out/a.txt', preset: 'sol-high-impl', write_scope: ['out/'], capsule_file: 'happy.md',
    }, ['## Goal', 'Create a file.', scenario('success', 'FAKE_WRITE: out/a.txt => hello')].join('\n'));
    const submitted = await env.cliJson(['submit', specFile, '--epoch', '1']);
    assert.equal(submitted.outcome, 'accepted');
    assert.equal(submitted.job_id, 'happy');

    const woke = await env.wait(c0, { timeout: '60s', debounce: '1s' });
    assert.equal(woke.reason, 'woke', JSON.stringify(woke));
    const completedRecord = woke.records.find((r) => r.kind === 'job' && r.job_id === 'happy' && r.to === 'completed');
    assert.ok(completedRecord, JSON.stringify(woke.records));
    assert.ok(woke.cursor >= completedRecord.seq);

    const changed = await env.cliJson(['status', '--changed']);
    assert.deepEqual(
      changed.changes.filter((r) => r.kind === 'job' && r.job_id === 'happy').map((r) => r.to),
      ['queued', 'launching', 'running', 'completed'],
    );
    assert.ok(changed.cursor >= completedRecord.seq);
    const again = await env.cliJson(['status', '--changed']);
    assert.deepEqual(again.changes, [], 'the session cursor advanced past everything already reported');
    assert.equal(again.cursor, changed.cursor);
    assert.equal(again.run.jobs.find((j) => j.job_id === 'happy').patch.verdict, 'clean');

    const result = await env.cliJson(['result', 'happy']);
    assert.equal(result.state, 'completed');
    assert.equal(result.patch.verdict, 'clean');
    assert.ok(result.patch.files.some((f) => f.path === 'out/a.txt'), JSON.stringify(result.patch.files));
    assert.equal(result.worker_report.job_id_matches, true);
    assert.equal(result.worker_report.valid_json, true);
    assert.equal(result.provenance.requested.model, 'gpt-6.1-sol');
    assert.equal(result.provenance.requested.effort, 'high');
    assert.equal(result.provenance.requested.sandbox, 'workspace-write');
    assert.equal(result.attempt, 1);
    assert.ok(fs.existsSync(result.patch_path));

    // The patch applies cleanly to a fresh clone of the repo at the base commit.
    const clone = path.join(env.root, 'clone');
    const gitExe = env.gitCtx.gitExe;
    const run = (...args) => execFileSync(gitExe, args, { windowsHide: true, encoding: 'utf8' });
    run('clone', '-q', '-c', 'core.autocrlf=false', env.repo, clone);
    run('-C', clone, 'checkout', '-q', '--detach', env.baseCommit);
    run('-C', clone, 'apply', '--check', result.patch_path);
    run('-C', clone, 'apply', result.patch_path);
    assert.equal(fs.readFileSync(path.join(clone, 'out', 'a.txt'), 'utf8'), 'hello');

    const decided = await env.cliJson(['decide', 'happy', 'integrated', '--epoch', '1', '--note', 'applied in e2e']);
    assert.equal(decided.decision, 'integrated');
    const after = await env.cliJson(['result', 'happy']);
    assert.equal(after.decision.decision, 'integrated');

    // Close: run closed, active-run.json released, runner shuts down.
    const lock = env.readLock();
    const runnerIdentity = { pid: lock.pid, start_time: lock.start_time };
    assert.equal(await isAlive(runnerIdentity), true);
    const closed = await env.cliJson(['run', 'close', '--epoch', '1']);
    assert.equal(closed.status, 'closed');
    env.cleanedClose = true;
    assert.ok(!fs.existsSync(path.join(env.home, 'active-run.json')));
    await waitFor(() => env.readRunner()?.status === 'exited', { timeoutMs: 15_000, label: 'runner exited', onTimeout: () => env.runnerLogTail() });
    assert.ok(['run_closed', 'shutdown_requested'].includes(env.readRunner().exit_reason), env.readRunner().exit_reason);
    await waitFor(async () => !(await isAlive(runnerIdentity)), { timeoutMs: 10_000, label: 'runner process gone' });

    // gc: after close there is no active run, so --run is required (plain `hybrid gc` exits 4; see report).
    // dry run lists the worktree, the real run removes it.
    const worktree = path.join(env.wt, env.runId, 'happy');
    assert.ok(fs.existsSync(worktree));
    const dry = await env.cliJson(['gc', '--dry-run', '--run', env.runId]);
    assert.equal(dry.dry_run, true);
    assert.deepEqual(dry.items.map((i) => [i.job_id, i.action]), [['happy', 'would_remove']]);
    assert.equal(dry.items[0].worktree.toLowerCase(), worktree.toLowerCase());
    assert.ok(fs.existsSync(worktree), 'dry run removes nothing');
    const real = await env.cliJson(['gc', '--run', env.runId]);
    assert.deepEqual(real.items.map((i) => [i.job_id, i.action]), [['happy', 'removed']], JSON.stringify(real));
    assert.ok(!fs.existsSync(worktree));
    assert.ok(fs.existsSync(env.jp('happy').result), 'job records survive gc');
  });
});

// ----------------------------------------------------------------------------------------------
describe('epoch fencing after takeover', () => {
  let env;
  before(async () => { env = await Env.create(); });
  after(async () => { await env?.cleanup(); });

  test('stale epoch is fenced (exit 3) and creates nothing; read-only commands still work', { timeout: 240_000 }, async () => {
    await env.startRun('e2e fencing');
    await env.submit('target', scenario('hang'));
    await env.waitJob('target', 'running');

    const taken = await env.cliJson(['takeover', '--session', 'sess-two']);
    assert.equal(taken.epoch, 2);
    assert.equal(taken.session_id, 'sess-two');

    const jobsBefore = fs.readdirSync(env.rp.jobs).sort();
    assert.deepEqual(jobsBefore, ['target']);
    const staleSpec = env.writeSpec('stale', { job_id: 'stale', preset: 'sol-high-impl', write_scope: ['out/'], capsule: scenario('success') });
    const submit = await env.cli(['submit', staleSpec, '--epoch', '1', '--json']);
    assert.equal(submit.code, 3, `${submit.stdout}${submit.stderr}`);
    assert.deepEqual(fs.readdirSync(env.rp.jobs).sort(), jobsBefore, 'a fenced submit creates no job directory');
    assert.deepEqual(fs.readdirSync(env.rp.inbox).filter((n) => n.endsWith('.json')), [], 'and queues no request');

    const cancel = await env.cli(['cancel', 'target', '--epoch', '1', '--json']);
    assert.equal(cancel.code, 3, `${cancel.stdout}${cancel.stderr}`);
    assert.equal((await env.cli(['decide', 'target', 'rejected', '--epoch', '1'])).code, 3);
    assert.equal((await env.cli(['run', 'close', '--epoch', '1'])).code, 3);
    assert.equal((await env.cli(['run', 'unhold', '--epoch', '1'])).code, 3);
    assert.equal((await env.cli(['run', 'ensure-runner', '--epoch', '1'])).code, 3);
    assert.equal((await env.cli(['submit', staleSpec, '--json'])).code, 2, 'a missing --epoch is a usage error');

    // Observation needs no epoch, and the fenced cancel did not touch the job.
    const status = await env.cliJson(['status']);
    assert.equal(status.owner.epoch, 2);
    assert.equal(status.owner.session_id, 'sess-two');
    assert.equal(status.jobs.find((j) => j.job_id === 'target').state, 'running');
    assert.equal((await env.statusJob('target')).cancel_requested, false);
    assert.equal((await env.cli(['result', 'target'])).code, 0);
    assert.equal((await env.cli(['wait', '--timeout', '1s', '--debounce', '1s', '--since', '0'])).code, 10);

    // The new owner can act.
    const cancelled = await env.cliJson(['cancel', 'target', '--epoch', '2', '--session', 'sess-two']);
    assert.equal(cancelled.outcome, 'accepted');
    await env.waitJob('target', 'cancelled');
    const closed = await env.cliJson(['run', 'close', '--epoch', '2', '--session', 'sess-two']);
    assert.equal(closed.status, 'closed');
    env.cleanedClose = true;
  });
});

// ----------------------------------------------------------------------------------------------
describe('worker lifecycle in one run: cancel, scope violations, interrupted resume', () => {
  let env;
  before(async () => {
    env = await Env.create();
    await env.startRun('e2e jobs');
  });
  after(async () => { await env?.cleanup(); });

  test('cancel a running job: cancelled, host and codex are dead', { timeout: 240_000 }, async () => {
    await env.submit('cancelme', scenario('hang'));
    const running = await env.waitRunningWithCodex('cancelme');
    const identities = [running.process.host, running.process.codex];
    assert.deepEqual(await areAlive(identities), [true, true]);
    const since = await env.cursor();

    const cancelled = await env.cliJson(['cancel', 'cancelme', '--epoch', '1']);
    assert.equal(cancelled.outcome, 'accepted');
    const woke = await env.wait(since);
    assert.equal(woke.reason, 'woke', JSON.stringify(woke));
    assert.ok(woke.records.some((r) => r.job_id === 'cancelme' && r.to === 'cancelled'));

    const result = await env.cliJson(['result', 'cancelme']);
    assert.equal(result.state, 'cancelled');
    assert.equal((await env.statusJob('cancelme')).cancel_requested, true);
    assert.deepEqual(await areAlive(identities), [false, false], 'cancel killed the whole worker tree');
    const state = env.readState('cancelme');
    for (const id of [state.process?.host, state.process?.codex].filter(Boolean)) {
      assert.equal(await isAlive(id), false);
    }

    // A terminal job cannot be cancelled again (conflict).
    assert.equal((await env.cli(['cancel', 'cancelme', '--epoch', '1'])).code, 5);
  });

  test('scope violations: completed with verdict violations, both paths listed', { timeout: 240_000 }, async () => {
    const since = await env.cursor();
    await env.submit('scoped', scenario(
      'success',
      'FAKE_WRITE: AGENTS.md => changed',
      'FAKE_WRITE: docs/x.txt => outside',
      'FAKE_WRITE: out/ok.txt => fine',
    ));
    const woke = await env.wait(since);
    assert.equal(woke.reason, 'woke', JSON.stringify(woke));

    const result = await env.cliJson(['result', 'scoped']);
    assert.equal(result.state, 'completed');
    assert.equal(result.patch.verdict, 'violations');
    const bad = result.patch.violations.map((v) => `${v.path}:${v.rule}`);
    assert.ok(bad.includes('AGENTS.md:protected'), bad.join(','));
    assert.ok(bad.includes('docs/x.txt:outside_write_scope'), bad.join(','));
    assert.ok(!result.patch.violations.some((v) => v.path === 'out/ok.txt'));
    assert.ok(fs.existsSync(result.patch_path), 'the patch is kept as evidence');

    const status = await env.cliJson(['status']);
    const row = status.jobs.find((j) => j.job_id === 'scoped');
    assert.equal(row.patch.verdict, 'violations');
    const text = await env.cli(['status']);
    assert.match(text.stdout, /scoped completed .*patch=violations/);
    await env.cliJson(['decide', 'scoped', 'rejected', '--epoch', '1']);
  });

  test('worker killed under a live runner: interrupted/worker_lost, then resume completes attempt 2', { timeout: 300_000 }, async () => {
    const since = await env.cursor();
    await env.submit('lostjob', scenario('hang'));
    const running = await env.waitRunningWithCodex('lostjob');
    const sessionId = running.codex_session_id;
    const kill = await killTree(running.process.host);
    assert.equal(kill.killed, true, JSON.stringify(kill));
    assert.equal((await env.readRunner()).status, 'running', 'the runner is untouched');

    const woke = await env.wait(since, { timeout: '60s' });
    assert.equal(woke.reason, 'woke', JSON.stringify(woke));
    const result = await env.cliJson(['result', 'lostjob']);
    assert.equal(result.state, 'interrupted');
    assert.equal(result.reason, 'worker_lost');
    assert.equal(result.exit.source, 'none');

    const before = await env.cursor();
    const resumed = await env.cliJson(['resume', 'lostjob', '--epoch', '1', '--note', scenario('success', 'FAKE_WRITE: out/resumed.txt => again')]);
    assert.equal(resumed.outcome, 'accepted', JSON.stringify(resumed));
    const done = await env.wait(before, { timeout: '90s' });
    assert.equal(done.reason, 'woke', JSON.stringify(done));

    const final = await env.cliJson(['result', 'lostjob']);
    assert.equal(final.state, 'completed', JSON.stringify(final));
    assert.equal(final.attempt, 2);
    assert.equal(final.provenance.codex_session_id, sessionId);
    assert.ok(final.patch.files.some((f) => f.path === 'out/resumed.txt'));
    const launch = readJson(env.ap('lostjob', 2).launch);
    assert.equal(launch.mode, 'resume');
    assert.deepEqual(launch.args.slice(0, 3), [FAKE_CODEX, 'exec', 'resume']);
    assert.ok(launch.args.includes(sessionId), 'resume targets the recorded Codex session');
    assert.ok(!launch.args.includes('-s') && !launch.args.includes('-C'));
    assert.equal((await env.statusJob('lostjob')).attempt, 2);
    const states = env.feed().filter((r) => r.kind === 'job' && r.job_id === 'lostjob').map((r) => r.to);
    assert.deepEqual(states, ['queued', 'launching', 'running', 'interrupted', 'queued', 'launching', 'running', 'completed']);
  });
});

// ----------------------------------------------------------------------------------------------
describe('quota hold', () => {
  let env;
  before(async () => { env = await Env.create(); });
  after(async () => { await env?.cleanup(); });

  test('quota pauses the job, hold keeps queued jobs queued and wait idle, unhold releases them', { timeout: 300_000 }, async () => {
    await env.startRun('e2e quota');
    const since = await env.cursor();
    await env.submit('q1', scenario('quota'));
    const woke = await env.wait(since);
    assert.equal(woke.reason, 'woke', JSON.stringify(woke));
    assert.equal((await env.cliJson(['result', 'q1'])).state, 'paused_quota');
    const hold = await waitFor(async () => (await env.cliJson(['status'])).runner.hold, { timeoutMs: 20_000, label: 'hold in status' });
    assert.equal(hold.reason, 'quota');
    assert.equal(hold.job_id, 'q1');
    assert.match((await env.cli(['status'])).stdout, /hold=quota/);

    const cursor = await env.cursor();
    await env.submit('q2', scenario('success', 'FAKE_WRITE: out/q2.txt => ok'));
    await sleep(2500);
    assert.equal((await env.statusJob('q2')).state, 'queued', 'a held runner must not launch');
    assert.ok(!fs.existsSync(path.join(env.wt, env.runId, 'q2')));
    const idle = await env.wait(cursor, { timeout: '30s' });
    assert.equal(idle.reason, 'idle', JSON.stringify(idle));

    const unheld = await env.cliJson(['run', 'unhold', '--epoch', '1']);
    assert.equal(unheld.outcome, 'accepted');
    assert.equal((await env.cliJson(['status'])).runner.hold, null);
    const done = await env.wait(cursor, { timeout: '90s' });
    assert.equal(done.reason, 'woke', JSON.stringify(done));
    const q2 = await env.cliJson(['result', 'q2']);
    assert.equal(q2.state, 'completed');
    assert.equal(q2.patch.verdict, 'clean');
    const feed = env.feed();
    const unholdAt = feed.find((r) => r.kind === 'run' && r.to === 'unhold').seq;
    assert.ok(feed.find((r) => r.job_id === 'q2' && r.to === 'launching').seq > unholdAt);

    // Unhold with no hold is accepted as a no-op; everything is terminal so the run closes.
    assert.equal((await env.cliJson(['run', 'unhold', '--epoch', '1'])).outcome, 'accepted');
    assert.equal((await env.cliJson(['run', 'close', '--epoch', '1'])).status, 'closed');
    env.cleanedClose = true;
  });
});

// ----------------------------------------------------------------------------------------------
describe('runner down and ensure-runner', () => {
  let env;
  before(async () => { env = await Env.create(); });
  after(async () => { await env?.cleanup(); });

  test('killed runner is reported by wait; ensure-runner adopts the job without relaunching it', { timeout: 300_000 }, async () => {
    await env.startRun('e2e runner down');
    const since = await env.cursor();
    await env.submit('slowjob', scenario('slow', 'FAKE_SLEEP_MS: 8000', 'FAKE_WRITE: out/slow.txt => done'));
    await env.waitRunningWithCodex('slowjob');

    // Kill ONLY the runner: no /T, so the job host and Codex keep running.
    const lock = env.readLock();
    const hostBefore = env.readState('slowjob').process;
    execFileSync(TASKKILL_EXE, ['/PID', String(lock.pid), '/F'], { windowsHide: true });
    await waitFor(async () => !(await isAlive({ pid: lock.pid, start_time: lock.start_time })), { timeoutMs: 10_000, label: 'runner dead' });
    assert.ok(await isAlive(hostBefore.host), 'job host survives a runner crash');

    const status = await env.cliJson(['status']);
    assert.equal(status.runner.alive, false);
    const down = await env.wait(since, { timeout: '40s' });
    assert.equal(down.reason, 'runner_down', JSON.stringify(down));
    assert.match(down.hint, /run ensure-runner --epoch 1/);

    const ensured = await env.cliJson(['run', 'ensure-runner', '--epoch', '1']);
    assert.equal(ensured.already_running, false);
    assert.ok(ensured.pid && ensured.pid !== lock.pid);
    const again = await env.cliJson(['run', 'ensure-runner', '--epoch', '1']);
    assert.equal(again.already_running, true);
    assert.equal(again.pid, ensured.pid);

    const woke = await env.wait(since, { timeout: '90s' });
    assert.equal(woke.reason, 'woke', JSON.stringify(woke));
    const result = await env.cliJson(['result', 'slowjob']);
    assert.equal(result.state, 'completed', JSON.stringify(result));
    assert.ok(result.patch.files.some((f) => f.path === 'out/slow.txt'));

    const launching = env.feed().filter((r) => r.kind === 'job' && r.job_id === 'slowjob' && r.to === 'launching');
    assert.equal(launching.length, 1, 'the adopted job was never relaunched');
    assert.equal(fs.readdirSync(path.join(env.jp('slowjob').attempts)).length, 1);
    assert.equal((await env.cliJson(['run', 'close', '--epoch', '1'])).status, 'closed');
    env.cleanedClose = true;
  });
});

// ----------------------------------------------------------------------------------------------
describe('real WMI launch', () => {
  let env;
  before(async () => { env = await Env.create({ wmi: true }); });
  after(async () => { await env?.cleanup(); });

  test('the runner is created by WmiPrvSE, runs a job, and exits on close', { timeout: 300_000 }, async () => {
    const started = await env.startRun('e2e wmi');
    assert.ok(Number.isInteger(started.runner_pid));
    const launch = readJson(env.rp.runnerLaunch);
    assert.equal(launch.method, 'wmi');
    assert.equal(launch.return_value, 0);

    const lock = await waitFor(() => env.readLock(), { label: 'runner.lock' });
    const identity = { pid: lock.pid, start_time: lock.start_time };
    const [runnerRec] = [...(await queryProcesses([lock.pid])).values()];
    const parent = (await queryProcesses([runnerRec.ppid])).get(runnerRec.ppid);
    assert.equal(parent?.name, 'WmiPrvSE.exe', `runner parent is ${JSON.stringify(parent)}`);

    const since = await env.cursor();
    await env.submit('wmijob', scenario('success', 'FAKE_WRITE: out/w.txt => wmi'));
    const woke = await env.wait(since, { timeout: '90s' });
    assert.equal(woke.reason, 'woke', JSON.stringify(woke));
    const result = await env.cliJson(['result', 'wmijob']);
    assert.equal(result.state, 'completed', JSON.stringify(result));
    assert.equal(result.patch.verdict, 'clean');

    assert.equal((await env.cliJson(['run', 'close', '--epoch', '1'])).status, 'closed');
    env.cleanedClose = true;
    await waitFor(() => env.readRunner()?.status === 'exited', { timeoutMs: 15_000, label: 'runner exited', onTimeout: () => env.runnerLogTail() });
    await waitFor(async () => !(await isAlive(identity)), { timeoutMs: 10_000, label: 'WMI runner process gone' });
  });
});
