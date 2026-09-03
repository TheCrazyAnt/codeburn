#!/usr/bin/env bash
# ============================================================================
# CodeBurn 中文版 · 一键安装 (macOS)
#   curl -fsSL https://raw.githubusercontent.com/TheCrazyAnt/codeburn/zh-hans/mac/Scripts/install-zh.sh | bash
#
# 做的事情：
#   1. 安装中文版命令行（从本仓库 Releases 下载 .tgz，校验 SHA-256）
#   2. 把界面语言设为简体中文
#   3. 下载并安装菜单栏应用 CodeBurnMenubar.app（同样校验 SHA-256）
#   4. 清除 Gatekeeper 隔离标记并启动
#
# 只想要命令行、不要菜单栏应用：加 --cli-only
# 前提：Node.js 22.13+（用于 npm 安装命令行）。
# ============================================================================
set -euo pipefail

REPO="${CODEBURN_ZH_REPO:-TheCrazyAnt/codeburn}"
API="https://api.github.com/repos/${REPO}/releases?per_page=100"
APPS="${HOME}/Applications"
BUNDLE="${APPS}/CodeBurnMenubar.app"
EXE="CodeBurnMenubar"
CLI_ONLY=0
for arg in "$@"; do
  [[ "${arg}" == "--cli-only" ]] && CLI_ONLY=1
done

say() { printf '▸ %s\n' "$*"; }
die() { printf '✗ %s\n' "$*" >&2; exit 1; }

# 命令行是跨平台的，所以 --cli-only 在 Linux 上也放行；只有菜单栏应用是 macOS 专属。
if [[ "$(uname -s)" != "Darwin" ]]; then
  [[ "${CLI_ONLY}" == "1" ]] || die "这个脚本的菜单栏应用部分只支持 macOS。Windows 请用 windows/Scripts/install-zh.ps1；Linux 加 --cli-only 只装命令行。"
  command -v python3 >/dev/null 2>&1 || die "需要 python3 来解析 GitHub Releases。"
fi

command -v npm >/dev/null 2>&1 || die "没有找到 npm。请先安装 Node.js 22.13 或更高版本：https://nodejs.org"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
NODE_MINOR=$(node -p 'process.versions.node.split(".")[1]' 2>/dev/null || echo 0)
if [[ "${NODE_MAJOR}" -lt 22 || ("${NODE_MAJOR}" -eq 22 && "${NODE_MINOR}" -lt 13) ]]; then
  die "需要 Node.js 22.13 或更高版本，当前是 $(node -v 2>/dev/null || echo '未安装')。"
fi

TMP=$(mktemp -d /tmp/codeburn-zh.XXXXXX)
trap 'rm -rf "${TMP}"' EXIT

# 一次取回所有 Release，后面按标签前缀各取所需，避免重复请求触发 GitHub 限流
say "查询最新版本 (${REPO}) ..."
RELEASES="${TMP}/releases.json"
curl -fsSL -H 'Accept: application/vnd.github+json' "${API}" -o "${RELEASES}" || die "无法访问 GitHub Releases。"

# 用法: pick_asset <标签前缀> <资源名正则>  → 输出 "下载地址 校验地址 标签"
pick_asset() {
  python3 - "$1" "$2" "${RELEASES}" <<'PY'
import json, re, sys
prefix, pattern, path = sys.argv[1], sys.argv[2], sys.argv[3]
for release in json.load(open(path)):
    if not release["tag_name"].startswith(prefix):
        continue
    asset = next((a for a in release["assets"] if re.fullmatch(pattern, a["name"])), None)
    if not asset:
        continue
    checksum = next((a for a in release["assets"] if a["name"] == asset["name"] + ".sha256"), None)
    if not checksum:
        continue
    print(asset["browser_download_url"], checksum["browser_download_url"], release["tag_name"])
    break
PY
}

# 下载并校验，输出本地文件路径
fetch_verified() {
  local url="$1" sum_url="$2" dest="$3"
  curl -fL --progress-bar -o "${dest}" "${url}"
  curl -fsSL -o "${dest}.sha256" "${sum_url}"
  local expected actual
  expected=$(awk '{print $1}' "${dest}.sha256")
  actual=$(shasum -a 256 "${dest}" | awk '{print $1}')
  [[ "${expected}" == "${actual}" ]] || die "校验失败：期望 ${expected}，实际 ${actual}。"
}

