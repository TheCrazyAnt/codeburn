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

# PowerShell 优先选用 npm 自带的 npm.ps1，而 Windows Server / 收紧过策略的机器
# 默认禁止运行 .ps1 文件，于是 npm 调用直接失败。这里解析出 .cmd/.exe 形式再调用。
# PowerShell 会把外部程序写到 stderr 的任何内容变成错误记录，配合脚本开头的
# $ErrorActionPreference = 'Stop'，npm 一行无害的 "npm notice" 就足以中断安装。
# 统一走这个包装：临时放宽错误策略，只按退出码判断成败。
function Invoke-Native ([string]$Exe, [string[]]$Arguments = @()) {
  # 刻意保持成最朴素的写法：这个脚本要在被收紧过的 shell 里通过 iex 执行，
  # 少一个语言特性就少一处出意外的可能。
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $output = (& $Exe @Arguments 2>&1 | Out-String)
  $code = $LASTEXITCODE
  $ErrorActionPreference = $previous
  return [pscustomobject]@{ ExitCode = $code; Output = $output }
}

# 当前策略是否会拦下 .ps1 文件。取不到就当作不拦，这只是给用户的提示，
# 判断错了顶多少一条建议，不该让安装失败。
function Get-EffectivePolicy ([string]$Scope) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'SilentlyContinue'
  $policy = if ($Scope) { Get-ExecutionPolicy -Scope $Scope } else { Get-ExecutionPolicy }
  $ErrorActionPreference = $previous
  return ($policy -in @('Restricted', 'AllSigned'))
}

function Resolve-Exe ([string]$name) {
  foreach ($candidate in @(Get-Command $name -All -ErrorAction SilentlyContinue)) {
    if ($candidate.Source -and $candidate.Source -notmatch '\.ps1$') { return $candidate.Source }
  }
  return $null
}

$npm = Resolve-Exe 'npm'
if (-not $npm) {
  Die '没有找到 npm。请先安装 Node.js 22.13 或更高版本：https://nodejs.org'
}
$node = Resolve-Exe 'node'
if (-not $node) { Die '没有找到 node。请先安装 Node.js 22.13 或更高版本：https://nodejs.org' }
$nodeProbe = Invoke-Native $node @('-p', 'process.versions.node')
$nodeVersion = $nodeProbe.Output.Trim()
if ($nodeProbe.ExitCode -ne 0 -or -not $nodeVersion) { Die '没有找到 node。请先安装 Node.js 22.13 或更高版本：https://nodejs.org' }
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

