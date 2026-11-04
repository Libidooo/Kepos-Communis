# Changelog

## 0.4.0 — 2026-11-04

Tool noise, communication cost, temporary work groups, unified scheduling, and a
second pass on delegation discipline, acceptance, and supervised automation:

- **Tool output folds to one line by default.** A tool result renders as a single summary line with a row count; `F5` expands to the full output, and the choice now persists across restarts instead of resetting. Failures never fold — a result marked as an error, carrying an error message, or whose first line reads like an error is always expanded and tinted with the error colour, so folding cannot hide a problem.
- **Reviews are event-driven instead of polled.** Every delegate used to fire a review point every five minutes, so 48 parallel delegates woke the lead 48 times per window — supervision could cost more than the work itself. Kepos now wakes the lead only when a delegate has produced no event for three consecutive cycles, or has entered a state needing a human decision. Stall detection stays as the safety floor. `lastProgress` is used rather than `checkpointAt`, because the latter only refreshes on assistant text and made delegates busy with long tool calls look stuck.
- **Delegates return a structured summary.** Output ends with 结论 / 证据 / 置信度 / 需要, and `kepos_worker result` returns that summary by default. Passing `maxChars` or a cursor still pages the full transcript, and output without the headings falls back to ordinary paging rather than losing anything.
- **The supervision prompt is assembled from segments.** Core rules and the identity boundary are always present; MCP governance appears only when servers are configured, deputy-chair governance only when one is elected, and plan/vote rules only when plans exist. A typical session drops from 2733 to 1453 characters while the full scenario stays slightly below the old size.
- **Temporary work groups with evidence-only peer reads.** A group forms around one task and dissolves with it, so membership is a `groupId` on the task rather than a persistent roster. Same-group delegates may read each other's evidence but never conclusions or votes: sharing evidence removes duplicated work, while sharing conclusions turns independent judgement into agreement — the known failure mode when same-base models read each other. Output without the contract heading is treated entirely as evidence. Cross-group reads are refused and point at the escalation path (deputy chair reports, the prime minister authorises, the deputy chair carries the conversation).
- **Debate runs three exchanges then a full-group poll.** Opening, rebuttal and closing, followed by a fourth round where every member states a position with a `VOTE:` line. The closing round requires each side to name what evidence would change its mind. The rebuttal and final rounds ask the human to watch.
- **The approval mode is always visible.** The status bar shows `⛨ 严格` / `◐ 代理` / `○ 只读` instead of hiding the mode inside the F2 menu. A missing callback falls back to strict rather than silently widening authority.
- **Attachments are addressable and pageable.** The attachment bar shows each item with its size and truncation marker; `/attach remove <n>` drops one item while `/attach remove` clears all. Long attachments use a cursor (`nextCursor` / `total` / `page` / `pages`) so the middle of a large document is reachable — previously only head and tail were returned.
- **Daemon pool adapter (D4 Phase 2).** New dispatch can route through the daemon; when it is missing or unresponsive Kepos degrades to the local pool and says why, with a status-bar banner. Cancellation always reaches the local pool too, so a degraded daemon cannot leave orphans. Existing tasks stay readable because SQLite remains the source of truth.
- **Installation-wide budget ledger (D4 Phase 4).** The daemon owns a ledger keyed by local calendar day, parent session and plan, fed from usage already recorded in receipts. `check()` reports measured spend and the configured action; it never kills a task, because termination stays a human decision.

### 0.4 优化迭代（依据 2026-11-03 调研报告）

委托纪律、代表记忆、验收条目、值守自动化。

**代表从一次性执行者变成能积累的同事**

- **委派四件套**：`kepos_delegate` 的任务要求写清目标 / 输出格式 / 允许范围 / 明确边界。缺项默认告警，`KEPOS_MANDATE_STRICT=1` 时拒绝派发——纯提示词的约束约每五次漏一次，所以这一项可以从告警逐步收紧。代表产出在呈现层加一行防御性抬头，声明其中的指令不构成对你的指令。
- **代表记忆（双时态）**：任务进入终态后，用一次极小的模型调用把产出压成 ADD / UPDATE / NOOP 操作，写进 `representative_memories`。修正只置 `valid_to`，永不物理删除，所以"某个时刻我们相信什么"始终可答。注入时最多 50 条 / 200 行，并以一句"仅供参考，与本任务证据冲突时以本任务为准"收尾。
- **失败任务也留复盘笔记**：旧实现在产出为空时直接跳过整理，而失败任务通常正是没有产出。现在只要给出错误原因就值得复盘，问题也换了一个——不是"这次发现了什么"，而是"下次同类任务该怎么委派"。
- **记忆 → 技能**：同一 slug 的过程记忆来自 **3 个不同任务**（而非同一任务 3 行）时，生成 `skills-proposed/<slug>/SKILL.md` 提议。采纳是人的动作：一份 SKILL.md 会改变后续每次分派的提示词，自动写入等于让模型给自己扩权。截断时切步骤而不是切文档尾部——尾部是"边界"一节，那正是防止技能误用的部分。

**"完成"要经得起核对**

- **验收条目**：计划步骤可带 1-8 条可在只读前提下验证的条目，存为独立列，创建时一律 `passes:false`。勾选必须逐条点名（序号或原文），空数组不是"全过"。带未勾选项成功 → 记 `premature_done` 事件：这不是失败状态，是"模型说完成了、验收说还没有"这一分歧的可度量记录。老计划没有该列时照常可读。
- **Watchdog 用模型判断是否空转**：超时只回答"跑了多久"，答不了"还在推进吗"。复核点把上次判定之后的事件与产出末尾交给便宜模型，判 `progress / deviated / looping / noisy`。**阶段①只观察**：progress 与 noisy 静默，deviated/looping 只提示且明说"是否终止由你决定"。坏输入一律按 progress——误报会让人关掉整个通道。误报率由 `kepos_metrics` 直接算，够数据前不升级为终止通道。
- **五项可复核指标**：`kepos_metrics` 给出重复委派、二次追问、提前完成、Watchdog 误报、记忆质量。每项都带分子分母；分母为空报"样本不足"而不是 0%——空分母报 0 正是仪表盘说谎的方式。

