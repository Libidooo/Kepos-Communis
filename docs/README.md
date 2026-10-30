# 文档

先了解产品职责，再安装试用；工程实现、运行边界与维护说明按需阅读。仓库版本和公开 Release 可能不同，以[安装说明](installation.md#版本与下载)的区分为准。

## 使用产品

- [产品说明](product.md)：一位总理 Agent、48 个代表席，以及人与 Worker 的分工。
- [安装](installation.md)：源码启动、本地 `.tgz` 安装、首次认证、中转服务、数据隔离与校验。
- [品牌与表达](brand-voice.md)：名称、产品语言和视觉表达的使用边界。

## 理解工程

- [架构](architecture.md)：Pi 底座与 Kepos 协作层、当前本地池、生命周期和源码入口。
- [Graph 契约](graph-contract.md)：GraphStore 投影、图数据接口与 F10 实时视图的区别。
- [本地画布](../canvas/README.md)：加载图数据的 SVG 画布；画布离线不表示整个应用可离线使用。
- [统一调度](unified-scheduling.md)：向单一调度所有者迁移的设计与阶段；不代表各客户端已全部接入 daemon。

## 维护与边界

- [daemon](daemon.md)：前台调度服务、数据目录租约与 Windows 登录启动。
- [远程 Worker](remote-worker.md)：显式远程执行协议及 token、TLS 要求。
- [归档与保留](retention.md)：事件归档、超龄终态任务清理及 Pi 会话历史的边界。
- [发布清单](release.md)：构建、打包和独立验收项目；清单不是通过记录。
- [安全说明](../SECURITY.md)：认证、应用层审批、只读工具、MCP 例外与本地 RPC 信任边界。
- [变更记录](https://github.com/Libidooo/kepos-communis/blob/main/CHANGELOG.md)：仓库版本变化。
- [开发状态](https://github.com/Libidooo/kepos-communis/blob/main/DEVELOPMENT-STATUS.md)：已完成工作与待办。

变更记录和开发状态通过 GitHub 查看，请按所用版本选择对应分支或标签。
