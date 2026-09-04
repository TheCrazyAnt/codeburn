# ============================================================================
# CodeBurn 中文版 · 一键安装 (Windows)
#   irm https://raw.githubusercontent.com/TheCrazyAnt/codeburn/zh-hans/windows/Scripts/install-zh.ps1 | iex
#
# 做的事情：
#   1. 安装中文版命令行（从本仓库 Releases 下载 .tgz，校验 SHA-256）
#   2. 把界面语言设为简体中文
#   3. 下载并安装托盘应用 .msi（同样校验 SHA-256）
#   4. 启动托盘应用
#
# 只想要命令行、不要托盘应用：加 -CliOnly
# 前提：Node.js 22.13+（用于 npm 安装命令行）。
# ============================================================================
[CmdletBinding()]
param(
  [string]$Repo = 'TheCrazyAnt/codeburn',
  [switch]$Interactive,
  [switch]$CliOnly
)

$ErrorActionPreference = 'Stop'
function Say ($m) { Write-Host "> $m" }
function Die ($m) { Write-Host "x $m" -ForegroundColor Red; exit 1 }

if (-not $IsWindows -and $PSVersionTable.PSVersion.Major -ge 6) { Die '这个脚本只支持 Windows。' }

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Die '没有找到 npm。请先安装 Node.js 22.13 或更高版本：https://nodejs.org'
}
$nodeVersion = (& node -p 'process.versions.node' 2>$null)
if ($LASTEXITCODE -ne 0 -or -not $nodeVersion) { Die '没有找到 node。请先安装 Node.js 22.13 或更高版本：https://nodejs.org' }
$nodeParts = $nodeVersion.Split('.')
if ([int]$nodeParts[0] -lt 22 -or ([int]$nodeParts[0] -eq 22 -and [int]$nodeParts[1] -lt 13)) {
  Die "需要 Node.js 22.13 或更高版本，当前是 $nodeVersion。"
}

Say "查询最新版本 ($Repo) ..."
$headers = @{ 'Accept' = 'application/vnd.github+json'; 'User-Agent' = 'codeburn-zh-installer' }
try {
  $releases = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases?per_page=100" -Headers $headers
} catch {
  Die "无法访问 GitHub Releases：$($_.Exception.Message)"
}

# 只认 windows-v* 的发布，里面必须同时有 .msi 和 .msi.sha256
# GitHub 按标签名的字符串顺序返回发布，"zh10" 会排在 "zh1" 和 "zh2" 之间。
# 把数字段左侧补零后再排序，才能让 zh10 胜过 zh9。
function Get-NaturalKey ([string]$text) {
  return [regex]::Replace($text, '\d+', { param($m) $m.Value.PadLeft(10, '0') })
}

function Select-Asset ($releases, $tagPrefix, $pattern) {
  $candidates = @()
  foreach ($r in $releases) {
    if ($r.draft) { continue }
    if ($r.tag_name -notlike "$tagPrefix*") { continue }
    $asset = $r.assets | Where-Object { $_.name -match $pattern } | Select-Object -First 1
    if (-not $asset) { continue }
    $sum = $r.assets | Where-Object { $_.name -eq ($asset.name + '.sha256') } | Select-Object -First 1
    if (-not $sum) { continue }
    $candidates += [pscustomobject]@{
      Tag    = $r.tag_name
      Url    = $asset.browser_download_url
      SumUrl = $sum.browser_download_url
      Name   = $asset.name
      Key    = (Get-NaturalKey $r.tag_name)
    }
  }
  if ($candidates.Count -eq 0) { return $null }
  return ($candidates | Sort-Object -Property Key -Descending | Select-Object -First 1)
}

