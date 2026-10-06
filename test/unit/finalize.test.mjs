import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { summarizeEvents } from '../../src/events.mjs';
import * as git from '../../src/git.mjs';
import { attemptPaths } from '../../src/paths.mjs';
import {
  MAX_REPORT_BYTES, MAX_RESULT_FILES, buildResult, capturePatchBlock, decideOutcome, mergeValidation, observedBlock,
  parseWorkerReport, resolveClassification,
} from '../../src/runner/finalize.mjs';

const ev = (overrides = {}) => ({ ...summarizeEvents([]), ...overrides });
const done = ev({ turn_completed: true });
const exit0 = { code: 0, signal: null };

const decide = (input) => decideOutcome({ events: done, finalMessage: true, exit: exit0, ...input });
const verdict = (input) => {
  const { state, reason } = decide(input);
  return `${state}${reason ? `/${reason}` : ''}`;
};

test('rule 1: cancel requested wins over everything', () => {
  assert.equal(verdict({ cancelRequested: true }), 'cancelled/cancel_requested');
  assert.equal(verdict({ cancelRequested: true, timedOut: true, exit: { spawn_error: 'x' } }), 'cancelled/cancel_requested');
  assert.equal(verdict({ cancelRequested: true, exit: null }), 'cancelled/cancel_requested');
});

test('rule 2: hard timeout beats launch failure and success', () => {
  assert.equal(verdict({ timedOut: true }), 'failed/timeout');
  assert.equal(verdict({ timedOut: true, exit: { spawn_error: 'x' } }), 'failed/timeout');
  assert.equal(verdict({ timedOut: true, exit: null }), 'failed/timeout');
});

test('rule 3: spawn_error in exit.json -> failed/launch_failed', () => {
  const out = decide({ exit: { spawn_error: 'spawn ENOENT' }, events: ev(), finalMessage: false });
  assert.equal(out.state, 'failed');
  assert.equal(out.reason, 'launch_failed');
  assert.equal(out.detail, 'spawn ENOENT');
  assert.equal(out.exit_source, 'host');
});

test('rule 4: no exit.json completes only with turn.completed AND a final message', () => {
  const ok = decide({ exit: null });
  assert.deepEqual([ok.state, ok.reason, ok.exit_source], ['completed', null, 'unknown']);
  assert.equal(verdict({ exit: null, finalMessage: false }), 'interrupted/worker_lost');
  assert.equal(verdict({ exit: null, events: ev() }), 'interrupted/worker_lost');
  assert.equal(decide({ exit: null, events: ev() }).exit_source, 'none');
  // a classified failure cannot pause a job that has no exit record: rule 4 comes first
  assert.equal(verdict({ exit: null, events: ev({ classification: 'quota' }), classification: 'quota' }), 'interrupted/worker_lost');
});

test('rule 5: an unfinished turn that classifies as quota/auth pauses the job', () => {
  const failed = ev({ turn_failed: true, failure_message: 'usage limit' });
  const q = decide({ exit: { code: 1 }, events: failed, finalMessage: false, classification: 'quota' });
  assert.deepEqual([q.state, q.reason, q.detail], ['paused_quota', null, 'usage limit']);
  assert.equal(verdict({ exit: { code: 1 }, events: failed, finalMessage: false, classification: 'auth' }), 'paused_auth');
  // rule 5 precedes rules 6 and 7, even for exit code 0
  assert.equal(verdict({ exit: exit0, events: ev(), finalMessage: false, classification: 'quota' }), 'paused_quota');
  // a completed turn is never paused
  assert.equal(verdict({ classification: 'quota' }), 'completed');
});

test('rule 6: exit 0 + turn.completed + final message -> completed', () => {
  const out = decide({});
  assert.deepEqual([out.state, out.reason, out.exit_source], ['completed', null, 'host']);
});

test('rule 7: everything else fails with a specific reason', () => {
  assert.equal(verdict({ exit: { code: 2 } }), 'failed/nonzero_exit');
  assert.equal(verdict({ exit: { code: null, signal: 'SIGKILL' } }), 'failed/nonzero_exit');
  assert.equal(verdict({ exit: { code: 1 }, events: ev(), finalMessage: false }), 'failed/nonzero_exit');
  assert.equal(verdict({ events: ev(), finalMessage: false }), 'failed/no_turn_completed');
  assert.equal(verdict({ events: ev(), finalMessage: true }), 'failed/no_turn_completed');
  assert.equal(verdict({ finalMessage: false }), 'failed/missing_final_output');
  assert.match(decide({ exit: { code: 3 }, events: ev({ failure_message: 'boom' }) }).detail, /code 3: boom/);
});

test('exit code alone never makes a job completed', () => {
  assert.notEqual(decide({ events: ev(), finalMessage: false }).state, 'completed');
  assert.notEqual(decide({ events: ev(), finalMessage: true }).state, 'completed');
  assert.notEqual(decide({ finalMessage: false }).state, 'completed');
});

