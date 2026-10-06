# Hybrid Workflow: v1 architecture and contracts

This document is normative for v1. Code that disagrees with it is a bug in one of the two;
fix deliberately, never silently.

## 1. Roles

| Actor | Responsibility | Never does |
| --- | --- | --- |
| Human | Final authority; merges to main; pushes | — |
| Opus (native Claude Code session) | Plans, decomposes, writes capsules, submits jobs, reviews results, integrates patches, decides | Launch Codex directly; edit runner-owned files |
| Claude-side Sonnet subagents | Short bounded Claude work chosen by Opus, inside the Opus session | Get managed by the runner |
| `hybrid` CLI | Deterministic control surface Opus calls; writes control files; launches the runner | Reasoning; merging |
| Runner (one per run, temporary) | Codex lifecycle: queue, worktrees, launch, monitor, cancel, capture, record | LLM calls; interpret `plan.md`; merge; commit; push; auto-relaunch uncertain work |
| Job host (one per attempt) | Owns exactly one `codex.exe` process and records its identity and exit | Anything else |
| Codex worker (`codex exec`) | Executes one capsule in an isolated worktree | Commit, merge, push, touch protected paths |

## 2. Process lifecycle (Windows)

```
Opus ── hybrid run start / submit / cancel / resume ──▶ CLI
CLI ── WMI Win32_Process.Create (DETACHED_PROCESS, SW_HIDE) ──▶ node runner/main.mjs   (parent: WmiPrvSE)
runner ── spawn(detached, windowsHide) ──▶ node runner/job-host.mjs   (one per attempt)
job host ── spawn(non-detached, windowsHide, stdio=files) ──▶ codex.exe exec ...
```

* There is no daemon, service, scheduled task, login item, pipe or HTTP server.
* One run = at most one runner. The runner exits after `runner_idle_exit_minutes` with no
  queued/active jobs and no pending requests. Any mutating CLI command relaunches it on demand.
* WMI is the launch mechanism because Test 2 proved ordinary detachment dies with Claude
  Desktop and WMI-created processes survive a full tray Quit.
