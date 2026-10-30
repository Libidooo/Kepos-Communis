# Changelog

## 0.3.0-beta.5 — 2026-10-30

Exit and failure-surfacing fixes (2026-10-31 round):

- **Exiting Kepos can no longer leave workers behind**: Windows console close kills the process without Pi's graceful shutdown (SIGHUP is handled POSIX-only), so `session_shutdown` never ran and warm executors lingered until their parent-death heartbeat fired. The extension now registers a process-level last-gasp cleanup — `pool.hardKill()` (synchronous SIGKILL of every running executor, no DB writes) on `exit`, plus a win32 `SIGHUP` handler that kills and exits; registered once per process so `/reload` cannot stack handlers.
- **Delegate failures are loud instead of sailing past**: a worker that dies at startup (e.g. pi rejecting launch args) used to leave only a 4-second "子 Agent X：失败" notice with the reason buried in task detail. Failure-family terminal states (失败/超时/已中断) now ring the terminal bell and surface the error reason directly in the notice; 空转 (stalled) and 预算到顶 (budget stop) alerts ring too.
- **Cancel settles promptly when the process is already gone**: cancelling a task whose worker already exited used to park it in CANCEL_REQUESTED until the 10-second cleanup timer, looking like "cancel does nothing". The cancel path now detects a dead process and settles immediately.
- Desk → worker message forwarding wired correctly: the call is awaited and fetches the live capability via `pool.liveHandle` (a literal capability string could never pass hash authorization).

Design-review fixes (2026-10-30 evening round):

- **Mission dispatch works against the real pool again**: `WorkerPool.authorize` hashes the presented capability, so the scheduler's hashed DB handle used to fail authorization and every dispatched step was misread as `FAILED "Worker UNKNOWN_HANDLE"` (cancel/deadline cancels silently no-oped, workers ran to their own deadline). Raw capabilities now live only in the dispatching process (scheduler `liveHandles` + pool `capabilities`); the database keeps hashes; a scheduler that lost them recovers via `pool.liveHandle` in-process or hands the step to `NEEDS_HUMAN` honestly instead of faking a worker failure. Cancelled plans settle their orphaned steps as CANCELLED.
- **Gate approval over RPC follows the approval policy**: `plan approve` on the SchedulerHost was executable by anyone holding `scheduler.token` regardless of the strict posture; it is now proxy-mode-only (strict/readonly get an actionable refusal). The default is fail-safe strict. `scheduler.token` is written 0600 where the OS honors it, and the boundary is documented in SECURITY.md.
- **Daemon takes the lease before opening the RPC port**: a second daemon can no longer publish/clear the shared `scheduler.port` file; on exit the port file is only removed when it still points at our own listener (a crashed daemon no longer has its endpoint clobbered by the next process).
- `kepos relay add` persists and probes the effective (normalized) URL — it used to save the raw input while probing could pass via a `/v1` candidate, so OpenAI-style relays added through the CLI 404'd at call time; behavior now matches the TUI flow.
- F10 council graph: multi-ring layouts assign sequential seat indexes (selection, click-hit and Ctrl+X were addressing `index: 0` nodes), single-ring slot collisions probe to the next free seat instead of silently overwriting one, and the pending-approval symbol comment now matches the committed `⚠` decision.

Security and approval hardening (D1-D2, human-approved decisions):

- Three-mode approval policy (F2 → 审批模式, default strict): tool_call interception asks the human before bash/edit/write touches human gates or Kepos data; proxy mode lets the model approve gates via orbital_plan approve with audit notices; readonly supervision removes bash/powershell/edit/write from the main agent.
- Worker sandbox: whitelisted environment (KEPOS_WORKER_ENV_PASSTHROUGH for env-auth providers), a read-sandbox extension in every worker (Kepos data directory, credential stores and auth files always refused), and adjustable per-delegation read scope (project default, machine opt-in, readAllow lists). mission_jobs stores the capability as a hash.

Scheduling and daemon:

- **Unified scheduling Phase 1 landed**: `kepos daemon` now exposes the SchedulerHost RPC on 127.0.0.1 (endpoint + token persisted in the data directory) with launch/status/result/wait/review/cancel/cancelAll/tasks/events/plans actions, plus SchedulerClient with daemon discovery from the data directory — the foundation for TUI/CLI dispatch through one shared 48-slot pool.
- The daemon fails loudly: duplicate start throws, a lost lease rejects run() with an error, failures exit non-zero with the reason.
- Approved unified scheduling design (docs/unified-scheduling.md): daemon-owned dispatch in four phases; process-level budget enforcement moves to the daemon in phase 4.
- Windows autostart replaced the broken sc.exe service with a per-user logon scheduled task (no admin required, verified end to end).

Workspace and council:

