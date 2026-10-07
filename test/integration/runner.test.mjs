// End-to-end runner tests against test/fixtures/fake-codex.mjs. Run sequentially:
//   node --test --test-concurrency=1 test/integration/runner.test.mjs
// One "minute" is 1000 ms (run.config.minute_ms), so timeouts and stalls are seconds long.
// Every PowerShell identity query costs ~1 s on a typical machine, so tests that can share a
// runner do (a "group": set up once, lazily, torn down by its last test).
import { test, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sha256, readJson } from '../../src/fsutil.mjs';
import { areAlive, findProcessesReferencing, killTree, TASKKILL_EXE } from '../../src/proc.mjs';
import { createFixture, waitFor } from '../helpers/runfixture.mjs';
import { readGlobalInstructions } from '../../src/instructions.mjs';

const TERMINAL = ['completed', 'failed', 'interrupted', 'cancelled', 'paused_quota', 'paused_auth', 'rejected'];
const loose = [];
const groups = new Map();

async function fixture(opts) {
  const fx = await createFixture(opts);
  loose.push(fx);
  return fx;
}

afterEach(async () => {
  while (loose.length) await loose.pop().cleanup();
});

after(async () => {
  for (const name of [...groups.keys()]) await endGroup(name);
});

function group(name, setup) {
  if (!groups.has(name)) {
    groups.set(name, (async () => {
      const fx = await createFixture(setup.options);
      await setup.run(fx);
      return fx;
    })());
  }
  return groups.get(name);
}

async function endGroup(name) {
  const pending = groups.get(name);
  groups.delete(name);
  if (pending) await (await pending.catch(() => null))?.cleanup();
}

const scenario = (name, ...extra) => [`FAKE_SCENARIO: ${name}`, ...extra].join('\n');
const jobFeed = (fx, jobId) => fx.readFeed().filter((r) => r.kind === 'job' && r.job_id === jobId);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const events = (fx, jobId, n = 1) => fs.readFileSync(fx.attempt(jobId, n).events, 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));
const terminal = (fx, jobId, timeoutMs = 90_000) => fx.waitForState(jobId, (s) => TERMINAL.includes(s.state), timeoutMs);
const kill = (pid) => execFileSync(TASKKILL_EXE, ['/PID', String(pid), '/F'], { windowsHide: true });

// Both the host and Codex identities are recorded once a job is running; wait for the Codex one.
const waitRunningWithCodex = (fx, jobId) => fx.waitForState(
  jobId, (s) => (s.state === 'running' || s.state === 'stalled') && s.process?.codex && s.codex_session_id, 90_000,
);

async function assertDead(identities) {
  const alive = await areAlive(identities);
  assert.deepEqual(alive, identities.map(() => false), `still alive: ${JSON.stringify(identities)}`);
}

// Jobs that finish on their own, run together with a poisoned parent environment.
const quick = {
  options: {},
  async run(fx) {
    fx.submit({ job_id: 'ok' }, scenario('success', 'FAKE_WRITE: src/new.txt => hello'));
    fx.submit({ job_id: 'env', write_scope: ['**'] }, scenario('dump-env'));
    fx.submit({ job_id: 'bad' }, scenario('fail'));
    fx.submit({ job_id: 'sc', write_scope: ['src/'] }, scenario(
      'success', 'FAKE_WRITE: AGENTS.md => changed', 'FAKE_WRITE: docs/x.txt => outside', 'FAKE_WRITE: src/ok.txt => fine',
    ));
    const poisoned = { OPENAI_API_KEY: 'fake', ANTHROPIC_API_KEY: 'fake', CLAUDE_CODE_FAKE: '1', CODEX_FAKE: '1' };
    Object.assign(process.env, poisoned);
    try {
      fx.startRunner();
    } finally {
      for (const name of Object.keys(poisoned)) delete process.env[name];
    }
    for (const id of ['ok', 'env', 'bad', 'sc']) await terminal(fx, id);
  },
};

