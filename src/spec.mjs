// Presets, job-spec validation and worker prompt composition. Specs carry no free-form model,
// path or flag fields: model/effort/sandbox come only from a named preset.
import { JOB_ID_RE, SCHEMAS, SHA1_RE } from './constants.mjs';
import { normalizeScopeEntries } from './repopath.mjs';

export const EFFORTS = Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh']);
// danger-full-access is never valid.
export const SANDBOXES = Object.freeze(['read-only', 'workspace-write']);

export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const MODEL_RE = /^[A-Za-z0-9._-]{1,64}$/;

export const MAX_CAPSULE_BYTES = 262144;
export const MAX_NOTE_BYTES = 4096;

const freezePreset = (p) => Object.freeze({ ...p });

export const BUILTIN_PRESETS = Object.freeze({
  'sol-high-review': freezePreset({ model: 'gpt-6.1-sol', effort: 'high', sandbox: 'read-only' }),
  'sol-high-impl': freezePreset({ model: 'gpt-6.1-sol', effort: 'high', sandbox: 'workspace-write' }),
  'sol-xhigh-impl': freezePreset({ model: 'gpt-6.1-sol', effort: 'xhigh', sandbox: 'workspace-write' }),
  'luna-xhigh-impl': freezePreset({ model: 'gpt-6-luna', effort: 'xhigh', sandbox: 'workspace-write' }),
  'luna-xhigh-review': freezePreset({ model: 'gpt-6-luna', effort: 'xhigh', sandbox: 'read-only' }),
  'sol-low-smoke': freezePreset({ model: 'gpt-6.1-sol', effort: 'low', sandbox: 'workspace-write' }),
});

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function presetProblems(name, preset) {
  const problems = [];
  if (!NAME_RE.test(name)) problems.push(`preset name "${name}" must match ${NAME_RE}`);
  if (!isPlainObject(preset)) {
    problems.push(`preset "${name}" must be an object`);
    return problems;
  }
  for (const key of Object.keys(preset)) {
    if (!['model', 'effort', 'sandbox'].includes(key)) problems.push(`preset "${name}" has unknown key "${key}"`);
  }
  if (typeof preset.model !== 'string' || !MODEL_RE.test(preset.model)) {
    problems.push(`preset "${name}" model must match ${MODEL_RE}`);
  }
  if (!EFFORTS.includes(preset.effort)) problems.push(`preset "${name}" effort must be one of ${EFFORTS.join(', ')}`);
  if (!SANDBOXES.includes(preset.sandbox)) problems.push(`preset "${name}" sandbox must be one of ${SANDBOXES.join(', ')}`);
  return problems;
}

// Builtins plus machine presets (which may override builtins). Throws on any invalid preset.
export function resolvePresets(extra = {}) {
  if (!isPlainObject(extra)) throw new Error('presets must be an object');
  const merged = {};
  for (const [name, p] of Object.entries({ ...BUILTIN_PRESETS, ...extra })) {
    const problems = presetProblems(name, p);
    if (problems.length) throw new Error(`Invalid preset: ${problems.join('; ')}`);
    merged[name] = { model: p.model, effort: p.effort, sandbox: p.sandbox };
  }
  return merged;
}

const SPEC_KEYS = new Set([
  'schema', 'job_id', 'title', 'preset', 'capsule', 'capsule_file', 'write_scope', 'allow_protected',
  'allow_symlinks', 'timeout_minutes', 'stall_minutes', 'base_commit',
]);

const hasGitSegment = (entry) => entry.split('/').some((s) => s.toLowerCase() === '.git');

function scopeList(raw, key, errors) {
  if (raw === undefined) return [];
  try {
    return normalizeScopeEntries(raw);
  } catch (err) {
    errors.push(`${key}: ${err.message}`);
    return null;
  }
}

