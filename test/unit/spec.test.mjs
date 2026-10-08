import test from 'node:test';
import assert from 'node:assert/strict';
import { SCHEMAS } from '../../src/constants.mjs';
import {
  BUILTIN_PRESETS, composePrompt, composeResumePrompt, resolvePresets, validateSpec,
} from '../../src/spec.mjs';

const presets = resolvePresets();
const opts = (extra = {}) => ({ presets, capsuleText: 'Do the thing.', ...extra });
const impl = (extra = {}) => ({ preset: 'sol-high-impl', capsule: 'x', write_scope: ['src/'], ...extra });

test('builtin presets are frozen and resolve unchanged', () => {
  assert.ok(Object.isFrozen(BUILTIN_PRESETS));
  assert.deepEqual(presets['luna-xhigh-review'], { model: 'gpt-6-luna', effort: 'xhigh', sandbox: 'read-only' });
  assert.deepEqual(presets['sol-xhigh-impl'], { model: 'gpt-6.1-sol', effort: 'xhigh', sandbox: 'workspace-write' });
  assert.equal(Object.keys(presets).length, 6);
});

test('resolvePresets lets machine presets add and override builtins', () => {
  const merged = resolvePresets({
    'my-preset': { model: 'gpt-x.1', effort: 'low', sandbox: 'read-only' },
    'sol-low-smoke': { model: 'gpt-6.1-sol', effort: 'minimal', sandbox: 'read-only' },
  });
  assert.equal(merged['my-preset'].model, 'gpt-x.1');
  assert.equal(merged['sol-low-smoke'].effort, 'minimal');
});

test('resolvePresets rejects invalid presets', () => {
  const ok = { model: 'm', effort: 'low', sandbox: 'read-only' };
  assert.throws(() => resolvePresets({ 'Bad Name': ok }), /name/);
  assert.throws(() => resolvePresets({ a: { ...ok, model: 'bad model!' } }), /model/);
  assert.throws(() => resolvePresets({ a: { ...ok, effort: 'ultra' } }), /effort/);
  assert.throws(() => resolvePresets({ a: { ...ok, sandbox: 'danger-full-access' } }), /sandbox/);
  assert.throws(() => resolvePresets({ a: { ...ok, extra: 1 } }), /unknown key/);
  assert.throws(() => resolvePresets({ a: 'nope' }), /object/);
});

test('validateSpec accepts a minimal workspace-write spec and applies defaults', () => {
  const r = validateSpec(impl(), opts());
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.deepEqual(r.spec, {
    schema: SCHEMAS.jobSpec,
    job_id: null,
    title: '',
    preset: 'sol-high-impl',
    preset_config: { model: 'gpt-6.1-sol', effort: 'high', sandbox: 'workspace-write' },
    write_scope: ['src'],
    allow_protected: [],
    allow_symlinks: false,
    timeout_minutes: 120,
    stall_minutes: 15,
    base_commit: null,
  });
});

test('validateSpec accepts a read-only spec and a full spec', () => {
  assert.equal(validateSpec({ preset: 'sol-high-review', capsule_file: 'c.md' }, opts()).ok, true);
  const full = validateSpec({
    schema: SCHEMAS.jobSpec, job_id: 'job-1', title: 'T', preset: 'sol-high-impl', capsule: 'x',
    write_scope: ['src\\a', './docs/'], allow_protected: ['AGENTS.md'], allow_symlinks: true,
    timeout_minutes: 30, stall_minutes: 5, base_commit: 'a'.repeat(40),
  }, opts());
  assert.equal(full.ok, true, full.errors.join('; '));
  assert.deepEqual(full.spec.write_scope, ['src/a', 'docs']);
  assert.equal(full.spec.stall_minutes, 5);
});

test('validateSpec rejects unknown keys and bad schema', () => {
  const r = validateSpec(impl({ model: 'gpt-9', schema: 'nope' }), opts());
  assert.equal(r.ok, false);
  assert.equal(r.spec, null);
  assert.ok(r.errors.some((e) => /unknown field "model"/.test(e)));
  assert.ok(r.errors.some((e) => /schema/.test(e)));
});

