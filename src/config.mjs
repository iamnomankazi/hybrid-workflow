// Machine config (config.json under HYBRID_HOME) and the per-run pinned copy of it.
import fs from 'node:fs';
import path from 'node:path';
import { SCHEMAS, V1_MAX_CONCURRENCY } from './constants.mjs';
import { ensureDir, readJson, writeJsonAtomic } from './fsutil.mjs';
import { defaultWorktreeRoot, homePaths } from './paths.mjs';
import { WINDOWS_SANDBOXES, resolveCodexExe } from './codex.mjs';
import { NAME_RE, resolvePresets } from './spec.mjs';

export const DEFAULTS = Object.freeze({
  codex_exe: null,
  codex_prefix_args: Object.freeze([]),
  codex_home: null,
  worktree_root: null,
  max_concurrency: 4,
  default_timeout_minutes: 120,
  max_timeout_minutes: 360,
  stall_minutes: 15,
  runner_idle_exit_minutes: 10,
  poll_ms: 1500,
  liveness_check_ms: 15000,
  heartbeat_ms: 10000,
  windows_sandbox: 'elevated',
  project_docs: false,
  output_schema: true,
  extra_path: Object.freeze([]),
  presets: Object.freeze({}),
  repos: Object.freeze({}),
});

const POSITIVE_INTS = [
  'max_concurrency', 'default_timeout_minutes', 'max_timeout_minutes', 'stall_minutes',
  'runner_idle_exit_minutes', 'poll_ms', 'liveness_check_ms', 'heartbeat_ms',
];
const NODE_MODULES_MODES = ['junction', 'none'];

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isAbsPath = (v) => typeof v === 'string' && path.isAbsolute(v);
const clone = (v) => JSON.parse(JSON.stringify(v));

function validateRepo(alias, repo) {
  if (!NAME_RE.test(alias)) throw new Error(`repos: alias "${alias}" must match ${NAME_RE}`);
  if (!isPlainObject(repo) || !isAbsPath(repo.path)) throw new Error(`repos.${alias}.path must be an absolute path`);
  const prepare = repo.prepare ?? { node_modules: 'none' };
  if (!isPlainObject(prepare) || !NODE_MODULES_MODES.includes(prepare.node_modules)) {
    throw new Error(`repos.${alias}.prepare.node_modules must be one of ${NODE_MODULES_MODES.join(', ')}`);
  }
  for (const key of Object.keys(repo)) {
    if (key !== 'path' && key !== 'prepare') throw new Error(`repos.${alias} has unknown key "${key}"`);
  }
  return { path: repo.path, prepare: { node_modules: prepare.node_modules } };
}

// Validates a parsed config and returns it merged over DEFAULTS. Throws on any problem.
function mergeConfig(raw) {
  if (!isPlainObject(raw)) throw new Error('config must be a JSON object');
  const cfg = clone(DEFAULTS);
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'schema') {
      if (value !== SCHEMAS.machineConfig) throw new Error(`schema must be "${SCHEMAS.machineConfig}"`);
    } else if (!Object.hasOwn(DEFAULTS, key)) {
      throw new Error(`unknown config key "${key}"`);
    } else {
      cfg[key] = value;
    }
  }
  for (const key of POSITIVE_INTS) {
    if (!Number.isInteger(cfg[key]) || cfg[key] <= 0) throw new Error(`${key} must be a positive integer`);
  }
  if (cfg.codex_exe !== null && !isAbsPath(cfg.codex_exe)) throw new Error('codex_exe must be null or an absolute path');
  if (!Array.isArray(cfg.codex_prefix_args) || !cfg.codex_prefix_args.every((a) => typeof a === 'string')) {
    throw new Error('codex_prefix_args must be an array of strings');
  }
  if (cfg.codex_home !== null && !isAbsPath(cfg.codex_home)) throw new Error('codex_home must be null or an absolute path');
  if (cfg.worktree_root !== null && !isAbsPath(cfg.worktree_root)) throw new Error('worktree_root must be null or an absolute path');
  if (!WINDOWS_SANDBOXES.includes(cfg.windows_sandbox)) {
    throw new Error(`windows_sandbox must be one of ${WINDOWS_SANDBOXES.join(', ')}`);
  }
  for (const key of ['project_docs', 'output_schema']) {
    if (typeof cfg[key] !== 'boolean') throw new Error(`${key} must be a boolean`);
  }
  if (!Array.isArray(cfg.extra_path) || !cfg.extra_path.every(isAbsPath)) {
    throw new Error('extra_path must be an array of absolute paths');
  }
  resolvePresets(cfg.presets); // throws on an invalid preset
  if (!isPlainObject(cfg.repos)) throw new Error('repos must be an object');
  cfg.repos = Object.fromEntries(Object.entries(cfg.repos).map(([alias, repo]) => [alias, validateRepo(alias, repo)]));
  return cfg;
}

