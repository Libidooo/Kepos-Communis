<p align="center">
  <img src="docs/media/readme-hero.svg" width="100%" alt="Kepos Communis">
</p>

<p align="center">
  <strong>一位总理 Agent，一座议会，一个终端。</strong><br>
  你提出目标，总理调度代表执行；方向与关键决定由你掌握。
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.5.5-B52F3B?style=flat-square&labelColor=22201F" alt="版本 0.5.5">
  <img src="https://img.shields.io/badge/tests-605%20%E2%9C%94-22201F?style=flat-square&labelColor=55514A" alt="605 项测试">
  <img src="https://img.shields.io/badge/Node.js-24%2B-22201F?style=flat-square&labelColor=55514A" alt="Node.js 24+">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-22201F?style=flat-square&labelColor=55514A" alt="MIT 许可"></a>
</p>

<p align="center">
  <a href="#install"><strong>安装</strong></a> &nbsp;/&nbsp;
  <a href="#features">特性</a> &nbsp;/&nbsp;
  <a href="#workspace">快捷键</a> &nbsp;/&nbsp;
  <a href="#architecture">架构</a> &nbsp;/&nbsp;
  <a href="README.en.md">English</a> &nbsp;/&nbsp;
  <a href="docs/README.md">文档</a>
</p>

<!-- 截图位：docs/screenshots/hero-demo.gif —— 拍好后取消注释：
<p align="center"><img src="docs/screenshots/hero-demo.gif" width="100%" alt="Kepos 运行演示"></p>
-->

<a id="install"></a>
## 安装

需要 Node.js 24+。Windows 用户在 Windows Terminal 中运行；在旧控制台启动时，程序自动迁移到 Windows Terminal。Windows x64 安装包内置 fd 与 ripgrep，首次启动不联网下载。

```bash
npm install -g https://github.com/Libidooo/kepos-communis/releases/latest/download/kepos-communis-latest.tgz
kepos
```