// Hang-style jobs that the tests then cancel, time out or watch stall.
const lifecycle = {
  options: {},
  async run(fx) {
    fx.submit({ job_id: 'h1' }, scenario('hang'));
    fx.submit({ job_id: 'sp' }, scenario('spawn-child'));
    fx.submit({ job_id: 'slowpoke', timeout_minutes: 2 }, scenario('hang'));
    fx.submit({ job_id: 'st', stall_minutes: 1 }, scenario('hang'));
    fx.startRunner();
  },
};

// One runner killed mid-flight with two live jobs, then replaced.
const crash = {
  options: {},
  async run(fx) {
    fx.submit({ job_id: 'adopt' }, scenario('slow', 'FAKE_SLEEP_MS: 30000', 'FAKE_WRITE: src/late.txt => late'));
    fx.submit({ job_id: 'lost' }, scenario('hang'));
    const first = fx.startRunner();
    const [adopt, lost] = await Promise.all([waitRunningWithCodex(fx, 'adopt'), waitRunningWithCodex(fx, 'lost')]);
    kill(first.pid);
    await first.exited;
    // The first runner is dead, so nobody writes exit.json for the host killed here.
    await killTree(lost.process.host);
    fx.crashed = { firstPid: first.pid, adopt: adopt.process, lost: lost.process };
  },
};

// An orphaned grandchild (Codex exits by itself after 1.5 s, leaving a detached child behind) and sibling job ids.
const misc = {
  options: {},
  async run(fx) {
    fx.submit({ job_id: 'orph' }, scenario('spawn-child', 'FAKE_SLEEP_MS: 1500'));
    // jb1's worktree path is a string prefix of jb10's: finalizing jb1 must not sweep jb10's Codex.
    fx.submit({ job_id: 'jb1' }, scenario('slow', 'FAKE_SLEEP_MS: 40000'));
    fx.submit({ job_id: 'jb10' }, scenario('hang'));
    fx.startRunner();
  },
};

test('success: queued -> launching -> running -> completed with full provenance', async () => {
  const fx = await group('quick', quick);
  const state = fx.readState('ok');
  assert.equal(state.state, 'completed', fx.diagnostics('ok'));
  const result = fx.readResult('ok');
  const ap = fx.attempt('ok');

  assert.deepEqual(jobFeed(fx, 'ok').map((r) => r.to), ['queued', 'launching', 'running', 'completed']);
  const seqs = fx.readFeed().map((r) => r.seq);
  assert.ok(seqs.every((v, i) => i === 0 || v > seqs[i - 1]), `seq not strictly increasing: ${seqs}`);
  assert.equal(state.seq, jobFeed(fx, 'ok').at(-1).seq);

  const done = fs.readdirSync(fx.rp.inboxDone).map((n) => readJson(`${fx.rp.inboxDone}/${n}`));
  assert.equal(done.find((r) => r.job_id === 'ok').outcome, 'accepted');
  assert.equal(fs.readdirSync(fx.rp.inbox).filter((n) => n.endsWith('.json')).length, 0);
  assert.ok(fs.existsSync(ap.host) && fs.existsSync(ap.exit));

  const sessionId = events(fx, 'ok').find((e) => e.type === 'thread.started').thread_id;
  assert.equal(result.state, 'completed');
  assert.equal(result.provenance.codex_session_id, sessionId);
  assert.equal(state.codex_session_id, sessionId);
  assert.equal(result.provenance.preset, 'sol-low-smoke');
  assert.deepEqual(result.provenance.requested, { model: 'gpt-6.1-sol', effort: 'low', sandbox: 'workspace-write', approval_policy: 'never' });
  assert.equal(result.provenance.prompt_sha256, sha256(fs.readFileSync(ap.prompt, 'utf8')));
  assert.equal(result.provenance.capsule_sha256, readJson(`${fx.jobDir('ok')}/spec.json`).capsule_sha256);
  assert.match(result.provenance.spec_sha256, /^[0-9a-f]{64}$/);
  assert.equal(result.provenance.observed, null);
  assert.equal(result.provenance.observed_matches, null);
  assert.equal(result.exit.source, 'host');
  assert.equal(result.exit.code, 0);
  assert.equal(result.events.turn_completed, true);
  assert.equal(result.worker_report.valid_json, true);
  assert.equal(result.worker_report.job_id_matches, true);
  assert.equal(result.patch.verdict, 'clean');
  assert.deepEqual(result.patch.files.map((f) => [f.path, f.status]), [['src/new.txt', 'A']]);
  assert.ok(fs.readFileSync(ap.patch, 'utf8').includes('src/new.txt'));
  assert.equal(readJson(ap.patchMeta).verdict, 'clean');

  const launch = readJson(ap.launch);
  for (const arg of ['--ignore-user-config', '--strict-config', '--ignore-rules', 'approval_policy="never"', 'shell_environment_policy.inherit="core"']) {
    assert.ok(launch.args.includes(arg), `launch args lack ${arg}`);
  }
  assert.ok(!launch.args.some((a) => a.startsWith('--dangerously')));
  assert.equal(launch.cwd, fx.worktree('ok'));
  assert.deepEqual(launch.env_names, Object.keys(launch.env).sort());
  assert.deepEqual(launch.env_names.filter((n) => /^(OPENAI_|ANTHROPIC_|CLAUDE|CODEX_)/i.test(n)), []);
  assert.ok(events(fx, 'ok').some((e) => e.item?.type === 'fake_argv'));

  const runner = fx.readRunnerJson();
  assert.equal(runner.run_id, fx.runId);
  assert.ok(runner.last_seq >= 4);
  assert.equal(runner.counts.queued, 0);
});

