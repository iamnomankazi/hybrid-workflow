import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  describeGlobalInstructions, globalInstructionProbes, readGlobalInstructions,
} from '../../src/instructions.mjs';
import { readObservedIsolation } from '../../src/rollout.mjs';

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hwi-'));
}

test('no global instructions: nothing selected, stable fingerprint', () => {
  const home = tempHome();
  try {
    const a = readGlobalInstructions(home);
    assert.equal(a.selected, null);
    assert.equal(a.present, false);
    assert.deepEqual(a.files.map((f) => f.present), [false, false]);
    assert.equal(readGlobalInstructions(home).fingerprint, a.fingerprint);
    assert.equal(describeGlobalInstructions(a), 'none');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('AGENTS.md is selected and fingerprinted; any edit, override or removal changes the fingerprint', () => {
  const home = tempHome();
  try {
    fs.writeFileSync(path.join(home, 'AGENTS.md'), 'one\n');
    const one = readGlobalInstructions(home);
    assert.equal(one.selected, 'AGENTS.md');
    assert.equal(one.present, true);
    assert.equal(one.files[1].bytes, 4);
    assert.match(one.files[1].sha256, /^[0-9a-f]{64}$/);
    assert.match(describeGlobalInstructions(one), /^AGENTS\.md \(4 bytes, sha256 [0-9a-f]{12}\) in /);

    fs.writeFileSync(path.join(home, 'AGENTS.md'), 'two\n');
    const two = readGlobalInstructions(home);
    assert.notEqual(two.fingerprint, one.fingerprint);

    fs.writeFileSync(path.join(home, 'AGENTS.override.md'), 'override\n');
    const over = readGlobalInstructions(home);
    assert.equal(over.selected, 'AGENTS.override.md', 'Codex prefers the override file');
    assert.notEqual(over.fingerprint, two.fingerprint);

    fs.writeFileSync(path.join(home, 'AGENTS.override.md'), '');
    const empty = readGlobalInstructions(home);
    assert.equal(empty.selected, 'AGENTS.override.md');
    assert.equal(empty.present, false, 'an empty selected file injects nothing');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('probes come only from the pinned version and skip markup lines', () => {
  const home = tempHome();
  try {
    fs.writeFileSync(path.join(home, 'AGENTS.md'), [
      '<!-- managed block start -->',
      '# Heading that must not be used as a probe',
      'Resolve the home directory before running anything described below.',
      'short',
      '- bullet lines are fine too when they are long enough to be distinctive',
    ].join('\n'));
    const pinned = readGlobalInstructions(home);
    const probes = globalInstructionProbes(home, pinned.fingerprint);
    assert.deepEqual(probes, [
      'Resolve the home directory before running anything described',
      '- bullet lines are fine too when they are long enough to be ',
    ]);
    fs.appendFileSync(path.join(home, 'AGENTS.md'), '\nchanged');
    assert.equal(globalInstructionProbes(home, pinned.fingerprint), null, 'a changed file is never attributed');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('readObservedIsolation detects the skills catalog and JSON-escaped global instruction text', () => {
  const home = tempHome();
  try {
    const rollout = path.join(home, 'rollout.jsonl');
    const probe = 'Use "<Codex home>/x" before anything else';
    fs.writeFileSync(rollout, [
      JSON.stringify({ type: 'session_meta', payload: { id: 'x' } }),
      JSON.stringify({ type: 'response_item', payload: { role: 'developer', content: [{ text: '<skills_instructions>\n## Skills\n</skills_instructions>' }] } }),
      JSON.stringify({ type: 'response_item', payload: { role: 'user', content: [{ text: `intro\n${probe}\n` }] } }),
    ].join('\n') + '\n');
    assert.deepEqual(readObservedIsolation(rollout, { globalProbes: [probe] }),
      { skills_catalog_present: true, global_instructions_present: true });
    assert.deepEqual(readObservedIsolation(rollout, { globalProbes: ['text that is not in the rollout at all'] }),
      { skills_catalog_present: true, global_instructions_present: false });
    assert.deepEqual(readObservedIsolation(rollout, { globalProbes: [] }),
      { skills_catalog_present: true, global_instructions_present: false });
    assert.deepEqual(readObservedIsolation(rollout),
      { skills_catalog_present: true, global_instructions_present: null }, 'unknown when no probes are available');
    assert.equal(readObservedIsolation(path.join(home, 'missing.jsonl')), null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
