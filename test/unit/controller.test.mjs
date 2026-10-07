import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CONTROLLER_KEEPALIVE_MS, CONTROLLER_PROFILE, CONTROLLER_STALE_FACTOR, CONTROLLER_STALE_MIN_MS, buildControllerArgs, controllerAttached,
  controllerPrompt, controllerShellEnv, validateExtraRoot,
} from '../../src/controller.mjs';
import { WORKER_DISABLED_FEATURES } from '../../src/codex.mjs';

const RUN_DIR = 'C:\\hw\\home\\runs\\r261007-221341-fc2b';
const GIT_DIR = 'C:\\src\\proj\\.git';

function args(overrides = {}) {
  const shellEnv = controllerShellEnv({ home: 'C:\\hw\\home', sessionId: 'sol-controller-1', safeDirectories: [RUN_DIR, GIT_DIR] });
  return buildControllerArgs({
    cwd: RUN_DIR, writableRoots: [GIT_DIR], lastMessageFile: `${RUN_DIR}\\controllers\\1\\last.md`, shellEnv, ...overrides,
  });
}

const valueAfter = (a, flag) => a[a.indexOf(flag) + 1];
const configs = (a) => a.filter((_, i) => a[i - 1] === '-c');

test('controller profile is Sol xhigh in the elevated workspace-write sandbox', () => {
  assert.deepEqual({ ...CONTROLLER_PROFILE }, {
    model: 'gpt-6.1-sol', effort: 'xhigh', sandbox: 'workspace-write', windowsSandbox: 'elevated',
  });
  const a = args();
  assert.deepEqual(a.slice(0, 5), ['exec', '--ignore-user-config', '--strict-config', '--ignore-rules', '--skip-git-repo-check']);
  assert.equal(valueAfter(a, '-m'), 'gpt-6.1-sol');
  assert.equal(valueAfter(a, '-s'), 'workspace-write');
  assert.equal(valueAfter(a, '-C'), RUN_DIR);
  assert.equal(a.at(-1), '-');
  const c = configs(a);
  for (const expected of [
    'model_reasoning_effort="xhigh"', 'approval_policy="never"', 'windows.sandbox="elevated"',
    'sandbox_workspace_write.network_access=true', 'skills.include_instructions=false',
    `sandbox_workspace_write.writable_roots=['${GIT_DIR}']`,
    ...WORKER_DISABLED_FEATURES.map((f) => `features.${f}=false`),
  ]) {
    assert.ok(c.includes(expected), expected);
  }
  // Guardian / auto-review stays at Codex's default: never disabled or rerouted.
  assert.ok(!a.some((x) => /guardian/.test(x)));
  assert.ok(!a.includes('--approve-for-me'));
});

test('controller args never carry full access or bypass flags', () => {
  const a = args();
  assert.ok(!a.some((x) => /danger|dangerously|bypass/.test(x)), a.join(' '));
  assert.throws(() => args({ writableRoots: ["C:\\x', 'danger-full-access"] }), /Invalid value|Forbidden/);
  assert.throws(() => args({ shellEnv: { X: 'danger-full-access' } }), /Forbidden Codex argument/);
  assert.throws(() => args({ cwd: 'relative' }), /Invalid cwd/);
});

test('controller shell env: Hybrid identity, no runner launches, git safe.directory without global config', () => {
  const env = controllerShellEnv({ home: 'C:\\hw\\home', sessionId: 'sol-controller-2', safeDirectories: [RUN_DIR, GIT_DIR] });
  assert.equal(env.HYBRID_HOME, 'C:\\hw\\home');
  assert.equal(env.HYBRID_SESSION_ID, 'sol-controller-2');
  assert.equal(env.HYBRID_RUNNER_LAUNCH, 'none');
  assert.equal(env.PSExecutionPolicyPreference, 'RemoteSigned');
  assert.equal(env.GIT_CONFIG_COUNT, '5');
  assert.equal(env.GIT_CONFIG_KEY_0, 'http.sslBackend');
  assert.equal(env.GIT_CONFIG_VALUE_0, 'openssl');
  const safe = [1, 2, 3, 4].map((i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]);
  assert.deepEqual(safe, [
    ['safe.directory', 'C:/hw/home/runs/r261007-221341-fc2b'], ['safe.directory', 'C:/hw/home/runs/r261007-221341-fc2b/*'],
    ['safe.directory', 'C:/src/proj/.git'], ['safe.directory', 'C:/src/proj/.git/*'],
  ]);
  const c = configs(args());
  assert.ok(c.includes("shell_environment_policy.set.HYBRID_RUNNER_LAUNCH='none'"));
  assert.ok(c.includes("shell_environment_policy.set.HYBRID_SESSION_ID='sol-controller-1'"));
});

