// Runs the real CLI as a child process against a temp HYBRID_HOME. The runner is never started
// (HYBRID_RUNNER_LAUNCH=none); the tests write the runner-owned files themselves where needed.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SCHEMAS } from '../../src/constants.mjs';
import { jobPaths, runPaths } from '../../src/paths.mjs';
import { readJson, sha256, sleep, writeJsonAtomic } from '../../src/fsutil.mjs';
import { ownIdentity } from '../../src/proc.mjs';
import * as git from '../../src/git.mjs';
import * as store from '../../src/store.mjs';
import { readGlobalInstructions } from '../../src/instructions.mjs';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'hybrid.mjs');

let tmp;
let home;
let repo;
let wtRoot;
let gitCtx;
let baseCommit;
let runId;

function cli(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: {
        ...process.env,
        HYBRID_HOME: home,
        HYBRID_RUNNER_LAUNCH: 'none',
        HYBRID_SESSION_ID: 'sess-a',
        ...env,
      },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function cliJson(args, env) {
  const r = await cli([...args, '--json'], env);
  assert.equal(r.code, 0, `${args.join(' ')} failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

const rp = () => runPaths(home, runId);
const jp = (jobId) => jobPaths(home, runId, jobId);

function writeSpec(name, spec, capsule = null) {
  const dir = path.join(tmp, 'specs');
  fs.mkdirSync(dir, { recursive: true });
  if (capsule !== null) fs.writeFileSync(path.join(dir, `${name}.md`), capsule);
  const file = path.join(dir, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(spec));
  return file;
}

function writeState(jobId, fields) {
  writeJsonAtomic(jp(jobId).state, {
    schema: SCHEMAS.jobState, run_id: runId, job_id: jobId, reason: null, detail: null, attempt: 1,
    queued_at: '2026-10-06T00:00:00.000Z', started_at: '2026-10-06T00:01:00.000Z',
    ended_at: '2026-10-06T00:11:00.000Z', worktree: null, process: {}, codex_session_id: null,
    ...fields,
  });
}

let seq = 0;
function appendTransition(jobId, from, to, reason = null) {
  seq++;
  store.appendTransition(home, runId, {
    seq, ts: new Date().toISOString(), kind: 'job', job_id: jobId, from, to, reason, attempt: 1,
  });
  return seq;
}

function clearInbox() {
  for (const f of store.listPendingRequests(home, runId)) fs.rmSync(f);
}

async function fakeRunnerLock() {
  const id = await ownIdentity();
  writeJsonAtomic(rp().runnerLock, { ...id, version: 'test', acquired_at: new Date().toISOString() });
}

// Plays the runner's inbox side: completes every request that shows up.
function fakeRunner(outcome = 'accepted', reason = null) {
  const seen = [];
  const timer = setInterval(() => {
    for (const file of store.listPendingRequests(home, runId)) {
      const request = readJson(file);
      seen.push(request);
      store.completeRequest(home, runId, file, request, outcome, reason);
    }
  }, 50);
  return { seen, stop: () => clearInterval(timer) };
}

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwk-'));
  home = path.join(tmp, 'home');
  repo = path.join(tmp, 'repo');
  wtRoot = path.join(tmp, 'wt');
  fs.mkdirSync(home, { recursive: true });

  const stub = path.join(tmp, 'codex-stub.mjs');
  fs.writeFileSync(stub, "if (process.argv.includes('--version')) console.log('codex-cli 0.0.0-stub');\n");
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    schema: SCHEMAS.machineConfig,
    codex_exe: process.execPath,
    codex_prefix_args: [stub],
    worktree_root: wtRoot,
  }));

  gitCtx = { gitExe: git.resolveGitExe(), hooksDir: git.ensureEmptyHooksDir(path.join(tmp, 'hooks')) };
  fs.mkdirSync(repo);
  const g = (...args) => git.runGit(gitCtx, ['-C', repo, ...args]).stdout.trim();
  g('init', '-q', '-b', 'main');
  g('config', 'user.name', 'Test');
  g('config', 'user.email', 'test@example.invalid');
  g('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'hello\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'init');
  baseCommit = g('rev-parse', 'HEAD');
});

after(() => {
  if (!tmp) return;
  // Linked worktrees hold files open for git; unlink them through git first.
  for (const dir of fs.existsSync(wtRoot) ? fs.readdirSync(wtRoot) : []) {
    for (const job of fs.readdirSync(path.join(wtRoot, dir))) {
      git.removeWorktree(gitCtx, { repo, worktree: path.join(wtRoot, dir, job) });
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('cli setup', () => {
  test('repo add rejects an invalid alias, accepts a valid one, repo list shows it', async () => {
    assert.equal((await cli(['repo', 'add', 'BAD ALIAS', repo])).code, 2);
    const added = await cliJson(['repo', 'add', 'proj', repo]);
    assert.equal(added.alias, 'proj');
    const list = await cliJson(['repo', 'list']);
    assert.equal(list.repos.proj.path, path.resolve(repo));
    assert.match((await cli(['repo', 'list'])).stdout, /^proj /);
  });

  test('doctor passes with the stub codex and warns that its release is unverified', async () => {
    const r = await cli(['doctor']);
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /warn codex: .*codex-cli 0\.0\.0-stub.*is not codex-cli 0\.160\.1/);
    assert.match(r.stdout, /ok\s+powershell_cim/);
  });

  test('unknown command and unknown option are usage errors', async () => {
    assert.equal((await cli(['frobnicate'])).code, 2);
    assert.equal((await cli(['status', '--nope'])).code, 2);
    assert.equal((await cli(['run', 'start'])).code, 2);
  });

  test('status with no active run is not-found', async () => {
    assert.equal((await cli(['status'])).code, 4);
  });
});

describe('run lifecycle', () => {
  test('run start writes run.json, plan.md and the active-run lock', async () => {
    const out = await cliJson(['run', 'start', '--repo', 'proj', '--goal', 'integration test goal', '--concurrency', '2']);
    runId = out.run_id;
    assert.match(runId, /^r\d{6}-\d{6}-[0-9a-f]{4}$/);
    assert.equal(out.epoch, 1);
    assert.equal(out.base_commit, baseCommit);
    assert.equal(out.runner_pid, null);

    const run = readJson(rp().run);
    assert.equal(run.schema, SCHEMAS.run);
    assert.equal(run.status, 'open');
    assert.equal(run.closed_at, null);
    assert.equal(run.goal, 'integration test goal');
    assert.deepEqual(run.repo, { alias: 'proj', path: path.resolve(repo), prepare: { node_modules: 'none' } });
    assert.equal(run.base_ref, 'HEAD');
    assert.equal(run.base_commit, baseCommit);
    assert.equal(run.owner.session_id, 'sess-a');
    assert.equal(run.owner.epoch, 1);
    assert.deepEqual(run.owner_history, []);
    assert.equal(run.versions.codex, 'codex-cli 0.0.0-stub');
    assert.equal(run.versions.node, process.version);
    assert.match(run.versions.git, /^git version /);
    assert.equal(run.tools.node_exe, process.execPath);
    assert.equal(run.config.max_concurrency, 2);
    assert.equal(run.config.worktree_root, path.resolve(wtRoot));
    assert.ok(run.config.presets['luna-xhigh-impl']);
    // Global CODEX_HOME instructions are pinned (fingerprint only, never content).
    assert.match(run.global_instructions.fingerprint, /^[0-9a-f]{64}$/);
    assert.equal(run.global_instructions.fingerprint, readGlobalInstructions(run.global_instructions.codex_home).fingerprint);
    assert.deepEqual(out.global_instructions, run.global_instructions);
    assert.deepEqual(Object.keys(run.global_instructions).sort(), ['codex_home', 'files', 'fingerprint', 'present', 'selected']);

    const plan = fs.readFileSync(rp().plan, 'utf8');
    assert.ok(plan.includes(runId) && plan.includes(baseCommit));
    for (const section of ['Goal', 'Decomposition', 'Decisions', 'Jobs', 'Integration log', 'Remaining work']) {
      assert.ok(plan.includes(`## ${section}`), section);
    }
    for (const dir of [rp().inbox, rp().inboxDone, rp().jobs, rp().cursors]) assert.ok(fs.statSync(dir).isDirectory());
    assert.equal(readJson(path.join(home, 'active-run.json')).run_id, runId);
  });

  test('a second run start is a conflict naming the active run', async () => {
    const r = await cli(['run', 'start', '--repo', 'proj']);
    assert.equal(r.code, 5);
    assert.ok(r.stderr.includes(runId));
  });

  test('ensure-runner with launch mode none reports it did not launch', async () => {
    const r = await cli(['run', 'ensure-runner', '--epoch', '1']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /not launched/);
  });
});

