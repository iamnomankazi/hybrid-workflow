// `hybrid controller start` end to end with a fake controller in place of Codex: the real CLI,
// controller host and runner (spawn launch mode), with a 2-second runner idle exit.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readJson } from '../../src/fsutil.mjs';
import { runnerAlive } from '../../src/launcher.mjs';
import { killTree } from '../../src/proc.mjs';
import { createFixture, waitFor } from '../helpers/runfixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(HERE, '..', '..', 'bin', 'hybrid.mjs');
const FAKE_CONTROLLER = path.resolve(HERE, '..', 'fixtures', 'fake-controller.mjs');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cli(fx, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args, '--run', fx.runId], {
      env: {
        ...process.env,
        HYBRID_HOME: fx.home,
        HYBRID_RUNNER_LAUNCH: 'spawn',
        HYBRID_SESSION_ID: 'opus',
        HYBRID_CONTROLLER_KEEPALIVE_MS: '300',
        USERPROFILE: fx.profile,
        CLAUDE_CODE_SESSION_ID: 'claude-session-must-not-leak',
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

const controllerJson = (fx) => readJson(path.join(fx.rp.dir, 'controller.json'), { optional: true });
const fakeRecord = (fx) => readJson(path.join(fx.rp.dir, 'fake-controller.json'), { optional: true });
const alive = async (fx) => (await runnerAlive(fx.home, fx.runId)).alive;

async function makeFixture() {
  return createFixture({ configOverrides: { codex_prefix_args: [FAKE_CONTROLLER], runner_idle_exit_minutes: 2 } });
}

describe('controller start: validation', () => {
  let fx;
  before(async () => {
    fx = await makeFixture();
    fs.writeFileSync(fx.rp.plan, '# plan\n');
  });
  after(() => fx?.cleanup());

  test('dry run shows the bounded Sol profile and launches nothing', async () => {
    const r = await cli(fx, ['controller', 'start', '--epoch', '1', '--dry-run', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.session_id, 'sol-controller-1');
    assert.equal(out.start_epoch, 1);
    const gitDir = path.join(fx.repo, '.git');
    assert.deepEqual(out.writable_roots.map((p) => p.toLowerCase()), [fx.rp.dir, gitDir].map((p) => p.toLowerCase()));
    assert.equal(out.args[0], FAKE_CONTROLLER);
    assert.ok(out.args.includes('workspace-write'));
    assert.ok(!out.args.some((a) => /danger|bypass/.test(a)));
    assert.ok(out.prompt.includes(fx.rp.plan));
    // The main repository is trusted by git (submit validates base_commit there) but not writable.
    const repoSlash = fx.repo.replace(/\\/g, '/');
    assert.ok(out.args.includes(`shell_environment_policy.set.GIT_CONFIG_VALUE_5='${repoSlash}'`), out.args.join(' '));
    assert.ok(!out.args.some((a) => a.startsWith('sandbox_workspace_write.writable_roots') && a.toLowerCase().includes(`'${fx.repo.toLowerCase()}'`)));
    assert.equal(fs.existsSync(path.join(fx.rp.dir, 'controllers')), true);
    assert.equal(fs.readdirSync(path.join(fx.rp.dir, 'controllers')).length, 0);
    assert.equal(await alive(fx), false);
  });

  test('stale epoch is fenced and broad writable roots are refused', async () => {
    const stale = await cli(fx, ['controller', 'start', '--epoch', '0']);
    assert.equal(stale.code, 3);
    const broad = await cli(fx, ['controller', 'start', '--epoch', '1', '--writable', path.dirname(fx.repo), '--dry-run']);
    assert.equal(broad.code, 2);
    assert.match(broad.stderr, /--writable is or contains/);
  });
});

describe('controller start: runner availability and handback', () => {
  let fx;
  before(async () => {
    fx = await makeFixture();
    fs.writeFileSync(fx.rp.plan, '# plan\n');
  });
  after(() => fx?.cleanup());

  test('launches the controller with its own identity and keeps the runner from idling out', async () => {
    const r = await cli(fx, ['controller', 'start', '--epoch', '1', '--json'], { FAKE_CONTROLLER_MS: '60000' });
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.ok(out.host_pid);
    assert.equal(controllerJson(fx).status, 'running');
    assert.ok(await alive(fx));

    const rec = await waitFor(() => fakeRecord(fx), { label: 'fake controller record' });
    assert.equal(rec.env.HYBRID_SESSION_ID, 'sol-controller-1');
    assert.equal(rec.env.HYBRID_RUNNER_LAUNCH, 'none');
    assert.equal(rec.env.HYBRID_HOME, fx.home);
    assert.equal(rec.env.CLAUDE_CODE_SESSION_ID, undefined);
    assert.equal(rec.argv.at(-1), '-');
    assert.ok(rec.prompt.includes('hybrid takeover --json'));

    // Well past the 2 s idle exit: the attached controller keeps the runner up.
    await sleep(5000);
    assert.ok(await alive(fx), 'runner idled out while a controller was attached');
    assert.equal(readJson(fx.rp.runner).status, 'running');
    const status = await cli(fx, ['status']);
    assert.match(status.stdout, /controller: sol-controller-1 running/);
  });

  test('the host relaunches a runner that died, as the host user', async () => {
    const before = (await runnerAlive(fx.home, fx.runId)).lock;
    await killTree({ pid: before.pid, start_time: before.start_time });
    await waitFor(async () => {
      const now = (await runnerAlive(fx.home, fx.runId));
      return now.alive && now.lock.pid !== before.pid;
    }, { timeoutMs: 20_000, label: 'runner relaunched by the controller host' });
  });

  test('a second controller is refused while one is attached', async () => {
    const r = await cli(fx, ['controller', 'start', '--epoch', '1']);
    assert.equal(r.code, 5);
    assert.match(r.stderr, /already running/);
  });

  test('takeover by another session stops the controller; then the runner may idle out', async () => {
    const t = await cli(fx, ['takeover', '--json'], { HYBRID_SESSION_ID: 'opus-back' });
    assert.equal(t.code, 0, t.stderr);
    assert.equal(JSON.parse(t.stdout).epoch, 2);
    const rec = await waitFor(() => (controllerJson(fx)?.status === 'exited' ? controllerJson(fx) : null), {
      timeoutMs: 15_000, label: 'controller stopped after takeover',
    });
    assert.equal(rec.stop_reason, 'taken_over');
    assert.equal(rec.thread_id, '00000000-0000-7000-8000-000000000001');
    await waitFor(async () => !(await alive(fx)), { timeoutMs: 20_000, label: 'runner idle exit after the controller left' });
    assert.equal(readJson(fx.rp.runner).exit_reason, 'idle');
    const status = await cli(fx, ['status']);
    assert.match(status.stdout, /controller: sol-controller-1 exited \(taken_over\)/);
  });
});

describe('controller start: the controller takes over and finishes', () => {
  let fx;
  before(async () => {
    fx = await makeFixture();
    fs.writeFileSync(fx.rp.plan, '# plan\n');
  });
  after(() => fx?.cleanup());

  test('its own takeover does not stop it; the previous epoch is fenced; a clean exit is recorded', async () => {
    const r = await cli(fx, ['controller', 'start', '--epoch', '1'], { FAKE_CONTROLLER_TAKEOVER: '1', FAKE_CONTROLLER_MS: '2500' });
    assert.equal(r.code, 0, r.stderr);
    const rec = await waitFor(() => (controllerJson(fx)?.status === 'exited' ? controllerJson(fx) : null), {
      timeoutMs: 20_000, label: 'controller finished',
    });
    assert.equal(rec.stop_reason, null);
    assert.equal(rec.exit.code, 0);
    const fake = fakeRecord(fx);
    assert.equal(fake.takeover.code, 0, fake.takeover.stderr);
    assert.deepEqual(JSON.parse(fake.takeover.stdout), { run_id: fx.runId, epoch: 2, session_id: 'sol-controller-1' });
    const run = readJson(fx.rp.run);
    assert.equal(run.owner.session_id, 'sol-controller-1');
    const fenced = await cli(fx, ['run', 'ensure-runner', '--epoch', '1']);
    assert.equal(fenced.code, 3);
  });
});
