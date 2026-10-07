import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HEARTBEAT_FALLBACK_MS, aliveByHeartbeat, ensureRunner, runnerAlive } from '../../src/launcher.mjs';
import { runPaths } from '../../src/paths.mjs';
import { writeJsonAtomic } from '../../src/fsutil.mjs';
import { ownIdentity } from '../../src/proc.mjs';
import { HybridError } from '../../src/store.mjs';

const RUN_ID = 'r261006-000000-abcd';
let tmp;
let rp;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwk-'));
  rp = runPaths(tmp, RUN_ID);
  fs.mkdirSync(rp.dir, { recursive: true });
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('launcher', () => {
  test('a denied process query falls back to the runner heartbeat', async () => {
    const lock = { pid: process.pid, start_time: 'x', acquired_at: new Date().toISOString() };
    writeJsonAtomic(rp.runnerLock, lock);
    const denied = async () => { throw new Error('Get-CimInstance : Access denied'); };
    try {
      writeJsonAtomic(rp.runner, { pid: process.pid, status: 'running', heartbeat_at: new Date().toISOString() });
      const fresh = await runnerAlive(tmp, RUN_ID, { query: denied });
      assert.deepEqual([fresh.alive, fresh.via], [true, 'heartbeat']);
      writeJsonAtomic(rp.runner, { pid: process.pid, status: 'running', heartbeat_at: new Date(Date.now() - HEARTBEAT_FALLBACK_MS).toISOString() });
      assert.equal((await runnerAlive(tmp, RUN_ID, { query: denied })).alive, false);
      // The query wins when it works.
      writeJsonAtomic(rp.runner, { pid: process.pid, status: 'running', heartbeat_at: new Date().toISOString() });
      assert.equal((await runnerAlive(tmp, RUN_ID, { query: async () => false })).alive, false);
    } finally {
      fs.rmSync(rp.runnerLock, { force: true });
      fs.rmSync(rp.runner, { force: true });
    }
  });

  test('aliveByHeartbeat needs the locked pid, running status, a fresh beat and a live process', () => {
    const now = Date.now();
    const lock = { pid: process.pid };
    const beat = new Date(now - 1000).toISOString();
    assert.equal(aliveByHeartbeat(lock, { pid: process.pid, status: 'running', heartbeat_at: beat }, now), true);
    assert.equal(aliveByHeartbeat(lock, { pid: process.pid + 1, status: 'running', heartbeat_at: beat }, now), false);
    assert.equal(aliveByHeartbeat(lock, { pid: process.pid, status: 'exited', heartbeat_at: beat }, now), false);
    assert.equal(aliveByHeartbeat(null, { pid: process.pid, status: 'running', heartbeat_at: beat }, now), false);
    // A pid that no longer exists (ESRCH) is dead whatever runner.json says.
    const gone = { pid: 4_000_000 };
    assert.equal(aliveByHeartbeat(gone, { pid: gone.pid, status: 'running', heartbeat_at: beat }, now), false);
  });

  test('no runner.lock means not alive', async () => {
    const r = await runnerAlive(tmp, RUN_ID);
    assert.equal(r.alive, false);
    assert.equal(r.lock, null);
  });

  test('launch mode none does not launch', async () => {
    assert.deepEqual(await ensureRunner(tmp, RUN_ID, { HYBRID_RUNNER_LAUNCH: 'none' }), { already: false, pid: null, skipped: true });
  });

  test('an unknown launch mode is a usage error', async () => {
    await assert.rejects(ensureRunner(tmp, RUN_ID, { HYBRID_RUNNER_LAUNCH: 'bogus' }), (e) => e instanceof HybridError && e.exitCode === 2);
  });

  test('a lock naming a live identity is alive and ensureRunner reports it as already running', async () => {
    const id = await ownIdentity();
    writeJsonAtomic(rp.runnerLock, { ...id, version: 'test', acquired_at: new Date().toISOString() });
    assert.equal((await runnerAlive(tmp, RUN_ID)).alive, true);
    assert.deepEqual(await ensureRunner(tmp, RUN_ID, { HYBRID_RUNNER_LAUNCH: 'none' }), { already: true, pid: id.pid });
  });

  test('a lock with the wrong start_time (pid reuse) or an unreadable lock is not alive', async () => {
    const id = await ownIdentity();
    writeJsonAtomic(rp.runnerLock, { pid: id.pid, start_time: '2000-01-01T00:00:00.0000000Z' });
    assert.equal((await runnerAlive(tmp, RUN_ID)).alive, false);
    fs.writeFileSync(rp.runnerLock, '{"pid":');
    assert.equal((await runnerAlive(tmp, RUN_ID)).alive, false);
  });
});
