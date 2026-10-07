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

v0.1. Unit- and integration-tested with a fake Codex. Acceptance-tested with real Codex 0.160.1
workers on Windows (October 2026): parallel 90+ minute runs, Claude app quit, runner crash and
adoption, cancellation, resume, patch rules, sandbox and environment isolation, and epoch
fencing. See "Validation status" for what is proven and what is not.

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
| Core persistence, state machine, specs, env sanitization, scope validation | Unit-tested |
| Worktrees, patch capture (untracked, binary, deletions), junction safety | Integration-tested (real git) |
| Process identity, tree kill, orphan sweep, WMI launch | Integration-tested (real processes) |
| Runner lifecycle, cancel, timeout, stall, crash adoption, resume, holds, epoch fencing | Integration-tested with a fake Codex |
| Native Codex (Sol, Luna) with pinned model, effort, sandbox and approval; observed config matches the request | Acceptance-tested on every real job |
| Runner and workers survive a full Claude desktop quit (WMI launch) | Acceptance-tested |
| Two parallel 90+ minute workers with sparse `hybrid wait` wakes | Acceptance-tested (~98 min) |
| Writes outside the worktree, network, `npm install` blocked without hanging; no approval prompts | Acceptance-tested; read access is broad |
| Worker environment: no `OPENAI_*`/`CLAUDE*`, no `codex`/`claude` on `PATH` | Acceptance-tested |
| Patch rules: hooks, symlinks/junctions, protected paths, write scope | Acceptance-tested |
| Cancel of a real cross-user process tree, no orphans, patch captured | Acceptance-tested |
| Runner crash: worker survives and is adopted once, or marked interrupted | Acceptance-tested |
| Manual resume: same session, pinned flags, worker re-inspects first | Acceptance-tested |
| Stale-epoch submit/cancel rejected at the CLI and by the runner | Acceptance-tested |
| Worker tool isolation (no account connectors, plugins, web access) | Acceptance-tested (tool table enumerated) |
| Quota consumption | Measured briefly; the real usage-limit → `paused_quota` path has not been observed |
| Auth refresh races | Not tested |
| Sleep | Not tested. Run on AC with system sleep disabled; there is no keep-awake in Hybrid |

Known gaps: Codex's collaboration (sub-agent) tools stay in the worker tool table; `apply_patch`
can fail with "Failed to write file" after long-lived shell sessions (workers fall back to shell
writes, and patch capture is unaffected); no Playwright browser in workers (the sandbox user
cannot read the user's AppData).

## License

MIT. See [LICENSE](LICENSE).
