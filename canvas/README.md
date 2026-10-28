# Kepos Graph Canvas

`graph.html` is an offline renderer for Kepos GraphStore exports. The JSON contract is React Flow 12 compatible (`run`, `nodes`, `edges`, `artifacts`), so the renderer can be replaced by `@xyflow/react` or `@xyflow/svelte` without changing the execution layer.

Export a run:

```cmd
kepos graph export <run-id> > graph.json
```

Open `graph.html` in a browser and load `graph.json`. The current renderer uses SVG/CSS so it works without a frontend dependency or network. Nodes show state, profile revision, checkpoint and errors; animated edges represent active dependencies.

The GraphStore export can later be mounted directly into React Flow or Svelte Flow; the current SVG canvas is dependency-free and keeps the same node/edge contract.

The host should import `@xyflow/react/dist/style.css` once. `GraphCanvas.tsx` is an optional React Flow 12 component with Controls, MiniMap, state-colored nodes and Approve/Stop callbacks. `GraphCanvas.svelte` provides the matching Svelte Flow-compatible node contract and keeps the same callbacks. Install the optional frontend peer dependency in the host UI project; the Kepos CLI does not require either package.