test('rule 8: a would-be completed job with a failed patch capture becomes failed/patch_capture_failed', () => {
  assert.equal(verdict({ patchFailed: true }), 'failed/patch_capture_failed');
  const unknown = decide({ exit: null, patchFailed: true });
  assert.deepEqual([unknown.state, unknown.reason, unknown.exit_source], ['failed', 'patch_capture_failed', 'unknown']);
  // other outcomes are untouched
  assert.equal(verdict({ patchFailed: true, cancelRequested: true }), 'cancelled/cancel_requested');
  assert.equal(verdict({ patchFailed: true, exit: { code: 1 } }), 'failed/nonzero_exit');
  assert.equal(verdict({ patchFailed: true, exit: null, finalMessage: false }), 'interrupted/worker_lost');
});

test('resolveClassification: events first, stderr tail only for an unfinished non-zero exit', () => {
  const stderr = 'noise\n401 Unauthorized: token\n';
  assert.equal(resolveClassification({ events: ev({ classification: 'quota' }), exit: { code: 1 }, stderrTail: stderr }), 'quota');
  assert.equal(resolveClassification({ events: ev(), exit: { code: 1 }, stderrTail: stderr }), 'auth');
  assert.equal(resolveClassification({ events: ev(), exit: { code: 1 }, stderrTail: "You've hit your usage limit" }), 'quota');
  assert.equal(resolveClassification({ events: ev(), exit: { code: 1 }, stderrTail: 'Reconnecting... 401 Unauthorized' }), null);
  assert.equal(resolveClassification({ events: ev(), exit: exit0, stderrTail: stderr }), null);
  assert.equal(resolveClassification({ events: done, exit: { code: 1 }, stderrTail: stderr }), null);
  assert.equal(resolveClassification({ events: ev(), exit: null, stderrTail: stderr }), null);
  assert.equal(resolveClassification({ events: ev(), exit: { code: 1 } }), null);
});

test('parseWorkerReport', () => {
  const good = parseWorkerReport('{"job_id":"j1","status":"done"}', 'j1');
  assert.deepEqual([good.present, good.valid_json, good.job_id_matches, good.truncated], [true, true, true, false]);
  assert.equal(good.report.status, 'done');
  assert.equal(parseWorkerReport('{"job_id":"other"}', 'j1').job_id_matches, false);
  const prose = parseWorkerReport('all done, no JSON here', 'j1');
  assert.deepEqual([prose.present, prose.valid_json, prose.report, prose.raw], [true, false, null, 'all done, no JSON here']);
  assert.equal(parseWorkerReport('[1,2]', 'j1').valid_json, false);
  assert.equal(parseWorkerReport('null', 'j1').valid_json, false);
  for (const absent of [null, undefined, '', '  \n']) {
    const r = parseWorkerReport(absent, 'j1');
    assert.deepEqual([r.present, r.valid_json, r.job_id_matches, r.raw], [false, false, false, null]);
  }
  const big = JSON.stringify({ job_id: 'j1', notes: 'é'.repeat(20000) });
  const capped = parseWorkerReport(big, 'j1');
  assert.equal(capped.truncated, true);
  assert.equal(capped.valid_json, true);
  assert.equal(capped.job_id_matches, true);
  assert.equal(capped.report, null);
  assert.ok(Buffer.byteLength(capped.raw) <= MAX_REPORT_BYTES);
});

test('mergeValidation: an allowed symlink is not also a reparse-point violation', () => {
  const link = { path: 'Link.txt', old_mode: '000000', new_mode: '120000' };
  const reparse = [{ path: 'link.txt', rule: 'reparse_point', detail: 'changed path is a symlink/junction' }];
  const base = { verdict: 'clean', violations: [] };
  assert.deepEqual(mergeValidation([link], base, reparse, true), { verdict: 'clean', violations: [] });
  assert.equal(mergeValidation([link], base, reparse, false).verdict, 'violations');
  const regular = { path: 'link.txt', old_mode: '000000', new_mode: '100644' };
  assert.equal(mergeValidation([regular], base, reparse, true).verdict, 'violations');
  const ancestor = [{ path: 'dir', rule: 'reparse_point', detail: 'ancestor' }];
  assert.equal(mergeValidation([{ path: 'dir/f', new_mode: '100644' }], base, ancestor, true).verdict, 'violations');
  assert.equal(mergeValidation([], base, [], false).verdict, 'empty');
  const scoped = { verdict: 'violations', violations: [{ path: 'a', rule: 'outside_write_scope' }] };
  assert.equal(mergeValidation([regular], scoped, [], false).violations.length, 1);
});

