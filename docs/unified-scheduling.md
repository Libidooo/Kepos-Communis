# Unified scheduling design (D4, approved direction)

Status: design for approval. The decision (2026-10-30) is to move Kepos to a single
scheduler owner: the TUI delegates dispatch to the daemon instead of owning a
WorkerPool. This document breaks that into shippable phases and states the
invariants each phase must keep.

## Problem

Today three entry points own a WorkerPool each — the TUI, `kepos missions run`,
and `kepos daemon`:

- total concurrent workers can exceed the documented 48 slots;
- only the daemon takes the scheduler lease, so `missions run` and the TUI can
  dispatch while another daemon owns planning;
- warm executors are per-process: a worker idling in the TUI is invisible to the
  daemon;
- token budget enforcement (D6) and per-task remote routing have no single point
  to sit behind.

## Target architecture

One owner per data directory. The daemon runs the WorkerPool, the
MissionScheduler and (phase 4) the budget governor. Clients — TUI, CLI,
future remote UIs — talk to it over a local RPC channel and hold no executors.

```
TUI / CLI / remote ──RPC──▶ daemon
                             ├─ WorkerPool (48 slots, warm executors)
                             ├─ MissionScheduler (lease owner)
                             ├─ Budget governor (phase 4)
                             └─ SQLite (existing durable state)
```

The RPC channel reuses the worker wire protocol already hardened in beta.5
(newline-delimited JSON, token auth, TLS beyond loopback, 1 MiB caps, request
timeouts). Daemon-liveness is handled by the client transparently spawning the
daemon on demand (`kepos daemon --home …` is idempotent thanks to the lease).

## Phases

Each phase ships independently, keeps every existing test green, and adds its
own tests. No phase changes tool semantics visible to the model.

### Phase 1 — daemon RPC surface (foundation)

Extend the daemon with the client-facing actions the TUI needs: `launch`,
`status`, `result`, `wait`, `review`, `cancel`, `cancelAll`, `events`,
`tasks`, `plans` (summaries), plus `health` (already exists). These wrap the
same WorkerPool calls the TUI uses in-process today.

- Keep `RemoteWorkerServer` untouched; build a `SchedulerHost` on the same
  line-delimited transport but with token from the data directory (no env
  sharing needed — same machine, same user).
- Acceptance: a scripted client can dispatch, poll, review and cancel a fake
  worker through the daemon; two clients share the 48 slots.

### Phase 2 — TUI switches to daemon dispatch

The TUI's global pool symbol is replaced by a `DaemonWorkerPool` adapter that
implements the WorkerPool interface over RPC. On daemon-unavailable (spawn
refused, RPC timeout), the TUI surfaces a notice and falls back to a local
pool with a clear warning banner — degraded, never silent.

- Migration detail: tasks created by an older in-process pool are readable as
  before (SQLite is the source of truth); only new dispatch goes through the
  daemon.
- Acceptance: ConPTY smoke passes end-to-end through the daemon; killing the
  daemon mid-task leaves receipts queryable from SQLite; the TUI banner shows
  the fallback state.

### Phase 3 — CLI and events alignment

`kepos missions run` gains the lease discipline (it dispatches through the
daemon or refuses when another owner lives), `RemoteWorkerPool.eventsSince`
stops being a stub (forwards `events` with `parentSessionId`), and the
constructor's stale-task sweep uses `ownerEpoch` instead of a bare
`alive(pid)` check so PID reuse cannot pin a task as running forever.

- Acceptance: two `missions run` invocations cannot double-dispatch one plan;
  a reused PID does not resurrect stale tasks; events flow through the daemon
  adapter.

### Phase 4 — budget governor ( prerequisite for D6 )

The daemon owns a running token ledger keyed by parent session, plan and
calendar day, fed from `usage` already collected in receipts (including
`cacheRead`). Limits and the over-limit action (pause-for-human vs cancel)
are the D6 decision; the governor only provides the enforcement point.

- Acceptance: a synthetic usage stream trips the limit and the configured
  action fires once, with a durable event.

## What this design does not do

- No cross-machine worker routing yet: the daemon schedules local executors;
  remote workers remain an explicit `--remote` choice.
- No change to the mission state machine, human gates or approval modes.
- No executors inside clients, ever: if the daemon dies, clients degrade to
  read-only over SQLite until it is back.

## Token efficiency workstream (runs alongside, independent of phases)

- Prompt-prefix stabilization: put the stable read-only policy text first in
  worker and supervision system prompts, role-specific text last, so provider
  prompt caches (Anthropic `cacheControlFormat`, OpenAI prefix caching) hit
  across tasks of the same profile.
- Surface `cacheRead` from usage in task details and summaries so cache
  effectiveness is visible (pi-ai already reports it).
- Delegate model routing: prefer an explicit cheaper model for read-only
  delegates; the daemon phase adds per-task model selection at dispatch.
- Incremental supervision already uses cursor-based events; keep review
  evidence deltas bounded (unchanged).
