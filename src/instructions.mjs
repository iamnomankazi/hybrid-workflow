// Global (CODEX_HOME-level) Codex instructions.
//
// Codex 0.160.1 injects <CODEX_HOME>/AGENTS.override.md, else <CODEX_HOME>/AGENTS.md, into every
// session. --ignore-user-config and project_doc_max_bytes=0 do not affect it, and no config key
// or flag disables it (verified 2026-10-06). Hybrid cannot keep it out of workers without a
// separate CODEX_HOME (auth refresh-token races), so it makes it visible and stable instead:
// run start pins this fingerprint, the runner refuses to launch if it changes mid-run, and
// every launch/result records it. Only presence, size and sha256 are ever recorded.
import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from './fsutil.mjs';

export const GLOBAL_INSTRUCTION_FILES = Object.freeze(['AGENTS.override.md', 'AGENTS.md']);

export function readGlobalInstructions(codexHome) {
  const files = GLOBAL_INSTRUCTION_FILES.map((name) => {
    let data = null;
    try {
      data = fs.readFileSync(path.join(codexHome, name));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    return data === null
      ? { name, present: false, bytes: 0, sha256: null }
      : { name, present: true, bytes: data.length, sha256: sha256(data) };
  });
  // Codex prefers the override file whenever it exists.
  const selected = files.find((f) => f.present)?.name ?? null;
  return {
    codex_home: codexHome,
    selected,
    present: selected !== null && files.find((f) => f.name === selected).bytes > 0,
    files,
    fingerprint: sha256(JSON.stringify(files)),
  };
}

// Lines that identify the selected file's text inside a session rollout. Returned only when the
// file still matches `fingerprint`, so a later edit cannot be attributed to an earlier attempt.
// Kept in memory only; never written to any Hybrid file.
export function globalInstructionProbes(codexHome, fingerprint, { max = 8 } = {}) {
  const now = readGlobalInstructions(codexHome);
  if (now.fingerprint !== fingerprint || !now.present) return null;
  const text = fs.readFileSync(path.join(codexHome, now.selected), 'utf8');
  return text.split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length >= 24 && !/^(<!--|[#|>])/.test(l))
    .slice(0, max)
    .map((l) => l.slice(0, 60));
}

export function describeGlobalInstructions(gi) {
  if (!gi?.present) return 'none';
  const f = gi.files.find((x) => x.name === gi.selected);
  return `${gi.selected} (${f.bytes} bytes, sha256 ${f.sha256.slice(0, 12)}) in ${gi.codex_home}`;
}
