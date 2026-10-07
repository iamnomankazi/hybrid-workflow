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

// Workers keep Codex's normal tool surface (shell, apply_patch, web search, images, goals,
// sub-agents) plus outbound network. Only features that act with the signed-in account's
// authority are disabled, since --ignore-user-config does not remove them (verified from a
// worker's own tool table): apps → the `codex_apps` MCP server (hundreds of account connectors —
// mail, Drive, Calendar, GitHub — plus a command_exec with inherited access); plugins and
// remote_plugin → plugin MCP servers installed on the account (e.g. `codex_security`).
export const WORKER_DISABLED_FEATURES = Object.freeze(['apps', 'plugins', 'remote_plugin']);

// The Codex release whose worker tool table the list above was verified against (`codex
// --version` output). The desktop app updates codex.exe in place, so `doctor` and `run start`
// warn on any other release, and the runner refuses launches if the version changes mid-run.
export const VERIFIED_CODEX_VERSION = 'codex-cli 0.160.1';

export function unverifiedCodexWarning(version) {
  return version === VERIFIED_CODEX_VERSION ? null
    : `Codex ${version} is not ${VERIFIED_CODEX_VERSION}, the release whose worker tool isolation was verified; `
      + 're-verify the worker tool table (docs/ARCHITECTURE.md §9) before relying on it';
}

// --ignore-user-config does not stop Codex from injecting the user's skills catalog from
// CODEX_HOME; skills.include_instructions=false does (verified against 0.160.1 rollouts).
// Shell commands get outbound network (curl, package installs, browsers); writes stay confined
// to the worktree by the sandbox. The setting applies to workspace-write; read-only presets
// (reviewers) keep Codex's read-only defaults. inherit="core" strips everything else from the
// shell's environment, so variables commands need (shared browser, script policy) go through
// shell_environment_policy.set. Extra writable roots (e.g. a shared npm cache) are granted by
// Codex's own sandbox setup, not by Hybrid editing ACLs.
function tailConfigArgs({ windowsSandbox, projectDocs, shellEnv, writableRoots }) {
  return [
    '-c', 'approval_policy="never"',
    '-c', 'shell_environment_policy.inherit="core"',
    ...shellEnvArgs(shellEnv),
    '-c', `windows.sandbox="${windowsSandbox}"`,
    '-c', 'sandbox_workspace_write.network_access=true',
    ...writableRootsArgs(writableRoots),
    ...(projectDocs ? [] : ['-c', 'project_doc_max_bytes=0']),
    '-c', 'skills.include_instructions=false',
    ...WORKER_DISABLED_FEATURES.flatMap((f) => ['-c', `features.${f}=false`]),
  ];
}

// Shell variables every worker gets. PowerShell's execution policy is not a security boundary,
// and Restricted (the sandbox accounts' default) breaks local scripts and .ps1 shims such as npm.
// Git for Windows defaults to Schannel, which fails under the network sandbox account
// (SEC_E_NO_CREDENTIALS); its bundled OpenSSL backend works, so git gets http.sslBackend=openssl
// through git's own environment config (GIT_CONFIG_COUNT/KEY/VALUE), for worker shells only.
export const BASE_SHELL_ENV = Object.freeze({
  PSExecutionPolicyPreference: 'RemoteSigned',
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'http.sslBackend',
  GIT_CONFIG_VALUE_0: 'openssl',
});

// TOML literal strings ('...') need no escaping for Windows paths but cannot hold ' or newlines.
function shellEnvArgs(shellEnv = {}) {
  return Object.entries(shellEnv).flatMap(([name, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid shell variable name: ${name}`);
    if (typeof value !== 'string' || /['\r\n]/.test(value)) throw new Error(`Invalid value for shell variable ${name}`);
    return ['-c', `shell_environment_policy.set.${name}='${value}'`];
  });
}

function writableRootsArgs(roots = []) {
  if (!roots.length) return [];
  for (const root of roots) {
    if (typeof root !== 'string' || !path.isAbsolute(root) || /['\r\n]/.test(root)) throw new Error(`Invalid writable root: ${root}`);
  }
  return ['-c', `sandbox_workspace_write.writable_roots=[${roots.map((r) => `'${r}'`).join(', ')}]`];
}

export function buildExecArgs({
  model, effort, sandbox, worktree, lastMessageFile, outputSchemaFile = null,
  windowsSandbox = 'elevated', projectDocs = false, shellEnv = BASE_SHELL_ENV, writableRoots = [],
}) {
  checkEnums({ model, effort, sandbox, windowsSandbox });
  checkPath('worktree', worktree);
  checkPath('lastMessageFile', lastMessageFile);
  if (outputSchemaFile) checkPath('outputSchemaFile', outputSchemaFile);
  const args = [
    'exec', '--ignore-user-config', '--strict-config', '--ignore-rules', '--skip-git-repo-check',
    ...commonConfigArgs({ model, effort }),
    '-s', sandbox,
    ...tailConfigArgs({ windowsSandbox, projectDocs, shellEnv, writableRoots }),
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
  windowsSandbox = 'elevated', projectDocs = false, shellEnv = BASE_SHELL_ENV, writableRoots = [],
}) {
  checkEnums({ model, effort, sandbox, windowsSandbox });
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) throw new Error(`Invalid session id: ${sessionId}`);
  checkPath('lastMessageFile', lastMessageFile);
  if (outputSchemaFile) checkPath('outputSchemaFile', outputSchemaFile);
  const args = [
    'exec', 'resume', '--ignore-user-config', '--strict-config', '--ignore-rules', '--skip-git-repo-check',
    ...commonConfigArgs({ model, effort }),
    '-c', `sandbox_mode="${sandbox}"`,
    ...tailConfigArgs({ windowsSandbox, projectDocs, shellEnv, writableRoots }),
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

// A shared Playwright install (browsers\ + node_modules\playwright) that the sandbox accounts can
// read; workers cannot use the user's own %LOCALAPPDATA%\ms-playwright. Null when absent.
export function playwrightEnv(dir) {
  if (!dir || !isDir(path.join(dir, 'browsers')) || !isDir(path.join(dir, 'node_modules', 'playwright'))) return null;
  return { PLAYWRIGHT_BROWSERS_PATH: path.join(dir, 'browsers'), NODE_PATH: path.join(dir, 'node_modules') };
}

export function buildWorkerEnv(sourceEnv, {
  nodeDir, gitDirs = [], extraPath = [], codexHome = null, systemRoot, playwrightDir = null,
} = {}) {
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
  const playwright = playwrightEnv(playwrightDir);
  if (playwright) Object.assign(env, playwright);

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
    playwright_dir: playwright ? playwrightDir : null,
  };
}
