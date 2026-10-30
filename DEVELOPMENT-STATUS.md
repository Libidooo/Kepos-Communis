# 当前开发状态 — 0.3.0-beta.5 准备中（2026-10-30）

分支 `codex/beta5-hardening` 已完成第一批加固：F10 图谱在真实 orbital-76 主题下不再崩溃（渲染异常退回工作台）、profile 修订哈希纳入 roleKey 并在恢复旧修订时清理多余字段、daemon 防重复启动且丢失租约时报错退出、远程 Worker 协议增加 1 MiB 缓冲上限/按会话过滤事件/1200 秒门禁/非回环强制 TLS、父会话间严格轮转（3 个以上会话有测试）、十席代表只初始化一次（删除后不再自动补回）、`orbital_worker` 支持按当前会话 taskId 复核、`/reload` 取消任务前先确认且关停清理必然执行、确认框中文化并默认"否"，README/CHANGELOG/画布/daemon/graph-contract 文档已与代码对齐。

- 验证：`npm run typecheck` 通过；`npm test` 74 项全部通过；无模型调用。本轮改动均带针对性测试（daemon 租约、远程协议四种失败、三父会话轮转、修订恢复、真实主题渲染）。
- 发布状态：GitHub 公开，Release 已发布（0.3.0-beta.4）；npm 尚未发布。
- F10 议会图谱已可用：静态分环布局、父子任务连线、鼠标拖动、详情气泡与席位状态配色；数据来自 `pool.tasks` 与 `scheduler.list()`（见 docs/graph-contract.md），不是 GraphStore。

## 已知问题与待决事项（需人类拍板）

- D1（已决策并实施，2026-10-30）主 Agent 绕过人工门禁：新增三态审批模式（F2 → 审批模式，存于配置）——严格（默认：拦截触碰门禁/Kepos 数据的 bash/edit/write，弹人工确认，无界面时直接拦截）、代理审批（模型可用 orbital_plan approve 自主批准并留痕）、只读监督（移除 bash/powershell/edit/write）。边界说明：严格/代理是确认与审计屏障，防顺手绕过不防刻意混淆；硬边界是只读模式，见 SECURITY.md。
- D2（已决策并实施，2026-10-30）子 Agent 沙箱：环境变量白名单（KEPOS_WORKER_ENV_PASSTHROUGH 可显式放行）、worker 内置读取沙箱扩展（永远拒绝 Kepos 数据目录与凭据位置；读取范围按次分派可调——默认 project 限任务目录，可声明 machine 或 readAllow 白名单）、mission_jobs 的 capability 改存哈希。边界：模型调用仍需自读服务商凭据（无模型代理架构前不可避免），见 SECURITY.md。
- D3（已决策并实施，2026-10-30）Windows 自启动：`kepos service` 从 sc.exe 系统服务改为当前用户登录触发的计划任务（PowerShell Register-ScheduledTask，免管理员权限；本机实测注册/查询/删除通过）。实测发现 schtasks /SC ONLOGON 命令行需要提权，与报告判断不同。语义限制：仅登录后运行，文档已注明。
- D4 TUI、CLI、daemon 各自维护 WorkerPool；需先写统一调度设计再实施。
- D5 四种模式、Tab 排队、Ctrl+K、计划步骤树等交互设想需先出界面草图再实现。
- D6（已决策并实施，2026-10-30）预算与表决：config.budget 支持 perTaskTokens/perTaskCost（到顶立即停止消耗、证据保留、通知等人）与 dailyTokens/dailyCost（当日累计到顶拒绝新派发）；orbital_delegate 支持按任务 budgetTokens（主 Agent 负责估计）；空转检测只标记 stalled+要求复核，不自动终止——严格审批模式下模型终止空转任务需人类逐次确认，代理模式留痕放行；新增 orbital_vote 表决工具（代表票来自产出末尾 VOTE 约定行，主 Agent 票标注"分派方"，结果由主 Agent 转述人类）；orbital_profiles 附带成员风险（连续失败/成功率）；TUI 任务详情显示空转标记与预算上限。强制点为进程级，D4 第 4 阶段上收 daemon 做全局强制。
- D7（已按推荐执行，2026-10-30，可一键回退）品牌红色统一为 `#B52F3B`：跟随最新展示图（v21–v23，含专门调色的 v23-red）；brand-voice.md 文字、正式 logo v14（17 处 #B3242A）与 README 徽章已同步替换；历史版本 SVG（v17/v18 等）作为档案保留原色。
- D8（已决策，2026-10-30）发版：本地版本号升至 0.3.0-beta.5、CHANGELOG 转正、打 tag `v0.3.0-beta.5`；不推送 GitHub、不发 npm——等真实模型验收通过后再发布，npm 届时由人类决定。
- 技术残留：RemoteWorkerPool.eventsSince 仍是返回空结果的桩（随 D4 统一调度处理）；跨进程执行器管理、真实模型长跑、干净环境安装与跨平台实机验收未做。

