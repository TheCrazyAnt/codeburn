# CodeBurn 菜单栏 · 简体中文版

> 这是 [getagentseal/codeburn](https://github.com/getagentseal/codeburn) 的中文分支。CodeBurn 是一个本地运行、开源（MIT）的 AI 编程花费追踪器，
> 能读取 Claude Code / Codex / Cursor / Copilot / Gemini 等 41 种工具留在本机的会话文件，按模型、项目、任务类型拆分 token 用量和花费，数据不出本机。
>
> 本分支在上游基础上做了这些事：
> - **全平台界面中文化**：命令行、网页仪表盘、macOS 菜单栏、Windows 托盘（含托盘右键菜单）。
> - **Windows 托盘应用补齐到和 macOS 一致**：六个周期（含 6 个月 / 累计）、日历选日、本地 / 合并多设备、19 种货币（含人民币）、套餐 / 趋势 / 预测 / 日历 / 脉搏 / 统计 / 优化 / 排行榜八个标签页。
> - 主数字旁直接显示 **token 总用量**（含缓存读写，和命令行、排行榜同一口径）。
> - 给右侧悬浮的 **Capacity Dock（容量面板）加上「自动收进屏幕边缘、鼠标划过即展开」**。
> - 一个可选的、默认关闭的 **排行榜**。
> - macOS / Windows **一键安装脚本**，装命令行 + 桌面应用并设为中文，重复运行安全。

## 安装

### macOS

一条命令装好命令行 + 菜单栏应用，并设为中文：

```bash
curl -fsSL https://raw.githubusercontent.com/TheCrazyAnt/codeburn/zh-hans/mac/Scripts/install-zh.sh | bash
```

只要命令行、不要菜单栏应用，在末尾加 `-s -- --cli-only`。菜单栏应用需要 macOS 14 (Sonoma) 以上。

### Windows

在 PowerShell 里执行，装好命令行 + 托盘应用：

```powershell
irm https://raw.githubusercontent.com/TheCrazyAnt/codeburn/zh-hans/windows/Scripts/install-zh.ps1 | iex
```

只要命令行：`& ([scriptblock]::Create((irm https://raw.githubusercontent.com/TheCrazyAnt/codeburn/zh-hans/windows/Scripts/install-zh.ps1))) -CliOnly`

首次安装托盘应用时会弹一次 UAC 确认框（安装包要把产品信息写进 HKLM，需要管理员权限），点「是」。托盘应用未做代码签名，首次运行 Windows SmartScreen 会拦截，点「更多信息」→「仍要运行」。

这条命令**重复运行是安全的**：已经装着同一个版本就会跳过；装失败时会把 Windows Installer 日志里真正的原因翻出来，而不是只给一个 1603。

如果装完敲 `codeburn` 报 `UnauthorizedAccess`，是 PowerShell 的执行策略拦住了 npm 生成的 `.ps1` 垫片，与本项目无关：改用 `codeburn.cmd`，或执行一次 `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`。

### Linux / 其他

只装命令行即可，终端和网页仪表盘都已汉化：

```bash
npm install -g https://github.com/TheCrazyAnt/codeburn/releases/download/cli-v0.9.23-zh5/codeburn-0.9.23-zh5.tgz
codeburn lang zh-CN
```

最新的命令行版本看 [Releases](https://github.com/TheCrazyAnt/codeburn/releases) 里 `cli-v*` 开头的那个。

### 装完怎么用

```bash
codeburn        # 终端仪表盘
codeburn web    # 浏览器仪表盘
```

三个平台都需要 **Node.js 22.13 或更高版本**。安装脚本会校验每个下载文件的 SHA-256。

用 nvm / volta 之类版本管理器的注意：桌面应用启动命令行时，会优先用**安装 codeburn 时所用的那个 node**，不受版本管理器"默认版本"影响——否则默认版本低于 22.13 时，桌面应用会显示「无法加载」却看不出和 Node 有关。

**关于 token 数字**：主数字旁显示的 token 用量**包含缓存读写**，和命令行的 `Tokens`、排行榜上报是同一口径。真实语料里缓存读取通常占 95% 以上，所以这个数会比「输入 + 输出」大一两个数量级；鼠标停上去能看到拆分。它是按消息 id 去重后的数，Claude Code 的日志会把同一条回复反复写入，不去重会多算一倍以上。

> ⚠️ 中文版命令行的包名和上游相同（`codeburn`），装上会替换掉英文版。如果之后执行了 `npm update -g codeburn`，会被上游英文版覆盖，重新跑一次安装命令即可。

## 语言

系统语言是简体中文时，各端自动显示中文。也可以手动指定：

```bash
codeburn lang zh-CN     # 强制中文
codeburn lang en        # 强制英文
codeburn lang --reset   # 跟随系统
```

这个设置存在 `~/.config/codeburn/config.json`，命令行和网页仪表盘跟随它。两个桌面应用各有自己的开关（跟随系统 / English / 简体中文）：macOS 在 设置 › General › 语言，切换后点「立即重新启动」；Windows 在设置面板里，切换后窗口和托盘右键菜单一起立即生效。

临时切换某一次命令的语言，可以用环境变量：`CODEBURN_LANG=en codeburn today`。

## Capacity Dock 自动隐藏

设置 → General → Capacity Dock → 打开「自动收进屏幕边缘」。开启后，面板平时只在屏幕边缘露出一小条，鼠标碰到边缘就滑出来，移开后自动缩回；点击面板可以固定展开。只在面板吸附在某条屏幕边缘时生效（拖成悬浮状态时不生效）。

命令行开关：

```bash
defaults write org.agentseal.codeburn-menubar CodeBurnCapacityDockAutoHide -bool true
```

## 排行榜（可选，默认关闭）

**看榜**：任何人任何系统，浏览器打开 [codeburn-leaderboard.tangyishun9846.workers.dev](https://codeburn-leaderboard.tangyishun9846.workers.dev) 即可，不用登录、不用装东西。也可以在终端里看：

```bash
codeburn leaderboard
codeburn leaderboard --board week --metric output
```

榜单按 **本周 / 本月 / 累计** 三个周期，和 **产出（模型输出 token）/ 花费 / 连续活跃（连续有调用的天数）** 三个指标自由切换。

**上榜**：三个平台都可以。

```bash
codeburn leaderboard login    # GitHub 设备码登录，终端里显示验证码
codeburn leaderboard join     # 开启共享并立即上传
codeburn leaderboard status   # 看自己的排名和共享状态
```

macOS 菜单栏和 Windows 托盘应用都可以在「排行榜」标签里一键完成（本机没有会话数据时这个标签也在）。

**隐私**

- 只上传汇总数字：花费（美元）、token 总数、调用次数、活跃天数，以及按服务商的花费拆分。
- 永远不会上传：项目名、会话内容、文件路径、模型提示词、API key。
- 身份来自 GitHub（设备码登录，不需要密码），一人一号。服务器会校验数字是否合理（累计不能倒退、本月不能超过累计、单日花费增长上限、每百万 token 单价区间），异常上报会被标记隐藏；标记不粘滞，下一次正常上报就恢复。
- 随时可以退出或删除：`codeburn leaderboard leave` 停止共享，`codeburn leaderboard delete` 让服务器整条删除你的数据。
- 后端是 Cloudflare Worker + D1，源码在 [leaderboard/](leaderboard/)，可以自己部署一套并改服务器地址（命令行用 `CODEBURN_LEADERBOARD_SERVER` 环境变量，macOS 用 `defaults write org.agentseal.codeburn-menubar CodeBurnLeaderboardServer "https://你的域名"`）。

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

- 命令行、网页仪表盘、两个桌面应用都已汉化。命令行以本仓库 Releases 里的 `.tgz` 分发（`npm install -g codeburn` 装到的是上游英文版）。
- 本分支会跟随上游版本更新；版本号形如 `0.9.23-zh7`，前半段对应上游版本，`zhN` 是本分支的第 N 次发布，三个端各自计数。
- Windows「应用」列表里的版本号从 zh8 起显示为 `0.9.23.N`（N 就是 zhN 的序号）；zh7 及更早都显示 `0.9.23`。应用内设置面板显示 `0.9.23-zhN`。
- 上游作者：[AgentSeal](https://github.com/getagentseal)。协议 MIT，见 [LICENSE](LICENSE)。

## 更新记录

**2026-09-05** · windows `zh8`
- MSI 版本号带上发布序号（`0.9.23.8`），Windows「应用」列表能分清装的是哪一版；安装包文件名也带 `zh8`。
- 安装脚本：已装同一个包时跳过，重复运行安全；MSI 失败时从日志翻出真实原因；首装主动提权。

**2026-09-04** · mac `zh13` · windows `zh7` · cli `zh5`
- Windows 托盘应用补齐到和 macOS 一致（周期、日历、本地/合并、货币、八个标签页、托盘菜单跟随语言）。
- 主数字旁显示 token 总用量（含缓存）；macOS 修复分标签页显示过期数字的问题。
- 桌面应用优先用安装 codeburn 的那个 node，修复版本管理器默认版本过低导致的「无法加载」。
- Windows「打开 GitHub」改为主线程直接调用 `ShellExecuteW`，修复静默失败；所有链接失败时显示原因。
- 安装脚本：重复运行跳过同一版本、MSI 安装失败时给出真实原因、首装提权；CI 真装 MSI 并验证重复运行。
- 排行榜后端：去掉误报的活跃天数规则，标记改为不粘滞。

**2026-09-03** · mac `zh1`–`zh10` · windows `zh1`–`zh3` · cli `zh1`–`zh5`
- 四个端的简体中文界面；Capacity Dock 自动隐藏；排行榜（后端、命令行、macOS、Windows）；人民币等货币换算。
- 一键安装脚本（macOS / Windows），修复 Windows 上 PATH、执行策略、npm 垫片等一串坑。

## 英文原版说明

见 [README.md](README.md)。
