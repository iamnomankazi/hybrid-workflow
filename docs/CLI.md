# `hybrid` CLI reference

`node bin/hybrid.mjs <command> …` (or `hybrid …` once linked). Output is concise text by
default; `--json` prints one JSON document for machine use. Errors go to stderr.

Run selection: `--run <id>` or, by default, the machine's active run (`active-run.json`).
Session identity: `--session <id>`, else `HYBRID_SESSION_ID`, else `CLAUDE_CODE_SESSION_ID`.
Mutating commands require `--epoch <n>` equal to the run's current owner epoch. The fence is
epoch-only: the session id is recorded but not checked, so any session presenting the current
epoch is accepted (it guards against stale controllers, not impersonation; ARCHITECTURE §6).

| Command | Mutates | Purpose |
| --- | --- | --- |
| `repo add <alias> <path> [--node-modules junction\|none]` | config | Register a repository alias |
| `repo list` | — | Show aliases |
| `doctor` | — | Check node, git, codex, PowerShell/CIM, state and worktree roots; warn when a global `CODEX_HOME` AGENTS.md exists (it reaches every worker) or Codex is not the release whose worker tool isolation was verified; report the shared Playwright install and warn if the Codex sandbox accounts can read `auth.json` |
| `run start --repo <alias> [--base <ref>] [--goal <text>] [--concurrency <n≤8>]` | creates run | Take the global lock, pin config + base commit + Codex version + global-instructions fingerprint, owner epoch 1, launch the runner |
| `run list` | — | All runs, newest first |
| `run close --epoch N` | yes | Refuses while jobs are queued/active; closes the run, stops the runner, releases the global lock |
| `run unhold --epoch N` | yes | Clear a quota/auth launch hold |
| `run ensure-runner --epoch N` | yes | Relaunch the runner if it is not alive (after `wait` reports `runner_down`) |
| `takeover [--session S]` | owner | Increment the epoch and become owner. Takes no `--epoch`; it is how a session gets one |
| `submit <spec.json> --epoch N [--no-wait]` | yes | Validate, store spec + capsule, queue the job |
| `status [<job>] [--changed [--since N]]` | cursor only | Run/job summary (including the last temporary controller); `--changed` = transitions since the session cursor |
| `wait [--any] [--since N] [--timeout 50m] [--debounce 60s] [--poll 2s]` | — | Block until a wake transition (batched for `--debounce`; `--any` returns at the first), `runner_down`, `idle` (nothing launchable or active) or timeout; `--poll` sets how often the feed is re-read |
| `result <job> [--full]` | — | Outcome, worker report, patch verdict and provenance; `WARNING isolation:` (JSON `isolation_warnings`) if the worker made MCP calls or saw `codex_apps` or a skills catalog. `--full` shows report fields untruncated, the raw report (≤16 KB) and every patch file (default: first 50) |
| `cancel <job> --epoch N` | yes | Cancel a queued or active job (tree kill + orphan sweep + patch capture) |
| `resume <job> --epoch N [--note <text> \| --note-file <f>]` | yes | Queue a new attempt of the same Codex session with pinned flags |
| `decide <job> <integrated\|rejected\|superseded\|deferred> --epoch N [--note]` | yes | Record Opus's integration decision |
| `gc [--dry-run] [--all-terminal] [--epoch N]` | worktrees | Remove worktrees of decided/completed terminal jobs |
| `controller start --epoch N [--writable <dir>]... [--dry-run]` | launches | Hand the run to a temporary Sol controller (ORCHESTRATION.md "Controller handoff"): ensure the runner, launch a detached controller host as the user, which runs `gpt-6.1-sol` `xhigh` in the workspace-write sandbox. Writable: the run directory, the repo's git directory and each `--writable` dir. `--dry-run` prints the exact invocation and prompt. Refused (5) while a controller is attached |

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | ok (for `wait`: woke, `idle` or `runner_down`; see the `reason` field) |
| 1 | error |
| 2 | usage / validation error |
| 3 | fenced: `--epoch` is not the current owner epoch (the fence checks the epoch only, not the session) |
| 4 | not found |
| 5 | conflict (active run exists, job in wrong state, run closed) |
| 10 | `wait` timed out with nothing to report |

## Job spec (`hybrid.job-spec/1`)

```json
{
  "job_id": "auth-refactor",
  "title": "Refactor token refresh",
  "preset": "luna-xhigh-impl",
  "capsule_file": "capsules/auth-refactor.md",
  "write_scope": ["src/auth/", "test/auth/"],
  "allow_protected": [],
  "allow_symlinks": false,
  "timeout_minutes": 120,
  "stall_minutes": 15,
  "base_commit": null
}
```

`capsule_file` is relative to the spec file (or use inline `capsule`). Model, effort and
sandbox come only from the preset. Unknown fields are rejected. `job_id` is optional
(`j001`, `j002`, … are generated).

Built-in presets: `sol-high-review`, `sol-high-impl`, `sol-xhigh-impl`, `luna-xhigh-impl`,
`luna-xhigh-review`, `sol-low-smoke`.