describe('submit', () => {
  test('a valid spec creates the job dir, spec.json, capsule.md and an inbox request', async () => {
    const capsule = '## Goal\nDo the thing\n';
    const file = writeSpec('a', {
      title: 'First', preset: 'luna-xhigh-impl', capsule_file: 'a.md', write_scope: ['src/'], timeout_minutes: 30,
    }, capsule);
    const out = await cliJson(['submit', file, '--epoch', '1', '--no-wait']);
    assert.equal(out.job_id, 'j001');
    assert.equal(out.outcome, 'pending');

    assert.equal(fs.readFileSync(jp('j001').capsule, 'utf8'), capsule);
    const spec = readJson(jp('j001').spec);
    assert.equal(spec.schema, SCHEMAS.jobSpec);
    assert.equal(spec.job_id, 'j001');
    assert.equal(spec.run_id, runId);
    assert.equal(spec.preset, 'luna-xhigh-impl');
    assert.deepEqual(spec.preset_config, { model: 'gpt-6-luna', effort: 'xhigh', sandbox: 'workspace-write' });
    assert.deepEqual(spec.write_scope, ['src']);
    assert.equal(spec.timeout_minutes, 30);
    assert.equal(spec.capsule_sha256, sha256(Buffer.from(capsule)));
    assert.equal(spec.submitted_epoch, 1);
    assert.equal(spec.submitted_by, 'sess-a');
    assert.ok(Date.parse(spec.submitted_at));
    assert.equal(fs.existsSync(jp('j001').state), false);

    const pending = store.listPendingRequests(home, runId);
    assert.equal(pending.length, 1);
    const request = readJson(pending[0]);
    assert.equal(request.type, 'submit');
    assert.equal(request.job_id, 'j001');
    assert.equal(request.epoch, 1);
    assert.equal(request.session_id, 'sess-a');
  });

  test('explicit and generated ids; a duplicate explicit id conflicts', async () => {
    const explicit = writeSpec('b', { job_id: 'my-job', preset: 'sol-high-review', capsule: 'review it' });
    assert.equal((await cliJson(['submit', explicit, '--epoch', '1', '--no-wait'])).job_id, 'my-job');
    const generated = writeSpec('c', { preset: 'sol-high-review', capsule: 'review it too' });
    assert.equal((await cliJson(['submit', generated, '--epoch', '1', '--no-wait'])).job_id, 'j002');
    const dup = await cli(['submit', explicit, '--epoch', '1', '--no-wait']);
    assert.equal(dup.code, 5);
    assert.equal(store.listJobIds(home, runId).length, 3);
  });

  test('an invalid spec exits 2 listing every error and creates nothing', async () => {
    const file = writeSpec('bad', { bogus: 1, preset: 'nope', capsule: 'x', stall_minutes: 0 });
    const r = await cli(['submit', file, '--epoch', '1', '--no-wait']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /unknown field "bogus"/);
    assert.match(r.stderr, /unknown preset "nope"/);
    assert.match(r.stderr, /stall_minutes/);
    assert.equal(store.listJobIds(home, runId).length, 3);
    assert.equal(store.listPendingRequests(home, runId).length, 3);
  });

  test('a missing capsule file and a base_commit absent from the repo are usage errors', async () => {
    const noCapsule = writeSpec('nocap', { preset: 'sol-high-review', capsule_file: 'missing.md' });
    const r1 = await cli(['submit', noCapsule, '--epoch', '1', '--no-wait']);
    assert.equal(r1.code, 2);
    assert.match(r1.stderr, /capsule_file not readable/);
    const badBase = writeSpec('badbase', { preset: 'sol-high-review', capsule: 'x', base_commit: 'a'.repeat(40) });
    const r2 = await cli(['submit', badBase, '--epoch', '1', '--no-wait']);
    assert.equal(r2.code, 2);
    assert.match(r2.stderr, /does not exist/);
    assert.equal((await cli(['submit', path.join(tmp, 'nope.json'), '--epoch', '1'])).code, 4);
    assert.equal((await cli(['submit', explicitSpec(), '--no-wait'])).code, 2);
  });

  test('a stale epoch is fenced (3); takeover fences the old owner, status needs no epoch', async () => {
    const file = explicitSpec();
    const t = await cliJson(['takeover'], { HYBRID_SESSION_ID: 'sess-b' });
    assert.equal(t.epoch, 2);
    assert.equal(t.session_id, 'sess-b');
    const fenced = await cli(['submit', file, '--epoch', '1', '--no-wait']);
    assert.equal(fenced.code, 3);
    assert.match(fenced.stderr, /epoch 1 != current epoch 2/);
    assert.equal((await cli(['status'])).code, 0);

    const run = readJson(rp().run);
    assert.equal(run.owner_history.length, 1);
    assert.equal(run.owner_history[0].epoch, 1);
    assert.ok(run.owner_history[0].released_at);

    const back = await cliJson(['takeover']);
    assert.equal(back.epoch, 3);
    assert.equal(store.listJobIds(home, runId).length, 3);
  });

  test('takeover without any session identity generates an anon id and warns', async () => {
    const r = await cli(['takeover', '--json'], { HYBRID_SESSION_ID: '', CLAUDE_CODE_SESSION_ID: '' });
    assert.equal(r.code, 0);
    assert.match(JSON.parse(r.stdout).session_id, /^anon-[0-9a-f]{8}$/);
    assert.match(r.stderr, /warning: no session identity/);
    await cliJson(['takeover']); // epoch 5 for sess-a
    assert.equal(readJson(rp().run).owner.epoch, 5);
  });
});

