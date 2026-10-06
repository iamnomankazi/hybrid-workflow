import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EXIT, RUN_ID_RE, SCHEMAS } from '../../src/constants.mjs';
import {
  PACKAGE_ROOT, RUNNER_ENTRY, JOB_HOST_ENTRY, WORKER_OUTPUT_SCHEMA, resolveHome, defaultWorktreeRoot,
  homePaths, runPaths, jobPaths, attemptPaths, worktreePath,
} from '../../src/paths.mjs';
import {
  HybridError, FencedError, generateRunId, assertRunId, assertJobId, readActiveRunLock, resolveRunId,
  loadRun, assertOwner, writeRequest, listPendingRequests, completeRequest, readRequestOutcome,
  listJobIds, readJobSpec, readJobState, readJobResult, readDecision, jobExists, appendTransition,
  readTransitions, lastTransitionSeq, readRunnerStatus,
} from '../../src/store.mjs';
import { writeJsonAtomic, ensureDir, exists } from '../../src/fsutil.mjs';

let root;
let counter = 0;
before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hwc-'));
});
after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function newHome() {
  const home = path.join(root, `home${counter++}`);
  fs.mkdirSync(home, { recursive: true });
  return home;
}

const RUN = 'r261006-101112-abcd';

function makeRun(home, runId = RUN, overrides = {}) {
  const run = {
    schema: SCHEMAS.run,
    run_id: runId,
    status: 'open',
    owner: { session_id: 'sess-1', epoch: 3, acquired_at: '2026-10-06T10:11:12.000Z' },
    ...overrides,
  };
  const rp = runPaths(home, runId);
  ensureDir(rp.dir);
  writeJsonAtomic(rp.run, run);
  return run;
}

function expectHybridError(fn, exitCode, code) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof HybridError, `expected HybridError, got ${err?.constructor?.name}: ${err?.message}`);
    assert.equal(err.exitCode, exitCode, err.message);
    if (code) assert.equal(err.code, code);
    return true;
  });
}

