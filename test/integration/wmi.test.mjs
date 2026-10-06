import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { launchDetachedViaWmi } from '../../src/wmi.mjs';
import { queryProcesses, isAlive, killTree } from '../../src/proc.mjs';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hybrid wmi test '));
let launched = null;

after(async () => {
  if (launched) await killTree(launched).catch(() => {});
  fs.rmSync(scratch, { recursive: true, force: true });
});

async function waitForFile(file, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch { /* not written yet, or mid-write */ }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

test('launchDetachedViaWmi validates inputs before launching', async () => {
  await assert.rejects(launchDetachedViaWmi({ exe: 'node.exe', cwd: scratch }), /absolute/);
  await assert.rejects(launchDetachedViaWmi({ exe: path.join(scratch, 'nope.exe'), cwd: scratch }), /does not exist/);
  await assert.rejects(launchDetachedViaWmi({ exe: process.execPath, cwd: path.join(scratch, 'nodir') }), /does not exist/);
  await assert.rejects(
    launchDetachedViaWmi({ exe: process.execPath, args: ['x'.repeat(33_000)], cwd: scratch }),
    /too long/,
  );
});

test('WMI launch: quoting, WmiPrvSE parent, identity, kill', async () => {
  const outFile = path.join(scratch, 'out file.json'); // space in path
  // space, embedded quotes and a trailing backslash all need quoting
  const marker = `hybrid wmi "marker" ${crypto.randomBytes(6).toString('hex')}\\`;
  const script = [
    'const fs = require("fs");',
    'fs.writeFileSync(process.argv[1], JSON.stringify({ pid: process.pid, ppid: process.ppid, argv: process.argv.slice(1) }));',
    'setTimeout(() => {}, 60000);',
  ].join('\n');
  const args = ['-e', script, outFile, marker];

  const result = await launchDetachedViaWmi({ exe: process.execPath, args, cwd: scratch });
  assert.equal(result.return_value, 0);
  assert.ok(Number.isSafeInteger(result.pid) && result.pid > 0);
  assert.match(result.start_time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/);
  assert.ok(Number.isFinite(Date.parse(result.launched_at)));
  launched = { pid: result.pid, start_time: result.start_time };

  const written = await waitForFile(outFile);
  assert.equal(written.pid, result.pid);
  assert.deepEqual(written.argv, [outFile, marker]);

  const map = await queryProcesses([result.pid, written.ppid]);
  assert.equal(map.get(result.pid).start_time, result.start_time);
  assert.equal(map.get(written.ppid)?.name.toLowerCase(), 'wmiprvse.exe');

  assert.equal(await isAlive(launched), true);
  const killed = await killTree(launched);
  assert.equal(killed.killed, true);
  assert.equal(await isAlive(launched), false);
});
