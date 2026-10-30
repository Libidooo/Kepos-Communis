# Graph contract

`GraphStore.toReactFlow(runId)` returns:

```json
{
  "format": "react-flow@12",
  "run": {"id":"...","goal":"...","state":"RUNNING"},
  "nodes": [{"id":"...","type":"kepos","position":{"x":0,"y":0},"data":{"label":"...","state":"RUNNING"}}],
  "edges": [{"id":"...","source":"...","target":"...","type":"smoothstep","animated":true}],
  "artifacts": []
}
```

Node state and edge animation are presentation hints. The database graph tables remain the source for graph queries. `canvas/graph.html` loads this JSON locally without a network dependency; a React Flow or Svelte Flow adapter can consume the same objects.

The live terminal graph is opened with `F10`. It does **not** read `GraphStore.events`: the terminal view (`terminal/index.ts`, `Desk.graph.snapshot`) reads `pool.tasks` plus `scheduler.list()` (including `NEEDS_HUMAN` gate jobs) and renders them through `terminal/graph-view.ts`. `GraphStore.events(runId, cursor, limit)` remains the incremental event API for stored graph runs. The old standalone graph export command is retired.