* **Why the job host exists.** Node (libuv) places every *non-detached* child in a
  kill-on-close Job Object, so a non-detached `codex.exe` dies with its parent (verified
  2026-10-06). Spawning Codex directly from the runner would make a runner crash kill all
  workers. The runner instead spawns a tiny detached job host per attempt; the host spawns
  Codex non-detached with `windowsHide`, which is exactly the parent/child relationship Test 2
  validated (hidden console inherited by Codex's shells). A runner crash leaves hosts and
  workers running; a fresh runner adopts them by identity. The host writes `exit.json`, a
  durable terminal artifact that exists even if no runner was alive at the moment Codex exited.

## 3. State root layout

`HYBRID_HOME` (default `%LOCALAPPDATA%\HybridWorkflow`):

```
config.json                      machine config (repo aliases, codex path, …)   human / `hybrid repo`
active-run.json                  global one-active-run lock                       CLI
empty-hooks/                     empty dir used as core.hooksPath for every git call
runs/<run_id>/
  run.json                       run metadata, owner + epoch, pinned config       CLI (under run.mutex)
  run.mutex                      short-lived mutex for run.json read-modify-write CLI
  plan.md                        Opus checkpoint (goal, decomposition, decisions)  Opus ONLY
  runner.json                    runner identity, heartbeat, hold, counters       runner
  runner.lock                    runner singleton {pid,start_time}                runner
  runner.log, progress.log       human-readable logs                              runner
  runner-launch.json             last WMI launch record                           CLI
  transitions.jsonl              append-only job/run change feed                  runner
  inbox/<id>.json                pending requests                                 CLI
  inbox/done/<id>.json           processed requests + outcome                     runner
  cursors/<session>.json         per-session status --changed cursor             CLI
  jobs/<job_id>/
    spec.json, capsule.md        immutable inputs (write-once)                    CLI
    decision.json                Opus integration decision                        CLI (for Opus)
    state.json                   lifecycle state                                  runner
    result.json                  terminal outcome + provenance                    runner
    attempts/<n>/
      launch.json, prompt.md     exact argv/env-names/cwd and stdin prompt        runner
      host.json, exit.json       process identities; exit code                    job host
      events.jsonl, stderr.log   Codex stdout (--json) / stderr                   codex (via host)
      last-message.md            Codex -o final message                           codex
      patch.diff, patch.json     captured change set + validation                 runner
```

Worktrees: `<worktree_root>\<run_id>\<job_id>` with `worktree_root` default `%SystemDrive%\hw\wt`.

Rules:
* **Single writer per file.** No file has two writers. The runner never reads `plan.md`.
* JSON documents are written temp + rename with retry on `EPERM/EACCES/EBUSY` (`src/fsutil.mjs`).
* Append-only files have exactly one appender.
* A reader that sees `state.json` in a terminal state may rely on `result.json` existing:
  the runner writes `result.json` first.

## 4. Identity and liveness

A process is identified by `(pid, start_time)` where `start_time` is CIM
`Win32_Process.CreationDate` rendered `.ToUniversalTime().ToString('o')`. Both sides of every
comparison use the same function (`src/proc.mjs`), so equality is exact string equality.
A PID alone is never trusted: Windows reuses PIDs. `taskkill` is only issued after the
identity re-verifies.

The runner heartbeats `runner.json` every `heartbeat_ms`. A runner is considered alive when
its `runner.lock` identity is alive. The CLI never infers liveness from heartbeat age alone.

## 5. Job state machine

```
            submit ok                 slot free             host+codex identity recorded
  (new) ───────────▶ queued ──────────────▶ launching ──────────────────────▶ running ◀──▶ stalled
    │ invalid/stale        │ cancel             │ spawn error → failed            │
    ▼                      ▼                    │ runner lost it → interrupted     ├─▶ completed
  rejected             cancelled                ▼                                  ├─▶ failed
                                              cancelled                            ├─▶ interrupted
                                                                                   ├─▶ cancelled
                                                                                   ├─▶ paused_quota
                                                                                   └─▶ paused_auth
  failed | interrupted | cancelled | paused_quota | paused_auth ── hybrid resume ──▶ queued (attempt+1)
```

The legal transition table is `TRANSITIONS` in `src/constants.mjs`; the runner asserts every
transition against it.

* `stalled`: process alive but no new Codex event for `stall_minutes`. Non-terminal; wakes Opus;
  returns to `running` when events resume. Never auto-killed.
* Hard timeout: process killed, state `failed`, reason `timeout`.
* `interrupted`: the runner could not establish what happened (worker gone without trustworthy
  terminal artifacts, launch uncertain after a runner restart, reboot). Never relaunched
  automatically; Opus decides between `hybrid resume` and a fresh job.
* `paused_quota` / `paused_auth`: the turn ended on a usage-limit / authentication failure.
  The runner also sets a **launch hold** (no new launches) until `hybrid run unhold`.
* `rejected`: the runner refused the submit (stale epoch at processing time, invalid spec).

### Outcome determination (runner `finalize`)

Order of precedence once no worker process remains:

1. Cancel requested → `cancelled`.
2. Runner killed it for the hard timeout → `failed/timeout`.
3. `exit.json` has `spawn_error` → `failed/launch_failed`.
4. No `exit.json` (host died or vanished): `turn.completed` event **and** a final message
   present → `completed` with `exit.source="unknown"`; otherwise `interrupted/worker_lost`.
5. Turn not completed and failure messages classify as quota/auth → `paused_quota` / `paused_auth`.
6. Exit code 0, `turn.completed` seen, final message present → `completed`.
7. Otherwise `failed` with reason `nonzero_exit`, `no_turn_completed` or `missing_final_output`.
8. A would-be `completed` whose patch capture failed becomes `failed/patch_capture_failed`.

Exit code alone never makes a job `completed`.

## 6. Ownership and epoch fencing

`run.json.owner = {session_id, epoch, acquired_at}`. `run start` sets epoch 1.
`hybrid takeover --session <id>` increments the epoch under `run.mutex`.

* Every mutating command (`submit`, `cancel`, `resume`, `decide`, `run close`, `run unhold`,
  `run runner`) requires `--epoch N` equal to the current epoch. The CLI checks it, and the
  runner re-checks each request's epoch against `run.json` when processing it (the
  authoritative fence; closes the CLI's TOCTOU window).
* Read-only commands (`status`, `wait`, `result`) need no epoch; any session may observe.
* The fence protects against accidental stale controllers (an old session waking up), not
  against an adversary with filesystem access.

## 7. Requests (inbox)

`inbox/<id>.json`: `{schema:"hybrid.request/1", id, type, run_id, epoch, session_id, job_id, payload, created_at}`.
`id` = zero-padded epoch millis + random hex, so lexical order = arrival order.
Types: `submit`, `cancel`, `resume` (`payload.note` ≤ 4 KB), `unhold`, `shutdown`.
The runner processes requests in order and writes `inbox/done/<id>.json` = request +
`{processed_at, outcome: "accepted"|"rejected", reason}` then deletes the pending file.

## 8. Transitions feed

`transitions.jsonl` lines: `{seq, ts, kind:"job"|"run", job_id, from, to, reason, attempt}`.
`seq` is strictly increasing across runner restarts (a new runner continues from the max seq on
disk). `status --changed` and `wait` read this feed; they never parse job directories to
detect change.

## 9. Codex worker invocation

Fresh attempt:
```
codex exec --ignore-user-config --strict-config --ignore-rules --skip-git-repo-check
  -m <model> -c model_reasoning_effort="<effort>" -s <read-only|workspace-write>
  -c approval_policy="never" -c shell_environment_policy.inherit="core"
  -c windows.sandbox="elevated" [-c project_doc_max_bytes=0]
  -C <worktree> --json -o <attempt>\last-message.md [--output-schema <schema>] -
```
Resume attempt (`exec resume` has no `-s`/`-C`): the same flags with
`-c sandbox_mode="<sandbox>"` instead of `-s`, `cwd` = worktree, then `<session_id> -`.

* The prompt is passed on stdin from `prompt.md` (no command-line length limit, no quoting).
* Model, effort and sandbox come only from a named **preset**; specs carry no free-form
  model, path or flag fields. `danger-full-access`, `--dangerously-*`, `--approve-for-me`
  and `--worktree` are never emitted (asserted).
* stdout → `events.jsonl`, stderr → `stderr.log`: files, never pipes to the runner.
* Observed model, effort, approval policy and sandbox are read from the session rollout
  (`$CODEX_HOME/sessions/**/rollout-*-<thread_id>.jsonl`, `turn_context`) and compared to the
  request; a mismatch is recorded in `result.json` provenance.

### Worker environment

Built from an allowlist (SystemRoot, windir, ComSpec, PATHEXT, USERPROFILE, APPDATA,
LOCALAPPDATA, ProgramData, ProgramFiles*, TEMP, TMP, HOMEDRIVE/HOMEPATH, USERNAME, …).
Everything else is dropped, including `OPENAI_*`, `ANTHROPIC_*`, `CLAUDE*`, `CODEX_*`
(except an explicitly configured `CODEX_HOME`) and proxy variables. `PATH` is curated:
Windows system dirs, Windows PowerShell, the node dir and the Git for Windows dirs, plus
explicit `extra_path`; any directory containing a `codex`/`claude` executable or shim is
dropped. Only variable *names* are recorded in provenance.

## 10. Worktrees and change capture

* Every job (read-only included) runs in its own worktree created with
  `git worktree add --detach <wt> <base_commit>`; every runner git call uses
  `-c core.hooksPath=<empty-hooks> -c core.fsmonitor=false`.
* Optional per-repo preparation: `node_modules` junction to the main checkout's
  `node_modules` (only when that path is git-ignored). Junctions are unlinked (never
  recursed) before worktree removal.
* Capture uses a temporary index (`GIT_INDEX_FILE`): `read-tree <base>`, `add -A`, then
  `diff --cached --binary --no-renames <base>`. Untracked files are included; ignored files
  are not. The worker's own index is never touched.
* Validation of every changed path: protected paths, write scope, symlink/gitlink modes,
  reparse points on disk. Verdict `clean | violations | empty | capture_failed`.
  A patch is captured and kept even when it has violations (evidence); Opus must not
  apply a non-clean patch.

Protected (case-insensitive, any depth): any `.git` path segment (never allowable),
`.gitmodules`, `.gitattributes`, `.github/workflows/`, `.husky/`, `.githooks/`, `.claude/`,
`.codex/`, `.agents/`, `AGENTS.md`, `CLAUDE.md`, `CODEX.md`. All but `.git` can be allowed
per path with `spec.allow_protected`. Symlinks (mode 120000) need `spec.allow_symlinks`;
gitlinks (160000) are always violations. Read-only jobs must produce an empty change set.

## 11. Recovery

On start the runner takes `runner.lock` (breaking it only if the holder's identity is dead),
continues `seq`, restores the launch hold, then reconciles every non-terminal job:

| Found | Action |
| --- | --- |
| `queued` | stays queued (never launched, safe) |
| `launching`, no `host.json` | wait ≤10 s for it; else kill any host process whose command line references the attempt dir; `interrupted/launch_uncertain` |
| `running`/`stalled` with `exit.json` | finalize normally |
| `running`/`stalled`, codex identity alive | adopt (monitor by identity polling) |
| `running`/`stalled`, worker gone, no `exit.json` | finalize via rule 4 (completed only with trustworthy artifacts, else `interrupted`) |

Nothing is ever relaunched automatically. After a reboot every in-flight job becomes
`interrupted` through the identity check (start times no longer match).

## 12. Document shapes

`run.json` (CLI):
```json
{ "schema": "hybrid.run/1", "run_id": "r261006-064512-a1b2", "status": "open|closed",
  "created_at": "…", "closed_at": null, "goal": "…",
  "repo": { "alias": "x", "path": "C:\\…", "prepare": { "node_modules": "none|junction" } },
  "base_ref": "HEAD", "base_commit": "<40 hex>",
  "owner": { "session_id": "…", "epoch": 1, "acquired_at": "…" },
  "owner_history": [ { "session_id": "…", "epoch": 1, "acquired_at": "…", "released_at": "…" } ],
  "versions": { "hybrid": "0.1.0", "node": "v24…", "git": "git version …", "codex": "codex-cli 0.160.1" },
  "tools": { "node_exe": "C:\\…\\node.exe", "git_exe": "C:\\…\\git.exe" },
  "config": { /* buildRunConfig(): codex_exe, codex_prefix_args, codex_home, worktree_root,
                max_concurrency, default_timeout_minutes, max_timeout_minutes, stall_minutes,
                runner_idle_exit_minutes, poll_ms, liveness_check_ms, heartbeat_ms,
                windows_sandbox, project_docs, output_schema, extra_path, presets
                (+ optional test-only "minute_ms", default 60000) */ } }
```

`spec.json` (CLI, write-once): the normalized spec from `validateSpec` plus
`{ job_id, run_id, capsule_sha256, submitted_at, submitted_epoch, submitted_by }`.

`state.json` (runner):
```json
{ "schema": "hybrid.job-state/1", "run_id": "…", "job_id": "…",
  "state": "queued", "reason": null, "detail": null, "seq": 12,
  "attempt": 1, "mode": "fresh|resume", "resume": null,
  "submitted_epoch": 1, "created_at": "…", "updated_at": "…",
  "queued_at": "…", "started_at": null, "ended_at": null,
  "last_event_at": null, "events_bytes": 0,
  "worktree": "C:\\hw\\wt\\<run>\\<job>", "base_commit": "<sha>",
  "process": { "host": { "pid": 1, "start_time": "…" }, "codex": { "pid": 2, "start_time": "…" } },
  "codex_session_id": null, "cancel_requested": false, "timed_out": false, "prompt_sha256": null }
```

`result.json` (runner, terminal):
```json
{ "schema": "hybrid.job-result/1", "run_id": "…", "job_id": "…", "epoch": 1, "attempt": 1,
  "state": "completed", "reason": null, "detail": null,
  "timestamps": { "queued_at": "…", "started_at": "…", "ended_at": "…" },
  "exit": { "code": 0, "signal": null, "source": "host|unknown|none" },
  "provenance": { "spec_sha256": "…", "capsule_sha256": "…", "prompt_sha256": "…",
    "base_commit": "…", "preset": "…",
    "requested": { "model": "…", "effort": "…", "sandbox": "…", "approval_policy": "never" },
    "observed": { "model": "…", "effort": "…", "sandbox_policy": "…", "approval_policy": "…", "source": "rollout" },
    "observed_matches": true, "observed_mismatches": [],
    "codex_session_id": "…", "codex_version": "…", "runner_version": "…", "node_version": "…",
    "codex_exe": "…", "env_names": ["…"], "path_entries": ["…"] },
  "events": { "count": 0, "turn_completed": true, "turn_failed": false, "failure_message": null,
    "errors": [], "usage": {}, "item_types": {}, "mcp_tool_calls": 0, "classification": null, "last_event_at": "…" },
  "worker_report": { "present": true, "valid_json": true, "job_id_matches": true, "report": {}, "raw": "…≤16KB", "truncated": false },
  "patch": { "captured": true, "file": "attempts/1/patch.diff", "sha256": "…", "bytes": 0,
    "stats": { "files": 0, "added": 0, "deleted": 0 }, "files": [], "verdict": "clean|violations|empty|capture_failed",
    "violations": [], "error": null },
  "orphans": { "killed": [], "failed": [] } }
```

## 13. Module map

| Module | Purpose |
| --- | --- |
| `src/constants.mjs` | versions, schemas, states, transitions, exit codes |
| `src/paths.mjs` | layout |
| `src/fsutil.mjs` | atomic/exclusive writes, JSONL, hashing, mutex |
| `src/store.mjs` | inbox, run.json, job/transition readers, ownership fence |
| `src/config.mjs` | machine config, defaults, run-config pinning |
| `src/spec.mjs` | presets, job spec validation, prompt composition |
| `src/codex.mjs` | Codex exe/version, argv builders, worker environment |
| `src/events.mjs` | Codex JSONL summary, quota/auth classification |
| `src/rollout.mjs` | observed model/effort from session rollout |
| `src/proc.mjs` | process identity, liveness, tree kill, orphan sweep |
| `src/wmi.mjs` | headless WMI launcher |
| `src/git.mjs` | git wrapper, worktrees, preparation, patch capture |
| `src/scope.mjs` | protected paths, write scope, symlink/reparse validation |
| `src/runner/*` | runner main loop, job host, finalize |
| `src/cli/*`, `bin/hybrid.mjs` | commands |
