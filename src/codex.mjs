// Codex executable discovery, argv builders and the curated worker environment.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { EFFORTS, MODEL_RE, SANDBOXES } from './spec.mjs';

export const WINDOWS_SANDBOXES = Object.freeze(['elevated', 'unelevated']);
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function defaultCodexExe(env = process.env) {
  return path.join(env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe');
}

export function resolveCodexExe(configured, env = process.env) {
  const exe = configured ?? defaultCodexExe(env);
  if (typeof exe !== 'string' || !path.isAbsolute(exe)) {
    throw new Error(`Codex executable path must be absolute: ${exe}`);
  }
  let stat = null;
  try {
    stat = fs.statSync(exe);
  } catch { /* reported below */ }
  if (!stat?.isFile()) {
    throw new Error(`Codex executable not found: ${exe} (set codex_exe in config.json)`);
  }
  return path.resolve(exe);
}

const VERSION_ENV_NAMES = ['SystemRoot', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP', 'PATHEXT', 'ComSpec'];

export function codexVersion({ exe, prefixArgs = [] }) {
  const env = {};
  for (const name of VERSION_ENV_NAMES) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  const out = execFileSync(exe, [...prefixArgs, '--version'], {
    encoding: 'utf8', timeout: 20_000, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return out.split(/\r?\n/)[0].trim();
}

// ---- argv builders -------------------------------------------------------------------------

export function assertSafeArgs(args) {
  for (const arg of args) {
    const s = String(arg);
    if (/^--dangerously/.test(s) || s === '--approve-for-me' || s === '--worktree' || s.includes('danger-full-access')) {
      throw new Error(`Forbidden Codex argument: ${s}`);
    }
    if (s.includes('approval_policy=') && s !== 'approval_policy="never"') {
      throw new Error(`Forbidden Codex argument: ${s}`);
    }
  }
}

function checkEnums({ model, effort, sandbox, windowsSandbox }) {
  if (typeof model !== 'string' || !MODEL_RE.test(model)) throw new Error(`Invalid model: ${model}`);
  if (!EFFORTS.includes(effort)) throw new Error(`Invalid effort: ${effort}`);
  if (!SANDBOXES.includes(sandbox)) throw new Error(`Invalid sandbox: ${sandbox}`);
  if (!WINDOWS_SANDBOXES.includes(windowsSandbox)) throw new Error(`Invalid windows sandbox: ${windowsSandbox}`);
}

function checkPath(name, value) {
  if (typeof value !== 'string' || !value || value.startsWith('-')) throw new Error(`Invalid ${name}: ${value}`);
}

// Flags shared by fresh and resume invocations; the sandbox/cwd flags differ and sit between the two parts.
function commonConfigArgs({ model, effort }) {
  return [
    '-m', model,
    '-c', `model_reasoning_effort="${effort}"`,
  ];
}

function tailConfigArgs({ windowsSandbox, projectDocs }) {
  return [
    '-c', 'approval_policy="never"',
    '-c', 'shell_environment_policy.inherit="core"',
    '-c', `windows.sandbox="${windowsSandbox}"`,
    ...(projectDocs ? [] : ['-c', 'project_doc_max_bytes=0']),
  ];
}

export function buildExecArgs({
  model, effort, sandbox, worktree, lastMessageFile, outputSchemaFile = null,
  windowsSandbox = 'elevated', projectDocs = false,
}) {
  checkEnums({ model, effort, sandbox, windowsSandbox });
  checkPath('worktree', worktree);
  checkPath('lastMessageFile', lastMessageFile);
  if (outputSchemaFile) checkPath('outputSchemaFile', outputSchemaFile);
  const args = [
    'exec', '--ignore-user-config', '--strict-config', '--ignore-rules', '--skip-git-repo-check',
    ...commonConfigArgs({ model, effort }),
    '-s', sandbox,
    ...tailConfigArgs({ windowsSandbox, projectDocs }),
    '-C', worktree,
    '--json', '-o', lastMessageFile,
    ...(outputSchemaFile ? ['--output-schema', outputSchemaFile] : []),
    '-',
  ];
  assertSafeArgs(args);
  return args;
}

// `codex exec resume` has neither -s nor -C: the sandbox goes through -c, the cwd is the process cwd.
export function buildResumeArgs({
  model, effort, sandbox, sessionId, lastMessageFile, outputSchemaFile = null,
  windowsSandbox = 'elevated', projectDocs = false,
}) {
  checkEnums({ model, effort, sandbox, windowsSandbox });
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) throw new Error(`Invalid session id: ${sessionId}`);
  checkPath('lastMessageFile', lastMessageFile);
  if (outputSchemaFile) checkPath('outputSchemaFile', outputSchemaFile);
  const args = [
    'exec', 'resume', '--ignore-user-config', '--strict-config', '--ignore-rules', '--skip-git-repo-check',
    ...commonConfigArgs({ model, effort }),
    '-c', `sandbox_mode="${sandbox}"`,
    ...tailConfigArgs({ windowsSandbox, projectDocs }),
    '--json', '-o', lastMessageFile,
    ...(outputSchemaFile ? ['--output-schema', outputSchemaFile] : []),
    sessionId, '-',
  ];
  assertSafeArgs(args);
  return args;
}

// ---- worker environment --------------------------------------------------------------------

const ENV_ALLOWLIST = new Set([
  'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT', 'OS', 'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER', 'NUMBER_OF_PROCESSORS', 'USERPROFILE', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME',
  'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ALLUSERSPROFILE', 'ProgramFiles',
  'ProgramFiles(x86)', 'ProgramW6432', 'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432',
  'PUBLIC', 'TEMP', 'TMP',
].map((n) => n.toLowerCase()));

const AGENT_CLI_NAMES = new Set([
  'codex.exe', 'codex.cmd', 'codex.ps1', 'codex', 'claude.exe', 'claude.cmd', 'claude.ps1', 'claude',
]);

// True when dir holds a codex/claude executable or shim. An unreadable dir counts as unsafe.
export function dirHasAgentCli(dir) {
  try {
    return fs.readdirSync(dir).some((name) => AGENT_CLI_NAMES.has(name.toLowerCase()));
  } catch {
    return true;
  }
}

export function assertCleanEnv(env) {
  for (const key of Object.keys(env)) {
    if (/^(OPENAI_|ANTHROPIC_|CLAUDE|npm_)/i.test(key)
      || (/^CODEX_/i.test(key) && key !== 'CODEX_HOME')
      || /^(HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/i.test(key)) {
      throw new Error(`Forbidden variable in worker environment: ${key}`);
    }
  }
}

const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

export function buildWorkerEnv(sourceEnv, { nodeDir, gitDirs = [], extraPath = [], codexHome = null, systemRoot } = {}) {
  const env = {};
  const kept = [];
  const dropped = [];
  let sourceSystemRoot = null;
  for (const [name, value] of Object.entries(sourceEnv)) {
    if (ENV_ALLOWLIST.has(name.toLowerCase()) && typeof value === 'string') {
      env[name] = value;
      kept.push(name);
      if (name.toLowerCase() === 'systemroot') sourceSystemRoot = value;
    } else {
      dropped.push(name);
    }
  }
  if (codexHome) env.CODEX_HOME = codexHome;

  const root = systemRoot ?? sourceSystemRoot ?? 'C:\\Windows';
  const candidates = [
    path.win32.join(root, 'System32'),
    root,
    path.win32.join(root, 'System32', 'Wbem'),
    path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0'),
    nodeDir,
    ...gitDirs,
    ...extraPath,
  ].filter(Boolean);

  const seen = new Set();
  const pathEntries = [];
  const droppedPathEntries = [];
  for (const dir of candidates) {
    const key = dir.replace(/[\\/]+$/, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (!isDir(dir)) continue;
    if (dirHasAgentCli(dir)) droppedPathEntries.push(dir);
    else pathEntries.push(dir);
  }
  env.Path = pathEntries.join(';');

  assertCleanEnv(env);
  return {
    env,
    path_entries: pathEntries,
    kept_names: kept.sort(),
    dropped_names: dropped.sort(),
    dropped_path_entries: droppedPathEntries,
  };
}
