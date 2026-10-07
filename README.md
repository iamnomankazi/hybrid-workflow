# Hybrid Workflow

A deterministic Codex execution plane for a native Claude Code (Opus) control plane, on Windows.

Opus plans, decomposes and integrates. A small per-run **runner** launches and supervises native
`codex exec` workers in isolated git worktrees, captures their complete change sets, validates
them against protected paths and write scopes, and records durable, verifiable results. Files on
disk are the source of truth; there is no daemon, service, IPC server or LLM in the runner.

```
Opus (Claude Code) ──hybrid CLI──▶ files (run.json, inbox/, jobs/) ◀──▶ runner (WMI-launched, per run)
                                                                          └─▶ job host ─▶ codex exec (worktree)
```

## Status

v0.1: deterministic foundation. Unit- and integration-tested with a fake Codex; the real
Codex path has had a short smoke validation only. See "Validation status" below before relying
on it for long unattended runs.

## Requirements

* Windows 10/11, Node.js ≥ 22.12, Git for Windows
* The official Codex CLI, signed in with a ChatGPT subscription (default location
  `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe`; override `codex_exe` in config)
* No npm dependencies

## Quick start

```bash
node bin/hybrid.mjs doctor
node bin/hybrid.mjs repo add myrepo C:\path\to\repo
node bin/hybrid.mjs run start --repo myrepo --goal "Refactor X"
node bin/hybrid.mjs submit job.json --epoch 1
node bin/hybrid.mjs wait --timeout 50m
node bin/hybrid.mjs status
node bin/hybrid.mjs result j001
```

State lives in `%LOCALAPPDATA%\HybridWorkflow` (override with `HYBRID_HOME`); worktrees in
`%SystemDrive%\hw\wt` (override `worktree_root` in `config.json`).

## Documentation

* [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): roles, lifecycle, layout, state machine, contracts
* [docs/RUNNER.md](docs/RUNNER.md): runner and job host algorithm
* [docs/CLI.md](docs/CLI.md): command reference, exit codes, job spec
* [docs/ORCHESTRATION.md](docs/ORCHESTRATION.md): the contract Opus follows

## Worker isolation

Every worker runs `codex exec --ignore-user-config --strict-config --ignore-rules` with explicit
model, reasoning effort, sandbox (`read-only` or `workspace-write` only),
`approval_policy="never"` and `shell_environment_policy.inherit="core"`, an allowlisted
environment (no `OPENAI_*`, `ANTHROPIC_*`, `CLAUDE*`, `CODEX_*`, proxies) and a curated `PATH`
without any `codex`/`claude` executables. Project `AGENTS.md` files and the user's Codex skills
catalog are suppressed. Codex features that add tools outside the sandboxed shell are disabled:
account apps (`codex_apps` MCP), plugins, web access, image generation and goals. Codex's
collaboration (sub-agent) tools have no verified switch yet and remain exposed.
The user's `config.toml` is never loaded, and nothing in `CODEX_HOME` is
ever modified (Hybrid only hashes the global instructions file, below).

**Known limitation:** Codex 0.160.1 always injects `CODEX_HOME/AGENTS.md` (or
`AGENTS.override.md`) into workers and offers no switch to disable it. Hybrid pins its
fingerprint per run, refuses launches if it changes mid-run, records it in every result, and
`doctor` warns when it exists. Keep that file empty if workers must receive no user-level
instructions. See docs/ARCHITECTURE.md §9.

## Tests

```bash
npm test                 # everything
npm run test:unit
npm run test:integration # spawns real processes (git, PowerShell CIM, WMI) with a fake Codex
```

## Validation status

| Area | Status |
| --- | --- |
| Native Codex with clean isolation flags (Sol High, Luna XHigh, subscription auth) | Proven experimentally (Test 1) |
| Runner survives full Claude Desktop quit when launched via WMI | Proven experimentally (Test 2) |
| Core persistence, state machine, specs, env sanitization, scope validation | Unit-tested |
| Worktrees, patch capture (untracked, binary, deletions), junction safety | Integration-tested (real git) |
| Process identity, tree kill, orphan sweep, WMI launch | Integration-tested (real processes) |
| Runner lifecycle, cancel, timeout, stall, crash adoption, resume, holds | Integration-tested with a fake Codex |
| Long duration, quota behaviour, auth refresh races, sleep, RoleForge worktrees | Awaiting acceptance testing |
