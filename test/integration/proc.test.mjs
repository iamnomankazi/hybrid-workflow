import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import {
  queryProcesses, getIdentity, isAlive, areAlive, killTree, findProcessesReferencing,
  sweepOrphans, getBootTime, ownIdentity,
} from '../../src/proc.mjs';

const children = [];

function marker() {
  return `hybrid-test-marker-${crypto.randomBytes(8).toString('hex')}`;
}

function spawnDummy(mark) {
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)', mark], {
    windowsHide: true,
    stdio: 'ignore',
  });
  children.push(child);
  return child;
}

async function waitFor(fn, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

after(() => {
  for (const child of children) {
    try { child.kill(); } catch { /* already gone */ }
  }
});

test('own identity is alive and has a sane shape', async () => {
  const id = await ownIdentity();
  assert.equal(id.pid, process.pid);
  assert.match(id.start_time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/);
  assert.equal(await isAlive(id), true);
  assert.deepEqual(await getIdentity(process.pid), id);
});

test('queryProcesses returns records and tolerates empty input', async () => {
  assert.equal((await queryProcesses([])).size, 0);
  const map = await queryProcesses([process.pid, process.pid]);
  const rec = map.get(process.pid);
  assert.equal(rec.pid, process.pid);
  assert.equal(rec.ppid, process.ppid);
  assert.match(rec.name, /^node(\.exe)?$/i);
  assert.ok(rec.command_line.length > 0);
  await assert.rejects(queryProcesses([0]), /Invalid pid/);
});

test('wrong start_time is not alive', async () => {
  const id = await ownIdentity();
  assert.equal(await isAlive({ pid: id.pid, start_time: '2000-01-01T00:00:00.0000000Z' }), false);
});

test('invalid or nonexistent identities are not alive', async () => {
  assert.equal(await isAlive(null), false);
  assert.equal(await isAlive({ pid: -1, start_time: 'x' }), false);
  assert.equal(await isAlive({ pid: process.pid }), false);
  assert.equal(await isAlive({ pid: 4_000_000, start_time: '2000-01-01T00:00:00.0000000Z' }), false);
  assert.equal(await getIdentity(4_000_000), null);
});

test('areAlive batches mixed identities in order', async () => {
  const own = await ownIdentity();
  const result = await areAlive([
    own,
    null,
    { pid: own.pid, start_time: 'bogus' },
    { pid: 4_000_000, start_time: own.start_time },
    own,
  ]);
  assert.deepEqual(result, [true, false, false, false, true]);
  assert.deepEqual(await areAlive([]), []);
});

test('find, killTree and confirm dead', async () => {
  const mark = marker();
  const child = spawnDummy(mark);
  const found = await waitFor(async () => {
    const hits = await findProcessesReferencing(mark);
    return hits.length ? hits : null;
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].pid, child.pid);
  assert.ok(found[0].command_line.includes(mark));
  const identity = { pid: found[0].pid, start_time: found[0].start_time };
  assert.equal(await isAlive(identity), true);

  const result = await killTree(identity);
  assert.equal(result.attempted, true);
  assert.equal(result.killed, true);
  assert.equal(await isAlive(identity), false);

  const again = await killTree(identity);
  assert.equal(again.attempted, false);
  assert.equal(again.already_gone, true);
});

test('killTree refuses a mismatched identity and kills nothing', async () => {
  const child = spawnDummy(marker());
  const id = await waitFor(() => getIdentity(child.pid));
  const result = await killTree({ pid: id.pid, start_time: '2000-01-01T00:00:00.0000000Z' });
  assert.equal(result.identity_mismatch, true);
  assert.equal(result.attempted, false);
  assert.equal(await isAlive(id), true);
  assert.equal((await killTree(id)).killed, true);
});

test('findProcessesReferencing honours excludePids and rejects short needles', async () => {
  const mark = marker();
  const child = spawnDummy(mark);
  const id = await waitFor(() => getIdentity(child.pid));
  assert.equal((await findProcessesReferencing(mark.toUpperCase())).length, 1);
  assert.equal((await findProcessesReferencing(mark, { excludePids: [child.pid] })).length, 0);
  await assert.rejects(findProcessesReferencing('short'), /at least 8/);
  await assert.rejects(sweepOrphans(''), /at least 8/);
  await killTree(id);
});

test('sweepOrphans kills a marked dummy and leaves others alone', async () => {
  const mark = marker();
  const target = spawnDummy(mark);
  const bystander = spawnDummy(marker());
  const targetId = await waitFor(() => getIdentity(target.pid));
  const bystanderId = await waitFor(() => getIdentity(bystander.pid));
  const out = await sweepOrphans(mark);
  assert.equal(out.found.length, 1);
  assert.deepEqual(out.killed, [targetId]);
  assert.deepEqual(out.failed, []);
  assert.equal(await isAlive(targetId), false);
  assert.equal(await isAlive(bystanderId), true);
  await killTree(bystanderId);
});

test('getBootTime returns a UTC ISO timestamp in the past', async () => {
  const boot = await getBootTime();
  assert.match(boot, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/);
  assert.ok(Date.parse(boot) < Date.now());
});