describe('paths', () => {
  test('resolveHome honours HYBRID_HOME (and resolves relative values)', () => {
    const abs = path.join(root, 'explicit-home');
    assert.equal(resolveHome({ HYBRID_HOME: abs, LOCALAPPDATA: 'C:\\ignored' }), abs);
    const rel = resolveHome({ HYBRID_HOME: 'some\\rel\\dir' });
    assert.ok(path.isAbsolute(rel));
    assert.equal(rel, path.resolve('some\\rel\\dir'));
  });

  test('resolveHome defaults to LOCALAPPDATA\\HybridWorkflow', () => {
    assert.equal(
      resolveHome({ LOCALAPPDATA: 'C:\\Users\\Someone\\AppData\\Local' }),
      path.join('C:\\Users\\Someone\\AppData\\Local', 'HybridWorkflow'),
    );
  });

  test('resolveHome falls back to <homedir>\\AppData\\Local when LOCALAPPDATA is unset, and ignores an empty HYBRID_HOME', () => {
    const expected = path.join(os.homedir(), 'AppData', 'Local', 'HybridWorkflow');
    assert.equal(resolveHome({}), expected);
    assert.equal(resolveHome({ HYBRID_HOME: '' }), expected);
  });

  test('resolveHome reads process.env by default', () => {
    const saved = process.env.HYBRID_HOME;
    try {
      const target = path.join(root, 'from-process-env');
      process.env.HYBRID_HOME = target;
      assert.equal(resolveHome(), target);
      delete process.env.HYBRID_HOME;
      assert.match(resolveHome(), /HybridWorkflow$/);
    } finally {
      if (saved === undefined) delete process.env.HYBRID_HOME;
      else process.env.HYBRID_HOME = saved;
    }
  });

  test('defaultWorktreeRoot is <SystemDrive>\\hw\\wt', () => {
    assert.equal(defaultWorktreeRoot({}), 'C:\\hw\\wt');
    assert.equal(defaultWorktreeRoot({ SystemDrive: 'D:' }), 'D:\\hw\\wt');
    assert.equal(defaultWorktreeRoot({ SYSTEMDRIVE: 'E:' }), 'E:\\hw\\wt');
  });

  test('package-level constants point inside the package', () => {
    assert.ok(fs.existsSync(path.join(PACKAGE_ROOT, 'package.json')));
    assert.equal(RUNNER_ENTRY, path.join(PACKAGE_ROOT, 'src', 'runner', 'main.mjs'));
    assert.equal(JOB_HOST_ENTRY, path.join(PACKAGE_ROOT, 'src', 'runner', 'job-host.mjs'));
    assert.equal(WORKER_OUTPUT_SCHEMA, path.join(PACKAGE_ROOT, 'schemas', 'worker-output.schema.json'));
  });

  test('homePaths shape', () => {
    const home = 'C:\\h';
    assert.deepEqual(homePaths(home), {
      home,
      config: path.join(home, 'config.json'),
      activeRunLock: path.join(home, 'active-run.json'),
      emptyHooks: path.join(home, 'empty-hooks'),
      runs: path.join(home, 'runs'),
    });
  });

  test('runPaths shape matches the documented layout', () => {
    const home = 'C:\\h';
    const rp = runPaths(home, RUN);
    const dir = path.join(home, 'runs', RUN);
    assert.deepEqual(rp, {
      dir,
      run: path.join(dir, 'run.json'),
      runMutex: path.join(dir, 'run.mutex'),
      plan: path.join(dir, 'plan.md'),
      runner: path.join(dir, 'runner.json'),
      runnerLock: path.join(dir, 'runner.lock'),
      runnerLog: path.join(dir, 'runner.log'),
      runnerLaunch: path.join(dir, 'runner-launch.json'),
      transitions: path.join(dir, 'transitions.jsonl'),
      progress: path.join(dir, 'progress.log'),
      inbox: path.join(dir, 'inbox'),
      inboxTmp: path.join(dir, 'inbox', '.tmp'),
      inboxDone: path.join(dir, 'inbox', 'done'),
      cursors: path.join(dir, 'cursors'),
      jobs: path.join(dir, 'jobs'),
    });
  });

  test('jobPaths shape', () => {
    const home = 'C:\\h';
    const jp = jobPaths(home, RUN, 'my-job');
    const dir = path.join(home, 'runs', RUN, 'jobs', 'my-job');
    assert.deepEqual(jp, {
      dir,
      spec: path.join(dir, 'spec.json'),
      capsule: path.join(dir, 'capsule.md'),
      state: path.join(dir, 'state.json'),
      result: path.join(dir, 'result.json'),
      decision: path.join(dir, 'decision.json'),
      attempts: path.join(dir, 'attempts'),
    });
  });

  test('attemptPaths shape; attempt number becomes a directory name', () => {
    const home = 'C:\\h';
    const ap = attemptPaths(home, RUN, 'my-job', 2);
    const dir = path.join(home, 'runs', RUN, 'jobs', 'my-job', 'attempts', '2');
    assert.deepEqual(ap, {
      dir,
      launch: path.join(dir, 'launch.json'),
      prompt: path.join(dir, 'prompt.md'),
      host: path.join(dir, 'host.json'),
      exit: path.join(dir, 'exit.json'),
      events: path.join(dir, 'events.jsonl'),
      stderr: path.join(dir, 'stderr.log'),
      lastMessage: path.join(dir, 'last-message.md'),
      hostLog: path.join(dir, 'host.log'),
      patch: path.join(dir, 'patch.diff'),
      patchMeta: path.join(dir, 'patch.json'),
    });
    assert.equal(attemptPaths(home, RUN, 'my-job', '7').dir, path.join(jobPaths(home, RUN, 'my-job').attempts, '7'));
  });

  test('job paths nest under the run dir; attempt paths nest under the job dir', () => {
    const home = 'C:\\h';
    const rp = runPaths(home, RUN);
    const jp = jobPaths(home, RUN, 'j');
    const ap = attemptPaths(home, RUN, 'j', 1);
    assert.ok(jp.dir.startsWith(rp.jobs + path.sep));
    assert.ok(ap.dir.startsWith(jp.attempts + path.sep));
  });

  test('worktreePath is <root>\\<run>\\<job>', () => {
    assert.equal(worktreePath('C:\\hw\\wt', RUN, 'job-1'), path.join('C:\\hw\\wt', RUN, 'job-1'));
  });
});

