# 安装

Kepos 需要 Node.js 24+。可以从源码运行，也可以安装构建好的 `.tgz` 包。

## 版本与下载

截至 2026-10-31，`codex/tui-refresh` 分支版本为 **0.3.0-beta.5**。最新公开 Release 是 [v0.3.0-beta.4](https://github.com/Libidooo/kepos-communis/releases/tag/v0.3.0-beta.4)，目前只有源码归档，没有安装附件。

下面的 `kepos-communis-0.3.0-beta.5.tgz` 由本地构建生成。它包含编译产物，但不捆绑 Node.js 和全部依赖；安装通常需要联网。

## 环境

- **Node.js 24 或更高版本**，以及 npm。可从 [Node.js 官网](https://nodejs.org/) 取得适合系统的版本。
- 使用交互式终端；Windows、macOS、Linux 使用同一个 Node CLI。
- 源码方式还需 Git。安装依赖时需能访问所用 npm registry；使用在线模型时另需访问对应服务。
- Pi 的三个依赖包（`pi-coding-agent`、`pi-ai`、`pi-tui`）当前均锁定为 `1.4.0`，由 npm 安装；不用另外全局安装 Pi。

先检查版本：

```sh
node --version
npm --version
```

## 源码运行

在准备存放项目的目录执行：

```sh
git clone --branch codex/tui-refresh https://github.com/Libidooo/kepos-communis.git
cd kepos-communis
npm ci --ignore-scripts
npm start
```

`npm ci` 按锁文件安装依赖。不要省略开发依赖：源码启动器需要 TypeScript，在构建缺失或源码变化时生成 `dist/`，构建匹配时直接启动。`--ignore-scripts` 跳过安装阶段的生命周期脚本，不会禁止后续启动器构建。

源码方式下，本文后续的 `kepos <参数>` 可替换为 `npm start -- <参数>`；例如：

```sh
npm start -- doctor --json
npm start -- --home ../kepos-trial
```

## 本地安装包

### 构建

维护者在已完成 `npm ci --ignore-scripts` 的源码目录执行：

```sh
npm pack
```

`prepack` 会先构建，再生成当前版本的 `.tgz`。这是本地打包，不会上传 GitHub 或发布 npm。包内带有运行所需的 `dist/` 等文件，但不把全部 `node_modules` 捆绑进去。

### 安装

取得可信的 `.tgz` 后，在文件所在目录执行；文件放在别处时请替换成本地实际路径：

```sh
npm install -g ./kepos-communis-0.3.0-beta.5.tgz
kepos --version
kepos doctor --json
kepos
```

安装后的包直接运行编译产物，不需要 TypeScript。请使用上述源码步骤或 `.tgz` 安装；当前未验证直接从 Git 地址全局安装的构建流程。

### 校验

安装前计算 SHA-256，并与交付者通过可信渠道提供的值核对。按系统选一条命令：

```powershell
# Windows PowerShell
Get-FileHash ./kepos-communis-0.3.0-beta.5.tgz -Algorithm SHA256
```

```sh
# macOS
shasum -a 256 ./kepos-communis-0.3.0-beta.5.tgz
# Linux
sha256sum ./kepos-communis-0.3.0-beta.5.tgz
```

校验值需要从可信渠道取得。只计算本地哈希，没有可对照的值，不能验证安装包。

## 首次使用

1. 启动工作台后输入 `/login`，选择模型服务商，由你完成认证。也可使用 `kepos login`。
2. 用 `F4` 选择可用模型，然后输入目标。总理 Agent 组织工作，代表配置界定领域职责，Worker 承载具体委派。
3. 用 `F3` 查看当前任务，`F9` 查看长程计划，`F10` 打开 48 席议会。默认预置十个常用代表，可以在 `F2` 中调整。

模型服务可能产生费用。`doctor` 成功只说明本地检查通过，不说明服务商认证、额度或模型调用已经可用。产品职责与人工决策入口见[产品说明](product.md)。

## 中转服务

自定义中转（relay）支持 `openai-completions`、`openai-responses` 和 `anthropic-messages`。先在本机环境变量中设置服务密钥，再注册你信任的地址。下面的尖括号内容必须替换：

```sh
kepos relay add my-relay "<baseUrl>" --api openai-completions --key-env KEPOS_RELAY_KEY
kepos relay models my-relay --enable "<model-id>"
kepos relay list
```

- `KEPOS_RELAY_KEY` 是示例环境变量名，不是密钥值；配置保存变量引用，不应把密钥放进命令历史或仓库。
- `relay add`、`test`、`models` 会联网探测指定服务，不是离线诊断。更新模型或环境变量后，完全退出 Kepos 并从新终端重启，再到 `F4` 选择；不要只依赖 `/reload` 更新环境。
- Worker 默认不继承任意密钥环境变量。若服务只通过环境变量认证，需明确把必要变量名加入 `KEPOS_WORKER_ENV_PASSTHROUGH`，不要透传整套环境。

命令概览见 `kepos --help`；凭证、环境白名单及 MCP 授权边界见[安全说明](../SECURITY.md)。

## 数据与隔离

默认使用当前用户的 `~/.kepos`；`~` 表示用户主目录，Windows 对应 `%USERPROFILE%`。

| 目录 | 内容 |
| --- | --- |
| `~/.kepos/agent/` | Pi 认证、模型与主题等配置；凭证通常在 `auth.json` |
| `~/.kepos/data/` | `orbital.sqlite` 协作状态、任务与运行证据；`sessions/` 保存 Pi 会话 JSONL |

试用、验收或多个环境应选不同的 home：

```sh
kepos --home ../kepos-trial
kepos doctor --home ../kepos-trial --json
```

后续登录、daemon 和查询命令也应使用同一 `--home`。`KEPOS_HOME` 可改变默认位置；显式 `--home` 会重新选择该环境的认证与数据目录。这是数据隔离，不是操作系统沙箱。

备份前应退出相关工作台并停止使用该 home 的 daemon，再备份整个 home。SQLite 不只是可随意删除的缓存；[保留策略](retention.md)会归档事件并清理超龄终态 Worker 及其回执，但不删除 Pi 会话 JSONL。不要将 home、数据库、凭证或终端捕获提交到仓库。

## 检查与排障

不调用模型的本地检查：

```sh
kepos --help
kepos --version
kepos doctor --json
```

| 现象 | 先检查 |
| --- | --- |
| 提示 Node 版本不足 | 当前终端的 `node --version` 是否至少为 24 |
| 安装后找不到 `kepos` | `npm prefix -g` 对应的命令目录是否在 PATH；重新打开终端 |
| 源码启动缺少编译器 | 在源码目录重新执行 `npm ci --ignore-scripts`，不要省略开发依赖 |
| `.tgz` 安装需要网络或依赖下载失败 | 包不是依赖离线镜像；检查 registry、网络与缓存 |
| 主会话能用中转，Worker 认证失败 | 检查必要密钥变量是否已明确透传，勿放宽所有环境变量 |

`test:package` 复用项目的 `node_modules` 检查包内容和启动入口。干净机器上的依赖下载、全局安装与启动，需要另外验证。

维护者参见[发布清单](release.md)；长期运行见 [daemon](daemon.md)，工程边界见[架构](architecture.md)。