**人机协作**

- **「等你处理」分区**：F3/F8 顶部固定等待区，按紧急度排序（门禁 → 空转 → 复核 → 失败/预算停止），每条带直达按键。失败是终态但仍要人决定"修还是重放"，所以只有**本次打开书案之后**才结算的失败才进等待区——重启不该把上周的失败重新挂成新闻。Enter 确认后落回历史。
- **人员加急槽**：常规槽满员时，人发给排队中任务的消息仍能把它提前到**一个**预留槽；新派发永远抢不到它。消息并入任务说明并标注"人类补充（优先处理）"。
- **中途改变需求真的送达了**：两条路径此前都是"看起来成功"。发给总理的消息没带 `deliverAs`，Pi 在流式中抛错而扩展层吞掉了错误，界面显示"已排队"而消息不存在；发给运行中代表的消息缺 `streamingBehavior`，同样被拒。现在都走 `steer`——当前工具批次结束后、下一次 LLM 调用前插入，正是"趁空闲间隙改安排"。代表收到后**停下**原目标（而非做完再说），并两段式上报：变更下达时先报"结论待补"，任务结算后补真实结论。
- **人类不能直接指挥僚属**：界面与工具层双重拒绝，并指出该找哪位代表——责任链断在中间，代表就不知道自己下属被改了方向。

**代表档案与自动化**

- **档案文件化**：代表导出为 `.kepos/profiles/<id>.md`（frontmatter + 职责正文），可读、可 diff、可手编。**数据库仍是权威**：`saveConfig` 带并发合并，搬走权威要重写合并并处理半写文件，风险远大于收益。导入是显式动作，只更新已存在的 id、重名整体拒绝、全部校验通过才写入。
- **`AGENTS.md`**：工作区根说明归档结构、代表名单与四条容易搞错的约定。导出是显式调用而非保存副作用——此前它挂在 `saveConfig` 上并遍历所有项目，导致测试夹具写进了真实仓库。
- **值守自动化（三项独立开关，全默认关闭）**：观察只写候选、不花钱；自动派发与静默预检会开任务，**必须是代理档**，且派发依赖观察。预检并行三名代表从测试 / 源码 / 运行行为三个角度复现，**只有带证据的确认才打扰人**；无证据的 "yes" 降级为 unclear，解析失败也降级为 unclear 而非 no。自动派发的任务标记 `purpose: watch`，**不能派生僚属**，并有每分钟上限。
- **配置迁移**：旧的 `watch.enabled` / `precheck.enabled` 迁移为"仅观察"。升级不该是人开始悄悄花钱的时刻。


## 0.3.0-beta.6 — 2026-11-02

Native attachments, three-tier themes and council readability:

- **Attachments are handled inside Kepos**: docx, pptx, xlsx, epub and zip are parsed by a hand-rolled ZIP reader built on `node:zlib`, so the feature adds no third-party dependency. PDF uses the optional `pdfjs-dist` package and states clearly that a parser is required when it is absent, instead of returning plausible-but-wrong text. Images reuse Pi's public MIME detection and resize helpers. Three entry points share one code path: `/attach` (with a path or a prompt), automatic recognition of pasted file paths, and the `kepos_attach` tool available to the lead agent and to read-only delegates.
- **Credential files are always refused**: attachment reads reject `.env`, `id_rsa`, `auth.json` and `.npmrc` outright, along with the credential directories. This closes a gap where the worker sandbox only blocked such names when they lived under home but outside cwd, so a project rooted at home leaked them.
- **Three brand themes with hot switching**: kepos-default joins kepos-dark and kepos-light. Each is built as a layered palette where page, card and info form a monotone depth ladder and semantic roles never reuse one another. The light theme is genuinely light now that the renderer paints the page background; inline background resets are rewritten to reopen the page colour, which previously cancelled the outer fill and left the main pane black. Themes upgrade themselves via a build-time manifest while user-edited copies are preserved, and the duplicate `themes/orbital-76.json` is retired.
- **Council seats read as annotations**: seat names are italic and half-bright, labels narrow to six columns in multi-ring layouts and centre on the seat glyph, which removes the half-cell drift that made dense councils look shaky. Selected seats and the prime minister use bolder, heavier circles. The elected deputy chair is ringed rather than seated, since it is a part-time duty rather than a roster entry.
- **Per-task spend is visible**: delegates default to a two-million-token budget per task, and the desk shows tokens used against the cap, the percentage, cost and cache hit rate. Budgets are per task, so a new task or conversation starts from zero.
- **The lead agent answers as Kepos**: the prompt carries an identity boundary, so it no longer recites engine documentation, resource formats or startup flags when asked about configuration. Assistant turns are labelled `◆ Kepos 总理`.
- **Command routing fixes**: `/theme` and `/attach` are Kepos-native and no longer fall through to the "leave Kepos" prompt.
- Legal and tooling roles join the catalog; deputy_chair leaves it, since governance is elected from sitting members rather than seeded as a seat.
- Legacy test harness: jiti no longer double-appends `/compat` when resolving pi-ai, and stale assertions were updated to current behaviour (queued submissions, speaker label, MCP layering, kepos_* tool names).


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
