# ============================================================================
# CodeBurn 托盘应用 · 中文版 一键安装脚本 (Windows)
#   irm https://raw.githubusercontent.com/TheCrazyAnt/codeburn/zh-hans/windows/Scripts/install-zh.ps1 | iex
#
# 做的事情：
#   1. 从 GitHub Releases 下载最新的中文版 .msi 和它的 sha256 校验文件
#   2. 校验 SHA-256
#   3. 静默安装（可以用 -Interactive 改成有界面的安装）
#   4. 启动托盘应用
# 前提：已安装 Node.js 22.13+ 并执行过 `npm install -g codeburn`（托盘应用靠它读数据）。
# ============================================================================
[CmdletBinding()]
param(
  [string]$Repo = 'TheCrazyAnt/codeburn',
  [switch]$Interactive
)

$ErrorActionPreference = 'Stop'
function Say ($m) { Write-Host "> $m" }
function Die ($m) { Write-Host "x $m" -ForegroundColor Red; exit 1 }

if (-not $IsWindows -and $PSVersionTable.PSVersion.Major -ge 6) { Die '这个脚本只支持 Windows。' }

if (-not (Get-Command codeburn -ErrorAction SilentlyContinue)) {
  Say '没有找到 codeburn 命令行。请先安装：npm install -g codeburn（需要 Node.js 22.13+），然后重新运行本脚本。'
  exit 1
}

Say "查询最新版本 ($Repo) ..."
$headers = @{ 'Accept' = 'application/vnd.github+json'; 'User-Agent' = 'codeburn-zh-installer' }
try {
  $releases = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases?per_page=30" -Headers $headers
} catch {
  Die "无法访问 GitHub Releases：$($_.Exception.Message)"
}

# 只认 windows-v* 的发布，里面必须同时有 .msi 和 .msi.sha256
$release = $releases |
  Where-Object { $_.tag_name -like 'windows-v*' } |
  Where-Object {
    ($_.assets | Where-Object { $_.name -like '*.msi' }) -and
    ($_.assets | Where-Object { $_.name -like '*.msi.sha256' })
  } |
  Select-Object -First 1
if (-not $release) { Die '没有找到带 .msi 的 windows-v* 发布。' }

$msiAsset = $release.assets | Where-Object { $_.name -like '*.msi' } | Select-Object -First 1
$sumAsset = $release.assets | Where-Object { $_.name -eq "$($msiAsset.name).sha256" } | Select-Object -First 1
if (-not $sumAsset) { Die "发布 $($release.tag_name) 里缺少 $($msiAsset.name).sha256 校验文件。" }

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("codeburn-zh-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
try {
  $msiPath = Join-Path $tmp $msiAsset.name
  $sumPath = "$msiPath.sha256"

  Say "下载 $($release.tag_name) ..."
  Invoke-WebRequest -Uri $msiAsset.browser_download_url -OutFile $msiPath -Headers $headers
  Invoke-WebRequest -Uri $sumAsset.browser_download_url -OutFile $sumPath -Headers $headers

  Say '校验 SHA-256 ...'
  $expected = ((Get-Content -Raw $sumPath).Trim() -split '\s+')[0]
  $actual = (Get-FileHash -Algorithm SHA256 -Path $msiPath).Hash
  if ($expected -ne $actual) { Die "校验失败：期望 $expected，实际 $actual。" }

  Say '安装 ...'
  # 不要用 $args：它是 PowerShell 的自动变量，赋值会影响参数绑定。
  $msiArgs = if ($Interactive) { @('/i', "`"$msiPath`"") } else { @('/i', "`"$msiPath`"", '/qb', '/norestart') }
  $proc = Start-Process msiexec.exe -ArgumentList $msiArgs -Wait -PassThru
  # 3010 = 安装成功，但需要重启才能完成
  if ($proc.ExitCode -ne 0 -and $proc.ExitCode -ne 3010) { Die "安装失败，msiexec 退出码 $($proc.ExitCode)。" }

  $exe = Get-ChildItem -Path @(
    "$env:LOCALAPPDATA\Programs",
    "${env:ProgramFiles}",
    "${env:ProgramFiles(x86)}"
  ) -Filter 'CodeBurn*.exe' -Recurse -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($exe) { Say '启动 ...'; Start-Process $exe.FullName }

  Write-Host ''
  Write-Host "√ 安装完成：$($release.tag_name)" -ForegroundColor Green
  Write-Host '  任务栏右下角会出现 CodeBurn 图标；系统语言为简体中文时界面自动显示中文。'
  Write-Host '  也可以在终端执行 `codeburn lang zh-CN` 强制使用中文。'
  if ($proc.ExitCode -eq 3010) { Write-Host '  提示：安装程序建议重启一次电脑。' -ForegroundColor Yellow }
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