function explicitSpec() {
  return path.join(tmp, 'specs', 'b.json');
}

describe('status, wait and run close on pending work', () => {
  test('status shows pending submits in text and json', async () => {
    const text = (await cli(['status'])).stdout;
    assert.match(text, new RegExp(`run: ${runId} open`));
    assert.match(text, /owner: sess-a epoch 5/);
    assert.match(text, new RegExp(`base: ${baseCommit.slice(0, 12)}`));
    assert.match(text, /repo: proj/);
    assert.match(text, /runner: not running/);
    assert.match(text, /counts: pending=3/);
    assert.match(text, /^j001 pending a- luna-xhigh-impl /m);

    const json = await cliJson(['status']);
    assert.equal(json.counts.pending, 3);
    assert.deepEqual(json.jobs.map((j) => j.job_id), ['j001', 'j002', 'my-job']);
    assert.equal(json.runner.alive, false);
    const one = await cliJson(['status', 'j001']);
    assert.equal(one.state, 'pending');
    assert.equal((await cli(['status', 'zzz'])).code, 4);
  });

  test('status --changed reads the feed from the session cursor and persists it', async () => {
    appendTransition('j001', null, 'queued');
    appendTransition('j001', 'queued', 'launching');
    const first = await cliJson(['status', '--changed']);
    assert.equal(first.cursor, 2);
    assert.deepEqual(first.changes.map((c) => c.seq), [1, 2]);
    assert.equal(first.run.run_id, runId);
    const cursorFile = path.join(rp().cursors, 'sess-a.json');
    assert.equal(readJson(cursorFile).seq, 2);

    appendTransition('j001', 'launching', 'running');
    const second = await cli(['status', '--changed']);
    assert.match(second.stdout, /^3 j001 launching->running$/m);
    assert.doesNotMatch(second.stdout, /^1 j001/m);
    assert.match(second.stdout, /^cursor: 3$/m);
    assert.equal(readJson(cursorFile).seq, 3);

    const since = await cliJson(['status', '--changed', '--since', '1']);
    assert.deepEqual(since.changes.map((c) => c.seq), [2, 3]);
    assert.equal(readJson(cursorFile).seq, 3, '--since must not move the cursor');

    const other = await cliJson(['status', '--changed'], { HYBRID_SESSION_ID: 'sess-z' });
    assert.equal(other.changes.length, 3, 'a new session starts from 0');
  });

  test('wait reports runner_down when work is pending and no runner holds the lock', async () => {
    const r = await cli(['wait', '--since', '3', '--poll', '200ms', '--json']);
    assert.equal(r.code, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.reason, 'runner_down');
    assert.match(out.hint, /ensure-runner --epoch 5/);
  });

  test('wait times out (exit 10) with a live runner and nothing to report', async () => {
    await fakeRunnerLock();
    const r = await cli(['wait', '--since', '3', '--timeout', '2s', '--poll', '200ms', '--json']);
    assert.equal(r.code, 10, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.reason, 'timeout');
    assert.equal(out.cursor, 3);
  });

  test('wait wakes on a wake transition after the debounce and leaves the cursor file alone', async () => {
    const before = readJson(path.join(rp().cursors, 'sess-a.json'));
    const pending = cli(['wait', '--since', '3', '--debounce', '1s', '--poll', '200ms', '--timeout', '30s', '--json']);
    await sleep(1500);
    appendTransition('j001', 'running', 'completed');
    const r = await pending;
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.reason, 'woke');
    assert.deepEqual(out.records.map((x) => [x.seq, x.to]), [[4, 'completed']]);
    assert.equal(out.cursor, 4);
    assert.deepEqual(readJson(path.join(rp().cursors, 'sess-a.json')), before);
  });

  test('run close is refused while jobs are pending', async () => {
    const r = await cli(['run', 'close', '--epoch', '5']);
    assert.equal(r.code, 5);
    assert.match(r.stderr, /j001/);
    assert.equal(readJson(rp().run).status, 'open');
  });
});

