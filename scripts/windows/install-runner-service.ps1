<#
.SYNOPSIS
  把远程 runner 注册成 Windows 服务（没有命令行窗口）。

.DESCRIPTION
  用 NSSM 把 `node apps/server/dist/distributed/runner.js` 包装成 Windows 服务：

    - 开机自启、崩溃自动拉起
    - stdout/stderr 落盘并滚动
    - 以指定账户运行，复用该账户的 Codex / Claude 登录态
    - 不打开任何控制台窗口（这是本脚本存在的主要原因）

  runner 不监听入站端口，只主动连接 Hub，所以不需要防火墙规则。

.PARAMETER HubUrl
  Hub 地址，`ws://` 或 `wss://`。经反向代理时用 `wss://你的域名`。

.PARAMETER RunnerId
  在 Hub 设置页创建执行机时得到的 `VIBEMOBILE_RUNNER_ID`。

.PARAMETER Token
  对应的 `VIBEMOBILE_RUNNER_TOKEN`（一次性显示的那串）。

.PARAMETER ServiceName
  Windows 服务名，默认 VibeMobileRunner。

.PARAMETER RunAsUser
  服务运行账户，默认当前登录用户。应使用已经登录过 Codex / Claude 的账户。

.PARAMETER WorkspaceRoot
  该 runner 可操作的目录白名单，默认仓库根目录。

.PARAMETER HubCaFile
  私有 CA 时指向 PEM 文件；公共证书不用传。

.PARAMETER SkipBuild
  跳过构建（已经构建过时用）。

.PARAMETER Force
  服务已存在时先停止并删除再重装。

.PARAMETER DryRun
  只打印将要执行的步骤，不碰系统。

.EXAMPLE
  .\install-runner-service.ps1 -HubUrl wss://vibemobile.example.com -RunnerId runner-ab12cd34 -Token 3f9a...

.EXAMPLE
  .\install-runner-service.ps1 -HubUrl wss://... -RunnerId runner-ab12cd34 -Token ... -WorkspaceRoot D:\projects
#>
[CmdletBinding()]
param(
  [string]$HubUrl,
  [string]$RunnerId,
  [string]$Token,
  [string]$ServiceName = 'VibeMobileRunner',
  [string]$RunAsUser,
  [string]$WorkspaceRoot,
  [string]$HubCaFile,
  [switch]$SkipBuild,
  [switch]$Force,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$script:DryRun = $DryRun.IsPresent

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg) { Write-Host "    $msg" -ForegroundColor Green }
function Write-Info($msg) { Write-Host "    $msg" -ForegroundColor Gray }
function Write-Warn2($msg) { Write-Host "    $msg" -ForegroundColor Yellow }

function Assert-Administrator {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($id)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw '安装服务需要管理员权限。请右键“以管理员身份运行”。'
  }
}

function Find-RepoRoot {
  param([string]$Start)

  $dir = $Start
  while ($true) {
    $parent = Split-Path $dir -Parent
    if ([string]::IsNullOrEmpty($parent) -or $parent -eq $dir) { break }
    $dir = $parent
    $pkg = Join-Path $dir 'package.json'
    if (Test-Path $pkg) {
      try {
        $json = Get-Content $pkg -Raw | ConvertFrom-Json
        if (@($json.PSObject.Properties.Name) -contains 'workspaces') { return $dir }
      } catch { }
    }
  }
  throw "找不到仓库根目录（没有哪个祖先目录的 package.json 声明了 workspaces），起点：$Start"
}

function Get-Nssm {
  param([string]$RepoRoot)

  $toolsDir = Join-Path $RepoRoot 'scripts\windows\tools'
  $nssm = Join-Path $toolsDir 'nssm.exe'
  if (Test-Path $nssm) { return $nssm }

  if ($script:DryRun) {
    Write-Info "[dry-run] 将执行：npm install --prefix <tmp> nssm-bin（取 nssm.exe 到 $toolsDir）"
    return $nssm
  }

  New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null
  $tmp = Join-Path $env:TEMP ("vibemobile-nssm-" + [guid]::NewGuid().ToString('N'))
  try {
    npm install --prefix $tmp nssm-bin --no-save --no-package-lock --no-audit --no-fund --loglevel=error 2>&1 |
      ForEach-Object { Write-Verbose $_ }
    if ($LASTEXITCODE -ne 0) { throw "npm install nssm-bin 失败（退出码 $LASTEXITCODE）" }
    $src = Join-Path $tmp 'node_modules\nssm-bin\nssm.exe'
    if (-not (Test-Path $src)) { throw "nssm-bin 包里没有 nssm.exe：$src" }
    Copy-Item $src $nssm -Force
  } finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
  return $nssm
}

