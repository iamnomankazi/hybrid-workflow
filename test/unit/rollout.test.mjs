import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compareObserved, defaultCodexHome, findRolloutFile, readObservedConfig } from '../../src/rollout.mjs';

const THREAD = '01a10f19-685d-7993-aaf0-7b528e9b4469';
const ctx = { model: 'gpt-6.1-sol', effort: 'high', approval_policy: 'never', sandbox_policy: { type: 'read-only' }, cwd: 'C:\\x' };

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hw-rollout-'));

function writeRollout(home, day, lines, threadId = THREAD) {
  const y = String(day.getUTCFullYear());
  const m = String(day.getUTCMonth() + 1).padStart(2, '0');
  const d = String(day.getUTCDate()).padStart(2, '0');
  const dir = path.join(home, 'sessions', y, m, d);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-${y}-${m}-${d}T10-00-00-${threadId}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return file;
}

test('defaultCodexHome uses USERPROFILE', () => {
  assert.equal(defaultCodexHome({ USERPROFILE: 'C:\\Users\\x' }), path.join('C:\\Users\\x', '.codex'));
  assert.ok(defaultCodexHome({}).endsWith('.codex'));
});

test('findRolloutFile finds a rollout in an adjacent date directory', () => {
  const home = tmp();
  try {
    const now = new Date('2026-10-06T12:00:00Z');
    const file = writeRollout(home, new Date('2026-10-05T12:00:00Z'), [{ type: 'session_meta', payload: {} }]);
    assert.equal(findRolloutFile(home, THREAD, { around: now }), file);
    assert.equal(findRolloutFile(home, THREAD.toUpperCase(), { around: now }), file);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('findRolloutFile falls back to a bounded walk and rejects bad ids', () => {
  const home = tmp();
  try {
    const file = writeRollout(home, new Date('2020-01-02T00:00:00Z'), [{ type: 'session_meta', payload: {} }]);
    assert.equal(findRolloutFile(home, THREAD, { around: new Date('2026-10-06T12:00:00Z') }), file);
    assert.equal(findRolloutFile(home, '11111111-2222-3333-4444-555555555555'), null);
    assert.equal(findRolloutFile(home, '../../etc'), null);
    assert.equal(findRolloutFile(home, 'x'.repeat(36)), null);
    assert.equal(findRolloutFile(path.join(home, 'missing'), THREAD), null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('readObservedConfig takes session_meta and the first turn_context', () => {
  const home = tmp();
  try {
    const file = writeRollout(home, new Date(), [
      { type: 'session_meta', payload: { id: THREAD, cli_version: '0.99.0', cwd: 'C:\\wt', instructions: 'SECRET TEXT' } },
      { type: 'response_item', payload: { text: 'hello' } },
      'garbage line',
      { type: 'turn_context', payload: ctx },
      { type: 'turn_context', payload: { ...ctx, model: 'later' } },
    ]);
    const obs = readObservedConfig(file);
    assert.deepEqual(obs, {
      session_id: THREAD,
      cli_version: '0.99.0',
      cwd: 'C:\\wt',
      model: 'gpt-6.1-sol',
      effort: 'high',
      approval_policy: 'never',
      sandbox_policy: 'read-only',
      source: 'rollout',
    });
    assert.ok(!JSON.stringify(obs).includes('SECRET'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('readObservedConfig handles missing turn_context, no meta, and missing file', () => {
  const home = tmp();
  try {
    const onlyMeta = writeRollout(home, new Date(), [{ type: 'session_meta', payload: { session_id: THREAD } }]);
    const obs = readObservedConfig(onlyMeta);
    assert.equal(obs.session_id, THREAD);
    assert.equal(obs.model, null);
    assert.equal(obs.sandbox_policy, null);

    const nothing = writeRollout(home, new Date(), [{ type: 'turn_context', payload: ctx }], 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    assert.equal(readObservedConfig(nothing), null);
    assert.equal(readObservedConfig(path.join(home, 'nope.jsonl')), null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('compareObserved', () => {
  const req = { model: 'gpt-6.1-sol', effort: 'high', sandbox: 'read-only', approval_policy: 'never' };
  const obs = { model: 'gpt-6.1-sol', effort: 'high', sandbox_policy: 'read-only', approval_policy: 'never' };
  assert.deepEqual(compareObserved(req, obs), { matches: true, mismatches: [] });
  assert.deepEqual(compareObserved(req, null), { matches: null, mismatches: [] });
  const bad = compareObserved(req, { ...obs, model: 'other', sandbox_policy: 'workspace-write' });
  assert.equal(bad.matches, false);
  assert.deepEqual(bad.mismatches, [
    { field: 'model', requested: 'gpt-6.1-sol', observed: 'other' },
    { field: 'sandbox', requested: 'read-only', observed: 'workspace-write' },
  ]);
});
