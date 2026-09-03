# CodeBurn 菜单栏 · 简体中文版

> 这是 [getagentseal/codeburn](https://github.com/getagentseal/codeburn) 的中文分支。CodeBurn 是一个本地运行、开源（MIT）的 AI 编程花费追踪器，
> 能读取 Claude Code / Codex / Cursor / Copilot / Gemini 等 41 种工具留在本机的会话文件，按模型、项目、任务类型拆分 token 用量和花费，数据不出本机。
>
> 本分支在上游基础上做了三件事：**全平台界面中文化**（命令行、网页仪表盘、macOS 菜单栏、Windows 托盘）、给右侧悬浮的 **Capacity Dock（容量面板）加上「自动收进屏幕边缘、鼠标划过即展开」**，以及一个可选的 **排行榜**。

## 安装

先装命令行（三个平台都需要，它负责读取数据）：

```bash
npm install -g codeburn
```

需要 Node.js 22.13 以上。装完就可以直接用了：

```bash
codeburn          # 终端仪表盘
codeburn web      # 浏览器仪表盘
```

### macOS 菜单栏应用（macOS 14+）

```bash
curl -fsSL https://raw.githubusercontent.com/TheCrazyAnt/codeburn/zh-hans/mac/Scripts/install-zh.sh | bash
```

脚本会从本仓库的 [Releases](https://github.com/TheCrazyAnt/codeburn/releases) 下载最新的 `CodeBurnMenubar-*.zip`，校验 SHA-256，安装到 `~/Applications/CodeBurnMenubar.app`，清除 Gatekeeper 隔离标记并启动。

手动安装也可以：到 Releases 下载 zip，解压后把 `CodeBurnMenubar.app` 拖进 `~/Applications`，然后在终端执行一次 `xattr -dr com.apple.quarantine ~/Applications/CodeBurnMenubar.app` 再打开。

### Windows 托盘应用

在 PowerShell 里执行：

```powershell
irm https://raw.githubusercontent.com/TheCrazyAnt/codeburn/zh-hans/windows/Scripts/install-zh.ps1 | iex
```

脚本会下载最新的 `.msi`、校验 SHA-256 并安装。也可以到 Releases 页面下载 `windows-v*` 版本的 `.msi` 双击安装。安装包未做代码签名，Windows SmartScreen 首次会拦截，点「更多信息」→「仍要运行」即可。

### Linux

用命令行和网页仪表盘即可，两者都已汉化：

```bash
codeburn          # 终端仪表盘
codeburn web      # 浏览器仪表盘
```

GNOME 桌面还有一个官方扩展（暂未汉化），装法见上游的 [gnome/README.md](gnome/README.md)。

## 语言

系统语言是简体中文时，各端自动显示中文。也可以手动指定：

```bash
codeburn lang zh-CN     # 强制中文
codeburn lang en        # 强制英文
codeburn lang --reset   # 跟随系统
```

这个设置存在 `~/.config/codeburn/config.json`，命令行、网页仪表盘和 Windows 托盘应用都会跟随它。macOS 菜单栏应用有自己的开关：设置 › General › 语言（跟随系统 / English / 简体中文），切换后点「立即重新启动」生效。

临时切换某一次命令的语言，可以用环境变量：`CODEBURN_LANG=en codeburn today`。

## Capacity Dock 自动隐藏

设置 → General → Capacity Dock → 打开「自动收进屏幕边缘」。开启后，面板平时只在屏幕边缘露出一小条，鼠标碰到边缘就滑出来，移开后自动缩回；点击面板可以固定展开。只在面板吸附在某条屏幕边缘时生效（拖成悬浮状态时不生效）。

命令行开关：

```bash
defaults write org.agentseal.codeburn-menubar CodeBurnCapacityDockAutoHide -bool true
```

## 排行榜（可选，默认关闭）

在弹窗的「排行榜」标签或 设置 › 排行榜 里用 GitHub 账号登录（设备码登录，不需要密码）并打开「参与排行榜」后，应用每小时把 **本月 / 累计的花费（美元）、token 总数、调用次数** 上传到 [codeburn-leaderboard.tangyishun9846.workers.dev](https://codeburn-leaderboard.tangyishun9846.workers.dev)，弹窗里的「排行榜」标签和网页都能看到榜单。榜单按 **本周 / 本月 / 累计** 三个周期，和 **产出（模型输出 token）/ 花费 / 活跃（连续活跃天数）** 三个指标自由切换，默认看产出。

- 永远不会上传：项目名、会话内容、文件路径、模型提示词、API key。
- 身份来自 GitHub（设备登录，不需要密码），一人一号；服务器会校验数字是否合理（累计不能倒退、单日增长上限、每百万 token 单价区间），异常账号自动隐藏。
- 随时可以在设置里「删除我的数据」，服务器端会整条删除。
- 后端是 Cloudflare Worker + D1，源码在 [leaderboard/](leaderboard/)，可以自己部署一套并在应用里改服务器地址（`defaults write org.agentseal.codeburn-menubar CodeBurnLeaderboardServer "https://你的域名"`）。

## 从源码构建

```bash
git clone -b zh-hans https://github.com/TheCrazyAnt/codeburn.git
cd codeburn && npm install

npm run build                    # 命令行 + 网页仪表盘
mac/Scripts/package-app.sh dev   # macOS 菜单栏应用（需要 Xcode 16+）
cd windows && npm ci && npm run tauri build   # Windows 托盘应用（需要 Windows + Rust）
```

翻译文件的位置：

| 端 | 文件 |
|---|---|
| 命令行 | `src/locales/zh-CN.json` |
| 网页仪表盘 | `dash/src/lib/locales/zh-CN.ts` |
| Windows 界面 | `windows/src/lib/locales/zh-CN.ts` |
| Windows 托盘菜单 | `windows/src-tauri/src/i18n.rs` |
| macOS | `mac/Sources/CodeBurnMenubar/Resources/zh-Hans.lproj/Localizable.strings` |

三端共用一个约定：**英文原文就是 key**，所以漏翻的词条会显示英文，不会出现空白或占位符。命令行侧可以用 `node scripts/merge-locales.mjs <目录> --write` 合并词条片段，它会检查占位符数量和类型是否对得上。macOS 侧用 `mac/Scripts/l10n/extract_keys.py` 列出界面文案。

## 与上游的关系

- 命令行工具（终端仪表盘、`codeburn web` 网页版）仍然直接使用上游的 npm 包，暂未汉化。
- 本分支会跟随上游版本更新；版本号形如 `0.9.23-zh1`，前半段对应上游版本。
- 上游作者：[AgentSeal](https://github.com/getagentseal)。协议 MIT，见 [LICENSE](LICENSE)。

## 英文原版说明

见 [README.md](README.md)。
