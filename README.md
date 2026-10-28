<p align="center">
  <img src="docs/assets/kepos-logo-v14.svg" alt="Kepos Communis — 让协作自然生长" width="620">
</p>

<p align="center"><strong>让协作自然生长。</strong></p>

<p align="center">
一个终端优先的多 Agent 花园：人类和 Agent 共同播种目标，协作代表照料并行工作，Kepos 让证据、计划和人类决策自然汇聚。
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="#工作方式">工作方式</a> ·
  <a href="#tui-工作台">TUI 工作台</a> ·
  <a href="#开发与验证">开发与验证</a>
</p>

<p align="center">
  <img alt="status beta" src="https://img.shields.io/badge/status-beta-B3242A?style=flat-square&labelColor=171717">
  <img alt="node 24+" src="https://img.shields.io/badge/node-%3E%3D24-0B2744?style=flat-square&labelColor=F2E9D8">
  <img alt="license MIT" src="https://img.shields.io/badge/license-MIT-171717?style=flat-square&labelColor=F2E9D8">
</p>

## 为什么是 Kepos

大多数 Agent 工具只展示一段聊天。Kepos 更像一座共同照料的花园：每个代表都有自己的工作台，成果可以被看见、复用和继续培育。

- **主 Agent + 协作代表**：主 Agent 负责任务拆解、派发和汇总；代表默认只读。
- **证据先于结论**：任务先返回短预览，完整产出通过任务句柄和游标读取。
- **任务配置冻结**：模型、工具、角色和 Skill 在任务开始时形成不可变 profile revision。
- **长程工作可恢复**：Mission 是持久 DAG，支持依赖、暂停、取消、人工门禁和恢复。
- **协作进入界面**：代表席、项目/会话、工具活动、任务证据和人类决策入口在同一 TUI 中自然汇聚。