describe('store: errors and id assertions', () => {
  test('HybridError defaults and FencedError shape', () => {
    const e = new HybridError('x');
    assert.equal(e.exitCode, EXIT.error);
    assert.equal(e.code, 'error');
    assert.ok(e instanceof Error);
    const f = new FencedError('stale');
    assert.ok(f instanceof HybridError);
    assert.equal(f.exitCode, EXIT.fenced);
    assert.equal(f.code, 'fenced');
    assert.equal(f.message, 'stale');
  });

  test('assertRunId / assertJobId accept valid and throw usage errors otherwise', () => {
    assert.doesNotThrow(() => assertRunId(RUN));
    assert.doesNotThrow(() => assertJobId('job-1'));
    for (const bad of [undefined, null, '', 'nope', '../x', `${RUN}/..`]) {
      expectHybridError(() => assertRunId(bad), EXIT.usage, 'usage');
    }
    for (const bad of [undefined, null, '', 'Job', '-job', 'a'.repeat(25), '../x']) {
      expectHybridError(() => assertJobId(bad), EXIT.usage, 'usage');
    }
  });
});

describe('store: generateRunId', () => {
  test('format rNNNNNN-NNNNNN-xxxx in local time, matches RUN_ID_RE', () => {
    const id = generateRunId(new Date(2026, 9, 6, 7, 8, 9));
    assert.match(id, /^r261006-070809-[0-9a-f]{4}$/);
    assert.match(id, RUN_ID_RE);
  });

  test('zero-pads single-digit fields', () => {
    assert.match(generateRunId(new Date(2005, 0, 2, 3, 4, 5)), /^r050102-030405-[0-9a-f]{4}$/);
  });

  test('default argument uses the current time and ids differ across calls', () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateRunId()));
    assert.ok(ids.size > 40, 'random suffix should vary');
    for (const id of ids) assert.match(id, RUN_ID_RE);
  });

  test('ids generated one second apart sort chronologically', () => {
    const a = generateRunId(new Date(2026, 9, 6, 7, 8, 9));
    const b = generateRunId(new Date(2026, 9, 6, 7, 8, 10));
    assert.ok(a.slice(0, 14) < b.slice(0, 14));
  });
});

describe('store: resolveRunId / readActiveRunLock', () => {
  test('explicit valid id is returned without touching disk', () => {
    const home = path.join(root, 'does-not-exist');
    assert.equal(resolveRunId(home, RUN), RUN);
  });

  test('explicit invalid id is a usage error', () => {
    expectHybridError(() => resolveRunId(newHome(), 'bogus'), EXIT.usage, 'usage');
  });

  test('explicit wins over the active lock', () => {
    const home = newHome();
    writeJsonAtomic(homePaths(home).activeRunLock, { run_id: 'r261006-000000-ffff' });
    assert.equal(resolveRunId(home, RUN), RUN);
  });

  test('falls back to the active lock', () => {
    const home = newHome();
    writeJsonAtomic(homePaths(home).activeRunLock, { run_id: RUN, session_id: 's' });
    assert.equal(resolveRunId(home), RUN);
    assert.equal(resolveRunId(home, ''), RUN);
    assert.equal(resolveRunId(home, null), RUN);
    assert.equal(readActiveRunLock(home).session_id, 's');
  });

  test('no lock file: HybridError exit 4 (not_found)', () => {
    const home = newHome();
    assert.equal(readActiveRunLock(home), null);
    expectHybridError(() => resolveRunId(home), EXIT.notFound, 'not_found');
    expectHybridError(() => resolveRunId(home, undefined), 4, 'not_found');
  });

  test('lock without run_id: exit 4', () => {
    const home = newHome();
    writeJsonAtomic(homePaths(home).activeRunLock, { session_id: 'x' });
    expectHybridError(() => resolveRunId(home), EXIT.notFound);
    writeJsonAtomic(homePaths(home).activeRunLock, { run_id: '' });
    expectHybridError(() => resolveRunId(home), EXIT.notFound);
  });

  test('corrupt lock file surfaces a JSON error naming the file', () => {
    const home = newHome();
    fs.writeFileSync(homePaths(home).activeRunLock, '{not json');
    assert.throws(() => resolveRunId(home), /Invalid JSON in .*active-run\.json/);
  });

  test('a run id read from the lock is validated before use as a path segment', () => {
    const home = newHome();
    writeJsonAtomic(homePaths(home).activeRunLock, { run_id: '..\\..\\evil' });
    assert.throws(() => resolveRunId(home), HybridError);
  });
});

