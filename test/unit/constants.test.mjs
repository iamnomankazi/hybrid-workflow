import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  HYBRID_VERSION, SCHEMAS, STATES, ACTIVE_STATES, TERMINAL_STATES, RESUMABLE_STATES, WAKE_STATES,
  TRANSITIONS, canTransition, assertTransition, DECISIONS, REQUEST_TYPES, EXIT,
  RUN_ID_RE, JOB_ID_RE, SHA1_RE, V1_MAX_CONCURRENCY,
} from '../../src/constants.mjs';
import { generateRunId } from '../../src/store.mjs';

const ALL_STATES = Object.values(STATES);

describe('constants: states and transitions', () => {
  test('STATES keys equal values and are frozen', () => {
    for (const [k, v] of Object.entries(STATES)) assert.equal(k, v);
    assert.ok(Object.isFrozen(STATES));
    assert.ok(Object.isFrozen(TRANSITIONS));
    assert.ok(Object.isFrozen(EXIT));
    assert.ok(Object.isFrozen(SCHEMAS));
  });

  test('every TRANSITIONS target is a known state', () => {
    for (const [from, targets] of Object.entries(TRANSITIONS)) {
      assert.ok(Array.isArray(targets), from);
      for (const t of targets) assert.ok(ALL_STATES.includes(t), `${from} -> ${t}`);
      assert.equal(new Set(targets).size, targets.length, `${from} has duplicate targets`);
    }
  });

  test('every TRANSITIONS source is a known state or the null pseudo-state, and every state has a row', () => {
    for (const from of Object.keys(TRANSITIONS)) {
      assert.ok(from === 'null' || ALL_STATES.includes(from), from);
    }
    for (const s of ALL_STATES) assert.ok(s in TRANSITIONS, `no TRANSITIONS row for ${s}`);
  });

  test('terminal states only transition to queued (resume); completed and rejected have none', () => {
    for (const s of TERMINAL_STATES) {
      const targets = TRANSITIONS[s];
      assert.ok(targets.every((t) => t === 'queued'), `${s}: ${targets}`);
    }
    assert.deepEqual(TRANSITIONS.completed, []);
    assert.deepEqual(TRANSITIONS.rejected, []);
    for (const s of ['failed', 'interrupted', 'cancelled', 'paused_quota', 'paused_auth']) {
      assert.deepEqual(TRANSITIONS[s], ['queued'], s);
    }
  });

  test('RESUMABLE_STATES are exactly the terminal states that can go to queued', () => {
    const expected = [...TERMINAL_STATES].filter((s) => TRANSITIONS[s].includes('queued'));
    assert.deepEqual([...RESUMABLE_STATES].sort(), expected.sort());
    for (const s of RESUMABLE_STATES) assert.ok(TERMINAL_STATES.has(s));
  });

  test('only queued and (null) lead into queued/rejected from non-terminal origins as documented', () => {
    assert.deepEqual(TRANSITIONS.null, ['queued', 'rejected']);
    assert.deepEqual(TRANSITIONS.queued, ['launching', 'cancelled']);
    // nothing but resume (terminal -> queued) and null may reach queued
    for (const [from, targets] of Object.entries(TRANSITIONS)) {
      if (targets.includes('queued')) {
        assert.ok(from === 'null' || TERMINAL_STATES.has(from), `${from} -> queued`);
      }
    }
  });

  test('canTransition(null, queued) is true; undefined behaves like null', () => {
    assert.equal(canTransition(null, 'queued'), true);
    assert.equal(canTransition(undefined, 'queued'), true);
    assert.equal(canTransition(null, 'rejected'), true);
    assert.equal(canTransition(null, 'running'), false);
    assert.equal(canTransition(null, 'completed'), false);
  });

  test('canTransition happy paths', () => {
    assert.equal(canTransition('queued', 'launching'), true);
    assert.equal(canTransition('launching', 'running'), true);
    assert.equal(canTransition('running', 'stalled'), true);
    assert.equal(canTransition('stalled', 'running'), true);
    assert.equal(canTransition('running', 'completed'), true);
    assert.equal(canTransition('failed', 'queued'), true);
    assert.equal(canTransition('paused_quota', 'queued'), true);
  });

  test('canTransition rejects illegal moves and garbage', () => {
    assert.equal(canTransition('running', 'queued'), false);
    assert.equal(canTransition('queued', 'running'), false);
    assert.equal(canTransition('completed', 'queued'), false);
    assert.equal(canTransition('rejected', 'queued'), false);
    assert.equal(canTransition('completed', 'completed'), false);
    assert.equal(canTransition('running', 'running'), false);
    assert.equal(canTransition('running', 'nope'), false);
    assert.equal(canTransition('nope', 'queued'), false);
    assert.equal(canTransition('queued', undefined), false);
  });

  test('canTransition is not fooled by Object.prototype keys', () => {
    for (const bad of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      assert.equal(canTransition(bad, 'queued'), false, bad);
      assert.equal(canTransition(bad, bad), false, bad);
    }
  });

  test('launching cannot reach stalled or completed directly', () => {
    assert.equal(canTransition('launching', 'stalled'), false);
    assert.equal(canTransition('launching', 'completed'), false);
    assert.equal(canTransition('launching', 'paused_quota'), false);
  });

  test('assertTransition throws on running->queued and passes on legal moves', () => {
    assert.throws(() => assertTransition('running', 'queued'), /Illegal job transition running -> queued/);
    assert.doesNotThrow(() => assertTransition('failed', 'queued'));
    assert.doesNotThrow(() => assertTransition(null, 'queued'));
  });

  test('assertTransition renders the null origin as (new)', () => {
    assert.throws(() => assertTransition(null, 'running'), /\(new\) -> running/);
  });

  test('canTransition treats the literal string "null" as the pseudo-state', () => {
    assert.equal(canTransition('null', 'queued'), false);
  });

  test('ACTIVE and TERMINAL are disjoint; together they cover all states except queued', () => {
    for (const s of ACTIVE_STATES) assert.ok(!TERMINAL_STATES.has(s), s);
    const union = new Set([...ACTIVE_STATES, ...TERMINAL_STATES]);
    assert.deepEqual([...union].sort(), ALL_STATES.filter((s) => s !== 'queued').sort());
    for (const s of [...ACTIVE_STATES, ...TERMINAL_STATES]) assert.ok(ALL_STATES.includes(s), s);
  });

  test('ACTIVE_STATES are launching, running, stalled', () => {
    assert.deepEqual([...ACTIVE_STATES].sort(), ['launching', 'running', 'stalled']);
  });

  test('WAKE_STATES = TERMINAL + stalled', () => {
    assert.deepEqual([...WAKE_STATES].sort(), [...TERMINAL_STATES, 'stalled'].sort());
    assert.ok(WAKE_STATES.has('stalled'));
    assert.ok(!WAKE_STATES.has('running'));
    assert.ok(!WAKE_STATES.has('queued'));
    assert.ok(!WAKE_STATES.has('launching'));
  });
});

