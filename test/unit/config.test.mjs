import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SCHEMAS } from '../../src/constants.mjs';
import {
  DEFAULTS, addRepoAlias, buildRunConfig, loadMachineConfig, saveMachineConfig,
} from '../../src/config.mjs';
import { readJson } from '../../src/fsutil.mjs';
import { homePaths } from '../../src/paths.mjs';

function withTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-config-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const writeConfig = (home, obj) => fs.writeFileSync(homePaths(home).config, JSON.stringify(obj));

test('DEFAULTS is frozen with the documented values', () => {
  assert.ok(Object.isFrozen(DEFAULTS));
  assert.equal(DEFAULTS.max_concurrency, 4);
  assert.equal(DEFAULTS.windows_sandbox, 'elevated');
  assert.equal(DEFAULTS.output_schema, true);
  assert.equal(DEFAULTS.project_docs, false);
});

test('loadMachineConfig returns defaults for a missing file, as a fresh copy', () => {
  withTmp((home) => {
    const a = loadMachineConfig(home);
    assert.deepEqual(a, DEFAULTS);
    a.extra_path.push('C:\\x');
    a.repos.foo = {};
    assert.deepEqual(loadMachineConfig(home).extra_path, []);
  });
});

test('loadMachineConfig merges over defaults', () => {
  withTmp((home) => {
    writeConfig(home, { schema: SCHEMAS.machineConfig, max_concurrency: 2, windows_sandbox: 'unelevated' });
    const c = loadMachineConfig(home);
    assert.equal(c.max_concurrency, 2);
    assert.equal(c.windows_sandbox, 'unelevated');
    assert.equal(c.poll_ms, 1500);
  });
});

test('loadMachineConfig is strict', () => {
  withTmp((home) => {
    const bad = (obj, re) => {
      writeConfig(home, obj);
      assert.throws(() => loadMachineConfig(home), re, JSON.stringify(obj));
    };
    bad({ max_concurency: 2 }, /unknown config key "max_concurency"/);
    bad({ schema: 'other/1' }, /schema/);
    bad({ windows_sandbox: 'none' }, /windows_sandbox/);
    bad({ poll_ms: 0 }, /poll_ms/);
    bad({ poll_ms: 1.5 }, /poll_ms/);
    bad({ heartbeat_ms: '10' }, /heartbeat_ms/);
    bad({ codex_exe: 'codex.exe' }, /codex_exe/);
    bad({ codex_prefix_args: [1] }, /codex_prefix_args/);
    bad({ worktree_root: 'rel' }, /worktree_root/);
    bad({ playwright_dir: 'rel' }, /playwright_dir/);
    bad({ npm_cache_dir: 'rel' }, /npm_cache_dir/);
    bad({ codex_home: 5 }, /codex_home/);
    bad({ project_docs: 'yes' }, /project_docs/);
    bad({ extra_path: ['rel'] }, /extra_path/);
    bad({ presets: { x: { model: 'm', effort: 'bad', sandbox: 'read-only' } } }, /effort/);
    bad({ repos: { 'Bad Alias': { path: 'C:\\r' } } }, /alias/);
    bad({ repos: { ok: { path: 'rel' } } }, /absolute/);
    bad({ repos: { ok: { path: 'C:\\r', prepare: { node_modules: 'copy' } } } }, /node_modules/);
    bad({ repos: { ok: { path: 'C:\\r', extra: 1 } } }, /unknown key/);
    bad([], /object/);
  });
});

test('saveMachineConfig writes only non-default keys plus schema, and round-trips', () => {
  withTmp((home) => {
    const home2 = path.join(home, 'nested');
    const c = loadMachineConfig(home2);
    c.max_concurrency = 3;
    c.presets = { 'my-one': { model: 'm1', effort: 'low', sandbox: 'read-only' } };
    saveMachineConfig(home2, c);
    const onDisk = readJson(homePaths(home2).config);
    assert.deepEqual(Object.keys(onDisk), ['schema', 'max_concurrency', 'presets']);
    assert.equal(onDisk.schema, SCHEMAS.machineConfig);
    assert.deepEqual(loadMachineConfig(home2), c);

    saveMachineConfig(home2, DEFAULTS);
    assert.deepEqual(readJson(homePaths(home2).config), { schema: SCHEMAS.machineConfig });
  });
});

test('saveMachineConfig refuses an invalid config', () => {
  withTmp((home) => {
    assert.throws(() => saveMachineConfig(home, { ...DEFAULTS, bogus: 1 }), /unknown config key/);
    assert.equal(fs.existsSync(homePaths(home).config), false);
  });
});

