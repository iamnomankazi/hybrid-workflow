import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertCleanEnv, assertSafeArgs, buildExecArgs, buildResumeArgs, buildWorkerEnv, codexVersion,
  defaultCodexExe, dirHasAgentCli, resolveCodexExe, unverifiedCodexWarning, VERIFIED_CODEX_VERSION,
  BASE_SHELL_ENV, playwrightEnv,
} from '../../src/codex.mjs';

test('unverifiedCodexWarning is silent only for the verified Codex release', () => {
  assert.equal(unverifiedCodexWarning(VERIFIED_CODEX_VERSION), null);
  assert.match(unverifiedCodexWarning('codex-cli 0.161.0'), /codex-cli 0\.161\.0 is not codex-cli 0\.160\.1/);
  assert.match(unverifiedCodexWarning('codex-cli 0.161.0'), /re-verify the worker tool table/);
});

const SESSION = '01a10f19-685d-7993-aaf0-7b528e9b4469';
const base = { model: 'gpt-6.1-sol', effort: 'high', sandbox: 'workspace-write', lastMessageFile: 'C:\\a\\last.md' };

function withTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-codex-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('defaultCodexExe and resolveCodexExe', () => {
  assert.equal(
    defaultCodexExe({ LOCALAPPDATA: 'C:\\L' }),
    path.join('C:\\L', 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'),
  );
  withTmp((dir) => {
    const exe = path.join(dir, 'codex.exe');
    fs.writeFileSync(exe, '');
    assert.equal(resolveCodexExe(exe), exe);
    const def = defaultCodexExe({ LOCALAPPDATA: dir });
    fs.mkdirSync(path.dirname(def), { recursive: true });
    fs.writeFileSync(def, '');
    assert.equal(resolveCodexExe(null, { LOCALAPPDATA: dir }), def);
  });
});

test('resolveCodexExe throws clearly for missing, relative and directory paths', () => {
  withTmp((dir) => {
    assert.throws(() => resolveCodexExe(path.join(dir, 'nope.exe')), /not found/);
    assert.throws(() => resolveCodexExe(dir), /not found/);
    assert.throws(() => resolveCodexExe('codex.exe'), /absolute/);
    assert.throws(() => resolveCodexExe(null, { LOCALAPPDATA: dir }), /not found/);
  });
});

test('codexVersion returns the first stdout line (fake exe via node)', () => {
  const v = codexVersion({
    exe: process.execPath,
    prefixArgs: ['-e', 'console.log("codex-cli 1.2.3\\nsecond line")', '--'],
  });
  assert.equal(v, 'codex-cli 1.2.3');
});

test('buildExecArgs exact order with defaults', () => {
  const args = buildExecArgs({ ...base, worktree: 'C:\\wt\\j1' });
  assert.deepEqual(args, [
    'exec', '--ignore-user-config', '--strict-config', '--ignore-rules', '--skip-git-repo-check',
    '-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort="high"', '-s', 'workspace-write',
    '-c', 'approval_policy="never"', '-c', 'shell_environment_policy.inherit="core"',
    '-c', "shell_environment_policy.set.PSExecutionPolicyPreference='RemoteSigned'",
    '-c', "shell_environment_policy.set.GIT_CONFIG_COUNT='1'",
    '-c', "shell_environment_policy.set.GIT_CONFIG_KEY_0='http.sslBackend'",
    '-c', "shell_environment_policy.set.GIT_CONFIG_VALUE_0='openssl'",
    '-c', 'windows.sandbox="elevated"', '-c', 'sandbox_workspace_write.network_access=true',
    '-c', 'project_doc_max_bytes=0', '-c', 'skills.include_instructions=false',
    '-c', 'features.apps=false', '-c', 'features.plugins=false', '-c', 'features.remote_plugin=false',
    '-C', 'C:\\wt\\j1', '--json', '-o', 'C:\\a\\last.md', '-',
  ]);
});

test('buildExecArgs with schema, projectDocs and unelevated sandbox', () => {
  const args = buildExecArgs({
    ...base, sandbox: 'read-only', worktree: 'C:\\wt', outputSchemaFile: 'C:\\s.json', windowsSandbox: 'unelevated', projectDocs: true,
  });
  assert.ok(!args.includes('project_doc_max_bytes=0'));
  assert.ok(args.includes('skills.include_instructions=false'), 'skills catalog is suppressed even with project docs on');
  assert.ok(args.includes('features.apps=false'), 'codex_apps MCP is disabled even with project docs on');
  assert.ok(!args.some((a) => a.startsWith('web_search')), 'web search stays at the Codex default (on)');
  assert.ok(args.includes('sandbox_workspace_write.network_access=true'), 'shell commands get outbound network');
  assert.ok(args.includes('windows.sandbox="unelevated"'));
  assert.deepEqual(args.slice(-5), ['-o', 'C:\\a\\last.md', '--output-schema', 'C:\\s.json', '-']);
  assert.equal(args[args.indexOf('-s') + 1], 'read-only');
});

test('buildResumeArgs exact order, no -s and no -C', () => {
  const args = buildResumeArgs({ ...base, sessionId: SESSION, outputSchemaFile: 'C:\\s.json' });
  assert.deepEqual(args, [
    'exec', 'resume', '--ignore-user-config', '--strict-config', '--ignore-rules', '--skip-git-repo-check',
    '-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort="high"', '-c', 'sandbox_mode="workspace-write"',
    '-c', 'approval_policy="never"', '-c', 'shell_environment_policy.inherit="core"',
    '-c', "shell_environment_policy.set.PSExecutionPolicyPreference='RemoteSigned'",
    '-c', "shell_environment_policy.set.GIT_CONFIG_COUNT='1'",
    '-c', "shell_environment_policy.set.GIT_CONFIG_KEY_0='http.sslBackend'",
    '-c', "shell_environment_policy.set.GIT_CONFIG_VALUE_0='openssl'",
    '-c', 'windows.sandbox="elevated"', '-c', 'sandbox_workspace_write.network_access=true',
    '-c', 'project_doc_max_bytes=0', '-c', 'skills.include_instructions=false',
    '-c', 'features.apps=false', '-c', 'features.plugins=false', '-c', 'features.remote_plugin=false',
    '--json', '-o', 'C:\\a\\last.md', '--output-schema', 'C:\\s.json', SESSION, '-',
  ]);
  assert.ok(!args.includes('-s'));
  assert.ok(!args.includes('-C'));
});

test('arg builders reject invalid inputs', () => {
  const ex = (o) => () => buildExecArgs({ ...base, worktree: 'C:\\wt', ...o });
  assert.throws(ex({ model: 'bad model' }), /model/);
  assert.throws(ex({ effort: 'max' }), /effort/);
  assert.throws(ex({ sandbox: 'danger-full-access' }), /sandbox/);
  assert.throws(ex({ windowsSandbox: 'off' }), /windows sandbox/);
  assert.throws(ex({ worktree: '--evil' }), /worktree/);
  assert.throws(ex({ worktree: '' }), /worktree/);
  const rs = (o) => () => buildResumeArgs({ ...base, sessionId: SESSION, ...o });
  assert.throws(rs({ sessionId: 'not-a-uuid' }), /session id/);
  assert.throws(rs({ sessionId: '--last' }), /session id/);
  assert.throws(rs({ sandbox: 'danger-full-access' }), /sandbox/);
  assert.doesNotThrow(rs({ sessionId: SESSION.toUpperCase() }));
});

test('assertSafeArgs rejections', () => {
  assert.doesNotThrow(() => assertSafeArgs(['exec', '-c', 'approval_policy="never"', '-s', 'read-only']));
  for (const bad of [
    '--dangerously-bypass-approvals-and-sandbox', '--dangerously-x', '--approve-for-me', '--worktree',
    'danger-full-access', 'sandbox_mode="danger-full-access"',
    'approval_policy="on-request"', 'approval_policy=never', 'approval_policy="never" ',
  ]) {
    assert.throws(() => assertSafeArgs(['exec', bad]), /Forbidden/, bad);
  }
});

test('dirHasAgentCli', () => {
  withTmp((dir) => {
    const clean = path.join(dir, 'clean');
    const shim = path.join(dir, 'shim');
    const exe = path.join(dir, 'exe');
    for (const d of [clean, shim, exe]) fs.mkdirSync(d);
    fs.writeFileSync(path.join(clean, 'node.exe'), '');
    fs.writeFileSync(path.join(shim, 'Claude.CMD'), '');
    fs.writeFileSync(path.join(exe, 'codex.exe'), '');
    assert.equal(dirHasAgentCli(clean), false);
    assert.equal(dirHasAgentCli(shim), true);
    assert.equal(dirHasAgentCli(exe), true);
    assert.equal(dirHasAgentCli(path.join(dir, 'missing')), true);
  });
});

const dirent = (d) => {
  fs.mkdirSync(d, { recursive: true });
  return d;
};

test('buildWorkerEnv drops everything outside the allowlist and curates PATH', () => {
  withTmp((dir) => {
    const root = dirent(path.join(dir, 'Windows'));
    dirent(path.join(root, 'System32'));
    const nodeDir = dirent(path.join(dir, 'node'));
    const gitDir = dirent(path.join(dir, 'git', 'cmd'));
    const badDir = dirent(path.join(dir, 'bad'));
    fs.writeFileSync(path.join(badDir, 'claude.cmd'), '');
    const missingDir = path.join(dir, 'not-there');

    const source = {
      SystemRoot: root,
      comspec: 'C:\\Windows\\System32\\cmd.exe',
      LocalAppData: 'C:\\L',
      'ProgramFiles(x86)': 'C:\\PF86',
      TEMP: 'C:\\T',
      Path: 'C:\\evil;C:\\more',
      OPENAI_API_KEY: 'sk-secret',
      ANTHROPIC_BASE_URL: 'http://x',
      CLAUDE_CODE_MESSAGING_SOCKET: 'sock',
      CODEX_COMPANION_SESSION_ID: 'abc',
      CODEX_HOME: 'C:\\other',
      HTTPS_PROXY: 'http://p',
      npm_config_x: '1',
      RANDOM: 'y',
    };
    const r = buildWorkerEnv(source, {
      nodeDir, gitDirs: [gitDir, nodeDir.toUpperCase()], extraPath: [badDir, missingDir],
    });

    assert.deepEqual(r.kept_names, ['LocalAppData', 'ProgramFiles(x86)', 'SystemRoot', 'TEMP', 'comspec']);
    assert.deepEqual(r.dropped_names, [
      'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CODEX_COMPANION_SESSION_ID', 'CODEX_HOME',
      'HTTPS_PROXY', 'OPENAI_API_KEY', 'Path', 'RANDOM', 'npm_config_x',
    ]);
    assert.equal(r.env.comspec, source.comspec);
    assert.equal(r.env.LocalAppData, 'C:\\L');
    assert.equal(r.env['ProgramFiles(x86)'], 'C:\\PF86');
    assert.deepEqual(Object.keys(r.env).sort(), ['LocalAppData', 'Path', 'ProgramFiles(x86)', 'SystemRoot', 'TEMP', 'comspec']);
    assert.deepEqual(r.path_entries, [path.join(root, 'System32'), root, nodeDir, gitDir]);
    assert.equal(r.env.Path, r.path_entries.join(';'));
    assert.deepEqual(r.dropped_path_entries, [badDir]);
    assert.ok(!r.env.Path.includes('evil'));
  });
});

test('buildWorkerEnv sets CODEX_HOME only when configured and honours systemRoot', () => {
  withTmp((dir) => {
    const root = dirent(path.join(dir, 'Win'));
    const plain = buildWorkerEnv({ SystemRoot: 'C:\\nonexistent' }, { nodeDir: dir, systemRoot: root });
    assert.ok(!('CODEX_HOME' in plain.env));
    assert.deepEqual(plain.path_entries, [root, dir]);
    const withHome = buildWorkerEnv({}, { nodeDir: dir, systemRoot: root, codexHome: 'C:\\codex-home' });
    assert.equal(withHome.env.CODEX_HOME, 'C:\\codex-home');
    assert.deepEqual(withHome.kept_names, []);
  });
});

test('a shared Playwright install is exposed only when both browsers and the package exist', () => {
  withTmp((dir) => {
    assert.equal(playwrightEnv(dir), null);
    assert.equal(playwrightEnv(null), null);
    dirent(path.join(dir, 'browsers'));
    assert.equal(playwrightEnv(dir), null, 'browsers without the playwright package');
    dirent(path.join(dir, 'node_modules', 'playwright'));
    const env = playwrightEnv(dir);
    assert.deepEqual(env, { PLAYWRIGHT_BROWSERS_PATH: path.join(dir, 'browsers'), NODE_PATH: path.join(dir, 'node_modules') });
    const root = dirent(path.join(dir, 'Win'));
    const built = buildWorkerEnv({}, { nodeDir: dir, systemRoot: root, playwrightDir: dir });
    assert.equal(built.env.PLAYWRIGHT_BROWSERS_PATH, env.PLAYWRIGHT_BROWSERS_PATH);
    assert.equal(built.playwright_dir, dir);
    assert.equal(buildWorkerEnv({}, { nodeDir: dir, systemRoot: root }).playwright_dir, null);
  });
});

test('shell variables reach commands through shell_environment_policy.set as TOML literals', () => {
  const args = buildExecArgs({ ...base, worktree: 'C:\\wt', shellEnv: { ...BASE_SHELL_ENV, NODE_PATH: 'C:\\hw\\ms-playwright\\node_modules' } });
  assert.ok(args.includes("shell_environment_policy.set.NODE_PATH='C:\\hw\\ms-playwright\\node_modules'"));
  assert.ok(args.includes("shell_environment_policy.set.PSExecutionPolicyPreference='RemoteSigned'"));
  assert.ok(buildResumeArgs({ ...base, sessionId: SESSION, shellEnv: { A: 'b' } }).includes("shell_environment_policy.set.A='b'"));
  assert.throws(() => buildExecArgs({ ...base, worktree: 'C:\\wt', shellEnv: { X: "it's" } }), /Invalid value/);
  assert.throws(() => buildExecArgs({ ...base, worktree: 'C:\\wt', shellEnv: { 'A=B': 'x' } }), /Invalid shell variable name/);
});

test('extra writable roots become one sandbox_workspace_write.writable_roots TOML array', () => {
  const args = buildExecArgs({ ...base, worktree: 'C:\\wt', writableRoots: ['C:\\hw\\npm-cache', 'D:\\x'] });
  assert.ok(args.includes("sandbox_workspace_write.writable_roots=['C:\\hw\\npm-cache', 'D:\\x']"));
  assert.ok(!buildExecArgs({ ...base, worktree: 'C:\\wt' }).some((a) => a.includes('writable_roots')), 'none by default');
  assert.ok(buildResumeArgs({ ...base, sessionId: SESSION, writableRoots: ['C:\\c'] }).includes("sandbox_workspace_write.writable_roots=['C:\\c']"));
  assert.throws(() => buildExecArgs({ ...base, worktree: 'C:\\wt', writableRoots: ['relative'] }), /Invalid writable root/);
  assert.throws(() => buildExecArgs({ ...base, worktree: 'C:\\wt', writableRoots: ["C:\\it's"] }), /Invalid writable root/);
});

test('assertCleanEnv guard', () => {
  assert.doesNotThrow(() => assertCleanEnv({ CODEX_HOME: 'x', Path: 'y', SystemRoot: 'z' }));
  for (const key of ['OPENAI_X', 'anthropic_x', 'CLAUDECODE', 'npm_x', 'CODEX_SANDBOX', 'https_proxy', 'NO_PROXY']) {
    assert.throws(() => assertCleanEnv({ [key]: '1' }), /Forbidden/, key);
  }
});
