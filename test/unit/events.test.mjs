import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyFailure, summarizeEvents, summarizeEventsFile } from '../../src/events.mjs';

const THREAD = '01a10f19-685d-7993-aaf0-7b528e9b4469';
const happy = [
  { type: 'thread.started', thread_id: THREAD },
  { type: 'turn.started' },
  { type: 'error', message: 'Reconnecting... 2/5 (stream disconnected)' },
  { type: 'item.started', item: { id: 'item_0', type: 'command_execution' } },
  { type: 'item.completed', item: { id: 'item_0', type: 'command_execution' } },
  { type: 'item.completed', item: { id: 'item_1', type: 'mcp_tool_call' } },
  { type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'OK' } },
  { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 2 } },
];

test('summarizeEvents on a successful turn', () => {
  const s = summarizeEvents(happy);
  assert.equal(s.count, 8);
  assert.equal(s.thread_id, THREAD);
  assert.equal(s.turn_started, true);
  assert.equal(s.turn_completed, true);
  assert.equal(s.turn_failed, false);
  assert.deepEqual(s.usage, { input_tokens: 1, output_tokens: 2 });
  assert.deepEqual(s.item_types, { command_execution: 1, mcp_tool_call: 1, agent_message: 1 });
  assert.equal(s.mcp_tool_calls, 1);
  assert.equal(s.last_agent_message, 'OK');
  assert.equal(s.classification, null);
  assert.deepEqual(s.errors, [{ message: 'Reconnecting... 2/5 (stream disconnected)', transient: true }]);
});

test('summarizeEvents classifies quota and auth failures', () => {
  const quota = summarizeEvents([
    { type: 'thread.started', thread_id: THREAD },
    { type: 'turn.started' },
    { type: 'turn.failed', error: { message: 'You hit your usage limit. Try again later.' } },
  ]);
  assert.equal(quota.turn_failed, true);
  assert.equal(quota.failure_message, 'You hit your usage limit. Try again later.');
  assert.equal(quota.classification, 'quota');

  const auth = summarizeEvents([
    { type: 'error', message: '401 Unauthorized: token expired' },
    { type: 'turn.failed', error: { message: 'x' } },
  ]);
  assert.equal(auth.classification, 'auth');

  const viaItem = summarizeEvents([{ type: 'item.completed', item: { id: 'i', type: 'error', message: 'rate limit exceeded' } }]);
  assert.equal(viaItem.classification, 'quota');
  assert.equal(viaItem.errors.length, 1);
});

test('classification ignores transient messages and a completed turn', () => {
  assert.equal(summarizeEvents([{ type: 'error', message: 'Reconnecting... 429 too many requests' }]).classification, null);
  assert.equal(summarizeEvents([
    { type: 'error', message: 'Falling back from WebSockets to HTTPS (401)' },
  ]).classification, null);
  const done = summarizeEvents([{ type: 'error', message: 'quota exceeded' }, { type: 'turn.completed' }]);
  assert.equal(done.classification, null);
});

test('errors keep the last maxErrors, truncated to 500 chars', () => {
  const recs = Array.from({ length: 8 }, (_, i) => ({ type: 'error', message: `e${i}` + 'x'.repeat(600) }));
  const s = summarizeEvents(recs, { maxErrors: 3 });
  assert.equal(s.errors.length, 3);
  assert.ok(s.errors[0].message.startsWith('e5'));
  assert.ok(s.errors.every((e) => e.message.length === 500 && e.transient === false));
  assert.equal(summarizeEvents(recs).errors.length, 5);
});

test('last_agent_message is truncated and last one wins; item ids are counted once', () => {
  const s = summarizeEvents([
    { type: 'item.started', item: { id: 'a', type: 'agent_message', text: 'first' } },
    { type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'first' } },
    { type: 'item.completed', item: { id: 'b', type: 'agent_message', text: 'y'.repeat(3000) } },
  ]);
  assert.equal(s.last_agent_message.length, 2000);
  assert.equal(s.item_types.agent_message, 2);
});

test('summarizeEvents tolerates empty input and unknown events', () => {
  const s = summarizeEvents([{ type: 'something.new' }, null, {}]);
  assert.equal(s.count, 3);
  assert.equal(s.thread_id, null);
  assert.equal(summarizeEvents([]).count, 0);
});

test('classifyFailure precedence and patterns', () => {
  assert.equal(classifyFailure([]), null);
  assert.equal(classifyFailure(['network blip']), null);
  assert.equal(classifyFailure(['usage limit reached', 'please sign in again']), 'auth');
  for (const m of ['Not logged in', 'refresh token was revoked', 'authentication failed', 'Token expired']) {
    assert.equal(classifyFailure([m]), 'auth', m);
  }
  for (const m of ['insufficient_quota', 'HTTP 429', 'You have reached the limit. Purchase more credits', 'Rate-limit hit']) {
    assert.equal(classifyFailure([m]), 'quota', m);
  }
  assert.equal(classifyFailure(['Reconnecting... unauthorized']), null);
});

test('summarizeEventsFile reads a JSONL file, counts malformed lines and handles missing files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-events-'));
  try {
    const file = path.join(dir, 'events.jsonl');
    const body = happy.map((r) => JSON.stringify(r)).join('\n') + '\nnot json\n{"type":"turn.sta';
    fs.writeFileSync(file, body);
    const s = summarizeEventsFile(file);
    assert.equal(s.count, 8);
    assert.equal(s.malformed, 1);
    assert.equal(s.thread_id, THREAD);
    assert.equal(s.bytes, body.lastIndexOf('\n') + 1);

    const missing = summarizeEventsFile(path.join(dir, 'nope.jsonl'));
    assert.equal(missing.count, 0);
    assert.equal(missing.bytes, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