function Invoke-Nssm {
  param([string]$Nssm, [string[]]$Arguments, [string]$Display)

  $shown = if ($Display) { $Display } else { $Arguments -join ' ' }
  if ($script:DryRun) {
    Write-Info "[dry-run] nssm $shown"
    return
  }
  $out = & $Nssm @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) { throw "nssm $shown 失败（退出码 $LASTEXITCODE）：$out" }
  foreach ($line in $out) { Write-Verbose "$line" }
}

# ------------------------------------------------------------------ 收集参数

if ($script:DryRun) {
  if (-not $HubUrl) { $HubUrl = 'wss://hub.example.com' }
  if (-not $RunnerId) { $RunnerId = 'runner-example' }
  if (-not $Token) { $Token = 'x' * 64 }
} else {
  if (-not $HubUrl) { $HubUrl = Read-Host -Prompt '    Hub 地址（ws:// 或 wss://）' }
  if (-not $RunnerId) { $RunnerId = Read-Host -Prompt '    Runner ID' }
  if (-not $Token) {
    $secureToken = Read-Host -Prompt '    Runner token' -AsSecureString
    $Token = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
      [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken))
  }
}

if ($HubUrl -notmatch '^wss?://') { throw 'HubUrl 必须以 ws:// 或 wss:// 开头。' }
if ($RunnerId -notmatch '^[a-zA-Z0-9_-]{1,64}$') { throw 'RunnerId 只能包含字母、数字、_ 和 -，且不超过 64 位。' }
if ($Token.Length -lt 32) { throw 'Token 看起来不完整，请在 Hub 设置页重新复制。' }

Write-Host '========================================================' -ForegroundColor White
Write-Host '   VibeMobile 远程 runner 服务安装' -ForegroundColor White
Write-Host '========================================================' -ForegroundColor White

Write-Step '检查权限与环境'
Assert-Administrator
Write-Ok '管理员权限 OK'

$repoRoot = Find-RepoRoot -Start $PSScriptRoot
Write-Ok "仓库根目录：$repoRoot"

$nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodeExe) { throw 'PATH 里找不到 node.exe，请先安装 Node.js（>=20）。' }
Write-Ok "node：$nodeExe ($(& $nodeExe -v))"

$entry = Join-Path $repoRoot 'apps\server\dist\distributed\runner.js'
if (-not (Test-Path $entry) -and $SkipBuild) {
  throw "找不到 runner 入口 $entry。去掉 -SkipBuild 先构建。"
}

if (-not $RunAsUser) { $RunAsUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name }
Write-Ok "运行账户：$RunAsUser"
if (-not $WorkspaceRoot) { $WorkspaceRoot = $repoRoot }
Write-Ok "工作区白名单：$WorkspaceRoot"