此安装地址始终指向 GitHub 上最新的正式 Release；历史版本仍可在 [Releases](https://github.com/Libidooo/kepos-communis/releases) 下载。

源码运行：

```bash
git clone https://github.com/Libidooo/kepos-communis.git
cd kepos-communis
npm ci --ignore-scripts
npm start
```

首次启动后输入 `/login` 配置模型服务商，`F4` 选择模型。模型调用使用你的账户并产生费用。`kepos doctor` 检查运行环境；安装日志中的 `npm warn deprecated node-domexception` 来自上游依赖，不影响使用。

<details>
<summary><strong>数据目录与本地构建</strong></summary>

默认数据目录为 `~/.kepos`。多套配置通过 `kepos --home <directory>` 隔离。源码启动器在源码变化时自动重新构建。

本地构建安装包：完成依赖安装后运行 `npm pack`。发布版本见 [Releases](https://github.com/Libidooo/kepos-communis/releases)。

校验值、中转端点与排错见[安装指南](docs/installation.md)。

</details>

<a id="features"></a>
## 特性

### 议会

席位默认 48 个，`config.councilSize` 可调整。席位环绕成单环，红色五角星标记总理。席位符号表示状态：运行 ◉、排队 ◔、待命 ◌、失败 ⊘。同一工作小组的席位自动聚成小环。点击席位，中栏打开该代表的任务书案。

<!-- 截图位：docs/screenshots/council.png
<p align="center"><img src="docs/screenshots/council.png" width="88%" alt="议会"></p>
-->

### 议案

三栏布局：左栏代表席，中栏对话，右栏项目与会话。点击工具输出或思考过程可折叠、展开。状态栏的审批模式芯片可点击切换。正文超出屏幕时右侧显示滚动轨道。

<!-- 截图位：docs/screenshots/desk.png
<p align="center"><img src="docs/screenshots/desk.png" width="88%" alt="议案"></p>
-->

### 审批

| 模式 | 行为 |
| --- | --- |
| ⛨ 严格 | 门禁与 Kepos 数据仅限人工操作；预算追加逐案审批 |
| ⚖ 代理 | 总理核查证据后可批准门禁；单任务预算追加在 200 万 token 内由总理决定并留痕，超出呈报人工 |
| ⊙ 只读 | 移除写入工具，仅查看与汇报 |

代理模式下，`kepos_delegate` 的 `tasks[].tools` 可直接携带 `edit`/`write`：授权随任务生效、范围限项目目录、任务结束自动收回，全过程留痕。严格模式下由代表在任务中经 `kepos_grant` 申请，人类确认后生效。`bash`/`powershell` 不对代表开放，命令执行走人类掌管的 CLI 白名单。

预算截停时审批窗口自动前置，提供按建议额度批准、自定义额度、拒绝三种操作。

### 派发控制

- 派发前核对各席位模型的可用性，失效席位直接拒绝
- 单批并发上限 8 路，`config.maxBatchConcurrency` 可调整
- 预算按任务难度分档：查询 ≥20k、常规 50k、深度分析 100k–200k token
- 读取类任务通过 `readAllow` 授权路径；推演类任务声明直接作答

### 研究与证据

- 对外部事实、当前信息、项目代码、本机文件、用户材料、创作和闲聊选择不同资料路径，并记录路由原因
- 对规则置信度不足的请求增加一次受限模型分类；显式本地/离线范围优先，路由原因可由 `kepos_research_status` 查看
- 可配置 Brave Search 或 DuckDuckGo；可选 Finnhub 结构化行情，记录来源、数据时间与读取时间
- 搜索摘要只作线索；事实型回答检查是否读取来源、引用是否属于本轮证据，并可由隔离 verifier 逐条审阅主张
- 总理、代表和僚属可在获准范围内按文件名定位本机文件；实际读取继续受沙箱限制
- supported 主张的引文必须能在本轮对应来源摘录中找到；文件搜索披露扫描覆盖，覆盖不完整时不会把“未找到”说成确定事实
- 代表可申请执行已存在的项目验证脚本，结果带退出码、耗时和归档；写入工具的成功、失败与拦截也会留审计记录
- 失败、中断或超时的代表任务可从检查点新建 continuation；旧写入、MCP、CLI 授权不继承，恢复前先核查当前项目状态
- Pi SDK 执行自动上下文压缩；Kepos 记录压缩触发原因，并提示自动压缩成功或失败

### 记忆与工作流

代表记忆采用双时态存储，修正仅标记失效，历史可回溯。重复出现的流程可提议为技能。协作编制与任务书可保存为工作流模板，再次使用时一键实例化。

### 任务归档

每个任务留存 brief、transcript、report、decision 四份文档与索引。代表可读取自己分支的归档，读取不到其他代表的结论，保证结论独立形成。

<a id="workspace"></a>
## 快捷键

| 按键 | 操作 |
| --- | --- |
| `Enter` | 发送；议会中打开选中席位的书案 |
| `F1` | 帮助 |
| `F2` | 操作菜单（对话与项目 / 代表与编制 / 任务与审批 / 系统） |
| `F3` / `F8` | 当前会话任务 / 跨项目任务 |
| `F4` | 切换总理模型，选择跨重启保留 |
| `F5` / 点击 | 折叠、展开工具输出 |
| `F6` | 切换面板焦点 |
| `F7` / `/copy` | 复制最新完整回答 |
| `F9` / `F10` | 长程计划 / 议会 |
| `F11` | 收起侧栏，专注阅读 |
| `Tab` | 议会内切换席位图与任务列表 |
| `/` / `v` | 议会列表过滤 / 阅读完整产出 |
| `Ctrl+K` | 命令面板 |
| `Ctrl+X` | 中止当前轮次；议会中取消选中任务 |
| `Ctrl+End` | 回到最新消息 |
| `PgUp/PgDn` · 滚轮 | 滚动历史 |
| `Esc` | 逐层返回 |

上滚历史只暂停跟随，不影响运行中的任务。

<a id="architecture"></a>
## 架构

Kepos 基于 Pi SDK 构建。Pi 负责模型、认证与会话；Kepos 负责代表配置、执行池、长程计划、运行记录与界面。

```text
TUI 工作台 ── Pi SDK ── 模型服务商
    └─ 代表配置 / WorkerPool / MissionScheduler

CLI ───────── 认证、诊断、计划操作
daemon ────── 本地 RPC / 租约 / 执行池

执行池 ────── 僚属执行进程 ── 任务结果
    ├─ Pi JSONL：原始会话
    └─ SQLite：任务、计划、事件、回执、用量
```

| 机制 | 说明 |
| --- | --- |
| 执行池 | 并发上限 48，与席位数相互独立；同会话按序排队，复用进程前清空上下文 |
| 长程计划 | DAG 步骤与依赖；默认任务 15 分钟，超过 1 小时进入审批，单任务上限 4 小时（`defaultTaskSeconds` 等三项 config 可调） |
| 运行证据 | 分页读取；保存结果哈希、终态回执与逐任务 token 用量 |
| 权限 | 三档审批模式、读取范围、环境变量白名单、按任务授予 MCP 权限 |

TUI、CLI 与 daemon 尚未共用执行池，统一调度在开发中，见[架构文档](docs/architecture.md)。

### 限制

- 已配置 MCP 的权限需单独检查
- 进程重启后部分任务需人工核对
- 终态任务按[保留策略](docs/retention.md)清理，重要产出另行备份

约束详情见 [SECURITY.md](SECURITY.md)。

## 文档与开发

| 使用 | 工程 |
| --- | --- |
| [安装指南](docs/installation.md) · [产品说明](docs/product.md) | [架构](docs/architecture.md) · [统一调度](docs/unified-scheduling.md) |
| [daemon](docs/daemon.md) · [远程 Worker](docs/remote-worker.md) | [图谱契约](docs/graph-contract.md) · [画布](canvas/README.md) |
| [保留策略](docs/retention.md) · [安全说明](SECURITY.md) | [发布检查](docs/release.md) · [全部文档](docs/README.md) |

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
npm run test:terminal:sdk   # Windows 终端实机验证
```

---

<p align="center">
  <sub>Kepos 意为花园 · MIT License · <a href="THIRD_PARTY_NOTICES.md">第三方许可</a></sub>
</p>
