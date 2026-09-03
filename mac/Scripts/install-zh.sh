#!/usr/bin/env bash
# ============================================================================
# CodeBurn 菜单栏 · 中文版 一键安装脚本
#   curl -fsSL https://raw.githubusercontent.com/TheCrazyAnt/codeburn/zh-hans/mac/Scripts/install-zh.sh | bash
#
# 做的事情：
#   1. 从 GitHub Releases 下载最新的中文版 CodeBurnMenubar.app（zip + sha256）
#   2. 校验 SHA-256
#   3. 退出正在运行的旧版本，解压到 ~/Applications/CodeBurnMenubar.app
#   4. 清除 Gatekeeper 隔离标记（否则首次打开会提示"无法验证开发者"）
#   5. 记录 codeburn 命令行的路径，然后启动应用
# 前提：已安装 Node.js 22.13+ 并执行过 `npm install -g codeburn`（菜单栏应用靠它读数据）。
# ============================================================================
set -euo pipefail

REPO="${CODEBURN_ZH_REPO:-TheCrazyAnt/codeburn}"
API="https://api.github.com/repos/${REPO}/releases/latest"
APPS="${HOME}/Applications"
BUNDLE="${APPS}/CodeBurnMenubar.app"
EXE="CodeBurnMenubar"

say() { printf '▸ %s\n' "$*"; }
die() { printf '✗ %s\n' "$*" >&2; exit 1; }

[[ "$(uname -s)" == "Darwin" ]] || die "这个脚本只支持 macOS。"
MACOS_MAJOR=$(sw_vers -productVersion | cut -d. -f1)
[[ "${MACOS_MAJOR}" -ge 14 ]] || die "需要 macOS 14 (Sonoma) 或更高版本，当前是 $(sw_vers -productVersion)。"

if ! command -v codeburn >/dev/null 2>&1; then
  say "没有找到 codeburn 命令行。请先安装：npm install -g codeburn（需要 Node.js 22.13+），然后重新运行本脚本。"
  exit 1
fi

say "查询最新版本 (${REPO})..."
JSON=$(curl -fsSL -H 'Accept: application/vnd.github+json' "${API}") || die "无法访问 GitHub Releases。"
ZIP_URL=$(printf '%s' "${JSON}" | grep -oE '"browser_download_url": *"[^"]+CodeBurnMenubar-[^"]+\.zip"' | head -1 | sed -E 's/.*"(https[^"]+)"/\1/')
SUM_URL=$(printf '%s' "${JSON}" | grep -oE '"browser_download_url": *"[^"]+CodeBurnMenubar-[^"]+\.zip\.sha256"' | head -1 | sed -E 's/.*"(https[^"]+)"/\1/')
TAG=$(printf '%s' "${JSON}" | grep -oE '"tag_name": *"[^"]+"' | head -1 | sed -E 's/.*"([^"]+)"$/\1/')
[[ -n "${ZIP_URL}" && -n "${SUM_URL}" ]] || die "最新 Release (${TAG:-?}) 里没有找到 CodeBurnMenubar zip 资源。"

TMP=$(mktemp -d /tmp/codeburn-zh.XXXXXX)
trap 'rm -rf "${TMP}"' EXIT
ZIP="${TMP}/$(basename "${ZIP_URL}")"

say "下载 ${TAG} ..."
curl -fL --progress-bar -o "${ZIP}" "${ZIP_URL}"
curl -fsSL -o "${ZIP}.sha256" "${SUM_URL}"

say "校验 SHA-256 ..."
EXPECTED=$(awk '{print $1}' "${ZIP}.sha256")
ACTUAL=$(shasum -a 256 "${ZIP}" | awk '{print $1}')
[[ "${EXPECTED}" == "${ACTUAL}" ]] || die "校验失败：期望 ${EXPECTED}，实际 ${ACTUAL}。"

say "解压 ..."
/usr/bin/ditto -x -k "${ZIP}" "${TMP}/unpacked"
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
printf '%s\n' "$(command -v codeburn)" > "${SUPPORT}/codeburn-cli-path.v1"
chmod 600 "${SUPPORT}/codeburn-cli-path.v1"

say "启动 ..."
open "${BUNDLE}"
echo ""
echo "✓ 安装完成：${BUNDLE} (${TAG})"
echo "  菜单栏右上角会出现 🔥 图标；系统语言为简体中文时界面自动显示中文。"
echo "  首次连接 Claude 额度时，macOS 会询问是否允许读取钥匙串，请选择「始终允许」。"