$stateDir = Join-Path $repoRoot ('.multi-runner\runners\' + $RunnerId)
$logDir = Join-Path $repoRoot '.multi-runner\runner-logs'

$plain = $null
if (-not $script:DryRun) {
  Write-Step "提供 $RunAsUser 的运行凭据"
  $secure = Read-Host -Prompt "    请输入 $RunAsUser 的登录密码（服务将以该身份运行）" -AsSecureString
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
  if ([string]::IsNullOrEmpty($plain)) { throw '密码为空。请换一个账户运行，或把该账户设好密码。' }
  Write-Ok '已取得凭据（密码只交给 NSSM，不写进脚本或日志）'
}

try {
  # ------------------------------------------------------------------- 构建

  if ($SkipBuild -or $script:DryRun) {
    Write-Info '跳过构建'
  } else {
    Write-Step '构建服务端'
    if (-not (Test-Path (Join-Path $repoRoot 'node_modules'))) {
      Push-Location $repoRoot
      try { npm ci } finally { Pop-Location }
      if ($LASTEXITCODE -ne 0) { throw "npm ci 失败（退出码 $LASTEXITCODE）" }
    }
    Push-Location $repoRoot
    try { npm run build --workspace=@vibemobile/server } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { throw "server 构建失败（退出码 $LASTEXITCODE）" }
    if (-not (Test-Path $entry)) { throw "构建后仍找不到 $entry" }
    Write-Ok '构建完成'
  }

  # ------------------------------------------------------------------- nssm

  Write-Step '准备 NSSM'
  $nssm = Get-Nssm -RepoRoot $repoRoot

  $existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  if ($existing) {
    if (-not $Force) { throw "服务 $ServiceName 已存在。如需重装，请加 -Force。" }
    Invoke-Nssm -Nssm $nssm -Arguments @('stop', $ServiceName)
    if (-not $script:DryRun) { Start-Sleep -Seconds 2 }
    Invoke-Nssm -Nssm $nssm -Arguments @('remove', $ServiceName, 'confirm')
    if (-not $script:DryRun) { Start-Sleep -Seconds 1 }
  }

  Write-Step "创建服务 $ServiceName"
  Invoke-Nssm -Nssm $nssm -Arguments @('install', $ServiceName, $nodeExe)
  Invoke-Nssm -Nssm $nssm -Arguments @('set', $ServiceName, 'AppParameters', "`"$entry`"")
  Invoke-Nssm -Nssm $nssm -Arguments @('set', $ServiceName, 'AppDirectory', $repoRoot)

  Write-Step '写入环境变量'
  if (-not $script:DryRun) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }

  $envPairs = @(
    "VIBEMOBILE_HUB_URL=$HubUrl",
    "VIBEMOBILE_RUNNER_ID=$RunnerId",
    "VIBEMOBILE_RUNNER_TOKEN=$Token",
    "VIBEMOBILE_ROOTS=$WorkspaceRoot",
    "VIBEMOBILE_STATE_DIR=$stateDir"
  )
  if ($HubCaFile) { $envPairs += "VIBEMOBILE_HUB_CA_FILE=$HubCaFile" }
  Invoke-Nssm -Nssm $nssm -Arguments (@('set', $ServiceName, 'AppEnvironmentExtra') + $envPairs)
  foreach ($pair in $envPairs) {
    # Token 是凭据，只显示前两个变量与存在的环境变量名。
    if ($pair -like 'VIBEMOBILE_RUNNER_TOKEN=*') { Write-Info 'VIBEMOBILE_RUNNER_TOKEN=******' }
    else { Write-Info $pair }
  }

  Write-Step '配置日志'
  Invoke-Nssm -Nssm $nssm -Arguments @('set', $ServiceName, 'AppStdout', (Join-Path $logDir 'runner.out.log'))
  Invoke-Nssm -Nssm $nssm -Arguments @('set', $ServiceName, 'AppStderr', (Join-Path $logDir 'runner.err.log'))
  Invoke-Nssm -Nssm $nssm -Arguments @('set', $ServiceName, 'AppRotateFiles', '1')
  Invoke-Nssm -Nssm $nssm -Arguments @('set', $ServiceName, 'AppRotateOnline', '1')
  Invoke-Nssm -Nssm $nssm -Arguments @('set', $ServiceName, 'AppRotateBytes', '5242880')
  Write-Ok "日志目录：$logDir"

  Write-Step "设置运行账户 $RunAsUser"
  Invoke-Nssm -Nssm $nssm `
    -Arguments @('set', $ServiceName, 'ObjectName', $RunAsUser, $plain) `
    -Display "set $ServiceName ObjectName $RunAsUser ******"

  Write-Step '配置自启、崩溃重启与优雅停止'
  Invoke-Nssm -Nssm $nssm -Arguments @('set', $ServiceName, 'Start', 'SERVICE_AUTO_START')
  Invoke-Nssm -Nssm $nssm -Arguments @('set', $ServiceName, 'AppExit', 'Default', 'Restart')
  Invoke-Nssm -Nssm $nssm -Arguments @('set', $ServiceName, 'AppRestartDelay', '10000')
  Invoke-Nssm -Nssm $nssm -Arguments @('set', $ServiceName, 'AppStopMethodConsole', '15000')

  Write-Step '启动服务'
  Invoke-Nssm -Nssm $nssm -Arguments @('start', $ServiceName)

  if ($script:DryRun) {
    Write-Host ''
    Write-Host '  预演结束，未改动系统。去掉 -DryRun 即正式安装。' -ForegroundColor Yellow
    exit 0
  }

  Start-Sleep -Seconds 5
  $svc = Get-Service -Name $ServiceName
  Write-Ok "服务状态：$($svc.Status)"

  Write-Host ''
  Write-Host '========================================================' -ForegroundColor White
  Write-Host '  安装完成（无控制台窗口，随开机自启）' -ForegroundColor Green
  Write-Host '========================================================' -ForegroundColor White
  Write-Host ''
  Write-Host "    服务名：  $ServiceName"
  Write-Host "    Hub：     $HubUrl"
  Write-Host "    Runner：  $RunnerId"
  Write-Host "    日志：    $logDir\runner.out.log"
  Write-Host ''
  Write-Host '    在 Hub 设置页刷新列表，该执行机应显示“在线”。' -ForegroundColor Gray
  Write-Host ''

  $outLog = Join-Path $logDir 'runner.out.log'
  if (Test-Path $outLog) {
    Write-Host '    最近日志：' -ForegroundColor Gray
    Get-Content $outLog -Tail 5 | ForEach-Object { Write-Host "      $_" -ForegroundColor DarkGray }
  }

  if ($svc.Status -ne 'Running') {
    Write-Warn2 "服务没有进入 Running 状态，请看 $logDir\runner.err.log。"
    exit 1
  }
} finally {
  $plain = $null
  Remove-Variable plain -ErrorAction SilentlyContinue
}