describe('store: loadRun', () => {
  test('loads a valid run', () => {
    const home = newHome();
    const run = makeRun(home);
    assert.deepEqual(loadRun(home, RUN), run);
  });

  test('missing run: exit 4', () => {
    expectHybridError(() => loadRun(newHome(), RUN), EXIT.notFound, 'not_found');
  });

  test('invalid run id: exit 2 and no disk access needed', () => {
    expectHybridError(() => loadRun(path.join(root, 'nowhere'), '../x'), EXIT.usage, 'usage');
  });

  test('unknown schema is rejected (exit 1, code "schema") naming the schema', () => {
    const home = newHome();
    makeRun(home, RUN, { schema: 'hybrid.run/99' });
    assert.throws(() => loadRun(home, RUN), (err) => {
      assert.ok(err instanceof HybridError);
      assert.equal(err.exitCode, EXIT.error);
      assert.equal(err.code, 'schema');
      assert.match(err.message, /hybrid\.run\/99/);
      return true;
    });
  });

  test('missing schema field is rejected too', () => {
    const home = newHome();
    const rp = runPaths(home, RUN);
    ensureDir(rp.dir);
    writeJsonAtomic(rp.run, { run_id: RUN, status: 'open' });
    expectHybridError(() => loadRun(home, RUN), EXIT.error, 'schema');
  });

  test('run.json containing null is treated as not found', () => {
    const home = newHome();
    const rp = runPaths(home, RUN);
    ensureDir(rp.dir);
    fs.writeFileSync(rp.run, 'null');
    expectHybridError(() => loadRun(home, RUN), EXIT.notFound);
  });

  test('corrupt run.json surfaces a JSON error rather than not-found', () => {
    const home = newHome();
    const rp = runPaths(home, RUN);
    ensureDir(rp.dir);
    fs.writeFileSync(rp.run, '{"schema":');
    assert.throws(() => loadRun(home, RUN), /Invalid JSON/);
  });

  test('BOM-prefixed run.json (hand-edited on Windows) loads', () => {
    const home = newHome();
    const rp = runPaths(home, RUN);
    ensureDir(rp.dir);
    fs.writeFileSync(rp.run, `\ufeff${JSON.stringify({ schema: SCHEMAS.run, run_id: RUN, status: 'open', owner: { epoch: 1 } })}`);
    assert.equal(loadRun(home, RUN).run_id, RUN);
  });
});

describe('store: assertOwner', () => {
  const run = () => ({ run_id: RUN, status: 'open', owner: { session_id: 'sess-1', epoch: 3 } });

  test('matching integer epoch returns it', () => {
    assert.equal(assertOwner(run(), 3), 3);
  });

  test('string "3" is accepted and normalised to the number 3', () => {
    assert.equal(assertOwner(run(), '3'), 3);
    assert.equal(assertOwner(run(), '03'), 3);
  });

  test('missing epoch: usage error, exit 2', () => {
    for (const missing of [undefined, null, '']) {
      expectHybridError(() => assertOwner(run(), missing), EXIT.usage, 'usage');
    }
    assert.throws(() => assertOwner(run()), /--epoch/);
  });

  test('non-integer epoch values: exit 2', () => {
    for (const bad of ['abc', '3.5', '-3', ' 3', '3 ', '0x3', 3.5, NaN, Infinity, true, {}, [], [3]]) {
      expectHybridError(() => assertOwner(run(), bad), EXIT.usage);
    }
  });

  test('stale epoch (lower or higher): FencedError, exit 3, message names owner session', () => {
    for (const stale of [2, '2', 4, '4', 0, 1]) {
      assert.throws(() => assertOwner(run(), stale), (err) => {
        assert.ok(err instanceof FencedError, String(stale));
        assert.ok(err instanceof HybridError);
        assert.equal(err.exitCode, EXIT.fenced);
        assert.equal(err.code, 'fenced');
        assert.match(err.message, /sess-1/);
        assert.match(err.message, /hybrid takeover/);
        return true;
      });
    }
  });

  test('closed run: conflict, exit 5 (even with the right epoch)', () => {
    const closed = { ...run(), status: 'closed' };
    expectHybridError(() => assertOwner(closed, 3), EXIT.conflict, 'conflict');
    assert.throws(() => assertOwner(closed, 3), /closed/);
  });

  test('closed run with a stale epoch reports the closed status first (exit 5, not 3)', () => {
    expectHybridError(() => assertOwner({ ...run(), status: 'closed' }, 99), EXIT.conflict);
  });

  test('any non-open status is a conflict', () => {
    for (const status of ['closing', 'aborted', undefined, null]) {
      expectHybridError(() => assertOwner({ ...run(), status }, 3), EXIT.conflict);
    }
  });

  test('epoch 0 and big epochs behave as plain integers', () => {
    const r = { run_id: RUN, status: 'open', owner: { session_id: 's', epoch: 0 } };
    assert.equal(assertOwner(r, 0), 0);
    assert.equal(assertOwner(r, '0'), 0);
    const big = { run_id: RUN, status: 'open', owner: { session_id: 's', epoch: 123456789 } };
    assert.equal(assertOwner(big, '123456789'), 123456789);
  });

  test('works end to end with a loaded run', () => {
    const home = newHome();
    makeRun(home);
    assert.equal(assertOwner(loadRun(home, RUN), '3'), 3);
  });
});