## 第三批：只有人类能做

- 真实模型验收（会产生费用）：覆盖 48 槽并发、十个角色、F10 图谱、Mission 人工门禁、预算闸门与表决流程。按测试产物时间推断，最后一次真实模型端到端测试在 10-28。
- 推送 GitHub、发 Release、是否发 npm。
- `recovery/` 清理（约 65MB：旧版本备份、自签 TLS 私钥、npm 缓存），删除需人类点头。

## 待办（2026-10-30 新增）

- **R1 中转商模型接入（已实施，2026-10-30）**：连接自定义 OpenAI/Anthropic 兼容中转端点、测试连通性、拉取模型列表。
  - CLI 三件套：`kepos relay add|test|models`（外加 list/remove）；探测双路径——先按运行时真实路径（全局 fetch，可能走系统代理），网络错误自动 `node:http` 直连兜底（本机实测发现 NODE_USE_ENV_PROXY 全局代理会拦 loopback，PI 的全局 dispatcher 也会接管 fetch）。
  - /login 集成：登录列表新增"中转商 / 自定义端点…"，引导流程含新增、从 cc-switch 导入（读 `~/.cc-switch/config.json`，key 引用 `$ANTHROPIC_AUTH_TOKEN` 跟随 cc-switch 当前激活项，不复制明文 token）、管理已有（测试/删除）。
  - key 安全：models.json 只写 `$ENV_NAME` 引用，明文 key 绝不落盘；粘贴的 key 仅用于当场探测。
  - 验证：95 项单元测试（含本地 mock 中转的探测分类/鉴权失败/直连兜底/cc-switch 解析）+ CLI 对本地 mock 的 add/test/models/list/remove 端到端实测。待人类用自己的真实中转做一次真实验收。

---

# 上一阶段状态 — 0.3.0-beta.4

本轮使用 code-simplifier 技能整理了 CLI、运行时认证、配置保存和调度代码，并加入自动构建、专家修订恢复、GraphStore、SQLite scheduler lease 和更简单的启动入口。重构保留既有命令、退出码和人工门禁行为；新增启动体验与配置修订管理另有针对性测试。

- 全局入口已备份并更新到 `T:\Kepos\kepos.cjs`，在用户目录验证过 `kepos doctor --json`；开发目录可 `npm start` 或双击 `start.cmd`。
- 源码启动会按内容指纹自动构建；已发布包直接运行编译产物。编译诊断走 stderr，不破坏 JSON stdout。
- F2 专家管理可查看/恢复旧修订，并配置只读工具范围。旧任务的配置快照保持不变。
- 自动化覆盖启动缓存、编译失败、发布包无编译器启动、修订幂等、恢复冲突、工具白名单及旧行为回归。
- Windows ConPTY 已实测专家修订恢复，直接检查 SQLite 中职责与工具范围确实恢复；未发送模型提示词。
- 已加入 Kepos Council 十角色目录（中英文名、role key、证据导向提示词和 Skill 使用边界）；代表配置快照保存 role key 与 Skill，F2 角色编辑默认使用角色目录，左栏更名为“代表席”。
- Council 角色目录扩展到学术、产品、工程和运营方向；学术角色按 academic-pipeline 的研究、写作、完整性、评审、修订和发表门禁拆分，主 Agent 仍可用自定义 name/role 自由创建代表。
- 新增政策研究、政策发布/评议和代码工程预设代表，并提供 `orbital_roles` 目录工具；主 Agent 可先按领域选 roleKey，再按需用 `orbital_skills` 验证 Skill。
- Council 角色定义已拆到 `terminal/council-roles/` 六个领域文件；安装器与安装验收改为递归复制/核对嵌套运行文件。