describe('constants: misc contracts', () => {
  test('HYBRID_VERSION matches package.json', () => {
    const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    assert.equal(HYBRID_VERSION, pkg.version);
  });

  test('schema ids are unique hybrid.<name>/1 strings', () => {
    const vals = Object.values(SCHEMAS);
    assert.equal(new Set(vals).size, vals.length);
    for (const v of vals) assert.match(v, /^hybrid\.[a-z-]+\/1$/);
  });

  test('EXIT codes are the documented values and unique', () => {
    assert.deepEqual({ ...EXIT }, {
      ok: 0, error: 1, usage: 2, fenced: 3, notFound: 4, conflict: 5, waitTimeout: 10,
    });
    assert.equal(new Set(Object.values(EXIT)).size, Object.keys(EXIT).length);
  });

  test('REQUEST_TYPES and DECISIONS are frozen and as documented', () => {
    assert.deepEqual([...REQUEST_TYPES], ['submit', 'cancel', 'resume', 'unhold', 'shutdown']);
    assert.deepEqual([...DECISIONS], ['integrated', 'rejected', 'superseded', 'deferred']);
    assert.ok(Object.isFrozen(REQUEST_TYPES));
    assert.ok(Object.isFrozen(DECISIONS));
  });

  test('V1_MAX_CONCURRENCY is 8', () => {
    assert.equal(V1_MAX_CONCURRENCY, 8);
  });
});

describe('constants: identifier grammars', () => {
  test('RUN_ID_RE matches generateRunId() output', () => {
    for (let i = 0; i < 200; i++) {
      const id = generateRunId();
      assert.match(id, RUN_ID_RE);
    }
    assert.match(generateRunId(new Date(2026, 0, 2, 3, 4, 5)), RUN_ID_RE);
    assert.match(generateRunId(new Date(2099, 11, 31, 23, 59, 59)), RUN_ID_RE);
  });

  test('RUN_ID_RE rejects malformed ids', () => {
    for (const bad of [
      '', 'r261006-123456', 'r261006-123456-abcg', 'r261006-123456-ABCD', 'R261006-123456-abcd',
      'r2610060-123456-abcd', 'r261006-12345-abcd', 'r261006-123456-abc', 'r261006-123456-abcde',
      'r261006-123456-abcd\n', ' r261006-123456-abcd', '../r261006-123456-abcd', 'r261006-123456-abcd/x',
    ]) {
      assert.doesNotMatch(bad, RUN_ID_RE, JSON.stringify(bad));
    }
    assert.match('r261006-123456-abcd', RUN_ID_RE);
  });

  test('JOB_ID_RE accepts valid ids up to 24 chars', () => {
    for (const ok of ['a', '0', 'job1', 'a-b', 'fix-parser-2', 'a'.repeat(24), '9' + 'z'.repeat(23)]) {
      assert.match(ok, JOB_ID_RE, ok);
    }
  });

  test('JOB_ID_RE rejects uppercase, leading dash, 25+ chars and path-ish input', () => {
    for (const bad of [
      '', 'A', 'Job', 'jobA', '-a', '-', 'a'.repeat(25), 'a'.repeat(100), 'a_b', 'a.b', 'a b', 'a/b', 'a\\b',
      '..', '.', 'a\n', '\na', 'jöb', 'a:b', 'con\u0000',
    ]) {
      assert.doesNotMatch(bad, JOB_ID_RE, JSON.stringify(bad));
    }
  });

  test('JOB_ID_RE allows a trailing dash and Windows reserved names (documented as questionable)', () => {
    // Not asserting these are desirable; pin current behaviour so a change is deliberate.
    assert.match('a-', JOB_ID_RE);
    assert.match('con', JOB_ID_RE);
    assert.match('nul', JOB_ID_RE);
  });

  test('SHA1_RE accepts 40 lowercase hex only', () => {
    assert.match('a'.repeat(40), SHA1_RE);
    assert.match('0123456789abcdef0123456789abcdef01234567', SHA1_RE);
    assert.doesNotMatch('A'.repeat(40), SHA1_RE);
    assert.doesNotMatch('a'.repeat(39), SHA1_RE);
    assert.doesNotMatch('a'.repeat(41), SHA1_RE);
    assert.doesNotMatch('a'.repeat(40) + '\n', SHA1_RE);
    assert.doesNotMatch('g'.repeat(40), SHA1_RE);
  });
});