test('validateSpec preset and capsule rules', () => {
  assert.ok(validateSpec({ capsule: 'x' }, opts()).errors.some((e) => /preset is required/.test(e)));
  assert.ok(validateSpec({ preset: 'nope', capsule: 'x' }, opts()).errors.some((e) => /unknown preset/.test(e)));
  assert.ok(validateSpec(impl({ capsule_file: 'a' }), opts()).errors.some((e) => /exactly one/.test(e)));
  const none = impl();
  delete none.capsule;
  assert.ok(validateSpec(none, opts()).errors.some((e) => /exactly one/.test(e)));
  assert.ok(validateSpec(impl(), opts({ capsuleText: '  \n' })).errors.some((e) => /empty/.test(e)));
  assert.ok(validateSpec(impl(), opts({ capsuleText: 'x'.repeat(262145) })).errors.some((e) => /exceeds/.test(e)));
  assert.equal(validateSpec(impl(), opts({ capsuleText: 'x'.repeat(262144) })).ok, true);
  // Multi-byte text is measured in bytes, not characters.
  assert.equal(validateSpec(impl(), opts({ capsuleText: 'é'.repeat(131073) })).ok, false);
});

test('validateSpec scope rules depend on the preset sandbox', () => {
  const noScope = { preset: 'sol-high-impl', capsule: 'x' };
  assert.ok(validateSpec(noScope, opts()).errors.some((e) => /write_scope is required/.test(e)));
  assert.ok(validateSpec({ ...noScope, write_scope: [] }, opts()).errors.some((e) => /write_scope is required/.test(e)));
  const ro = validateSpec({ preset: 'sol-high-review', capsule: 'x', write_scope: ['src'] }, opts());
  assert.ok(ro.errors.some((e) => /read-only/.test(e)));
  assert.equal(validateSpec({ preset: 'sol-high-review', capsule: 'x', write_scope: [] }, opts()).ok, true);
  assert.equal(validateSpec(impl({ write_scope: ['**'] }), opts()).ok, true);
  assert.ok(validateSpec(impl({ write_scope: ['../x'] }), opts()).errors.some((e) => /write_scope/.test(e)));
  assert.ok(validateSpec(impl({ write_scope: 'src' }), opts()).errors.some((e) => /write_scope/.test(e)));
});

test('validateSpec allow_protected rules', () => {
  assert.equal(validateSpec(impl({ allow_protected: ['.github/workflows/ci.yml'] }), opts()).ok, true);
  for (const bad of ['.git/config', 'sub/.GIT/hooks', '.Git', '**']) {
    const r = validateSpec(impl({ allow_protected: [bad] }), opts());
    assert.equal(r.ok, false, bad);
  }
  assert.equal(validateSpec(impl({ allow_protected: ['.gitmodules'] }), opts()).ok, true);
});

test('validateSpec timeout and stall bounds', () => {
  const run = (extra) => validateSpec(impl(extra), opts({ maxTimeoutMinutes: 60 }));
  assert.equal(run({ timeout_minutes: 0 }).ok, false);
  assert.equal(run({ timeout_minutes: 61 }).ok, false);
  assert.equal(run({ timeout_minutes: 1.5 }).ok, false);
  assert.equal(run({ timeout_minutes: '10' }).ok, false);
  assert.equal(run({ timeout_minutes: 60 }).ok, true);
  assert.equal(run({ timeout_minutes: 10, stall_minutes: 11 }).ok, false);
  assert.equal(run({ stall_minutes: 0 }).ok, false);
  // Default stall is clamped to a short timeout.
  assert.equal(run({ timeout_minutes: 5 }).spec.stall_minutes, 5);
  assert.equal(validateSpec(impl(), opts({ defaultTimeoutMinutes: 30, defaultStallMinutes: 7 })).spec.timeout_minutes, 30);
});

