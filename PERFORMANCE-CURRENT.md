# 当前性能与回归实测

## 性能测量纠正

旧 ttft-results 中首 token 全为 0 的结果无效。旧脚本未显式禁用自动发现扩展，无法把其 baseline 当作原生 Pi；也未校验实际助手回复，因此不能用旧平均值声称提速。

新版 `ttft-benchmark.cjs`：交替运行原生 Pi 和显式加载 Orbital 的新 JSON 模式进程，固定 low thinking、同一模型、同一短提示词、隔离 cwd 与数据；两组均禁用自动发现扩展。仅收到真实 text_delta 且最终回复包含验收标记时样本才有效；60秒上限。

本轮模型：openai-codex / gpt-6.1-sol，各3次。

| 指标（中位数） | 原生 Pi | Orbital | 差值 |
|---|---:|---:|---:|
| 进程启动到首个可见文本 | 3807.8 ms | 3871.6 ms | +63.9 ms |
| agent_start 到首个可见文本 | 2820.4 ms | 2835.9 ms | +15.5 ms |
| 启动到回合结束 | 3810.7 ms | 4097.8 ms | +287.0 ms |

**结论：没有证据证明整体提速。** 本小样本中扩展的首文本差异很小；原生Pi有一次14.9秒首文本异常等待。小样本、上游波动、新进程和缓存差异不能支持因果结论。

这不是旧版/新版 Orbital 的 A/B，不是已打开的 TUI 的像素绘制时间，也不是隐藏推理首token。之后的历史镜像时序修复尚未另作旧新延迟对比。不能把这组数据宣传成百分比性能改善。

## 当前回归

- `node terminal-smoke.cjs`：19项通过（真实Editor和SessionManager；宿主为测试替身）。
- `node session-store-test.cjs`：逻辑会话、幂等UID、冲突检测、归档恢复通过。
- `python conpty-test.py`：真实Windows ConPTY全链路通过；详见 conpty-current-results.txt。
- 真实终端覆盖聊天、历史恢复、项目切换、双子Agent并行及汇总、后台任务跨项目、新建会话、模型选择、成员新增删除、项目新增、鼠标、动态缩放、热重载。
- 新增镜像验收：对每个测试会话逐条比较Pi原始 user/assistant/toolResult 与Orbital镜像的content、数量和UID唯一性。

## SessionStore 当前定位

Pi JSONL 仍为唯一权威会话。Orbital SessionStore 是派生镜像/索引，不接管模型上下文、压缩或原生会话恢复。新旧会话建立映射；恢复时补录，agent_settled后同步，UID由logical session和Pi entry ID稳定派生。保留完整消息content，不再只抽取文本。

已修复message_end早于落盘造成漏写、不同测试共享临时父目录、损坏索引被静默重置、UID角色冲突及危险logical ID路径。

当前源码已提供 SQLite 写事务与 WAL、历史代际、capability/receipt API 和 warm worker 复用。SQLite 负责串行化各进程写入，并非单独的单写者服务。完整历史迁移和所有 Skill/MCP 授权链路仍需单独验收；服务器级 MCP 授权目前明确拒绝。


## 2026-10-28 源码优化回归

本轮减少历史同步中的重复 SQL 编译和元数据列表分配，未新增模型延迟 A/B 数据。不得由这些结构调整推导模型首 token 或整体提速百分比。

`npm test` 直接验证工作区，新增确定性的本地 RPC 生命周期及隔离安装验收。真实 Windows ConPTY 的启动、帮助、菜单、中止后重新打开及热重载已通过；另行验证了真实 Pi 的 RPC 空会话重置、十进程取消和父进程突然退出后的回收。这些新增检查均未发送模型提示词。


## 0.3.0-beta.2 本地渲染基准

`npm run benchmark:render` 的当前报告位于 `reports/render-benchmark.json`。1000 条合成历史，300 次缓存重绘与100次流式重绘，仅调用一次 `getBranch()`。本机样本：首次渲染约19.7ms，缓存重绘 p95 约0.43ms，流式重绘 p95 约0.40ms。使用简化主题、无终端绘制和无模型请求，不能用于宣称真实像素渲染或模型首 token 百分比提速。每次重跑报告会更新样本。

队列等待 `queueWaitMs` 与派发后 `firstTextMs` 已分别记录。真实模型 TTFT/token A/B 尚未重测。历史 Worker 记录仍在启动时载入，懒加载/保留策略尚待实现。