本轮验证：`npm run typecheck`、45项 `npm test`、旧回归、真实ConPTY修订恢复及打包产物启动均通过。打包白名单已包含最新 GraphStore/daemon 文件，产物约122KB，使用项目已有依赖验证，不是干净机器安装验收。全局启动入口已备份至 `recovery/launcher-d59531e1-5040-4278-99a8-96e5d580d8b4/`。本轮无模型调用。全局 PATH 入口已通过 `install-launcher.cjs --check` 核对，`kepos doctor --json` 从用户目录启动通过。

下面保留上一阶段的运行时验证记录。Run/Node/Edge/Event/Artifact 数据投影、SQLite scheduler lease、`kepos daemon`、远程 Worker 协议和事件归档已完成第一版；React Flow 适配的离线画布已提供，完整画布交互和跨机器路由策略仍待完成；GitHub 公开发布（Release 已发），npm 尚未发布。

---

# Kepos 开发状态 — 0.3.0-beta.4

本轮在 2026-10-28 完成长程运行基础的修复与验证，没有发布 npm/GitHub，也没有发送模型提示词。

## 完成的行为

1. WorkerPool：默认 48 个执行器槽位；正常完成后自动出队；父会话内 FIFO、会话间轮转；排队 AbortSignal/超时/取消；运行中的任务每 300 秒产生一次主 Agent 复核事件；退出确认前保留执行器槽位；池关闭后不再派发。单步默认 300 秒，超过 1200 秒的长程步骤必须经过人类门禁，安全上限 3600 秒。
2. Mission：局部步骤ID按计划隔离；事务认领；计划间共享预算；依赖证据传递；人工门禁批准；暂停时活动步骤收尾；CLI只运行指定计划；未知派发不重放。
3. 人类控制：F8跨项目、F9长程计划、F2审批；CLI `missions show/events/pause/approve/resume/cancel/run`。模型工具没有批准人工门禁的动作。
4. Token/性能：结果原文预览1600字符，分页最多6000字符，同步批量共享预览预算；事件cursor与受限检查点；历史/列表缓存；队列等待和派发后首文本时长分开记录。
5. 独立应用：兼容入口与npm入口统一；延迟绑定数据目录；单进程多home明确拒绝；默认主题随包安装。

## 本轮验证

- `npm run typecheck`：通过。
- `npm test`：31项通过，使用本地模拟执行器、真实SQLite和CLI，无模型调用。
- `npm run test:legacy`：通过，包含20项交互、14项数据库、12项真实本地RPC生命周期检查及安装/启动入口检查。
- `npm run test:terminal:sdk`：真实Windows ConPTY通过，覆盖启动、帮助、菜单、F8/F9、中止后重开、热重载；无模型提示词。
- `npm run test:package`：103个打包文件的白名单/完整性及打包后doctor通过。使用项目已安装依赖，尚不是全新机器npm registry安装验收。
- 90项混合排队工作负载：全部完成或按要求取消，容量不越界，receipt不被后续取消覆盖。

## 本地合成渲染样本

1000条历史，300次缓存重绘和100次流式重绘。最近样本首绘约19.96ms，缓存p95约0.38ms，流式p95约0.52ms，历史源读取1次。简化主题、无终端绘制和无网络/模型请求；不是端到端像素/模型TTFT。报告可通过 `npm run benchmark:render` 重现。

## 明确保留的后续工作

- Run/Node/Edge/Artifact统一图模型与流程图画布。
- 统一守护进程、跨OS进程共享执行器、PID重用下的所有权确认。
- 历史懒加载、事件归档、保留策略、模型费用预算与真实TTFT/token A/B。
- macOS/Linux实机、远程CI、干净机器安装与公开发布。

代码级回归和模拟压力测试不能替代服务商认证/真实模型长跑验收。故障、网络和账户额度依然可能影响执行。


## 2026-10-28 扩展冒烟结果

- React Flow 12 host fixture：`@xyflow/react@12.12.0` + React 19 + TypeScript 编译通过。
- Svelte 5 host fixture：`@xyflow/svelte@1.7.0` + Svelte compiler 编译通过（有 accessibility warning，组件宿主应继续配置键盘交互）。
- Remote Worker TLS：自签证书、token、health、submit、result 通过；无模型调用。
- Windows Service：执行 `sc.exe` 安装路径，系统返回 `OpenSCManager error 5 / Access Denied`；需要管理员 CMD 重试。


## Windows service smoke note

The source compilation issue in `terminal/index.ts` was corrected and `npm run typecheck` now passes. Installing `KeposScheduler` from the current restricted shell reached the OS service manager but returned Access Denied; use an elevated PowerShell and `C:\ProgramData\Kepos` for the real install.