# ---- 1. 中文版命令行 -------------------------------------------------------
read -r CLI_URL CLI_SUM CLI_TAG < <(pick_asset "cli-v" 'codeburn-.*\.tgz') || true
[[ -n "${CLI_URL:-}" ]] || die "没有找到带 .tgz 的 cli-v* 发布。"
say "下载命令行 ${CLI_TAG} ..."
fetch_verified "${CLI_URL}" "${CLI_SUM}" "${TMP}/codeburn.tgz"
say "安装命令行（npm install -g）..."
npm install -g "${TMP}/codeburn.tgz" >/dev/null 2>&1 || die "npm 安装失败。可以手动执行：npm install -g ${CLI_URL}"

CODEBURN_BIN="$(command -v codeburn || true)"
[[ -n "${CODEBURN_BIN}" ]] || die "命令行安装完成但 PATH 里找不到 codeburn，请重开终端后重试。"
say "设置界面语言为简体中文 ..."
"${CODEBURN_BIN}" lang zh-CN >/dev/null 2>&1 || true

if [[ "${CLI_ONLY}" == "1" ]]; then
  echo ""
  echo "✓ 命令行安装完成（${CLI_TAG}）"
  echo "  试试：codeburn      终端仪表盘"
  echo "        codeburn web  浏览器仪表盘"
  exit 0
fi

# ---- 2. 菜单栏应用 ---------------------------------------------------------
MACOS_MAJOR=$(sw_vers -productVersion | cut -d. -f1)
if [[ "${MACOS_MAJOR}" -lt 14 ]]; then
  echo ""
  echo "✓ 命令行安装完成（${CLI_TAG}）"
  echo "  菜单栏应用需要 macOS 14 (Sonoma) 或更高版本，当前是 $(sw_vers -productVersion)，已跳过。"
  exit 0
fi

read -r APP_URL APP_SUM APP_TAG < <(pick_asset "mac-v" 'CodeBurnMenubar-.*\.zip') || true
[[ -n "${APP_URL:-}" ]] || die "没有找到带 zip 的 mac-v* 发布。"
say "下载菜单栏应用 ${APP_TAG} ..."
fetch_verified "${APP_URL}" "${APP_SUM}" "${TMP}/menubar.zip"

say "解压 ..."
/usr/bin/ditto -x -k "${TMP}/menubar.zip" "${TMP}/unpacked"
NEW_APP=$(find "${TMP}/unpacked" -maxdepth 2 -name 'CodeBurnMenubar.app' | head -1)
[[ -d "${NEW_APP}" ]] || die "zip 里没有 CodeBurnMenubar.app。"
BUNDLE_ID=$(defaults read "${NEW_APP}/Contents/Info.plist" CFBundleIdentifier 2>/dev/null || true)
[[ "${BUNDLE_ID}" == "org.agentseal.codeburn-menubar" ]] || die "应用签名信息不符 (${BUNDLE_ID})，已中止。"

say "安装到 ${BUNDLE} ..."
pkill -x "${EXE}" 2>/dev/null || true
sleep 1
mkdir -p "${APPS}"
rm -rf "${BUNDLE}"
/usr/bin/ditto "${NEW_APP}" "${BUNDLE}"
/usr/bin/xattr -dr com.apple.quarantine "${BUNDLE}" 2>/dev/null || true

# 记录 CLI 路径，和官方 `codeburn menubar` 安装器保持一致
SUPPORT="${HOME}/Library/Application Support/CodeBurn"
mkdir -p "${SUPPORT}"
chmod 700 "${SUPPORT}"
printf '%s\n' "${CODEBURN_BIN}" > "${SUPPORT}/codeburn-cli-path.v1"
chmod 600 "${SUPPORT}/codeburn-cli-path.v1"

say "启动 ..."
open "${BUNDLE}"
echo ""
echo "✓ 安装完成"
echo "  命令行 ${CLI_TAG}：codeburn（终端） / codeburn web（浏览器）"
echo "  菜单栏应用 ${APP_TAG}：${BUNDLE}"
echo "  菜单栏右上角会出现 🔥 图标。首次连接 Claude 额度时，macOS 会询问是否允许读取钥匙串，请选择「始终允许」。"