test('worker environment is allowlisted and PATH is curated', async () => {
  const fx = await group('quick', quick);
  assert.equal(fx.readState('env').state, 'completed', fx.diagnostics('env'));
  const dumped = readJson(`${fx.worktree('env')}/env.json`);
  assert.ok(!Object.keys(dumped).some((n) => /^(OPENAI_|ANTHROPIC_|CLAUDE|CODEX_|HYBRID_)/i.test(n)));
  assert.ok(!JSON.stringify(dumped).includes('"fake"'));
  assert.ok(fs.readFileSync(`${fx.worktree('env')}/path-dirs.txt`, 'utf8').split('\n').length >= 4);
});

test('fail -> failed/nonzero_exit', async () => {
  const fx = await group('quick', quick);
  const s = fx.readState('bad');
  assert.equal(s.state, 'failed');
  assert.equal(s.reason, 'nonzero_exit');
  const result = fx.readResult('bad');
  assert.equal(result.exit.code, 1);
  assert.equal(result.events.turn_failed, true);
  assert.equal(result.events.failure_message, 'boom');
  assert.equal(fx.readRunnerJson().hold, null);
});

test('scope violations are recorded without failing the job', async () => {
  const fx = await group('quick', quick);
  assert.equal(fx.readState('sc').state, 'completed', fx.diagnostics('sc'));
  const { patch } = fx.readResult('sc');
  assert.equal(patch.verdict, 'violations');
  const bad = patch.violations.map((v) => `${v.path}:${v.rule}`);
  assert.ok(bad.includes('AGENTS.md:protected'), bad.join(','));
  assert.ok(bad.includes('docs/x.txt:outside_write_scope'), bad.join(','));
  assert.ok(!patch.violations.some((v) => v.path === 'src/ok.txt'));
  assert.equal(readJson(fx.attempt('sc').patchMeta).verdict, 'violations');
  await endGroup('quick');
});

