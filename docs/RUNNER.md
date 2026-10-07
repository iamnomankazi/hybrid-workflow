# Runner and job host: algorithm

Normative companion to `ARCHITECTURE.md` §5 and §11. The runner is deterministic: no LLM calls,
no interpretation of `plan.md`, no git integration, no automatic relaunch of uncertain work.

## Entry

`node src/runner/main.mjs --home <HYBRID_HOME> --run <run_id>`, normally launched by the CLI
through WMI (`DETACHED_PROCESS`, `SW_HIDE`; parent `WmiPrvSE.exe`). For tests the CLI may
spawn it detached instead (`HYBRID_RUNNER_LAUNCH=spawn`); the runner itself does not care.

Uncaught errors: log to `runner.log`, set `runner.json.status = "crashed"`, release
`runner.lock`, exit 1. Hosts and Codex workers keep running and are adopted by the next runner.

## Startup

1. Load `run.json`. If `status != "open"`, exit 0.
2. Take `runner.lock` (`{pid, start_time, version, acquired_at}`, exclusive create). If it
   exists and its identity is alive, another runner owns the run: exit 0. If the identity is
   dead, remove the stale lock and retry once.
3. Restore `hold` from the previous `runner.json`; continue `seq` from the max seq in
   `transitions.jsonl`, repairing the feed first: any job whose `state.json.seq` exceeds the
   feed's max gets a recovery record appended (`reason: "recovered_feed"`) in seq order.
4. Write `runner.json` (`status: "starting"`), reconcile (ARCHITECTURE §11), then
   `status: "running"` and enter the loop.

## Loop (every `poll_ms`, never overlapping)

1. **Inbox.** Process `inbox/*.json` in name order. Re-read `run.json` once per batch; a request
   whose `epoch` differs from `run.owner.epoch` is rejected `stale_epoch` (a stale submit also
   records its job as `rejected`). Then by type:
   * `submit`: the job dir must contain `spec.json` and `capsule.md` and no `state.json`.
     Recompute the capsule sha256 and compare with `spec.capsule_sha256`; check the preset
     exists in `run.config.presets` with identical `preset_config`. Accept → `queued`
     (attempt 1, mode `fresh`). Otherwise → `rejected` with the reason.
   * `cancel`: `queued` → `cancelled` immediately (result written). Active → persist
     `cancel_requested`, kill the host tree then the Codex tree (identity-verified); the
     monitor finalizes when no process remains. Terminal → reject `not_active`.
   * `resume`: state must be resumable, `codex_session_id` known, worktree present, no live
     process. Then `attempt += 1`, `mode = "resume"`, `resume = {note, from_state, from_reason}`
     and → `queued`. Otherwise reject with the reason.
   * `unhold`: clear the hold; feed record `{kind:"run", to:"unhold"}`.
   * `shutdown`: accepted only with no active jobs; the runner exits after the batch.
   Each request ends in `inbox/done/<id>.json` with `outcome` and `reason`.
2. **Monitor** each active job:
   * `exit.json` present → finalize.
   * `events.jsonl` grew → `last_event_at = now` (persisted at most every 30 s); capture
     `codex_session_id` from `thread.started` as soon as it appears; `stalled` → `running`
     (`events_resumed`).
   * No event for `stall_minutes` (measured from `last_event_at`, else `started_at`) →
     `stalled` (`no_events`).
   * Elapsed since `started_at` > `timeout_minutes` → mark `timed_out`, kill trees.
   * Every `liveness_check_ms`: batch identity check of host and Codex. Both gone and still no
     `exit.json` (re-checked) → finalize.
3. **Launch** while `active < max_concurrency`, no hold and queued jobs exist (FIFO by
   `queued_at`):
   1. `queued → launching`, create `attempts/<n>/` (must not contain `launch.json`).
   1b. Re-read the global Codex instructions fingerprint; if it differs from `run.json.global_instructions`,
      fail the job as `global_instructions_changed` (no worktree, no worker).
   1c. Re-read `codex --version`; if it differs from `run.json.versions.codex`, fail the job as
      `codex_version_changed` (no worktree, no worker). An unreadable version is logged and recorded
      as `null`; the launch then fails on its own if Codex is unusable.
   2. Fresh: `git worktree add --detach` at `spec.base_commit ?? run.base_commit`, then repo
      preparation. Resume: the worktree must exist.
   3. Write `prompt.md` (composed capsule prompt or resume preamble) and record its sha256.
   4. Build argv (exec or resume), the sanitized environment and `launch.json`.
   5. Spawn the job host **detached** with `windowsHide`; immediately record the host identity
      in `state.json` (still `launching`).
   6. Wait ≤ 20 s for `host.json` → `running` with host and Codex identities, `started_at`.
      `exit.json` with `spawn_error` → `failed/launch_failed`. Neither → kill the host,
      `failed/launch_failed`.
   Any exception in steps 1–4 → `failed/launch_failed` with the error text.
4. **Heartbeat** `runner.json` every `heartbeat_ms` (also re-reads `run.json` status).
5. **Idle exit**: no launchable queued jobs (queued jobs under a launch hold do not count), no
   active jobs and no pending requests for `runner_idle_exit_minutes` (or the run is closed with
   nothing active) → `runner.json.status = "exited"`, release the
   lock, exit 0.

## Finalize (idempotent per attempt)

1. Sweep orphans: every process whose command line or executable path references the worktree
   path (matched at a path boundary, so `…\j1` never matches `…\j10`) is killed by identity;
   records are kept in the result. Any process, including a human's shell, whose command line
   names a job worktree at finalize time is killed: do not work inside job worktrees by hand.
2. Summarize `events.jsonl`; read the rollout for observed model/effort/approval/sandbox and
   compare with the request.
3. Read `last-message.md` (capped at 16 KB) and parse the worker report.
4. Capture the patch (`attempts/<n>/patch.diff`), validate it (scope, protected paths,
   symlinks, reparse points) and write `patch.json`.
5. Decide the state (ARCHITECTURE §5), write `result.json`, then transition. `paused_quota` /
   `paused_auth` also set the launch hold (feed record `{kind:"run", to:"hold"}`).

## `runner.json`

`{schema, run_id, version, node, pid, start_time, status: starting|running|exited|crashed,
started_at, heartbeat_at, exit_reason, hold: null|{reason, since, job_id}, counts, last_seq}`.

## Job host (`src/runner/job-host.mjs <attemptDir>`)

Reads `launch.json`, opens `prompt.md` (stdin), `events.jsonl` and `stderr.log` (append), and
spawns Codex **non-detached** with `windowsHide: true` (the Test 2-validated relationship; the
host's libuv kill-on-close job means Codex dies if the host is killed, which is what cancel
wants). It writes `host.json` (`{host:{pid,start_time}, codex:{pid,start_time}, spawned_at}`),
always before `exit.json` (`{code, signal, ended_at}` or `{spawn_error}`), then exits.