# 把 MSI 日志里真正的失败原因翻译成一句人话。日志里标记失败动作的惯例是
# 「Return value 3」，它前面那几行才写着到底哪一步、为什么。认得出的几种给出
# 对应做法，认不出的就把原始行打出来 —— 有原文总比只有一个 1603 强。
function Show-MsiFailure ([string]$logPath) {
  if (-not (Test-Path $logPath)) { return }
  $lines = @(Get-Content $logPath -ErrorAction SilentlyContinue)
  if ($lines.Count -eq 0) { return }
  $text = $lines -join "`n"

  # 权限先判。1402 是「打不开注册表键」，配上 HKEY_LOCAL_MACHINE 就是没提权；
  # 1729 是「产品配置失败」，重新配置一个 perMachine 产品而没有管理员权限时
  # 就是这个组合。0x80030005 (-2147287035) 是底下那句拒绝访问。
  if ($text -match 'Error 1925|administrator privileges|需要管理员' -or
      $text -match '1402 2: HKEY_LOCAL_MACHINE' -or
      $text -match '1: 1729' -or $text -match '-2147287035') {
    Write-Host '  原因：这个安装包要把产品信息写进 HKLM，需要管理员权限。' -ForegroundColor Yellow
    Write-Host '  做法：右键 PowerShell → 以管理员身份运行，再执行一次；或在弹出的确认框里点「是」。' -ForegroundColor Yellow
    return
  }
  # 「FilesInUse」是每份日志都有的标准动作名，拿它当证据会把无关的失败也说成
  # 文件占用 —— 只认 Windows 真正判定被占用时写下的那句。
  if ($text -match 'Files in Use|being used by another process|InstallValidate.*in use') {
    Write-Host '  原因：有文件正被占用（托盘应用可能还在运行）。' -ForegroundColor Yellow
    Write-Host '  做法：在任务栏右下角退出 CodeBurn，或重启一次电脑，再执行一次。' -ForegroundColor Yellow
    return
  }
  if ($text -match 'Error 1618|another installation') {
    Write-Host '  原因：Windows 上另有一个安装正在进行。' -ForegroundColor Yellow
    Write-Host '  做法：等它结束（或重启电脑）后再执行一次。' -ForegroundColor Yellow
    return
  }
  if ($text -match 'Error 1638|already installed') {
    Write-Host '  原因：已经装了同版本或更新的版本。' -ForegroundColor Yellow
    Write-Host '  做法：在「设置 → 应用」里卸载 CodeBurn Menubar 后再执行一次。' -ForegroundColor Yellow
    return
  }

  # 认不出来：把日志里标了失败的那几行原样给出去。原文永远比猜测可靠。
  $idx = -1
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match 'Return value 3\.') { $idx = $i }
  }
  if ($idx -ge 0) {
    $from = [Math]::Max(0, $idx - 6)
    Write-Host '  日志里失败的那一段：' -ForegroundColor Yellow
    foreach ($line in $lines[$from..$idx]) { Write-Host "    $line" -ForegroundColor DarkGray }
  }
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
  $install = Invoke-Native $npm @('install', '-g', $tgz)
  if ($install.ExitCode -ne 0) {
    Die "npm 安装失败。可以手动执行：npm install -g $($cli.Url)`n$($install.Output)"
  }

  # npm 把全局命令装到它自己的 prefix 目录下，而 PowerShell 的 $env:PATH 是进程
  # 启动时的快照 —— 首次全局安装时那个目录往往还不在里面。所以直接问 npm 要路径，
  # 而不是依赖 Get-Command。
  $codeburnCmd = Resolve-Exe 'codeburn' 
  if (-not $codeburnCmd) {
    $npmPrefix = (Invoke-Native $npm @('prefix', '-g')).Output.Trim() -split "`r?`n" | Select-Object -First 1
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
  # PowerShell 的 try 只能作为语句，不能当表达式赋值（那是 C# 的写法），
  # 所以这里用函数包一层。
  $script:ExecutionPolicyBlocked = (Get-EffectivePolicy -Scope 'CurrentUser') -or (Get-EffectivePolicy)

  if ($codeburnCmd) {
    Say '设置界面语言为简体中文 ...'
    $null = Invoke-Native $codeburnCmd @('lang', 'zh-CN')
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

  # 升级时旧版通常正在托盘里跑着，文件被占用。交互式安装会弹「需要关闭以下
  # 程序」让人点确认，静默安装没人能点，msiexec 直接以 1603 收场。macOS 的
  # install-zh.sh 一直有对应的 pkill，这里补上。
  $running = @(Get-Process -Name 'CodeBurn*' -ErrorAction SilentlyContinue)
  if ($running.Count -gt 0) {
    Say '关闭正在运行的托盘应用 ...'
    $running | Stop-Process -Force -ErrorAction SilentlyContinue
    # 进程退出和它对文件的句柄释放不是同一刻，等一下再交给 msiexec。
    Start-Sleep -Seconds 2
  }

  Say '安装 ...'
  # 1603 只是「安装期间发生致命错误」，本身不含任何线索。留一份详细日志，
  # 失败时把里面真正的原因翻出来，别让人对着一个数字干瞪眼。
  $msiLog = Join-Path $tmp 'msi.log'
  # 不要用 $args：它是 PowerShell 的自动变量，赋值会影响参数绑定。
  $msiArgs = if ($Interactive) { @('/i', "`"$msiPath`"") } else { @('/i', "`"$msiPath`"", '/qb', '/norestart') }
  $msiArgs += @('/l*v', "`"$msiLog`"")
  # 这个 .msi 是 perMachine 安装：产品信息写在 HKLM，装/改都要管理员权限。
  # 首次安装时 msiexec 自己会弹 UAC，但产品已在、走「重新配置」路径时它不弹，
  # 于是直接卡在写 HKLM\...\Installer\Rollback\Scripts 上（1402 + 拒绝访问
  # 0x80030005，再 1729 配置失败，最后回滚成 1603）。所以这里主动提权。
  # 已经是管理员时 -Verb RunAs 不会再弹框。
  $isAdmin = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
      [Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $isAdmin) { Say '安装托盘应用需要管理员权限，接下来会弹出确认框，请点「是」...' }
  try {
    $proc = Start-Process msiexec.exe -ArgumentList $msiArgs -Wait -PassThru -Verb RunAs -ErrorAction Stop
  } catch {
    Die "没有拿到管理员权限，托盘应用未安装。在弹出的确认框里点「是」再试一次，或者右键 PowerShell → 以管理员身份运行。`n（命令行已经装好了，可以直接用 codeburn。）"
  }
  # 3010 = 安装成功，但需要重启才能完成
  if ($proc.ExitCode -ne 0 -and $proc.ExitCode -ne 3010) {
    $keep = Join-Path $env:TEMP 'codeburn-msi.log'
    if (Test-Path $msiLog) { Copy-Item $msiLog $keep -Force -ErrorAction SilentlyContinue }
    Write-Host "x 安装失败，msiexec 退出码 $($proc.ExitCode)。" -ForegroundColor Red
    Show-MsiFailure $keep
    Write-Host "  完整日志：$keep" -ForegroundColor Yellow
    exit 1
  }

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