describe('store: inbox requests', () => {
  const req = (over = {}) => ({ type: 'cancel', epoch: 3, session_id: 'sess-1', job_id: 'job-1', ...over });

  test('writeRequest returns the request and the file appears in inbox, not in inbox/.tmp', () => {
    const home = newHome();
    const request = writeRequest(home, RUN, req({ payload: { why: 'test' } }));
    const rp = runPaths(home, RUN);
    assert.equal(request.schema, SCHEMAS.request);
    assert.equal(request.type, 'cancel');
    assert.equal(request.run_id, RUN);
    assert.equal(request.epoch, 3);
    assert.equal(request.session_id, 'sess-1');
    assert.equal(request.job_id, 'job-1');
    assert.deepEqual(request.payload, { why: 'test' });
    assert.match(request.created_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(request.id, /^\d{14}-\d{6}-[0-9a-f]{8}$/);

    const file = path.join(rp.inbox, `${request.id}.json`);
    assert.ok(exists(file));
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), request);
    assert.deepEqual(fs.readdirSync(rp.inboxTmp), []);
    assert.ok(!exists(path.join(rp.inboxTmp, `${request.id}.json`)));
  });

  test('defaults: job_id null, payload {}', () => {
    const home = newHome();
    const request = writeRequest(home, RUN, { type: 'unhold', epoch: 1, session_id: 's' });
    assert.equal(request.job_id, null);
    assert.deepEqual(request.payload, {});
  });

  test('every documented request type is accepted; unknown types throw and write nothing', () => {
    const home = newHome();
    for (const type of ['submit', 'cancel', 'resume', 'unhold', 'shutdown']) {
      assert.doesNotThrow(() => writeRequest(home, RUN, req({ type })), type);
    }
    assert.equal(listPendingRequests(home, RUN).length, 5);
    assert.throws(() => writeRequest(home, RUN, req({ type: 'explode' })), /Unknown request type explode/);
    assert.throws(() => writeRequest(home, RUN, req({ type: undefined })), /Unknown request type/);
    assert.equal(listPendingRequests(home, RUN).length, 5);
  });

  test('request ids are unique across 100 quick writes', () => {
    const home = newHome();
    const ids = new Set();
    for (let i = 0; i < 100; i++) ids.add(writeRequest(home, RUN, req()).id);
    assert.equal(ids.size, 100);
  });

  test('lexical order equals creation order across 20 quick writes (real clock)', () => {
    const home = newHome();
    const created = [];
    for (let i = 0; i < 20; i++) created.push(writeRequest(home, RUN, req({ payload: { i } })).id);
    const listed = listPendingRequests(home, RUN).map((f) => path.basename(f, '.json'));
    assert.deepEqual(listed, created);
  });

  test('lexical order equals creation order when the clock does not advance (deterministic)', () => {
    const home = newHome();
    const realNow = Date.now;
    Date.now = () => 1_800_000_000_000;
    try {
      const created = [];
      for (let i = 0; i < 20; i++) created.push(writeRequest(home, RUN, req({ payload: { i } })).id);
      const listed = listPendingRequests(home, RUN).map((f) => path.basename(f, '.json'));
      assert.deepEqual(listed, created);
    } finally {
      Date.now = realNow;
    }
  });

  test('requests created in different milliseconds sort in creation order', () => {
    const home = newHome();
    const realNow = Date.now;
    let t = 1_800_000_000_000;
    Date.now = () => t++;
    try {
      const created = [];
      for (let i = 0; i < 20; i++) created.push(writeRequest(home, RUN, req({ payload: { i } })).id);
      const listed = listPendingRequests(home, RUN).map((f) => path.basename(f, '.json'));
      assert.deepEqual(listed, created);
    } finally {
      Date.now = realNow;
    }
  });

  test('ids are zero-padded so a 13-digit millis value still sorts before a 14-digit one', () => {
    const home = newHome();
    const realNow = Date.now;
    try {
      Date.now = () => 999_999_999_999; // 12 digits
      const a = writeRequest(home, RUN, req()).id;
      Date.now = () => 1_000_000_000_000; // 13 digits
      const b = writeRequest(home, RUN, req()).id;
      assert.ok(a < b, `${a} < ${b}`);
      assert.equal(a.indexOf('-'), 14);
    } finally {
      Date.now = realNow;
    }
  });

  test('listPendingRequests: missing inbox -> []; returns absolute paths; ignores non-json, .tmp and done/', () => {
    const home = newHome();
    assert.deepEqual(listPendingRequests(home, RUN), []);

    const request = writeRequest(home, RUN, req());
    const rp = runPaths(home, RUN);
    fs.writeFileSync(path.join(rp.inbox, 'notes.txt'), 'x');
    fs.writeFileSync(path.join(rp.inbox, 'x.json.part'), '{}');
    fs.writeFileSync(path.join(rp.inbox, 'README'), '');
    ensureDir(rp.inboxDone);
    fs.writeFileSync(path.join(rp.inboxDone, '00000000000001-aaaaaaaa.json'), '{}');
    fs.writeFileSync(path.join(rp.inboxTmp, '00000000000002-bbbbbbbb.json'), '{}');

    assert.deepEqual(listPendingRequests(home, RUN), [path.join(rp.inbox, `${request.id}.json`)]);
  });

  test('listPendingRequests does not list directories whose name ends in .json', () => {
    const home = newHome();
    const rp = runPaths(home, RUN);
    ensureDir(path.join(rp.inbox, 'weird.json'));
    assert.deepEqual(listPendingRequests(home, RUN), []);
  });

  test('completeRequest moves to done with outcome and removes the pending file', () => {
    const home = newHome();
    const request = writeRequest(home, RUN, req({ payload: { a: 1 } }));
    const file = listPendingRequests(home, RUN)[0];
    completeRequest(home, RUN, file, request, 'accepted');

    const rp = runPaths(home, RUN);
    assert.ok(!exists(file), 'pending file must be removed');
    assert.deepEqual(listPendingRequests(home, RUN), []);
    const done = JSON.parse(fs.readFileSync(path.join(rp.inboxDone, `${request.id}.json`), 'utf8'));
    assert.equal(done.outcome, 'accepted');
    assert.equal(done.reason, null);
    assert.match(done.processed_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(done.payload, { a: 1 });
    assert.equal(done.id, request.id);
    assert.equal(done.type, 'cancel');
  });

  test('completeRequest records rejection reason and extra fields', () => {
    const home = newHome();
    const request = writeRequest(home, RUN, req({ type: 'submit', job_id: 'j' }));
    completeRequest(home, RUN, listPendingRequests(home, RUN)[0], request, 'rejected', 'stale_epoch', { current_epoch: 4 });
    const out = readRequestOutcome(home, RUN, request.id);
    assert.equal(out.outcome, 'rejected');
    assert.equal(out.reason, 'stale_epoch');
    assert.equal(out.current_epoch, 4);
    assert.equal(out.type, 'submit');
  });

  test('completeRequest leaves no temp files and tolerates an already-removed pending file', () => {
    const home = newHome();
    const request = writeRequest(home, RUN, req());
    const file = listPendingRequests(home, RUN)[0];
    fs.rmSync(file);
    assert.doesNotThrow(() => completeRequest(home, RUN, file, request, 'accepted'));
    const rp = runPaths(home, RUN);
    assert.deepEqual(fs.readdirSync(rp.inboxDone), [`${request.id}.json`]);
  });

  test('completeRequest lets `extra` override outcome (pinned: caller beware)', () => {
    const home = newHome();
    const request = writeRequest(home, RUN, req());
    completeRequest(home, RUN, listPendingRequests(home, RUN)[0], request, 'accepted', null, { outcome: 'oops' });
    assert.equal(readRequestOutcome(home, RUN, request.id).outcome, 'oops');
  });

  test('readRequestOutcome: null while pending, record once done', () => {
    const home = newHome();
    const request = writeRequest(home, RUN, req());
    assert.equal(readRequestOutcome(home, RUN, request.id), null);
    assert.equal(readRequestOutcome(home, RUN, 'nonexistent'), null);
    completeRequest(home, RUN, listPendingRequests(home, RUN)[0], request, 'accepted');
    assert.equal(readRequestOutcome(home, RUN, request.id).outcome, 'accepted');
  });

  test('writeRequest validates the run id before building paths', () => {
    const home = newHome();
    assert.throws(() => writeRequest(home, '..\\..\\x', req()), HybridError);
  });
});