- Relay providers: `/login` now offers 中转商/自定义端点 — guided setup for OpenAI/Anthropic-compatible relays with connectivity probing (dual-path: runtime fetch first, raw direct fallback when a global proxy swallows loopback), model listing and enablement. CLI trio `kepos relay add|test|models` (plus list/remove). Keys are never written to disk: models.json keeps `$ENV` references, and cc-switch providers can be imported following the active `$ANTHROPIC_AUTH_TOKEN`.
- Budget gates: per-task token/cost caps (orbital_delegate budgetTokens) stop spend mid-run with evidence kept; daily caps refuse new dispatch; stalled tasks are flagged for review — termination is the human's call, confirmed per call in strict mode.
- orbital_vote council voting: delegate votes via the VOTE output convention, the lead agent's own vote labeled as the dispatching party, tallies presented to the human; member risk notes in orbital_profiles.
- MCP temporary grants: the human configures servers in mcp.json; the main agent governs them and may grant configured servers per delegation (`tasks[].mcp` = true or an explicit list). Workers expose only the granted servers' tool patterns and the grant expires with the worker; readonly supervision refuses grants. The main agent itself keeps full access to configured MCP tools.
- Workspace completions: plan dependency tree, step rescheduling (scheduler.reschedule), gate veto flow, member Skill editing, project removal, Ctrl+K command palette, and mid-turn submission queueing.
- Token efficiency: worker and supervision prompts lead with stable policy text so provider prompt caches hit; cache-hit share and per-task cost surfaced in the usage meter and task details.

Earlier in beta.5 (10-29/10-30 hardening):

- Fix the F10 graph crash: orbital-76 `vars` colors (teal/blue/mauve) are emitted directly instead of going through theme lookups that throw; a failing frame now falls back to the desk with a notice instead of ending the process.
- Include `roleKey` in profile revision hashes (v2); restoring an old revision clears fields absent from the stored snapshot; draft/config save failures surface a notice.
- Harden the remote worker wire protocol on both ends: 1 MiB buffer caps, `events` requires and filters by `parentSessionId`, remote submits past the 1200 s human gate are rejected, and the client fails fast on unparsable/mismatched responses and enforces TLS beyond loopback.
- Dispatch now rotates strictly across three or more parent sessions; council seats seed exactly once so deleted members stay deleted.
- `orbital_worker` accepts the current session's `taskId` (foreground dispatches have no handle); `/reload` confirms before cancelling tasks and shutdown cleanup always runs; background dispatch rolls back launched workers on failure; mission dispatch cancels a worker left running by failed bookkeeping.
- Desk fixes: F3 resets to session scope, right column reserves its 4 header rows so the bottom row stays visible, confirm dialogs use Chinese options defaulting to No, and the mission menu only reports real changes.
- Terminal work from 10-29: static F10 graph with rings, parent-child edges, mouse dragging and a detail bubble; council seat state palette and right-aligned status.
- Documented: graph contract now reflects the F10 data source, canvas README notes the retired export command, daemon doc matches the scheduled-task autostart, README aligns copyOf / gate-reject / remote-TLS wording with the code; brand red unified on #B52F3B across doc, logo and badge.

## 0.3.0-beta.4 — 2026-10-28

- Add first Run/Node/Edge/Event/Artifact graph projection and graph cursor APIs.
- Add SQLite scheduler leases and `kepos daemon` for one scheduler owner per data directory.
- Add graph/lease, daemon CLI, cross-process control, remote Worker TLS protocol, event retention, canvas export and package startup verification.
- Add bilingual Kepos Council role catalog, evidence-first role prompts, Skill discovery, role keys, profile Skill snapshots, and the `代表席` panel naming.
- Expand the Council catalog with academic pipeline delegates (research, literature, methods, statistics, ethics, peer review, integrity, revision, reproducibility, visualization, monitoring) plus product, data, QA, operations, and prompt-evaluation delegates.
- Add preset Policy, Publication, and Code delegates plus the `orbital_roles` catalog tool for fast role selection; custom main-agent role definitions remain supported.
- Split the Council role catalog into six domain files with a shared type/index layer; make terminal extension installation recursive so nested role modules ship correctly.

## 0.3.0-beta.3 — 2026-10-28

- Simplify CLI parsing, workspace auth hosting, config merging, scheduler boundaries and startup diagnostics.
- Build source checkouts automatically by content fingerprint; keep the existing compiled entry only for published packages, not failed source builds.
- Add global `start.cmd`, repair PATH launcher and add `kepos` from any project directory.
- Add immutable profile history, readonly tool presets, F2 restore flow and SDK-owned authentication controls.
- Fix queued task dispatch after normal completion and after idle executor retirement; retain slots until process exit.
- Use per-parent FIFO with round robin between parents; handle queued cancellation, AbortSignal, deadlines and pool shutdown.
- Preserve frozen task profiles and stable revisions; split queue wait from dispatch-to-first-text measurements.
- Repair durable Mission lifecycle, plan-scoped job IDs, global Mission concurrency claims, explicit human gates and dependency evidence.
- Add local-human CLI and TUI plan controls; models cannot approve human gates.
- Add F8 global task monitoring, F9 Mission monitoring, entry caching and bounded local render metrics.
- Add safe incremental events, bounded checkpoints and paginated evidence previews.
- Unify compatibility and npm entry points; delay binding the data path until SDK app paths are chosen.
- Add Windows SDK ConPTY smoke and local no-model regression coverage.

Current boundaries: per-process WorkerPool, no detached execution after owner shutdown, no general graph canvas or complete revision-history UI. No model latency speedup is claimed.
