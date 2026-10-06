import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDuration, resolveSession, anonSession, nextJobId, truncate, fmtDuration, safeFileName, parseSeq,
  outcomeResult,
} from '../../src/cli/util.mjs';
import { HybridError } from '../../src/store.mjs';

describe('parseDuration', () => {
  test('accepts units and bare seconds', () => {
    assert.equal(parseDuration('90s'), 90_000);
    assert.equal(parseDuration('50m'), 3_000_000);
    assert.equal(parseDuration('2h'), 7_200_000);
    assert.equal(parseDuration('200ms'), 200);
    assert.equal(parseDuration('45'), 45_000);
    assert.equal(parseDuration('1.5m'), 90_000);
  });

  test('rejects garbage with a usage error', () => {
    for (const bad of ['', 'abc', '-5s', '5x', '1d']) {
      assert.throws(() => parseDuration(bad), (e) => e instanceof HybridError && e.exitCode === 2);
    }
  });
});

describe('resolveSession', () => {
  test('flag beats HYBRID_SESSION_ID beats CLAUDE_CODE_SESSION_ID', () => {
    const env = { HYBRID_SESSION_ID: 'h', CLAUDE_CODE_SESSION_ID: 'c' };
    assert.equal(resolveSession({ session: 'f' }, env), 'f');
    assert.equal(resolveSession({}, env), 'h');
    assert.equal(resolveSession({}, { CLAUDE_CODE_SESSION_ID: 'c' }), 'c');
    assert.equal(resolveSession({}, {}), null);
  });

  test('anonymous ids look like anon-<8 hex>', () => {
    assert.match(anonSession(), /^anon-[0-9a-f]{8}$/);
  });
});

describe('nextJobId', () => {
  test('starts at j001 and follows the max numeric id', () => {
    assert.equal(nextJobId([]), 'j001');
    assert.equal(nextJobId(['j001', 'j002']), 'j003');
    assert.equal(nextJobId(['j009', 'auth-refactor', 'j002']), 'j010');
    assert.equal(nextJobId(['j999']), 'j1000');
  });

  test('skip offsets past a collision', () => {
    assert.equal(nextJobId(['j001'], 2), 'j004');
  });
});

describe('formatting helpers', () => {
  test('truncate', () => {
    assert.equal(truncate('abcdef', 10), 'abcdef');
    assert.equal(truncate('abcdefghij', 8), 'abcde...');
    assert.equal(truncate(undefined, 5), '');
  });

  test('fmtDuration', () => {
    assert.equal(fmtDuration(45_000), '45s');
    assert.equal(fmtDuration(12 * 60_000), '12m');
    assert.equal(fmtDuration((3 * 60 + 5) * 60_000), '3h05m');
    assert.equal(fmtDuration(null), '-');
  });

  test('safeFileName strips path characters', () => {
    assert.equal(safeFileName('a/b\\c:d'), 'a_b_c_d');
    assert.equal(safeFileName('sess-1.x'), 'sess-1.x');
  });

  test('parseSeq', () => {
    assert.equal(parseSeq('12', '--since'), 12);
    assert.throws(() => parseSeq('-1', '--since'), (e) => e.exitCode === 2);
    assert.throws(() => parseSeq('x', '--since'), (e) => e.exitCode === 2);
  });
});

describe('outcomeResult', () => {
  const req = { id: 'r1', type: 'cancel', job_id: 'j001' };
  test('accepted is exit 0', () => {
    const r = outcomeResult('cancel j001', req, { outcome: 'accepted', reason: null });
    assert.equal(r.exitCode, 0);
    assert.equal(r.text, 'cancel j001: accepted');
  });

  test('stale_epoch rejection is fenced (3), other rejections are errors (1)', () => {
    assert.equal(outcomeResult('x', req, { outcome: 'rejected', reason: 'stale_epoch' }).exitCode, 3);
    const other = outcomeResult('x', req, { outcome: 'rejected', reason: 'not_active' });
    assert.equal(other.exitCode, 1);
    assert.match(other.text, /rejected \(not_active\)/);
  });

  test('no outcome yet is pending, exit 0', () => {
    const r = outcomeResult('x', req, null);
    assert.equal(r.exitCode, 0);
    assert.equal(r.data.outcome, 'pending');
  });
});
