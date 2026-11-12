# 安装

Kepos 需要 Node.js 24+。可以从源码运行，也可以安装构建好的 `.tgz` 包。

## 版本与下载

此源码版本在 `package.json` 中标记为 **0.5.5**。下方 GitHub 下载地址使用 `releases/latest` 和固定资产名，指向最新正式 Release；每次发布都需上传同一安装包的 `kepos-communis-latest.tgz` 别名。历史版本仍可在 [Releases](https://github.com/Libidooo/kepos-communis/releases) 页面下载。包尚未发布到 npm 公共仓库，安装取以下三条路径之一。

```sh
npm install -g https://github.com/Libidooo/kepos-communis/releases/latest/download/kepos-communis-latest.tgz
kepos
```

## 一行安装

`kepos` 的打包机制与 Pi 完全一致：npm 全局安装会把 `kepos` 垫片写进 npm 的全局 bin 目录（Windows 即 `%APPDATA%\npm`，已在 PATH），因此在**任意目录**打开 PowerShell / 终端输入 `kepos` 都能唤起——这一点不是配置出来的，是全局安装的自动结果。

**① npm 仓库（发布后可用，最推荐）**

```sh
npm install -g kepos-communis
kepos
```

包名已核验未被占用；执行 `npm publish`（需 npm 账号）后此路径即刻生效。

**② GitHub 直装（无需发布，任何能访问 GitHub 的机器都可用）**

```sh
npm install -g github:Libidooo/kepos-communis
kepos
```

npm 会拉取仓库并执行 `prepack` 构建（TypeScript 等构建依赖由 npm 自动安装），得到的垫片与①完全相同。

**③ 本地构建包（离线 / 内网）**

```sh
git clone https://github.com/Libidooo/kepos-communis.git
cd kepos-communis && npm pack        # prepack 自动构建，产出 kepos-communis-<版本>.tgz
npm install -g ./kepos-communis-<版本>.tgz
kepos
```

三条路径装完都建议跑一次 `kepos doctor --json` 自检环境（Node 版本、ConPTY、UTF-8 代码页）。升级同理：①②重跑安装命令即可，③重打包重装。

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

### 安装时的警告说明

安装过程可能输出以下**警告**，它们不是错误，安装会正常完成（看到 `added N packages` 即成功）：

- `npm warn deprecated node-domexception@1.0.0` —— 来自 Google 认证链的传递依赖（`@google/genai → google-auth-library → gaxios → node-fetch`），上游更新后自然消失，不影响运行。请勿手动 override 它：依赖它的 `fetch-blob` 需要旧版 API，强行换新版会在运行时破坏认证。
- 部分安全增强的 npm 配置会提示 "install scripts not yet covered by allowScripts"（涉及 `@google/genai` 与 `protobufjs` 的空操作脚本）——默认拦截即可，不影响功能。

真正的安装失败以 `npm error` 开头并中断（例如 Windows 下已存在同名命令时提示 `EEXIST`，按提示处理或换 `--force`）。

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
2. 用 `F4` 选择可用模型，然后输入目标。总理 Agent 组织工作，代表配置界定领域职责，僚属执行进程承载具体委派。
3. 用 `F3` 查看任务，`F9` 看长程计划，`F10` 打开议会。默认预置十个常用代表，可以在 `F2` 中调整。

### 界面出现方框符号、乱码或排线错位？

Kepos 的界面按 **Windows Terminal（ConPTY）+ UTF-8** 设计。在传统控制台（conhost）、GBK 代码页或不覆盖制表符的字体下运行，会出现：

- `★ ◉ ╭ ┤ ─` 显示为方框（□）——**字体问题**：终端字体换 **Cascadia Mono/Code**（Windows Terminal 自带）或 Sarasa Term SC
- 中文乱码——**代码页问题**：在 Windows Terminal 设置中启用 UTF-8，或启动前执行 `chcp 65001`
- 边框错位、排线断裂——**终端问题**：请在 **Windows Terminal** 中运行 `kepos`（传统 cmd/conhost 不支持 ConPTY 渲染）

运行 `kepos doctor` 可自动检测这三项并给出针对性提示。npm 安装时的 `deprecated` / `install-scripts` 字样是警告不是错误，看到 `changed N packages` 即安装成功——不要把 npm 提示句整段复制进命令行，只复制命令本身。

### 首次启动下载 fd / ripgrep 超时？

首次启动时，运行时会尝试下载两个文件搜索工具（`fd` 与 `rg`），下载源是 GitHub Releases——部分网络直连会超时：

```
fd not found. Downloading...
ripgrep not found. Downloading...
Warning: Failed to download ripgrep: The operation was aborted due to timeout
```

**Windows x64 用户不会再遇到这个问题**：安装包已内置 fd 与 rg（`vendor/win32-x64/`），启动时自动加入 PATH，首次启动零下载。其余平台按下方方式补齐（运行时会优先使用系统 PATH 里的工具，装好即生效）：

```powershell
# 方式一：包管理器安装（推荐，进入 PATH 后自动被采用）
winget install sharkdp.fd BurntSushi.ripgrep.MSVC
# 或 scoop install fd ripgrep

# 方式二：手动放置——把 fd.exe 与 rg.exe 放进：
#   %USERPROFILE%\.kepos\agent\bin\
```

手动下载可走任意可达渠道（GitHub 加速镜像等）：[fd releases](https://github.com/sharkdp/fd/releases)（`fd-v*-x86_64-pc-windows-msvc.zip`）、[ripgrep releases](https://github.com/BurntSushi/ripgrep/releases)（`ripgrep-*-x86_64-pc-windows-msvc.zip`），解压取其中的 `fd.exe` / `rg.exe`。也可临时设置 `HTTPS_PROXY` 后再启动一次，下载完成即不再需要。

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