describe('store: jobs', () => {
  test('listJobIds: missing jobs dir -> []', () => {
    assert.deepEqual(listJobIds(newHome(), RUN), []);
  });

  test('listJobIds ignores invalid names and plain files, and sorts', () => {
    const home = newHome();
    const jobs = runPaths(home, RUN).jobs;
    for (const name of ['zeta', 'alpha', 'a-1', '9lives', 'Upper', '-lead', 'under_score', 'a'.repeat(25), 'dot.name', 'sp ace']) {
      ensureDir(path.join(jobs, name));
    }
    fs.writeFileSync(path.join(jobs, 'valid-name-but-file'), 'x');
    assert.deepEqual(listJobIds(home, RUN), ['9lives', 'a-1', 'alpha', 'zeta']);
  });

  test('listJobIds keeps a 24-char id', () => {
    const home = newHome();
    ensureDir(path.join(runPaths(home, RUN).jobs, 'a'.repeat(24)));
    assert.deepEqual(listJobIds(home, RUN), ['a'.repeat(24)]);
  });

  test('read helpers return null for missing files and the parsed document otherwise', () => {
    const home = newHome();
    const jp = jobPaths(home, RUN, 'j1');
    assert.equal(jobExists(home, RUN, 'j1'), false);
    for (const fn of [readJobSpec, readJobState, readJobResult, readDecision]) {
      assert.equal(fn(home, RUN, 'j1'), null);
    }
    ensureDir(jp.dir);
    assert.equal(jobExists(home, RUN, 'j1'), true);
    writeJsonAtomic(jp.spec, { s: 1 });
    writeJsonAtomic(jp.state, { st: 2 });
    writeJsonAtomic(jp.result, { r: 3 });
    writeJsonAtomic(jp.decision, { d: 4 });
    assert.deepEqual(readJobSpec(home, RUN, 'j1'), { s: 1 });
    assert.deepEqual(readJobState(home, RUN, 'j1'), { st: 2 });
    assert.deepEqual(readJobResult(home, RUN, 'j1'), { r: 3 });
    assert.deepEqual(readDecision(home, RUN, 'j1'), { d: 4 });
    assert.equal(readJobState(home, RUN, 'other'), null);
  });

  test('readRunnerStatus: null then document', () => {
    const home = newHome();
    assert.equal(readRunnerStatus(home, RUN), null);
    ensureDir(runPaths(home, RUN).dir);
    writeJsonAtomic(runPaths(home, RUN).runner, { pid: 1 });
    assert.deepEqual(readRunnerStatus(home, RUN), { pid: 1 });
  });
});