test('quota pauses the job and holds launches until unhold; auth pauses with hold reason auth', async () => {
  const fx = await fixture();
  fx.submit({ job_id: 'q1' }, scenario('quota'));
  fx.startRunner();
  const s = await terminal(fx, 'q1');
  assert.equal(s.state, 'paused_quota', fx.diagnostics('q1'));
  const hold = await waitFor(() => fx.readRunnerJson()?.hold, { label: 'runner.json hold' });
  assert.equal(hold.reason, 'quota');
  assert.equal(hold.job_id, 'q1');
  assert.ok(fx.readFeed().some((r) => r.kind === 'run' && r.to === 'hold' && r.job_id === null));

  fx.submit({ job_id: 'q2' }, scenario('success'));
  await fx.waitForState('q2', 'queued', 20_000);
  await sleep(2500);
  assert.equal(fx.readState('q2').state, 'queued', 'a held runner must not launch');
  assert.ok(!fs.existsSync(fx.worktree('q2')));

  const unhold = fx.unhold();
  assert.equal((await fx.waitForRequest(unhold.id)).outcome, 'accepted');
  await fx.waitForState('q2', 'completed', 60_000);
  assert.equal(fx.readRunnerJson().hold, null);
  const feed = fx.readFeed();
  const holdAt = feed.find((r) => r.to === 'hold').seq;
  const unholdAt = feed.find((r) => r.to === 'unhold').seq;
  assert.ok(holdAt < unholdAt);
  assert.ok(feed.find((r) => r.job_id === 'q2' && r.to === 'launching').seq > unholdAt);

  fx.submit({ job_id: 'a1' }, scenario('auth'));
  const a = await terminal(fx, 'a1');
  assert.equal(a.state, 'paused_auth', fx.diagnostics('a1'));
  assert.equal((await waitFor(() => fx.readRunnerJson()?.hold, { label: 'auth hold' })).reason, 'auth');
});

test('stale-epoch and tampered submits are rejected and recorded as rejected jobs', async () => {
  const fx = await fixture();
  const stale = fx.submit({ job_id: 'old' }, scenario('success'), { epoch: 99 });
  const tampered = fx.submit({ job_id: 'tamper' }, scenario('success'));
  fs.writeFileSync(`${fx.jobDir('tamper')}/capsule.md`, 'something else');
  fx.startRunner();

  const staleOutcome = await fx.waitForRequest(stale.request.id);
  assert.equal(staleOutcome.outcome, 'rejected');
  assert.equal(staleOutcome.reason, 'stale_epoch');
  const s = fx.readState('old');
  assert.equal(s.state, 'rejected');
  assert.equal(s.reason, 'stale_epoch');
  assert.equal(fx.readResult('old').state, 'rejected');
  assert.ok(!fs.existsSync(fx.worktree('old')));

  assert.equal((await fx.waitForRequest(tampered.request.id)).reason, 'capsule_hash_mismatch');
  assert.equal(fx.readState('tamper').state, 'rejected');
});

test('cancel of a running hang job kills host and codex; shutdown is refused while active', async () => {
  const fx = await group('lifecycle', lifecycle);
  const running = await waitRunningWithCodex(fx, 'h1');
  const { host, codex } = running.process;
  assert.ok(host && codex);
  assert.deepEqual(await areAlive([host, codex]), [true, true]);

  const refused = fx.shutdown();
  assert.equal((await fx.waitForRequest(refused.id)).reason, 'active_jobs');

  const c = fx.cancel('h1');
  assert.equal((await fx.waitForRequest(c.id)).outcome, 'accepted');
  const s = await terminal(fx, 'h1', 30_000);
  assert.equal(s.state, 'cancelled', fx.diagnostics('h1'));
  assert.equal(fx.readResult('h1').state, 'cancelled');
  await assertDead([host, codex]);

  const again = fx.cancel('h1');
  assert.equal((await fx.waitForRequest(again.id)).reason, 'not_active');
});

test('cancel of a spawn-child job leaves no grandchild process behind', async () => {
  const fx = await group('lifecycle', lifecycle);
  const running = await waitRunningWithCodex(fx, 'sp');
  const worktree = fx.worktree('sp');
  const grandchild = await waitFor(async () => {
    const found = await findProcessesReferencing(worktree);
    return found.find((p) => /setTimeout/.test(p.command_line ?? '')) ?? null;
  }, { label: 'grandchild process', timeoutMs: 30_000 });
  const identity = { pid: grandchild.pid, start_time: grandchild.start_time };
  assert.deepEqual(await areAlive([identity]), [true]);

  fx.cancel('sp');
  await fx.waitForState('sp', 'cancelled', 30_000);
  await assertDead([identity, running.process.host, running.process.codex]);
});