export function validateSpec(raw, {
  presets = resolvePresets(),
  defaultTimeoutMinutes = 120,
  maxTimeoutMinutes = 360,
  defaultStallMinutes = 15,
  capsuleText,
} = {}) {
  const errors = [];
  if (!isPlainObject(raw)) return { ok: false, errors: ['spec must be a JSON object'], spec: null };

  for (const key of Object.keys(raw)) {
    if (!SPEC_KEYS.has(key)) errors.push(`unknown field "${key}"`);
  }
  if (raw.schema !== undefined && raw.schema !== SCHEMAS.jobSpec) errors.push(`schema must be "${SCHEMAS.jobSpec}"`);

  let jobId = null;
  if (raw.job_id !== undefined) {
    if (typeof raw.job_id === 'string' && JOB_ID_RE.test(raw.job_id)) jobId = raw.job_id;
    else errors.push(`job_id must match ${JOB_ID_RE}`);
  }

  let title = '';
  if (raw.title !== undefined) {
    if (typeof raw.title === 'string' && raw.title.length <= 200) title = raw.title;
    else errors.push('title must be a string of at most 200 characters');
  }

  let presetConfig = null;
  if (typeof raw.preset !== 'string' || !raw.preset) {
    errors.push('preset is required');
  } else if (!Object.hasOwn(presets, raw.preset)) {
    errors.push(`unknown preset "${raw.preset}" (known: ${Object.keys(presets).join(', ')})`);
  } else {
    const p = presets[raw.preset];
    presetConfig = { model: p.model, effort: p.effort, sandbox: p.sandbox };
  }

  const hasCapsule = raw.capsule !== undefined;
  const hasCapsuleFile = raw.capsule_file !== undefined;
  if (hasCapsule === hasCapsuleFile) {
    errors.push('exactly one of capsule or capsule_file is required');
  } else if (typeof (hasCapsule ? raw.capsule : raw.capsule_file) !== 'string') {
    errors.push(`${hasCapsule ? 'capsule' : 'capsule_file'} must be a string`);
  }
  if (typeof capsuleText !== 'string' || !capsuleText.trim()) {
    errors.push('capsule text is empty');
  } else if (Buffer.byteLength(capsuleText, 'utf8') > MAX_CAPSULE_BYTES) {
    errors.push(`capsule exceeds ${MAX_CAPSULE_BYTES} bytes`);
  }

  let writeScope = scopeList(raw.write_scope, 'write_scope', errors);
  if (writeScope && presetConfig) {
    if (presetConfig.sandbox === 'workspace-write' && writeScope.length === 0) {
      errors.push('write_scope is required and must be non-empty for workspace-write presets');
    }
    if (presetConfig.sandbox === 'read-only' && writeScope.length > 0) {
      errors.push('write_scope must be absent or empty for read-only presets');
    }
  }
  writeScope ??= [];

  let allowProtected = scopeList(raw.allow_protected, 'allow_protected', errors);
  if (allowProtected) {
    if (allowProtected.includes('**')) errors.push('allow_protected must not contain "**"');
    for (const e of allowProtected) {
      if (hasGitSegment(e)) errors.push(`allow_protected entry "${e}" has a .git segment, which is never allowable`);
    }
  }
  allowProtected ??= [];

  let allowSymlinks = false;
  if (raw.allow_symlinks !== undefined) {
    if (typeof raw.allow_symlinks === 'boolean') allowSymlinks = raw.allow_symlinks;
    else errors.push('allow_symlinks must be a boolean');
  }

  let timeoutMinutes = defaultTimeoutMinutes;
  if (raw.timeout_minutes !== undefined) {
    if (Number.isInteger(raw.timeout_minutes) && raw.timeout_minutes >= 1 && raw.timeout_minutes <= maxTimeoutMinutes) {
      timeoutMinutes = raw.timeout_minutes;
    } else {
      errors.push(`timeout_minutes must be an integer between 1 and ${maxTimeoutMinutes}`);
      timeoutMinutes = null;
    }
  }

  // The configured default stall window must not exceed a short job's own timeout.
  let stallMinutes = timeoutMinutes === null ? defaultStallMinutes : Math.min(defaultStallMinutes, timeoutMinutes);
  if (raw.stall_minutes !== undefined) {
    const upper = timeoutMinutes ?? maxTimeoutMinutes;
    if (Number.isInteger(raw.stall_minutes) && raw.stall_minutes >= 1 && raw.stall_minutes <= upper) {
      stallMinutes = raw.stall_minutes;
    } else {
      errors.push(`stall_minutes must be an integer between 1 and timeout_minutes (${upper})`);
    }
  }

  let baseCommit = null;
  if (raw.base_commit !== undefined) {
    if (typeof raw.base_commit === 'string' && SHA1_RE.test(raw.base_commit)) baseCommit = raw.base_commit;
    else errors.push('base_commit must be a 40-character lowercase hex SHA-1');
  }

  if (errors.length) return { ok: false, errors, spec: null };
  return {
    ok: true,
    errors: [],
    spec: {
      schema: SCHEMAS.jobSpec,
      job_id: jobId,
      title,
      preset: raw.preset,
      preset_config: presetConfig,
      write_scope: writeScope,
      allow_protected: allowProtected,
      allow_symlinks: allowSymlinks,
      timeout_minutes: timeoutMinutes,
      stall_minutes: stallMinutes,
      base_commit: baseCommit,
    },
  };
}

