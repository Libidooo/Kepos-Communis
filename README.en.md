<p align="center">
  <img src="docs/media/readme-hero.svg" width="100%" alt="Kepos Communis">
</p>

<p align="center">
  <strong>One premier agent, one council, one terminal.</strong><br>
  You set the goal; the premier delegates across the council. Direction and key decisions stay with you.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.5.1-B52F3B?style=flat-square&labelColor=22201F" alt="version 0.5.1">
  <img src="https://img.shields.io/badge/tests-584%20%E2%9C%94-22201F?style=flat-square&labelColor=55514A" alt="584 tests">
  <img src="https://img.shields.io/badge/Node.js-24%2B-22201F?style=flat-square&labelColor=55514A" alt="Node.js 24+">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-22201F?style=flat-square&labelColor=55514A" alt="MIT license"></a>
</p>

<p align="center">
  <a href="#install"><strong>Getting started</strong></a> &nbsp;/&nbsp;
  <a href="#features">Features</a> &nbsp;/&nbsp;
  <a href="#architecture">Architecture</a> &nbsp;/&nbsp;
  <a href="README.md">中文</a> &nbsp;/&nbsp;
  <a href="docs/README.md">Docs</a>
</p>

<!-- Screenshot slot: docs/screenshots/hero-demo.gif — uncomment once recorded:
<p align="center"><img src="docs/screenshots/hero-demo.gif" width="100%" alt="Kepos in motion"></p>
-->

<a id="install"></a>
## 🚀 Getting started

Requires **Node.js 24+, npm and Git**. Works on Windows, macOS and Linux.

```bash
git clone --branch codex/tui-refresh https://github.com/Libidooo/kepos-communis.git
cd kepos-communis
npm ci --ignore-scripts
npm start
```

Once inside, run `/login` to configure a model provider, `F4` to pick the premier's model, then just say what you want:

> Survey this project — architecture, risks and docs, three parts. Do not modify files.

`F10` shows the council at work, `F3` task results, `F9` long-range plans. Model calls use your own account and may incur costs.

<details>
<summary><strong>.tgz install, releases and data directory</strong></summary>

```bash
npm install -g ./kepos-communis-0.5.1.tgz
kepos doctor --json
kepos
```

Build the package from source with `npm pack`. The default data directory is `~/.kepos`; isolate setups with `kepos --home <dir>`. See the [installation guide](docs/installation.md) for checksums, relay endpoints and troubleshooting.

A `npm warn deprecated node-domexception@…` during install is an upstream transitive-dependency notice from Google's auth chain — **a warning, not an error**; `added N packages` means the install succeeded.

</details>

<a id="features"></a>
## ✨ Features

### 🏛 The council · one ring, like the logo

The council seats **48 by default** (`config.councilSize` — a default, not a cap) and circles a single ring. A red star marks the premier at the centre; seat glyphs carry state (◉ breathing while running, ◔ queued, ◌ idle, ⊘ failed). Work groups gather into their own small rings — who collaborates with whom is visible at a glance. Click any seat and its desk opens in the middle column.

### 🗳 The desk · your workbench

Three panes: seats on the left, your conversation with the premier in the middle (your own words carry an amber edge bar), projects and sessions on the right. Tool output and thinking fold and unfold with a click; the approval-mode chip lives in the status bar — click it to switch regimes.

### 🔐 Three approval regimes · sovereignty stays with you

| Mode | Behaviour |
| --- | --- |
| **⛨ Strict** | Gates and Kepos data are yours alone; every budget increase pops a human dialog |
| **⚖ Proxy** | The premier may approve gates after checking evidence; budget increases within the per-task cap (2M) apply on the premier's assessment, audited — beyond it, you decide |
| **⊙ Readonly** | No mutating tools at all; observe and report |

Budget stops jump to the front: approve at the suggested amount, set a custom one, or refuse — one screen per case.

### 🧰 Dispatch discipline · earned in a live 48-seat exercise

- **Preflight**: every batch is checked against the model registry before spending anything — dead providers are named and refused
- **Batches of ≤8**: the measured concurrency safety line; a failure costs one batch, not the wave
- **Tiered budgets**: ≥20k lookups, 50k ordinary, 100k–200k deep analysis; heavy seats start wide
- **Evidence whitelists**: file-reading tasks get `readAllow`; judgement tasks are told to answer directly — no delegate burns its budget hunting files it cannot read

### 📚 Memory, skills, workflows

Representative memory is bitemporal — corrections mark, never erase. Repeated practices surface as skill proposals. A real collaboration's roster and mandates can be saved as a **workflow template** and re-instantiated in one step.

### 🗄 The archive contract

Every task files `brief / transcript / report / decision` plus an index. Representatives can read their own branch's archive — what was tried, what failed — but never each other's conclusions, so independent judgement is never contaminated by consensus.

<a id="architecture"></a>
## 🏗 Architecture

Built on the **Pi SDK**: Pi handles models, auth and sessions; Kepos handles seat configuration, the worker pool, long-range plans, run records and the interface.

```text
TUI workbench ── Pi SDK ── model providers
    └─ seat config / WorkerPool / MissionScheduler

CLI ─────────── auth, diagnostics, plan ops / local runs
daemon ──────── local RPC / leases / own pool

pools ───────── worker processes ── task results
    ├─ Pi JSONL: raw sessions
    └─ SQLite: tasks, plans, events, receipts, per-task usage
```

48 concurrent tasks is the per-pool cap (seat count is separate — default 48, configurable); TUI, CLI and daemon do not yet share one pool — see [architecture](docs/architecture.md) and [unified scheduling](docs/unified-scheduling.md). Beta boundaries are listed in [SECURITY.md](SECURITY.md).

## 📖 Docs & development

| Using | Engineering |
| --- | --- |
| [Installation](docs/installation.md) · [Product](docs/product.md) | [Architecture](docs/architecture.md) · [Unified scheduling](docs/unified-scheduling.md) |
| [Daemon](docs/daemon.md) · [Remote workers](docs/remote-worker.md) | [Graph contract](docs/graph-contract.md) |
| [Retention](docs/retention.md) · [Security](SECURITY.md) | [Release checks](docs/release.md) |

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
```

---

<p align="center">
  <sub>Kepos — a garden.</sub><br>
  <sub>MIT License · notices in <a href="THIRD_PARTY_NOTICES.md">THIRD_PARTY_NOTICES</a></sub>
</p>