test('hard timeout kills the worker -> failed/timeout', async () => {
  const fx = await group('lifecycle', lifecycle);
  const s = await terminal(fx, 'slowpoke');
  assert.equal(s.state, 'failed', fx.diagnostics('slowpoke'));
  assert.equal(s.reason, 'timeout');
  assert.equal(s.timed_out, true);
  assert.equal(fx.readResult('slowpoke').reason, 'timeout');
  await assertDead([s.process.host, s.process.codex]);
});

test('no events for stall_minutes -> stalled (non-terminal), then cancel', async () => {
  const fx = await group('lifecycle', lifecycle);
  await fx.waitForState('st', 'stalled', 60_000);
  const entry = jobFeed(fx, 'st').find((r) => r.to === 'stalled');
  assert.equal(entry.from, 'running');
  assert.equal(entry.reason, 'no_events');
  fx.cancel('st');
  await fx.waitForState('st', 'cancelled', 30_000);
  await endGroup('lifecycle');
});

test('queued-job cancel and resume rejections', async () => {
  const fx = await fixture({ configOverrides: { max_concurrency: 1 } });
  fx.submit({ job_id: 'busy' }, scenario('hang'));
  fx.startRunner();
  await waitRunningWithCodex(fx, 'busy');
  fx.submit({ job_id: 'second' }, scenario('success'));
  await fx.waitForState('second', 'queued', 20_000);

  const c = fx.cancel('second');
  assert.equal((await fx.waitForRequest(c.id)).outcome, 'accepted');
  assert.equal((await fx.waitForState('second', 'cancelled')).reason, 'cancel_requested');
  assert.equal(fx.readResult('second').state, 'cancelled');
  assert.equal((await fx.waitForRequest(fx.cancel('nope').id)).reason, 'unknown_job');

  assert.equal((await fx.waitForRequest(fx.resume('second').id)).reason, 'no_session');
  assert.equal((await fx.waitForRequest(fx.resume('busy').id)).reason, 'not_resumable');
  assert.equal((await fx.waitForRequest(fx.resume('busy', '', 99).id)).reason, 'stale_epoch');
  fx.cancel('busy');
  await fx.waitForState('busy', 'cancelled', 30_000);
});

test('orphan sweep: a grandchild that outlives Codex is killed and recorded', async () => {
  const fx = await group('misc', misc);
  const s = await terminal(fx, 'orph');
  assert.equal(s.state, 'failed', fx.diagnostics('orph'));
  assert.equal(s.reason, 'no_turn_completed');
  const { orphans } = fx.readResult('orph');
  assert.ok(orphans.killed.length >= 1, JSON.stringify(orphans));
  assert.deepEqual(await findProcessesReferencing(fx.worktree('orph')), []);
});

test('the orphan sweep never touches a sibling job whose id extends this one', async () => {
  const fx = await group('misc', misc);
  const sibling = await waitRunningWithCodex(fx, 'jb10');
  assert.ok(!TERMINAL.includes(fx.readState('jb1').state), 'jb1 must still be running for this test to mean anything');
  const done = await terminal(fx, 'jb1');
  assert.equal(done.state, 'completed', fx.diagnostics('jb1'));
  assert.deepEqual(await areAlive([sibling.process.host, sibling.process.codex]), [true, true]);
  assert.ok(!TERMINAL.includes(fx.readState('jb10').state));
  fx.cancel('jb10');
  await fx.waitForState('jb10', 'cancelled', 30_000);
  await endGroup('misc');
});

