# ◌ Kepos Communis

![Kepos Communis](docs/assets/kepos-logo-v5.svg)

> **把目标交给理事会，把执行过程掌握在手里。**

Kepos Communis 是一个独立的多智能体终端工作台。它使用 Pi SDK 负责模型、会话和认证，由 Kepos 负责任务拆解、专家协作、证据监督、长程调度和人类审批。

~~~text
┌──────────────────────────────────────────────────────────────────────┐
│  ◌ KEPOS COMMUNIS          Council · Workers · Missions · Evidence   │
│                                                                      │
│  人类目标  →  主 Agent  →  专家并行执行  →  证据汇总  →  人类决策      │
└──────────────────────────────────────────────────────────────────────┘
~~~

当前版本：**0.3.0-beta.4**。这是一个可从源码构建、可发布 npm 包的 beta 版本。

## 为什么是 Kepos

Kepos 把 Agent 当作一个可观察的协作系统，而不是一次性的聊天窗口：

- **监督优先**：主 Agent 掌握子任务状态、检查点、工具调用和最终证据。
- **证据优先**：子 Agent 的输出先以短预览返回，完整证据按任务句柄和游标读取，减少上下文浪费。
- **快照不惊扰**：角色、模型、工具和 Skill 在任务创建时固化为 profile revision；修改配置不会改变正在运行的任务。
- **长程可恢复**：Mission 是持久 DAG，支持依赖、暂停、人工门禁、取消和 SQLite 事件记录。
- **资源有边界**：WorkerPool 有队列、并发上限、超时和跨父会话轮转，拒绝用失控的进程换取速度。
- **设计可见**：三栏 TUI 展示人类、主 Agent、代表席和项目；任务图可导出给 React Flow 或 Svelte Flow。

Pi 是 Kepos 的引擎依赖，Kepos 是完整的应用层。模型认证仍由 Pi 的 ModelRuntime 提供，用户不需要单独安装全局 Pi。

## 下载与启动

### 从 GitHub 安装

~~~powershell
npm install -g github:Libidooo/kepos-communis
kepos --version
kepos doctor --json
kepos
~~~

如果你只想下载源码：

~~~powershell
git clone https://github.com/Libidooo/kepos-communis.git
cd kepos-communis
npm ci --ignore-scripts
npm start
~~~

Node.js 需要 **24 或更高版本**。源码启动器会根据源文件指纹自动构建；构建失败时不会偷偷加载旧产物。

### Windows PowerShell

命令可以从任意目录运行，不依赖当前目录：

~~~powershell
kepos
kepos login
kepos doctor --json
~~~

如果系统里已有旧的全局入口，在仓库目录重新安装入口：

~~~powershell
node .\install-launcher.cjs
~~~

这会生成一个 ASCII-only 的 Windows shim，实际路径以 Unicode 转义保存，避免中文用户目录和 CP936/UTF-8 切换导致 MODULE_NOT_FOUND。不要手写指向旧 kepos.cjs 的批处理文件。

## 第一次使用

1. 运行 kepos 打开 Kepos 工作台。
2. 输入 /login，选择模型服务商并完成认证。
3. 回到输入区，用自然语言描述目标。
4. 主 Agent 根据目标使用 orbital_delegate 分派只读专家任务。
5. 用 F3 查看当前会话任务，用 F8 查看跨项目任务，用 F9 查看长程计划。
6. 需要离开工作台时输入 /pi；回到 Kepos 时在 Pi 命令行输入 /kepos。

认证和数据默认保存到 ~/.kepos：

| 路径 | 内容 |
| --- | --- |
| agent/auth.json | API Key / OAuth 凭据，不要提交到 Git |
| agent/settings.json | Pi 与 Kepos 设置 |
| agent/themes/orbital-76.json | 默认主题 |
| data/sessions/ | Pi 权威 JSONL 会话 |
| data/orbital.sqlite | 任务、事件、结果、计划和图数据 |

需要隔离环境时使用 kepos --home <directory> 或 KEPOS_HOME。

## TUI 快捷键

Kepos 延续 orbital-76 的琥珀、灰绿、sage、rust 和 teal 语义色。建议终端至少 110×24。

| 按键 | 作用 |
| --- | --- |
| Enter | 发送目标 |
| F1 | 帮助 |
| F2 | 项目、会话、代表、分派和审批菜单 |
| F3 | 当前父会话任务 |
| F4 | 切换主 Agent 模型 |
| F5 | 展开/折叠工具输出 |
| F6 | 输入、项目、代表席之间切换 |
| F7 / /copy | 复制最新完整回答 |
| F8 | 当前会话/跨项目监控 |
| F9 | 长程计划监控 |
| Ctrl+← / Ctrl+→ | 切换任务证据 |
| Ctrl+X | 中止主 Agent 和本进程子任务 |
| Esc | 只回退到 Kepos 工作台，不露出 Pi |