test('validateExtraRoot accepts a worktree and rejects broad or overlapping roots', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-ctl-'));
  try {
    const profile = path.join(tmp, 'Users', 'me');
    const projects = path.join(profile, 'Projects');
    const repo = path.join(projects, 'proj');
    const home = path.join(tmp, 'hw', 'home');
    const intwt = path.join(tmp, 'hw', 'int', 'proj-run');
    for (const d of [repo, home, intwt]) fs.mkdirSync(d, { recursive: true });
    const ctx = { repo, home, userProfile: profile };
    assert.equal(validateExtraRoot(intwt, ctx), null);
    assert.match(validateExtraRoot(path.parse(tmp).root, ctx), /drive root/);
    assert.match(validateExtraRoot(profile, ctx), /user profile/);
    assert.match(validateExtraRoot(path.join(tmp, 'Users'), ctx), /user profile/);
    assert.match(validateExtraRoot(projects, ctx), /contains the repository/);
    assert.match(validateExtraRoot(repo, ctx), /contains the repository/);
    assert.match(validateExtraRoot(path.join(tmp, 'hw'), ctx), /Hybrid home/);
    assert.match(validateExtraRoot(path.join(tmp, 'missing'), ctx), /not an existing directory/);
    assert.match(validateExtraRoot('relative\\dir', ctx), /absolute/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('controllerAttached needs a running record with a fresh heartbeat', () => {
  const now = Date.parse('2026-10-08T10:00:00.000Z');
  const rec = (fields) => ({ status: 'running', keepalive_ms: 30_000, heartbeat_at: '2026-10-08T09:59:59.000Z', ...fields });
  assert.equal(controllerAttached(null, now), false);
  assert.equal(controllerAttached(rec(), now), true);
  assert.equal(controllerAttached(rec({ status: 'exited' }), now), false);
  assert.equal(controllerAttached(rec({ status: 'starting' }), now), true);
  assert.equal(controllerAttached(rec({ heartbeat_at: new Date(now - 30_000 * CONTROLLER_STALE_FACTOR).toISOString() }), now), false);
  // Short keepalives still get the minimum grace period.
  assert.equal(controllerAttached(rec({ keepalive_ms: 300, heartbeat_at: new Date(now - 5000).toISOString() }), now), true);
  assert.equal(controllerAttached(rec({ keepalive_ms: 300, heartbeat_at: new Date(now - CONTROLLER_STALE_MIN_MS).toISOString() }), now), false);
  assert.equal(controllerAttached(rec({ heartbeat_at: 'garbage' }), now), false);
  assert.equal(controllerAttached(rec({ keepalive_ms: undefined, heartbeat_at: new Date(now - CONTROLLER_KEEPALIVE_MS).toISOString() }), now), true);
});

test('controller prompt points at the shared contract and the run on disk', () => {
  const p = controllerPrompt({
    runId: 'r1', home: 'C:\\h', sessionId: 'sol-controller-1', startEpoch: 4, runDir: 'C:\\h\\runs\\r1',
    planFile: 'C:\\h\\runs\\r1\\plan.md', cliEntry: 'C:\\hw\\bin\\hybrid.mjs', orchestrationDoc: 'C:\\hw\\docs\\ORCHESTRATION.md',
    writableRoots: ['C:\\h\\runs\\r1', 'C:\\src\\.git'],
  });
  for (const s of ['C:\\hw\\docs\\ORCHESTRATION.md', 'Controller handoff', 'C:\\h\\runs\\r1\\plan.md', 'hybrid takeover --json',
    'takes no --epoch', 'exits 3', 'C:\\h\\runs\\r1; C:\\src\\.git', 'node "C:\\hw\\bin\\hybrid.mjs"', 'epoch when you were launched: 4']) {
    assert.ok(p.includes(s), s);
  }
});