test('stalled returns to running when events resume, keeping the original start time', async () => {
  const fx = await fixture();
  fx.submit({ job_id: 'pz', stall_minutes: 1 }, scenario('pause', 'FAKE_SLEEP_MS: 7000', 'FAKE_RESUME_MS: 10000'));
  fx.startRunner();
  const s = await terminal(fx, 'pz');
  assert.equal(s.state, 'completed', fx.diagnostics('pz'));
  const feed = jobFeed(fx, 'pz');
  assert.deepEqual(feed.map((r) => [r.to, r.reason]), [
    ['queued', 'submitted'], ['launching', 'slot_free'], ['running', 'host_recorded'],
    ['stalled', 'no_events'], ['running', 'events_resumed'], ['completed', null],
  ]);
  assert.equal(fx.readResult('pz').timestamps.started_at, feed[2].ts);
});

test('global Codex instructions are recorded per launch and a mid-run change refuses the launch', async () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hwgi-'));
  try {
    fs.writeFileSync(path.join(codexHome, 'AGENTS.md'), 'global instructions, version one\n');
    const pinned = readGlobalInstructions(codexHome);
    const fx = await fixture({ runOverrides: { global_instructions: pinned } });
    fx.submit({ job_id: 'gi-ok' }, scenario('success'));
    fx.startRunner();
    const ok = await terminal(fx, 'gi-ok');
    assert.equal(ok.state, 'completed', fx.diagnostics('gi-ok'));
    assert.equal(readJson(fx.attempt('gi-ok').launch).global_instructions.fingerprint, pinned.fingerprint);
    const prov = fx.readResult('gi-ok').provenance;
    assert.equal(prov.global_instructions.fingerprint, pinned.fingerprint);
    assert.equal(prov.global_instructions.selected, 'AGENTS.md');
    assert.ok(!JSON.stringify(prov).includes('version one'), 'instruction text is never recorded');

    fs.writeFileSync(path.join(codexHome, 'AGENTS.md'), 'global instructions, version two\n');
    fx.submit({ job_id: 'gi-changed' }, scenario('success'));
    const refused = await terminal(fx, 'gi-changed');
    assert.equal(refused.state, 'failed', fx.diagnostics('gi-changed'));
    assert.equal(refused.reason, 'global_instructions_changed');
    assert.match(refused.detail, /changed since run start/);
    assert.ok(!fs.existsSync(fx.worktree('gi-changed')), 'no worktree is created for a refused launch');
    assert.ok(!fs.existsSync(fx.attempt('gi-changed').host), 'no worker is started');
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test('the Codex version is recorded per launch and a version changed since run start refuses the launch', async () => {
  const fx = await fixture();
  fx.submit({ job_id: 'cv-ok' }, scenario('success'));
  fx.startRunner();
  const ok = await terminal(fx, 'cv-ok');
  assert.equal(ok.state, 'completed', fx.diagnostics('cv-ok'));
  assert.equal(readJson(fx.attempt('cv-ok').launch).codex_version, 'codex-cli 0.0.0-fake');
  assert.equal(fx.readResult('cv-ok').provenance.codex_version, 'codex-cli 0.0.0-fake');

  const pinnedElsewhere = await fixture({ runOverrides: { versions: { ...fx.run.versions, codex: 'codex-cli 0.0.0-pinned' } } });
  pinnedElsewhere.submit({ job_id: 'cv-changed' }, scenario('success'));
  pinnedElsewhere.startRunner();
  const refused = await terminal(pinnedElsewhere, 'cv-changed');
  assert.equal(refused.state, 'failed', pinnedElsewhere.diagnostics('cv-changed'));
  assert.equal(refused.reason, 'codex_version_changed');
  assert.match(refused.detail, /pinned codex-cli 0\.0\.0-pinned, now codex-cli 0\.0\.0-fake/);
  assert.ok(!fs.existsSync(pinnedElsewhere.worktree('cv-changed')), 'no worktree is created for a refused launch');
  assert.ok(!fs.existsSync(pinnedElsewhere.attempt('cv-changed').host), 'no worker is started');
});

test('launch failures: a missing Codex executable and an unusable base commit', async () => {
  const fx = await fixture({ configOverrides: { codex_exe: 'C:/hybrid-test-no-such-dir/codex.exe' } });
  fx.submit({ job_id: 'noexe' }, scenario('success'));
  fx.submit({ job_id: 'nobase', base_commit: '0'.repeat(40) }, scenario('success'));
  fx.startRunner();
  const noexe = await terminal(fx, 'noexe');
  assert.equal(noexe.state, 'failed', fx.diagnostics('noexe'));
  assert.equal(noexe.reason, 'launch_failed');
  assert.match(noexe.detail, /ENOENT/);
  assert.equal(readJson(fx.attempt('noexe').exit).spawn_error.includes('ENOENT'), true);
  assert.equal(readJson(fx.attempt('noexe').host).codex, null);
  assert.ok(fs.statSync(fx.attempt('noexe').host).mtimeMs <= fs.statSync(fx.attempt('noexe').exit).mtimeMs);

  const nobase = await terminal(fx, 'nobase');
  assert.equal(nobase.state, 'failed', fx.diagnostics('nobase'));
  assert.equal(nobase.reason, 'launch_failed');
  assert.ok(!fs.existsSync(fx.attempt('nobase').host), 'no host is spawned when preparation fails');
  assert.equal(fx.readResult('nobase').patch.verdict, 'capture_failed');
  assert.deepEqual(jobFeed(fx, 'nobase').map((r) => r.to), ['queued', 'launching', 'failed']);
});

test('runner crash: the worker survives and a new runner adopts it exactly once', async () => {
  const fx = await group('crash', crash);
  const { firstPid, adopt } = fx.crashed;
  assert.deepEqual(await areAlive([adopt.host, adopt.codex]), [true, true], 'worker must survive a runner crash');

  fx.second ??= fx.startRunner();
  const done = await terminal(fx, 'adopt');
  assert.equal(done.state, 'completed', fx.diagnostics('adopt'));
  assert.equal(done.attempt, 1);
  assert.deepEqual(jobFeed(fx, 'adopt').map((r) => r.to), ['queued', 'launching', 'running', 'completed']);
  assert.ok(!fs.existsSync(fx.attempt('adopt', 2).dir));
  assert.equal(fx.readResult('adopt').patch.verdict, 'clean');
  assert.notEqual(fx.readRunnerJson().pid, firstPid);
  assert.equal(fx.readRunnerJson().pid, fx.second.pid);
});

test('worker lost while the runner is down -> interrupted/worker_lost', async () => {
  const fx = await group('crash', crash);
  const { host, codex } = fx.crashed.lost;
  await assertDead([host, codex]);
  assert.ok(!fs.existsSync(fx.attempt('lost').exit), 'a force-killed host writes no exit.json');
  fx.second ??= fx.startRunner();
  const s = await terminal(fx, 'lost');
  assert.equal(s.state, 'interrupted', fx.diagnostics('lost'));
  assert.equal(s.reason, 'worker_lost');
  assert.equal(fx.readResult('lost').exit.source, 'none');
  await endGroup('crash');
});

test('resume queues attempt 2 of the same Codex session and completes', async () => {
  const fx = await fixture();
  fx.submit({ job_id: 'rs' }, scenario('hang'));
  fx.startRunner();
  const running = await waitRunningWithCodex(fx, 'rs');
  const sessionId = running.codex_session_id;
  fx.cancel('rs');
  await fx.waitForState('rs', 'cancelled', 30_000);

  const request = fx.resume('rs', scenario('success', 'FAKE_WRITE: src/resumed.txt => again'));
  assert.equal((await fx.waitForRequest(request.id)).outcome, 'accepted');
  const done = await fx.waitForState('rs', (s) => s.attempt === 2 && TERMINAL.includes(s.state), 90_000);
  assert.equal(done.state, 'completed', fx.diagnostics('rs'));
  assert.equal(done.mode, 'resume');
  assert.equal(done.resume.from_state, 'cancelled');

  const launch = readJson(fx.attempt('rs', 2).launch);
  assert.equal(launch.mode, 'resume');
  const at = launch.args.indexOf('exec');
  assert.deepEqual(launch.args.slice(at, at + 2), ['exec', 'resume']);
  assert.ok(launch.args.includes(sessionId));
  assert.ok(!launch.args.includes('-s') && !launch.args.includes('-C'));
  assert.equal(launch.cwd, fx.worktree('rs'));
  assert.equal(events(fx, 'rs', 2).find((e) => e.type === 'thread.started').thread_id, sessionId);

  const result = fx.readResult('rs');
  assert.equal(result.attempt, 2);
  assert.equal(result.provenance.codex_session_id, sessionId);
  assert.ok(result.patch.files.some((f) => f.path === 'src/resumed.txt'));
  assert.deepEqual(
    jobFeed(fx, 'rs').map((r) => r.to),
    ['queued', 'launching', 'running', 'cancelled', 'queued', 'launching', 'running', 'completed'],
  );
});

test('idle exit: the runner exits after runner_idle_exit_minutes and releases its lock', async () => {
  const fx = await fixture({ configOverrides: { runner_idle_exit_minutes: 2 } });
  const child = fx.startRunner();
  await waitFor(() => fx.readRunnerJson()?.status === 'running', { label: 'runner running' });
  assert.ok(fs.existsSync(fx.rp.runnerLock));
  assert.equal(await child.exited, 0);
  const info = fx.readRunnerJson();
  assert.equal(info.status, 'exited');
  assert.equal(info.exit_reason, 'idle');
  assert.ok(!fs.existsSync(fx.rp.runnerLock));
});

test('a second runner exits quietly; shutdown is accepted when idle; a closed run is not started', async () => {
  const fx = await fixture();
  const first = fx.startRunner();
  await waitFor(() => fx.readRunnerJson()?.status === 'running', { label: 'runner running' });
  const second = fx.startRunner();
  assert.equal(await second.exited, 0);
  assert.equal(fx.readRunnerJson().pid, first.pid, 'the live runner keeps runner.json');

  const stop = fx.shutdown();
  assert.equal((await fx.waitForRequest(stop.id)).outcome, 'accepted');
  assert.equal(await first.exited, 0);
  assert.equal(fx.readRunnerJson().exit_reason, 'shutdown_requested');

  const run = readJson(fx.rp.run);
  fs.writeFileSync(fx.rp.run, JSON.stringify({ ...run, status: 'closed' }));
  const third = fx.startRunner();
  assert.equal(await third.exited, 0);
  assert.equal(fx.readRunnerJson().exit_reason, 'shutdown_requested', 'a closed run leaves runner.json alone');
});

test('stale lock from a dead runner is broken; a crashed feed (state ahead of feed) is repaired', async () => {
  const fx = await fixture();
  fx.submit({ job_id: 'rep' }, scenario('success'));
  const first = fx.startRunner();
  await fx.waitForState('rep', 'completed', 90_000);
  kill(first.pid);
  await first.exited;
  assert.ok(fs.existsSync(fx.rp.runnerLock), 'a force-killed runner leaves its lock behind');

  // Simulate a crash between state.json and the feed append: drop the last feed line.
  const lines = fs.readFileSync(fx.rp.transitions, 'utf8').trim().split('\n');
  const dropped = JSON.parse(lines.pop());
  fs.writeFileSync(fx.rp.transitions, `${lines.join('\n')}\n`);

  fx.startRunner();
  await waitFor(() => fx.readRunnerJson()?.pid !== first.pid && fx.readRunnerJson()?.status === 'running', { label: 'second runner' });
  const feed = fx.readFeed();
  const repaired = feed.find((r) => r.seq === dropped.seq);
  assert.equal(repaired.reason, 'recovered_feed');
  assert.equal(repaired.to, 'completed');
  assert.ok(feed.every((r, i) => i === 0 || r.seq > feed[i - 1].seq));
});
