# Changelog

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


- Separate CLI parsing, authentication and diagnostics; extract workspace auth controls and model/session selection.
- Expand compact scheduler code and simplify mission dispatch and config merging while retaining command behavior.
- Add content-fingerprinted automatic builds for source startup; precompiled npm installs do not require a compiler.
- Add an ASCII Windows `start.cmd`; repair the global launcher to use the SDK application from any project directory.
- Save immutable expert configuration revisions; restore them in F2 without altering existing task snapshots.
- Support saved readonly tool presets and reject unsafe tools.


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