function Get-Verified ($asset, $destination, $headers) {
  Invoke-WebRequest -Uri $asset.Url -OutFile $destination -Headers $headers
  Invoke-WebRequest -Uri $asset.SumUrl -OutFile "$destination.sha256" -Headers $headers
  $expected = ((Get-Content -Raw "$destination.sha256").Trim() -split '\s+')[0]
  $actual = (Get-FileHash -Algorithm SHA256 -Path $destination).Hash
  if ($expected -ne $actual) { Die "校验失败：期望 $expected，实际 $actual。" }
}

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("codeburn-zh-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
try {
  # ---- 1. 中文版命令行 -----------------------------------------------------
  $cli = Select-Asset $releases 'cli-v' '\.tgz$'
  if (-not $cli) { Die '没有找到带 .tgz 的 cli-v* 发布。' }
  Say "下载命令行 $($cli.Tag) ..."
  $tgz = Join-Path $tmp $cli.Name
  Get-Verified $cli $tgz $headers

  Say '安装命令行（npm install -g）...'
  & npm install -g $tgz 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { Die "npm 安装失败。可以手动执行：npm install -g $($cli.Url)" }

  # npm 把全局命令装到它自己的 prefix 目录下，而 PowerShell 的 $env:PATH 是进程
  # 启动时的快照 —— 首次全局安装时那个目录往往还不在里面。所以直接问 npm 要路径，
  # 而不是依赖 Get-Command。
  $codeburnCmd = (Get-Command codeburn -ErrorAction SilentlyContinue | Select-Object -First 1).Source
  if (-not $codeburnCmd) {
    $npmPrefix = (& npm prefix -g 2>$null | Select-Object -First 1)
    if ($npmPrefix) {
      $npmPrefix = $npmPrefix.Trim()
      foreach ($candidate in @(
        (Join-Path $npmPrefix 'codeburn.cmd'),
        (Join-Path $npmPrefix 'codeburn.ps1'),
        (Join-Path $npmPrefix 'codeburn'),
        (Join-Path (Join-Path $npmPrefix 'bin') 'codeburn.cmd'),
        (Join-Path (Join-Path $npmPrefix 'bin') 'codeburn')
      )) {
        if (Test-Path $candidate) { $codeburnCmd = $candidate; break }
      }
      # 让本次会话后续的调用也能直接用 codeburn
      if ($codeburnCmd -and ($env:PATH -notlike "*$npmPrefix*")) { $env:PATH = "$npmPrefix;$env:PATH" }
    }
  }

  # PowerShell 优先执行 npm 装出的 codeburn.ps1，而 Windows Server（以及被组策略
  # 收紧的机器）默认禁止运行 .ps1 文件。安装脚本自身走 iex 在内存里执行，不受影响，
  # 但装完之后每次敲 codeburn 都会被拦，所以这里提前检出并给出办法。
  $policy = try { Get-ExecutionPolicy -Scope CurrentUser } catch { 'Undefined' }
  if ($policy -in @('Restricted', 'AllSigned')) {
    $script:ExecutionPolicyBlocked = $true
  } elseif ((try { Get-ExecutionPolicy } catch { 'Undefined' }) -in @('Restricted', 'AllSigned')) {
    $script:ExecutionPolicyBlocked = $true
  }

  if ($codeburnCmd) {
    Say '设置界面语言为简体中文 ...'
    & $codeburnCmd lang zh-CN 2>&1 | Out-Null
  } else {
    # 不中止：托盘应用会自己找命令行，用户重开终端后也能正常用。
    Write-Host '! 暂时没能在 PATH 里找到 codeburn，跳过语言设置。' -ForegroundColor Yellow
    Write-Host '  重开一个 PowerShell 窗口后执行：codeburn lang zh-CN' -ForegroundColor Yellow
  }

  if ($CliOnly) {
    Write-Host ''
    Write-Host "√ 命令行安装完成（$($cli.Tag)）" -ForegroundColor Green
    if (-not $codeburnCmd) { Write-Host '  请先重开一个 PowerShell 窗口，然后：' -ForegroundColor Yellow }
    Write-Host '  试试：codeburn      终端仪表盘'
    Write-Host '        codeburn web  浏览器仪表盘'
  if ($script:ExecutionPolicyBlocked) {
    Write-Host ''
    Write-Host '! PowerShell 当前禁止运行脚本文件，直接敲 codeburn 会报 UnauthorizedAccess。' -ForegroundColor Yellow
    Write-Host '  二选一：' -ForegroundColor Yellow
    Write-Host '    1) 用 codeburn.cmd 代替 codeburn，例如：codeburn.cmd today' -ForegroundColor Yellow
    Write-Host '    2) 执行一次（只影响当前用户，无需管理员）：' -ForegroundColor Yellow
    Write-Host '       Set-ExecutionPolicy -Scope CurrentUser RemoteSigned' -ForegroundColor Yellow
  }
    return
  }

  # ---- 2. 托盘应用 ---------------------------------------------------------
  $msi = Select-Asset $releases 'windows-v' '\.msi$'
  if (-not $msi) { Die '没有找到带 .msi 的 windows-v* 发布。' }
  Say "下载托盘应用 $($msi.Tag) ..."
  $msiPath = Join-Path $tmp $msi.Name
  Get-Verified $msi $msiPath $headers

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
  Write-Host "√ 安装完成" -ForegroundColor Green
  Write-Host "  命令行 $($cli.Tag)：codeburn（终端） / codeburn web（浏览器）"
  if (-not $codeburnCmd) { Write-Host '  注意：需要重开一个 PowerShell 窗口，codeburn 命令才会生效。' -ForegroundColor Yellow }
  Write-Host "  托盘应用 $($msi.Tag)：任务栏右下角会出现 CodeBurn 图标。"
  if ($proc.ExitCode -eq 3010) { Write-Host '  提示：安装程序建议重启一次电脑。' -ForegroundColor Yellow }
  if ($script:ExecutionPolicyBlocked) {
    Write-Host ''
    Write-Host '! PowerShell 当前禁止运行脚本文件，直接敲 codeburn 会报 UnauthorizedAccess。' -ForegroundColor Yellow
    Write-Host '  二选一：' -ForegroundColor Yellow
    Write-Host '    1) 用 codeburn.cmd 代替 codeburn，例如：codeburn.cmd today' -ForegroundColor Yellow
    Write-Host '    2) 执行一次（只影响当前用户，无需管理员）：' -ForegroundColor Yellow
    Write-Host '       Set-ExecutionPolicy -Scope CurrentUser RemoteSigned' -ForegroundColor Yellow
  }
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