Kepos 使用 [Pi SDK](https://github.com/badlogic/pi-mono) 负责模型、会话和认证；Kepos 负责协作基础设施。用户不需要额外安装全局 Pi。

## 快速开始

需要 Node.js **24 或更高版本**。

### 直接安装

```powershell
npm install -g github:Libidooo/kepos-communis
kepos doctor --json
kepos
```

### 从源码运行

```powershell
git clone https://github.com/Libidooo/kepos-communis.git
cd kepos-communis
npm ci --ignore-scripts
npm start
```

首次进入工作台后：

1. 输入 `/login`，选择模型服务商并完成认证。
2. 在输入区描述目标，交给主 Agent。
3. 让主 Agent 使用 `orbital_delegate` 分派只读代表。
4. 用 `F3` 查看当前任务、`F8` 查看跨项目任务、`F9` 查看长程计划。
5. 遇到人工门禁时，在 TUI 中明确允许、拒绝或暂停。

认证和数据默认保存在 `~/.kepos`。需要隔离环境时使用 `kepos --home <directory>` 或 `KEPOS_HOME`。

### macOS 与 Linux

macOS 和 Linux 使用同一个 Node.js CLI，不需要 Windows launcher 或 Windows Service：

~~~bash
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
nvm install 24
npm install -g github:Libidooo/kepos-communis
kepos doctor --json
kepos
~~~

认证 URL 会调用 macOS 的 `open` 或 Linux 的 `xdg-open`；如果桌面环境没有浏览器启动器，Kepos 仍会把 URL 打印到终端，可手动打开。长程任务可运行 `kepos daemon --home ~/.kepos`；Windows 专用的 `kepos service` 命令在这两个系统上会明确返回平台错误。

## 工作方式

```text
目标
  │
  ▼
主 Agent ── 拆解 ──> 代表席 ── 并行只读执行 ──> 证据
  │                                              │
  └────────────── 汇总、校验、请求人类决策 <──────┘
```

任务执行受到明确边界约束：子 Agent 的产出必须经过主 Agent 验证；只读代表不能替人类修改文件；人工门禁不能被模型或 Worker 自动批准；远程 Worker 必须使用 token 和 TLS。

## TUI 工作台

Kepos 的三栏工作台分别承载代表席、主会话和项目/对话。底部输入区负责目标、命令和任务控制；视觉主题使用花园纸、叶绿、薄荷、珊瑚、向日葵黄和天空蓝。

```text
Kepos · project-b (main) · gpt-6.1-sol · ctx 14% · 01:42              PLAN · 2 agents
────────────────────────────────────────────────────────────────────────────────────
代表席                  当前会话                                      项目 / 对话

● 主 Agent              › 设计一个可验证的多 Agent 工作流。           ▾ project-b
  PLAN · 工作中          ┊ 研究阶段 · 2 workers · 1 running             › 当前会话
○ 调研 Kiro             ┊ Read 官方文档 · ✓ 3 条证据                     ○ 旧会话
  ✓ 完成 · 32s
○ 调研 Gemini           ┊ $ npm test · 等待审批                         ▾ kepos
  · 运行中 · 01:08      └ 阶段摘要                                     ○ ConPTY smoke

────────────────────────────────────────────────────────────────────────────────────
                        › 输入目标…
                        Enter 发送 · Tab 排队 · Ctrl+X 中止 · @ 文件 · / 命令
────────────────────────────────────────────────────────────────────────────────────
F1 帮助   F2 操作   F3 任务   F4 模型   F5 工具   F7 复制   F8 全局   F9 计划
```

默认主题是 `orbital-76`。主题文件位于 `themes/orbital-76.json`；品牌标语是“让协作自然生长”。

## 核心能力

| 能力 | 作用 |
| --- | --- |
| Council / 代表席 | 配置稳定角色或临时 roleKey，按任务分派只读代表 |
| WorkerPool | 默认 48 个并发槽位、队列、每 5 分钟复核、跨项目轮转和 warm executor |
| Evidence | 结果摘要、完整产出、游标分页、哈希和不可变 receipt |
| Mission | 持久 DAG、依赖、暂停、取消、人工门禁和恢复 |
| GraphStore | Run / Node / Edge / Event / Artifact 图模型，支持 React Flow 和 Svelte Flow |
| Remote Worker | token + TLS 的 health、submit、status、result、cancel、events 协议 |
| SQLite | 任务、事件、结果、计划和归档的协作索引；Pi JSONL 仍是会话权威来源 |

## 架构

```text
人类目标
   │
   ▼
Kepos TUI / CLI ─── Pi SDK Runtime ─── 模型服务商
   │                       │
   ├─ Council Profiles      └─ Auth / Session / Theme
   ├─ WorkerPool → queue → warm executor / RPC child
   ├─ MissionScheduler → DAG / gate / lease / recovery
   ├─ GraphStore → Run / Node / Edge / Event / Artifact
   └─ SQLite → receipts / checkpoints / retention archive
```

## 常用命令与快捷键

```powershell
kepos login
kepos logout
kepos doctor --json
kepos missions
kepos graph export <run-id>
kepos daemon --home <dir>
```

| 按键 | 作用 |
| --- | --- |
| `Enter` | 发送目标 |
| `F1` | 帮助 |
| `F2` | 项目、会话、代表、分派和审批菜单 |
| `F3` | 当前父会话任务 |
| `F4` | 切换主 Agent 模型 |
| `F5` | 展开/折叠工具输出 |
| `F6` | 输入、项目、代表席之间切换 |
| `F7` / `/copy` | 复制最新完整回答 |
| `F8` | 当前会话/跨项目监控 |
| `F9` | 长程计划监控 |
| `Ctrl+X` | 中止主 Agent 和本进程子任务 |
| `Esc` | 回退到 Kepos 工作台 |

子 Agent 默认运行 5 分钟，主 Agent 每 5 分钟复核状态。子 Agent 可以通过 `copyOf` 创建一层复制委派，但子任务时限最多是父任务的一半，不能递归扩散。超过 20 分钟的步骤必须进入 Mission 并等待人类批准；单步安全上限为 60 分钟。默认启动十个稳定 Council 角色，任务可以继续扩充临时角色或复用既有配置。

## 开发与验证

```powershell
npm ci --ignore-scripts
npm run typecheck
npm test
npm run test:legacy
npm run test:terminal:sdk
npm run test:package
npm run audit:public
```

测试不需要模型调用。GitHub CI 在 Ubuntu、Windows 和 macOS 上运行 typecheck、核心测试、打包和公开仓库审计；`test:terminal:sdk` 使用真实 Windows ConPTY 验证启动、帮助、菜单、任务监控、中止和热重载；`test:live` 会调用真实模型，可能产生费用，应单独执行。

公开安全边界见 [SECURITY.md](SECURITY.md)。

更多资料：

- [架构说明](docs/architecture.md)
- [远程 Worker](docs/remote-worker.md)
- [任务归档](docs/retention.md)
- [画布接口](canvas/README.md)
- [开发状态](DEVELOPMENT-STATUS.md)
- [变更记录](CHANGELOG.md)

## 许可

Kepos Communis 使用 MIT License。Pi SDK 及其传递依赖按各自上游许可证发布，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