export function loadMachineConfig(home) {
  const file = homePaths(home).config;
  const raw = readJson(file, { optional: true });
  if (raw === null) return clone(DEFAULTS);
  try {
    return mergeConfig(raw);
  } catch (err) {
    throw new Error(`Invalid machine config ${file}: ${err.message}`);
  }
}

export function saveMachineConfig(home, config) {
  const cfg = mergeConfig(config);
  const out = { schema: SCHEMAS.machineConfig };
  for (const key of Object.keys(DEFAULTS)) {
    if (JSON.stringify(cfg[key]) !== JSON.stringify(DEFAULTS[key])) out[key] = cfg[key];
  }
  ensureDir(home);
  writeJsonAtomic(homePaths(home).config, out);
}

export function addRepoAlias(home, alias, repoPath, { nodeModules = 'none' } = {}) {
  const config = loadMachineConfig(home);
  const resolved = path.resolve(repoPath);
  let stat = null;
  try {
    stat = fs.statSync(resolved);
  } catch { /* reported below */ }
  if (!stat?.isDirectory()) throw new Error(`Repo path is not an existing directory: ${resolved}`);
  config.repos[alias] = validateRepo(alias, { path: resolved, prepare: { node_modules: nodeModules } });
  saveMachineConfig(home, config);
  return config;
}

// The config pinned into run.json: everything the runner needs, with every path absolute and
// the full preset map, so a run behaves the same even if config.json changes afterwards.
export function buildRunConfig(machine, { concurrency } = {}, {
  resolveCodexExe: resolveExe = resolveCodexExe,
  defaultWorktreeRoot: defaultRoot = defaultWorktreeRoot,
} = {}) {
  const requested = concurrency ?? machine.max_concurrency;
  if (!Number.isInteger(requested)) throw new Error('concurrency must be an integer');
  return {
    codex_exe: resolveExe(machine.codex_exe),
    codex_prefix_args: [...machine.codex_prefix_args],
    codex_home: machine.codex_home ? path.resolve(machine.codex_home) : null,
    worktree_root: path.resolve(machine.worktree_root ?? defaultRoot()),
    max_concurrency: Math.max(1, Math.min(requested, V1_MAX_CONCURRENCY)),
    default_timeout_minutes: machine.default_timeout_minutes,
    max_timeout_minutes: machine.max_timeout_minutes,
    stall_minutes: machine.stall_minutes,
    runner_idle_exit_minutes: machine.runner_idle_exit_minutes,
    poll_ms: machine.poll_ms,
    liveness_check_ms: machine.liveness_check_ms,
    heartbeat_ms: machine.heartbeat_ms,
    windows_sandbox: machine.windows_sandbox,
    project_docs: machine.project_docs,
    output_schema: machine.output_schema,
    extra_path: [...machine.extra_path],
    presets: resolvePresets(machine.presets),
  };
}