// Shared by fresh and resume prompts so the rules can never drift apart.
function rulesBlock(spec, jobId) {
  const lines = [
    '## Rules',
    '',
    '- Work only inside the current directory: it is a dedicated git worktree at the base commit.',
    '- Never run git commit, push, merge, rebase, stash, reset, or checkout of other refs. Leave all changes uncommitted.',
  ];
  if (spec.preset_config.sandbox === 'read-only') {
    lines.push('- This is a read-only job: modify nothing.');
  } else {
    lines.push('- Only modify files within this write scope:');
    for (const entry of spec.write_scope) lines.push(`  - ${entry === '**' ? '** (the entire repository)' : entry}`);
  }
  lines.push(
    '- Never modify .git, git hooks, .github/workflows, .claude, .codex, .agents, AGENTS.md, CLAUDE.md or CODEX.md,'
    + ' unless the path is explicitly listed here as allowed:',
  );
  if (spec.allow_protected.length) {
    for (const entry of spec.allow_protected) lines.push(`  - ${entry}`);
  } else {
    lines.push('  - (none)');
  }
  // Matches the worker baseline in src/codex.mjs: web search for every job; shell network
  // (sandbox_workspace_write.network_access) only applies to workspace-write jobs.
  if (spec.preset_config.sandbox === 'read-only') {
    lines.push('- Web search is available. Shell commands may have no network access in this read-only job.');
  } else {
    lines.push(
      '- You have network access: web search, and outbound HTTP(S) from shell commands (e.g. Node fetch, npm,'
      + ' git over HTTPS). Windows-native HTTPS clients (curl.exe, Invoke-WebRequest, Invoke-RestMethod) fail'
      + ' here; use Node or the other tools instead. If a shared Playwright install is configured,'
      + ' require(\'playwright\') works.',
      '- Install packages only when the task needs them, and only locally in this worktree (no global installs).',
    );
  }
  lines.push(
    '- Do not launch other AI agents or CLIs (codex, claude).',
    '- Your final reply must be ONLY a JSON object matching the provided output schema'
    + ` (job_id, status, summary, files_changed, tests, notes), with job_id set to exactly "${jobId}".`
    + ' No prose and no code fences around it.',
  );
  return lines.join('\n');
}

export function composePrompt({ runId, jobId, baseCommit, spec, capsuleText }) {
  const { model, effort, sandbox } = spec.preset_config;
  return [
    '# Hybrid Workflow worker task',
    '',
    `- job_id: ${jobId}`,
    `- run_id: ${runId}`,
    `- base commit: ${baseCommit}`,
    `- preset: ${spec.preset} (${model}, ${effort}, ${sandbox})`,
    '',
    rulesBlock(spec, jobId),
    '',
    '## Task capsule',
    '',
    capsuleText,
    '',
  ].join('\n');
}

export function composeResumePrompt({ runId, jobId, spec, reason, note }) {
  if (note && Buffer.byteLength(note, 'utf8') > MAX_NOTE_BYTES) {
    throw new Error(`resume note exceeds ${MAX_NOTE_BYTES} bytes`);
  }
  const { model, effort, sandbox } = spec.preset_config;
  const parts = [
    '# Hybrid Workflow worker task (resumed)',
    '',
    `- job_id: ${jobId}`,
    `- run_id: ${runId}`,
    `- preset: ${spec.preset} (${model}, ${effort}, ${sandbox})`,
    '',
    `The previous session for this job was interrupted (reason: ${reason}).`,
    'Before editing anything, re-inspect the current state: run git status and git diff, and check the state of the tests.',
    'Then continue the original task from where it stopped, under the same rules as before.',
    '',
    rulesBlock(spec, jobId),
    '',
  ];
  if (note) parts.push('## Owner note', '', note, '');
  return parts.join('\n');
}
