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

`kepos graph export <run-id> > graph.json` exports a run. `GraphStore.events(runId, cursor, limit)` is the incremental graph event API.