describe('store: transitions feed', () => {
  const tr = (seq, extra = {}) => ({
    seq, ts: '2026-10-06T00:00:00.000Z', kind: 'job', job_id: 'j', from: 'queued', to: 'launching', reason: null, attempt: 1, ...extra,
  });

  test('missing feed: empty records, offset 0, last seq 0', () => {
    const home = newHome();
    assert.deepEqual(readTransitions(home, RUN), { records: [], nextOffset: 0 });
    assert.equal(lastTransitionSeq(home, RUN), 0);
  });

  test('appendTransition then readTransitions returns records in order', () => {
    const home = newHome();
    ensureDir(runPaths(home, RUN).dir);
    for (let i = 1; i <= 5; i++) appendTransition(home, RUN, tr(i));
    const { records, nextOffset } = readTransitions(home, RUN);
    assert.deepEqual(records.map((r) => r.seq), [1, 2, 3, 4, 5]);
    assert.equal(nextOffset, fs.statSync(runPaths(home, RUN).transitions).size);
  });

  test('sinceSeq filters strictly greater', () => {
    const home = newHome();
    ensureDir(runPaths(home, RUN).dir);
    for (let i = 1; i <= 5; i++) appendTransition(home, RUN, tr(i));
    assert.deepEqual(readTransitions(home, RUN, { sinceSeq: 3 }).records.map((r) => r.seq), [4, 5]);
    assert.deepEqual(readTransitions(home, RUN, { sinceSeq: 5 }).records, []);
    assert.deepEqual(readTransitions(home, RUN, { sinceSeq: 99 }).records, []);
    assert.equal(readTransitions(home, RUN, { sinceSeq: 0 }).records.length, 5);
  });

  test('offset resumes reading; combined with sinceSeq', () => {
    const home = newHome();
    ensureDir(runPaths(home, RUN).dir);
    appendTransition(home, RUN, tr(1));
    appendTransition(home, RUN, tr(2));
    const first = readTransitions(home, RUN);
    appendTransition(home, RUN, tr(3));
    appendTransition(home, RUN, tr(4));
    const second = readTransitions(home, RUN, { offset: first.nextOffset });
    assert.deepEqual(second.records.map((r) => r.seq), [3, 4]);
    const third = readTransitions(home, RUN, { offset: first.nextOffset, sinceSeq: 3 });
    assert.deepEqual(third.records.map((r) => r.seq), [4]);
    assert.equal(third.nextOffset, second.nextOffset);
    assert.deepEqual(readTransitions(home, RUN, { offset: second.nextOffset }).records, []);
  });

  test('records without an integer seq are ignored; malformed lines and a partial tail are skipped', () => {
    const home = newHome();
    const file = runPaths(home, RUN).transitions;
    ensureDir(runPaths(home, RUN).dir);
    fs.writeFileSync(file, [
      JSON.stringify(tr(1)),
      JSON.stringify({ no: 'seq' }),
      JSON.stringify(tr('7')),
      JSON.stringify(tr(2.5)),
      'garbage',
      JSON.stringify(tr(3)),
    ].join('\n') + '\n{"seq":4,');
    const { records, nextOffset } = readTransitions(home, RUN);
    assert.deepEqual(records.map((r) => r.seq), [1, 3]);
    assert.equal(nextOffset, fs.statSync(file).size - '{"seq":4,'.length);
    assert.equal(lastTransitionSeq(home, RUN), 3);
  });

  test('lastTransitionSeq is the max seq, even if the file is out of order', () => {
    const home = newHome();
    ensureDir(runPaths(home, RUN).dir);
    for (const s of [3, 9, 4]) appendTransition(home, RUN, tr(s));
    assert.equal(lastTransitionSeq(home, RUN), 9);
  });

  test('lastTransitionSeq does not count a partial last line', () => {
    const home = newHome();
    ensureDir(runPaths(home, RUN).dir);
    appendTransition(home, RUN, tr(1));
    fs.appendFileSync(runPaths(home, RUN).transitions, '{"seq":2,"kind":"job"');
    assert.equal(lastTransitionSeq(home, RUN), 1);
    fs.appendFileSync(runPaths(home, RUN).transitions, '}\n');
    assert.equal(lastTransitionSeq(home, RUN), 2);
  });

  test('appendTransition into a run directory that does not exist throws ENOENT', () => {
    assert.throws(() => appendTransition(newHome(), RUN, tr(1)), { code: 'ENOENT' });
  });

  test('lastTransitionSeq is not confused by seq 0 or negative values', () => {
    const home = newHome();
    ensureDir(runPaths(home, RUN).dir);
    appendTransition(home, RUN, tr(0));
    appendTransition(home, RUN, tr(-4));
    assert.equal(lastTransitionSeq(home, RUN), 0);
  });
});