test('validateSpec validates job_id, title, base_commit, allow_symlinks', () => {
  assert.equal(validateSpec(impl({ job_id: 'Bad_ID' }), opts()).ok, false);
  assert.equal(validateSpec(impl({ title: 'x'.repeat(201) }), opts()).ok, false);
  assert.equal(validateSpec(impl({ title: 5 }), opts()).ok, false);
  assert.equal(validateSpec(impl({ base_commit: 'ABC' }), opts()).ok, false);
  assert.equal(validateSpec(impl({ base_commit: 'A'.repeat(40) }), opts()).ok, false);
  assert.equal(validateSpec(impl({ allow_symlinks: 'yes' }), opts()).ok, false);
});

test('validateSpec collects all errors and rejects non-objects', () => {
  const r = validateSpec({
    preset: 'nope', job_id: 'BAD', bogus: 1, timeout_minutes: 0, allow_symlinks: 1, base_commit: 'x',
  }, opts({ capsuleText: '' }));
  assert.ok(r.errors.length >= 7, r.errors.join('; '));
  assert.equal(validateSpec(null, opts()).ok, false);
  assert.equal(validateSpec([], opts()).ok, false);
});

function sampleSpec(extra = {}) {
  const r = validateSpec(impl({ allow_protected: ['AGENTS.md'], write_scope: ['src/', 'docs/a.md'], ...extra }), opts());
  assert.equal(r.ok, true, r.errors.join('; '));
  return r.spec;
}

test('composePrompt is deterministic and includes header, scope, rules and capsule', () => {
  const args = {
    runId: 'r261006-120000-abcd', jobId: 'job-1', baseCommit: 'b'.repeat(40), spec: sampleSpec(), capsuleText: '## Goal\nDo it.\n',
  };
  const a = composePrompt(args);
  assert.equal(a, composePrompt(args));
  for (const needle of [
    'job_id: job-1', 'run_id: r261006-120000-abcd', 'b'.repeat(40), 'sol-high-impl',
    '  - src', '  - docs/a.md', '  - AGENTS.md', 'git commit', 'You have network access', 'Invoke-WebRequest', 'no global installs', 'codex, claude',
    'job_id set to exactly "job-1"', '## Task capsule',
  ]) {
    assert.ok(a.includes(needle), needle);
  }
  assert.ok(!a.includes('No network'), 'the stale no-network rule is gone');
  assert.ok(a.endsWith('## Goal\nDo it.\n\n'));
  assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(a));
});

test('composePrompt for read-only says modify nothing and shows no scope', () => {
  const spec = validateSpec({ preset: 'sol-high-review', capsule: 'x' }, opts()).spec;
  const p = composePrompt({ runId: 'r', jobId: 'j', baseCommit: 'c', spec, capsuleText: 'x' });
  assert.ok(p.includes('modify nothing'));
  assert.ok(!p.includes('write scope'));
  assert.ok(p.includes('(none)'));
  assert.ok(p.includes('Web search is available'), 'read-only jobs are told only about web search');
  assert.ok(!p.includes('You have network access') && !p.includes('Install packages'));
  assert.ok(p.includes('codex, claude'), 'the no-other-agents rule applies to every job');
});

test('composeResumePrompt repeats the rules and includes reason and note', () => {
  const spec = sampleSpec();
  const p = composeResumePrompt({ runId: 'r1', jobId: 'job-1', spec, reason: 'worker_lost', note: 'Prefer small diffs.' });
  assert.ok(p.includes('interrupted (reason: worker_lost)'));
  assert.ok(p.includes('git status'));
  assert.ok(p.includes('## Rules'));
  assert.ok(p.includes('  - src'));
  assert.ok(p.includes('You have network access') && !p.includes('No network'), 'resumed jobs get the same network rule');
  assert.ok(p.includes('job_id set to exactly "job-1"'));
  assert.ok(p.includes('## Owner note\n\nPrefer small diffs.'));
  assert.ok(!composeResumePrompt({ runId: 'r1', jobId: 'job-1', spec, reason: 'x' }).includes('Owner note'));
  assert.throws(() => composeResumePrompt({ runId: 'r', jobId: 'j', spec, reason: 'x', note: 'n'.repeat(4097) }), /note/);
  assert.doesNotThrow(() => composeResumePrompt({ runId: 'r', jobId: 'j', spec, reason: 'x', note: 'n'.repeat(4096) }));
});