test('addRepoAlias registers, updates and validates', () => {
  withTmp((home) => {
    const repo = path.join(home, 'repo');
    fs.mkdirSync(repo);
    const c = addRepoAlias(home, 'my-app', repo);
    assert.deepEqual(c.repos['my-app'], { path: repo, prepare: { node_modules: 'none' } });
    const c2 = addRepoAlias(home, 'other', repo, { nodeModules: 'junction' });
    assert.equal(c2.repos.other.prepare.node_modules, 'junction');
    assert.deepEqual(Object.keys(loadMachineConfig(home).repos).sort(), ['my-app', 'other']);

    assert.throws(() => addRepoAlias(home, 'Bad Alias', repo), /alias/);
    assert.throws(() => addRepoAlias(home, 'x', path.join(home, 'missing')), /existing directory/);
    const file = path.join(home, 'file.txt');
    fs.writeFileSync(file, '');
    assert.throws(() => addRepoAlias(home, 'x', file), /existing directory/);
    assert.throws(() => addRepoAlias(home, 'x', repo, { nodeModules: 'copy' }), /node_modules/);
  });
});

const fakeResolvers = {
  resolveCodexExe: (configured) => configured ?? 'C:\\fake\\codex.exe',
  defaultWorktreeRoot: () => 'C:\\hw\\wt',
  defaultPlaywrightDir: () => 'C:\\hw\\ms-playwright',
  defaultNpmCacheDir: () => 'C:\\hw\\npm-cache',
};

test('buildRunConfig pins settings and clamps concurrency to the v1 maximum', () => {
  const machine = { ...loadMachineConfigDefaults(), max_concurrency: 12, extra_path: ['C:\\tools'] };
  const rc = buildRunConfig(machine, {}, fakeResolvers);
  assert.equal(rc.max_concurrency, 8);
  assert.equal(rc.codex_exe, 'C:\\fake\\codex.exe');
  assert.equal(rc.worktree_root, path.resolve('C:\\hw\\wt'));
  assert.equal(rc.playwright_dir, path.resolve('C:\\hw\\ms-playwright'));
  assert.equal(rc.npm_cache_dir, path.resolve('C:\\hw\\npm-cache'));
  assert.equal(rc.codex_home, null);
  assert.deepEqual(rc.extra_path, ['C:\\tools']);
  assert.equal(Object.keys(rc.presets).length, 6);
  assert.equal(rc.windows_sandbox, 'elevated');
  assert.equal('repos' in rc, false);
  assert.notEqual(rc.extra_path, machine.extra_path);

  assert.equal(buildRunConfig(machine, { concurrency: 2 }, fakeResolvers).max_concurrency, 2);
  assert.equal(buildRunConfig(machine, { concurrency: 8 }, fakeResolvers).max_concurrency, 8);
  assert.equal(buildRunConfig(machine, { concurrency: 9 }, fakeResolvers).max_concurrency, 8);
  // The machine default stays 4; 8 is a per-run choice (run start --concurrency 8).
  assert.equal(buildRunConfig(loadMachineConfigDefaults(), {}, fakeResolvers).max_concurrency, 4);
  assert.equal(buildRunConfig(machine, { concurrency: 0 }, fakeResolvers).max_concurrency, 1);
  assert.throws(() => buildRunConfig(machine, { concurrency: 1.5 }, fakeResolvers), /integer/);
});

test('buildRunConfig uses configured paths and machine presets', () => {
  const machine = {
    ...loadMachineConfigDefaults(),
    codex_exe: 'C:\\custom\\codex.exe',
    codex_home: 'C:\\ch',
    worktree_root: 'D:\\wt',
    playwright_dir: 'D:\\pw',
    presets: { mine: { model: 'm', effort: 'low', sandbox: 'read-only' } },
  };
  const rc = buildRunConfig(machine, {}, fakeResolvers);
  assert.equal(rc.codex_exe, 'C:\\custom\\codex.exe');
  assert.equal(rc.codex_home, path.resolve('C:\\ch'));
  assert.equal(rc.worktree_root, path.resolve('D:\\wt'));
  assert.equal(rc.playwright_dir, path.resolve('D:\\pw'));
  assert.equal(rc.presets.mine.model, 'm');
  assert.ok(rc.presets['sol-high-impl']);
});

function loadMachineConfigDefaults() {
  return JSON.parse(JSON.stringify(DEFAULTS));
}