test('observedBlock compares the rollout to the request and tolerates a missing rollout', () => {
  const thread = '01a10f19-685d-7993-aaf0-7b528e9b4469';
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hwf-'));
  try {
    const now = new Date();
    const dir = path.join(home, 'sessions', String(now.getUTCFullYear()), String(now.getUTCMonth() + 1).padStart(2, '0'), String(now.getUTCDate()).padStart(2, '0'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `rollout-x-${thread}.jsonl`), [
      { type: 'session_meta', payload: { id: thread, cli_version: '0.0.0' } },
      { type: 'turn_context', payload: { model: 'm1', effort: 'high', approval_policy: 'never', sandbox_policy: { type: 'workspace-write' } } },
    ].map((r) => JSON.stringify(r)).join('\n'));
    const requested = { model: 'm1', effort: 'high', sandbox: 'workspace-write', approval_policy: 'never' };

    const ok = observedBlock({ codexHome: home, threadId: thread, requested });
    assert.equal(ok.matches, true);
    assert.equal(ok.observed.model, 'm1');
    assert.equal(ok.observed.sandbox_policy, 'workspace-write');

    const bad = observedBlock({ codexHome: home, threadId: thread, requested: { ...requested, effort: 'low' } });
    assert.equal(bad.matches, false);
    assert.deepEqual(bad.mismatches, [{ field: 'effort', requested: 'low', observed: 'high' }]);

    const missing = observedBlock({ codexHome: home, threadId: '11111111-2222-3333-4444-555555555555', requested });
    assert.deepEqual([missing.observed, missing.matches], [null, null]);
    assert.deepEqual(observedBlock({ codexHome: home, threadId: null, requested }), { observed: null, matches: null, mismatches: [] });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('capturePatchBlock: missing worktree, and the 500-file cap on result.json', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hwf-'));
  try {
    const ctx = { gitExe: git.resolveGitExe(), hooksDir: git.ensureEmptyHooksDir(path.join(root, 'hooks')) };
    const ap = attemptPaths(root, 'r260101-000000-abcd', 'j1', 1);
    fs.mkdirSync(ap.dir, { recursive: true });
    const spec = { preset_config: { sandbox: 'workspace-write' }, write_scope: ['**'], allow_protected: [], allow_symlinks: false };
    const base = '0'.repeat(40);

    const missing = capturePatchBlock({ ctx, worktree: path.join(root, 'nope'), baseCommit: base, ap, attempt: 1, spec });
    assert.deepEqual([missing.captured, missing.verdict, missing.error], [false, 'capture_failed', 'worktree does not exist']);

    const repo = path.join(root, 'repo');
    git.runGit(ctx, ['init', '-q', '-b', 'main', repo]);
    for (const [k, v] of [['user.name', 't'], ['user.email', 't@example.invalid'], ['commit.gpgsign', 'false']]) {
      git.runGit(ctx, ['-C', repo, 'config', k, v]);
    }
    fs.writeFileSync(path.join(repo, 'seed.txt'), 'x');
    git.runGit(ctx, ['-C', repo, 'add', '-A']);
    git.runGit(ctx, ['-C', repo, 'commit', '-q', '-m', 'init']);
    const head = git.runGit(ctx, ['-C', repo, 'rev-parse', 'HEAD']).stdout.trim();
    for (let i = 0; i < MAX_RESULT_FILES + 1; i++) fs.writeFileSync(path.join(repo, `f${String(i).padStart(3, '0')}.txt`), `${i}\n`);

    const block = capturePatchBlock({ ctx, worktree: repo, baseCommit: head, ap, attempt: 1, spec });
    assert.equal(block.captured, true, block.error);
    assert.equal(block.verdict, 'clean');
    assert.equal(block.stats.files, MAX_RESULT_FILES + 1);
    assert.equal(block.files.length, MAX_RESULT_FILES);
    assert.equal(block.files_truncated, true);
    assert.equal(block.file, 'attempts/1/patch.diff');
    assert.equal(JSON.parse(fs.readFileSync(ap.patchMeta, 'utf8')).files.length, MAX_RESULT_FILES + 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('buildResult: a bare result for a job that never ran keeps the documented shape', () => {
  const state = {
    run_id: 'r260101-000000-abcd', job_id: 'j1', submitted_epoch: 1, attempt: 1, queued_at: 'q', started_at: null,
    prompt_sha256: null, base_commit: 'b'.repeat(40), codex_session_id: null,
  };
  const result = buildResult({
    run: { versions: { codex: 'codex-cli x' } }, spec: { preset: 'p', preset_config: { model: 'm', effort: 'low', sandbox: 'read-only' }, capsule_sha256: 'c' },
    state, outcome: { state: 'rejected', reason: 'stale_epoch', detail: null }, evidence: null, sweep: null, endedAt: 'e', specSha256: 's',
  });
  assert.equal(result.schema, 'hybrid.job-result/1');
  assert.deepEqual([result.state, result.reason, result.epoch, result.attempt], ['rejected', 'stale_epoch', 1, 1]);
  assert.deepEqual(result.exit, { code: null, signal: null, source: 'none' });
  assert.equal(result.provenance.codex_version, 'codex-cli x');
  assert.deepEqual(result.provenance.requested, { model: 'm', effort: 'low', sandbox: 'read-only', approval_policy: 'never' });
  assert.deepEqual([result.events, result.worker_report, result.patch], [null, null, null]);
  assert.deepEqual(result.orphans, { killed: [], failed: [] });
  assert.equal(result.timestamps.ended_at, 'e');
});
