import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compareObserved, defaultCodexHome, findRolloutFile, readObservedConfig, readObservedIsolation } from '../../src/rollout.mjs';

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

test('readObservedConfig takes session_meta and the last turn_context', () => {
  const home = tmp();
  try {
    const file = writeRollout(home, new Date(), [
      { type: 'session_meta', payload: { id: THREAD, cli_version: '0.99.0', cwd: 'C:\\wt', instructions: 'SECRET TEXT' } },
      { type: 'response_item', payload: { text: 'hello' } },
      'garbage line',
      { type: 'turn_context', payload: { ...ctx, model: 'earlier' } },
      { type: 'turn_context', timestamp: '2026-10-07T00:00:00.000Z', payload: ctx },
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
      turn_context_at: '2026-10-07T00:00:00.000Z',
      turn_contexts_in_window: 2,
      source: 'rollout',
    });
    assert.ok(!JSON.stringify(obs).includes('SECRET'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// `codex exec resume` appends the new attempt's turn_context to the original rollout. Attempt 1
// here ran correctly; attempt 2 (resumed) ran without the pinned sandbox/approval. The resumed
// attempt must be judged by its own record, so the mismatch is reported.
test('a resumed attempt is described by its own turn_context, not the first one', () => {
  const home = tmp();
  try {
    const good = { ...ctx, sandbox_policy: { type: 'workspace-write' } };
    const bad = { ...ctx, sandbox_policy: { type: 'danger-full-access' }, approval_policy: 'on-request' };
    const file = writeRollout(home, new Date(), [
      { timestamp: '2026-10-06T22:28:41.973Z', type: 'session_meta', payload: { id: THREAD } },
      { timestamp: '2026-10-06T22:28:43.764Z', type: 'turn_context', payload: good },
      { timestamp: '2026-10-06T22:35:45.153Z', type: 'turn_context', payload: bad },
    ]);
    const requested = { model: 'gpt-6.1-sol', effort: 'high', sandbox: 'workspace-write', approval_policy: 'never' };

    const attempt1 = readObservedConfig(file, { since: '2026-10-06T22:28:40.000Z' });
    const attempt2 = readObservedConfig(file, { since: '2026-10-06T22:35:43.000Z' });
    assert.equal(attempt2.sandbox_policy, 'danger-full-access');
    assert.equal(attempt2.turn_contexts_in_window, 1);
    assert.deepEqual(compareObserved(requested, attempt2).mismatches.map((m) => m.field), ['sandbox', 'approval_policy']);
    assert.equal(attempt1.sandbox_policy, 'danger-full-access', 'last record wins without a tighter window');

    const none = readObservedConfig(file, { since: '2026-10-06T23:00:00.000Z' });
    assert.equal(none.sandbox_policy, null, 'no turn_context after the launch: unverifiable, reported as a mismatch');
    assert.equal(none.turn_contexts_in_window, 0);
    assert.equal(compareObserved(requested, none).matches, false);

    assert.equal(readObservedConfig(file, { since: 'not a date' }).sandbox_policy, 'danger-full-access', 'invalid since = no window');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('records beyond the first 4 MB of a rollout are read (long or resumed sessions)', () => {
  const home = tmp();
  try {
    const padding = { type: 'response_item', payload: { text: 'x'.repeat(5 * 1024 * 1024) } };
    const file = writeRollout(home, new Date(), [
      { timestamp: '2026-10-06T22:00:00.000Z', type: 'session_meta', payload: { id: THREAD } },
      { timestamp: '2026-10-06T22:00:01.000Z', type: 'turn_context', payload: ctx },
      padding,
      { timestamp: '2026-10-06T22:30:00.000Z', type: 'turn_context', payload: { ...ctx, model: 'resumed' } },
      { timestamp: '2026-10-06T22:30:00.100Z', type: 'response_item', payload: { text: '<skills_instructions>late</skills_instructions>' } },
    ]);
    assert.equal(readObservedConfig(file, { since: '2026-10-06T22:29:00.000Z' }).model, 'resumed');
    assert.equal(readObservedIsolation(file).skills_catalog_present, true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('readObservedIsolation reports codex_apps tools or calls, not base-instruction prose', () => {
  const home = tmp();
  try {
    const prose = { type: 'session_meta', payload: { id: THREAD, base_instructions: { text: 'An app is a set of MCP tools within the `codex_apps` MCP.' } } };
    const declared = writeRollout(home, new Date(), [
      prose,
      { type: 'turn_context', payload: ctx },
      { type: 'response_item', payload: { type: 'custom_tool_call_output', output: '{"name":"mcp__codex_apps__codexless_codex_command_exec"}' } },
    ]);
    assert.equal(readObservedIsolation(declared).apps_present, true);
    const called = writeRollout(home, new Date(), [
      prose,
      { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'McpToolCall', server: 'codex_apps', tool: 'x' } } },
    ], 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee');
    assert.equal(readObservedIsolation(called).apps_present, true);
    const proseOnly = writeRollout(home, new Date(), [prose, { type: 'turn_context', payload: ctx }], 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    assert.equal(readObservedIsolation(proseOnly).apps_present, false, 'base-instruction prose is not exposure');
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