describe('job outcomes, decisions, gc and close', () => {
  test('result, status <job>, cancel and resume against synthetic runner output', async () => {
    const worktree = path.join(wtRoot, runId, 'j001');
    git.createWorktree(gitCtx, { repo, worktree, baseCommit });
    clearInbox();
    fs.rmSync(rp().runnerLock);

    writeState('j001', { state: 'completed', worktree, codex_session_id: 'sid-1' });
    writeState('my-job', { state: 'failed', reason: 'nonzero_exit', codex_session_id: 'c1f7a0e2-0000-4000-8000-000000000001' });
    writeState('j002', { state: 'queued', started_at: null, ended_at: null });
    const result = {
      schema: SCHEMAS.jobResult, run_id: runId, job_id: 'j001', epoch: 3, attempt: 1, state: 'completed', reason: null,
      detail: null,
      timestamps: { queued_at: 'q', started_at: 's', ended_at: 'e' },
      exit: { code: 0, signal: null, source: 'host' },
      provenance: {
        requested: { model: 'gpt-6-luna', effort: 'xhigh', sandbox: 'workspace-write', approval_policy: 'never' },
        observed: { model: 'gpt-6-luna', effort: 'high', sandbox_policy: 'workspace-write', approval_policy: 'never', source: 'rollout' },
        observed_matches: false, observed_mismatches: ['effort'],
        codex_session_id: 'sid-1', codex_version: 'codex-cli 0.0.0-stub', runner_version: '0.1.0', node_version: 'v24',
      },
      worker_report: {
        present: true, valid_json: true, job_id_matches: true,
        report: { job_id: 'j001', status: 'done', summary: 'did the thing', files_changed: ['src/x.mjs'], tests: 'all green', notes: '' },
        raw: '{"job_id":"j001","RAWMARKER":true}', truncated: false,
      },
      patch: {
        captured: true, file: 'attempts/1/patch.diff', sha256: 'x', bytes: 10, verdict: 'clean', violations: [], error: null,
        stats: { files: 1, added: 3, deleted: 1 },
        files: [{ path: 'src/x.mjs', status: 'A', old_mode: '000000', new_mode: '100644', added: 3, deleted: 1, binary: false }],
      },
    };
    writeJsonAtomic(jp('j001').result, result);

    const text = (await cli(['result', 'j001'])).stdout;
    assert.match(text, /^job: j001 completed$/m);
    assert.match(text, /^worker: status=done valid_json=true job_id_matches=true$/m);
    assert.match(text, /summary: did the thing/);
    assert.match(text, /^patch: clean 1 files \+3\/-1$/m);
    assert.ok(text.includes(path.join(jp('j001').dir, 'attempts', '1', 'patch.diff')));
    assert.match(text, /A src\/x\.mjs \+3\/-1/);
    assert.match(text, /observed: .*MISMATCH/);
    assert.match(text, /codex_session: sid-1/);
    assert.doesNotMatch(text, /RAWMARKER/);
    assert.match((await cli(['result', 'j001', '--full'])).stdout, /RAWMARKER/);

    const json = await cliJson(['result', 'j001']);
    assert.equal(json.patch.verdict, 'clean');
    assert.equal(json.decision, null);
    assert.match((await cli(['result', 'j002'])).stdout, /j002: queued \(not terminal\)/);
    assert.equal((await cli(['result', 'nope'])).code, 4);

    const summary = await cliJson(['status', 'j001']);
    assert.equal(summary.worker_status, 'done');
    assert.equal(summary.patch.verdict, 'clean');

    // cancel: only pending/queued/active jobs; the fake runner accepts the request
    assert.equal((await cli(['cancel', 'j001', '--epoch', '5'])).code, 5);
    const runner = fakeRunner();
    try {
      const c = await cli(['cancel', 'j002', '--epoch', '5']);
      assert.equal(c.code, 0, c.stderr);
      assert.match(c.stdout, /cancel j002: accepted/);
      writeState('j002', { state: 'cancelled', reason: 'cancel_requested' });

      assert.equal((await cli(['resume', 'j002', '--epoch', '5'])).code, 5, 'no codex session recorded');
      assert.equal((await cli(['resume', 'j001', '--epoch', '5'])).code, 5, 'completed is not resumable');
      assert.equal((await cli(['resume', 'my-job', '--epoch', '5', '--note', 'x'.repeat(5000)])).code, 2);
      const noteFile = path.join(tmp, 'note.txt');
      fs.writeFileSync(noteFile, 'from a file');
      const r = await cli(['resume', 'my-job', '--epoch', '5', '--note-file', noteFile]);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /resume my-job: accepted/);
    } finally {
      runner.stop();
    }
    assert.deepEqual(runner.seen.map((q) => [q.type, q.job_id, q.epoch]), [['cancel', 'j002', 5], ['resume', 'my-job', 5]]);
    assert.equal(runner.seen[1].payload.note, 'from a file');
  });

  test('a rejected request maps stale_epoch to exit 3 and other reasons to exit 1', async () => {
    const stale = fakeRunner('rejected', 'stale_epoch');
    try {
      assert.equal((await cli(['resume', 'my-job', '--epoch', '5'])).code, 3);
    } finally {
      stale.stop();
    }
    const other = fakeRunner('rejected', 'worktree_missing');
    try {
      const r = await cli(['resume', 'my-job', '--epoch', '5']);
      assert.equal(r.code, 1);
      assert.match(r.stdout, /rejected \(worktree_missing\)/);
    } finally {
      other.stop();
    }
  });

  test('wait reports idle once nothing is queued, active or pending', async () => {
    const r = await cli(['wait', '--since', '4', '--poll', '200ms', '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).reason, 'idle');
  });

  test('wait returns immediately when wake records exist and no work remains', async () => {
    const t0 = Date.now();
    const r = await cli(['wait', '--since', '0', '--debounce', '60s', '--json']);
    assert.equal(JSON.parse(r.stdout).reason, 'woke');
    assert.ok(Date.now() - t0 < 20_000);
  });

  test('decide records the decision and keeps history; it needs a terminal job and a valid verdict', async () => {
    assert.equal((await cli(['decide', 'j001', 'integrated'])).code, 2, 'epoch required');
    assert.equal((await cli(['decide', 'j001', 'maybe', '--epoch', '5'])).code, 2);
    const first = await cliJson(['decide', 'j001', 'integrated', '--epoch', '5', '--note', 'abc123']);
    assert.equal(first.schema, SCHEMAS.decision);
    assert.equal(first.decision, 'integrated');
    assert.equal(first.note, 'abc123');
    assert.deepEqual(first.history, []);
    const second = await cliJson(['decide', 'j001', 'rejected', '--epoch', '5']);
    assert.equal(second.history.length, 1);
    assert.equal(second.history[0].decision, 'integrated');
    assert.equal(readJson(jp('j001').decision).decision, 'rejected');
    assert.match((await cli(['status'])).stdout, /^j001 completed .* decision=rejected patch=clean 1f \+3\/-1$/m);
    assert.equal((await cliJson(['result', 'j001'])).decision.decision, 'rejected');

    writeState('j002', { state: 'queued' });
    assert.equal((await cli(['decide', 'j002', 'deferred', '--epoch', '5'])).code, 5);
    writeState('j002', { state: 'cancelled', reason: 'cancel_requested' });
  });

  test('gc needs an epoch on an open run, --dry-run lists, a real run removes the worktree', async () => {
    const worktree = path.join(wtRoot, runId, 'j001');
    assert.equal((await cli(['gc', '--dry-run'])).code, 2);
    const dry = await cliJson(['gc', '--dry-run', '--epoch', '5']);
    assert.deepEqual(dry.items.map((i) => [i.job_id, i.action]), [['j001', 'would_remove']]);
    assert.ok(fs.existsSync(worktree));

    const real = await cliJson(['gc', '--epoch', '5']);
    assert.deepEqual(real.items.map((i) => [i.job_id, i.action]), [['j001', 'removed']]);
    assert.equal(fs.existsSync(worktree), false);
    const gc = readJson(path.join(jp('j001').dir, 'gc.json'));
    assert.equal(gc.worktree, worktree);
    assert.ok(gc.removed_at);
    assert.equal((await cliJson(['gc', '--epoch', '5'])).items.length, 0);
  });

  test('run close succeeds when everything is terminal, releases the lock; a closed run gcs its root', async () => {
    assert.equal((await cli(['run', 'close', '--epoch', '4'])).code, 3);
    const closed = await cliJson(['run', 'close', '--epoch', '5']);
    assert.equal(closed.status, 'closed');
    const run = readJson(rp().run);
    assert.equal(run.status, 'closed');
    assert.ok(run.closed_at);
    assert.equal(fs.existsSync(path.join(home, 'active-run.json')), false);
    assert.equal((await cli(['run', 'close', '--run', runId, '--epoch', '5'])).code, 5);
    assert.equal((await cli(['submit', explicitSpec(), '--run', runId, '--epoch', '5', '--no-wait'])).code, 5);

    assert.ok(fs.existsSync(path.join(wtRoot, runId)));
    const gc = await cliJson(['gc', '--run', runId]);
    assert.equal(gc.run_root_removed, true);
    assert.equal(fs.existsSync(path.join(wtRoot, runId)), false);
  });
});

describe('second run', () => {
  let runId2;

  test('a stale active-run lock (its run is closed) is cleaned by run start', async () => {
    writeJsonAtomic(path.join(home, 'active-run.json'), { run_id: runId, created_at: new Date().toISOString(), session_id: 'sess-a' });
    const out = await cliJson(['run', 'start', '--repo', 'proj', '--base', 'main']);
    runId2 = out.run_id;
    assert.notEqual(runId2, runId);
    assert.equal(readJson(path.join(home, 'active-run.json')).run_id, runId2);
    assert.equal(readJson(runPaths(home, runId2).run).base_ref, 'main');
    assert.equal((await cli(['run', 'start', '--repo', 'missing'])).code, 4);
  });

  test('run list shows both runs newest first with the active one marked', async () => {
    const out = await cliJson(['run', 'list']);
    assert.equal(out.runs.length, 2);
    assert.equal(out.runs.find((r) => r.run_id === runId2).active, true);
    assert.equal(out.runs.find((r) => r.run_id === runId).status, 'closed');
    assert.match((await cli(['run', 'list'])).stdout, new RegExp(`^\\* ${runId2} open epoch=1 `, 'm'));
  });

  test('submit without --no-wait reports the runner outcome', async () => {
    runId = runId2;
    const file = writeSpec('d', { preset: 'sol-high-review', capsule: 'x' });
    const accept = fakeRunner();
    try {
      const r = await cli(['submit', file, '--epoch', '1']);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /^j001: accepted$/m);
    } finally {
      accept.stop();
    }
    const reject = fakeRunner('rejected', 'stale_epoch');
    try {
      const r = await cli(['submit', file, '--epoch', '1']);
      assert.equal(r.code, 3);
      assert.match(r.stdout, /^j002: rejected \(stale_epoch\)$/m);
    } finally {
      reject.stop();
    }
  });

  test('a submit that cannot launch the runner still leaves the queued job and says so', async () => {
    const file = writeSpec('e', { preset: 'sol-high-review', capsule: 'x' });
    const r = await cli(['submit', file, '--epoch', '1'], { HYBRID_RUNNER_LAUNCH: 'bogus' });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /Job j003 submitted/);
    assert.equal(store.listJobIds(home, runId2).includes('j003'), true);
  });
});