常用斜线命令：/login、/logout、/copy、/reload、/pi、/kepos。

## 架构一览

~~~text
人类
 │
 ▼
Kepos TUI / CLI ──────── Pi SDK Runtime ──────── Model Provider
 │              \                              /
 │               └─ Auth / Session / Theme ───┘
 │
 ├─ Council Profiles → immutable Task Snapshot
 ├─ WorkerPool → queue → warm executor / RPC child
 ├─ MissionScheduler → DAG / gate / lease / recovery
 ├─ GraphStore → Run / Node / Edge / Event / Artifact
 └─ SQLite → receipts / checkpoints / retention archive
~~~

主 Agent 只接收必要的摘要；完整结果通过 orbital_worker、orbital_tasks 和 orbital_events 分页读取。Pi JSONL 是会话权威来源，SQLite 是 Kepos 的派生任务索引和监督视图。

## 专家角色与多智能体协作

F2 可以配置代表席，也可以让主 Agent 使用稳定的 roleKey 创建临时代表。预设按领域维护在 terminal/council-roles/，覆盖代码、学术、政策、出版、产品和核心运营角色，并支持中英文显示。

每个任务最多 300 秒、最多 10 个并行步骤。子 Agent 默认只获得 read、grep、find、ls 等只读工具；任务完成后返回短预览，完整证据留在 receipt 中。正在执行的任务使用自己的 profile revision，后续修改不会改变它。

## 长程任务、任务图与远程 Worker

~~~powershell
kepos missions
kepos supervise mission.json
kepos graph export <run-id> > graph.json
~~~

graph.json 兼容 React Flow 数据结构；canvas/GraphCanvas.tsx 和 canvas/GraphCanvas.svelte 是可嵌入宿主项目的画布组件，canvas/graph.html 提供无依赖预览。

启动跨进程调度器：

~~~powershell
kepos daemon --home C:\ProgramData\Kepos
~~~

跨机器 Worker 必须使用 token 和 TLS：

~~~powershell
$env:KEPOS_WORKER_TOKEN = 'replace-with-a-long-random-token'
kepos worker serve --host 0.0.0.0 --port 7788 --token $env:KEPOS_WORKER_TOKEN --tls-cert .\server.crt --tls-key .\server.key
~~~

远程协议支持 health、submit、status、result、cancel 和 events。生产环境还应配置网络 ACL、证书轮换和专用 Worker 账号。

## Windows 后台服务

在管理员 PowerShell 中执行：

~~~powershell
kepos service install --home C:\ProgramData\Kepos
kepos service start
kepos service query
~~~

卸载：

~~~powershell
kepos service stop
kepos service delete
~~~

服务安装使用 sc.exe 注册 KeposScheduler。如果看到 OpenSCManager error 5 或“拒绝访问”，请关闭当前窗口，右键 PowerShell 选择“以管理员身份运行”，再执行安装命令。

## 事件归档

~~~powershell
kepos retention --days 30 --max-events 100000
~~~

归档只处理 Worker、Mission 和 Graph 等派生事件，不删除 Pi 原始 JSONL。归档记录仍可以按 source、entity 和 cursor 查询。

## 开发与验证

~~~powershell
npm ci --ignore-scripts
npm run typecheck
npm test
npm run test:legacy
npm run test:terminal:sdk
npm run test:package
~~~

测试不需要模型调用；test:terminal:sdk 使用真实 Windows ConPTY 验证启动、帮助、菜单、任务监控、中止和热重载。test:live 会调用真实模型，可能产生费用，应单独执行。

## 项目结构

~~~text
src/                  CLI、认证、运行时、守护进程和服务入口
terminal/             TUI、WorkerPool、Mission、Graph、事件和角色预设
canvas/               React Flow / Svelte Flow / 无依赖画布宿主
themes/               orbital-76 默认主题
tests/                SQLite、队列、任务图、远程 Worker 和启动回归
docs/                 架构、守护进程、远程 Worker、保留策略和发布说明
~~~

## 许可

Kepos Communis 使用 MIT License。Pi SDK 及其传递依赖按各自上游许可证发布，详见 THIRD_PARTY_NOTICES.md。

欢迎通过 Issue 或 Pull Request 讨论新的 Council 角色、Worker 后端、画布宿主和调度策略。
