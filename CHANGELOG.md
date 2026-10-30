# Changelog

## 0.3.0-beta.5 — 2026-10-30

Security and approval hardening (D1-D2, human-approved decisions):

- Three-mode approval policy (F2 → 审批模式, default strict): tool_call interception asks the human before bash/edit/write touches human gates or Kepos data; proxy mode lets the model approve gates via orbital_plan approve with audit notices; readonly supervision removes bash/powershell/edit/write from the main agent.
- Worker sandbox: whitelisted environment (KEPOS_WORKER_ENV_PASSTHROUGH for env-auth providers), a read-sandbox extension in every worker (Kepos data directory, credential stores and auth files always refused), and adjustable per-delegation read scope (project default, machine opt-in, readAllow lists). mission_jobs stores the capability as a hash.

Scheduling and daemon:

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
