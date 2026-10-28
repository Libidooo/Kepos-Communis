# Kepos 架构总览

```text
Kepos CLI / SDK workspace
        │
        ├── Pi ModelRuntime + AgentSessionRuntime
        ├── Kepos extension / TUI
        │       ├── WorkerPool → local RPC workers
        │       ├── MissionScheduler → bounded DAG steps
        │       └── GraphStore → Run / Node / Edge / Event / Artifact
        ├── SchedulerLease → one daemon owner per data directory
        └── SQLite → config, sessions, workers, missions, graph, archive
```

Pi JSONL remains the authoritative conversation. SQLite stores derived mirrors, task state, leases, graph projection and archived events. Worker configuration is copied into immutable `profileSnapshot` and `profileRevision` when a task is accepted. Queue wait and dispatch-to-first-text are measured separately.

The UI reads summaries and cursors. It reads full evidence only after a human or the main Agent selects a task. The graph layer does not own execution; it is a projection that can feed the dependency-free SVG canvas today or React Flow/Svelte Flow later.
