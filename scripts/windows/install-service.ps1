<#
.SYNOPSIS
  把 VibeMobile 安装成真正的 Windows 服务（SCM 注册，出现在 services.msc 里）。

.DESCRIPTION
  用 NSSM 把 `node apps/server/dist/index.js` 包装成一个 Windows 服务：

    - 开机自启（SERVICE_AUTO_START）
    - 崩溃自动拉起（AppExit Restart）
    - stdout/stderr 落盘并按大小滚动
    - 以指定用户身份运行，从而复用该用户的 Codex 登录态

  为什么用 NSSM 而不是 winsw：本机只装了 .NET Framework 4.x，没有 .NET 2.0/3.5，
  而 node-windows 自带的 winsw 是 .NET2 stub，起不来。nssm.exe 是原生程序，无运行时依赖。

  为什么不用 `sc.exe create` 直接跑 node：Node 不实现服务控制协议
  （不调用 StartServiceCtrlDispatcher），直接注册会得到「服务无法启动」的 1053 错误，
  必须由包装器代持。

.PARAMETER ServiceName
  服务名，默认 VibeMobile。

.PARAMETER Port
  HTTP 监听端口，默认 3000。

.PARAMETER Pin
  固定的登录 PIN。不传则首次启动自动生成 16 位强密码（大小写字母、数字与符号）
  并写进 .vibemobile/state.json。

.PARAMETER RunAsUser
  服务运行账户，默认取当前登录用户。必须是已经跑过 `codex login` 的那个账户，
  否则 Codex 找不到登录态。

.PARAMETER WorkspaceRoot
  Codex 可操作的目录白名单（对应 VIBEMOBILE_ROOTS），默认仓库根目录。

.PARAMETER Terminal
  是否开启浏览器里的终端直连，on / off，默认 on。

.PARAMETER SkipBuild
  跳过 npm ci / npm run build（你已经手动构建过时用）。

.PARAMETER Force
  服务已存在时先停止并删除再重装。

.PARAMETER DryRun
  只打印将要执行的每一步，不碰系统：不建服务、不写环境变量、不启动、不要密码。
  用于确认路径和参数是否正确。

.EXAMPLE
  .\install-service.ps1 -DryRun
  先看一眼会做什么。

.EXAMPLE
  .\install-service.ps1
  以当前用户安装，端口 3000，首次启动自动生成 PIN。

.EXAMPLE
  .\install-service.ps1 -Pin 123456 -Port 8080
  固定 PIN 为 123456，监听 8080。
#>
[CmdletBinding()]
param(
  [string]$ServiceName = 'VibeMobile',
  [int]$Port = 3000,
  [string]$Pin,
  [string]$RunAsUser,
  [string]$WorkspaceRoot,
  [ValidateSet('on', 'off')][string]$Terminal = 'on',
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

# ------------------------------------------------------------------ 前置检查

function Assert-Administrator {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($id)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw '安装服务需要管理员权限。请右键“以管理员身份运行”。'
  }
}

# 走 package.json 的 workspaces 字段定位仓库根，和 apps/server/src/config.ts 里
# repoRoot() 的逻辑保持一致：脚本从哪个目录被调用都不影响结果。
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
      } catch {
        # package.json 读不了或不是合法 JSON，继续往上找
      }
    }
  }
  throw "找不到仓库根目录（没有哪个祖先目录的 package.json 声明了 workspaces），起点：$Start"
}

# ------------------------------------------------------------- nssm.exe 获取

# npm 源可达而 GitHub Releases 不可达，所以从 npm 上的 nssm-bin 取二进制。
function Get-Nssm {
  param([string]$RepoRoot)

  $toolsDir = Join-Path $RepoRoot 'scripts\windows\tools'
  $nssm = Join-Path $toolsDir 'nssm.exe'
  if (Test-Path $nssm) {
    Write-Info "复用已有 nssm.exe：$nssm"
    return $nssm
  }

  if ($script:DryRun) {
    Write-Info "[dry-run] 将执行：npm install --prefix <tmp> nssm-bin（取 nssm.exe 到 $toolsDir）"
    return $nssm
  }

  Write-Info '未找到 nssm.exe，正在从 npm 源获取 nssm-bin ...'
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

  Write-Ok "nssm.exe 已就位：$nssm"
  return $nssm
}

# -Display 用于回显：ObjectName 那步的真实参数里含明文密码，绝不能进日志或异常信息。
function Invoke-Nssm {
  param(
    [string]$Nssm,
    [string[]]$Arguments,
    [string]$Display
  )

  $shown = if ($Display) { $Display } else { $Arguments -join ' ' }

  if ($script:DryRun) {
    Write-Info "[dry-run] nssm $shown"
    return
  }

  $out = & $Nssm @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "nssm $shown 失败（退出码 $LASTEXITCODE）：$out"
  }
  foreach ($line in $out) { Write-Verbose "$line" }
}

# --------------------------------------------------------------------- 主流程

Write-Host '========================================================' -ForegroundColor White
if ($script:DryRun) {
  Write-Host '     VibeMobile Windows 服务安装（预演，不改动系统）' -ForegroundColor Yellow
} else {
  Write-Host '        VibeMobile Windows 服务安装' -ForegroundColor White
}
Write-Host '========================================================' -ForegroundColor White

Write-Step '检查权限与环境'
Assert-Administrator
Write-Ok '管理员权限 OK'

$repoRoot = Find-RepoRoot -Start $PSScriptRoot
Write-Ok "仓库根目录：$repoRoot"

$nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodeExe) { throw 'PATH 里找不到 node.exe，请先安装 Node.js（>=20）。' }
Write-Ok "node：$nodeExe ($(& $nodeExe -v))"

$entry = Join-Path $repoRoot 'apps\server\dist\index.js'
if (-not (Test-Path $entry)) {
  throw "找不到服务端入口 $entry。请先执行：npm run build --workspace=@vibemobile/server"
}

# Codex 凭据所在的账户就是服务该运行的账户，否则 app-server 会以未登录状态启动。
if (-not $RunAsUser) {
  $RunAsUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
}
Write-Ok "运行账户：$RunAsUser"

$codexHome = Join-Path $env:USERPROFILE '.codex'
if (Test-Path (Join-Path $codexHome 'auth.json')) {
  Write-Ok "Codex 登录态：$codexHome\auth.json"
} else {
  Write-Warn2 "警告：$codexHome\auth.json 不存在 —— 该账户可能还没跑过 codex login，"
  Write-Warn2 '      服务起来后 Codex 会处于未登录状态。'
}

if (-not $WorkspaceRoot) { $WorkspaceRoot = $repoRoot }
Write-Ok "工作区白名单：$WorkspaceRoot"

$logDir = Join-Path $WorkspaceRoot '.vibemobile\logs'
$stateDir = Join-Path $WorkspaceRoot '.vibemobile'

# --------------------------------------------------------- 先收密码，再动系统
#
# 顺序很重要：这一步必须排在创建服务之前。否则用户中途 Ctrl+C 取消密码输入，
# 会留下一个已经注册、但账户没配好的服务。

$plain = $null
if (-not $script:DryRun) {
  Write-Step "提供 $RunAsUser 的运行凭据"
  $secure = Read-Host -Prompt "    请输入 $RunAsUser 的登录密码（服务将以该身份运行）" -AsSecureString
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
  if ([string]::IsNullOrEmpty($plain)) {
    throw '密码为空。若该账户确实没有密码，请用 -RunAsUser 换一个账户，或改以 LocalSystem 运行。'
  }
  Write-Ok '已取得凭据（密码只传给 NSSM 作为服务凭据，不写进脚本、配置或日志）'
} else {
  Write-Info '（预演模式跳过密码输入）'
}

try {
  # ------------------------------------------------------------------- 构建

  if ($SkipBuild -or $script:DryRun) {
    Write-Info "跳过构建（$(if ($script:DryRun) { '预演模式' } else { '-SkipBuild' })）"
  } else {
    Write-Step '构建前端与服务端'

    # 根目录的 `npm run build` 只构建 web；服务端要单独构建。
    # 注意 @openai/codex 在根 devDependencies 里，所以这里必须完整安装，
    # 不能用 npm ci --omit=dev，否则 supervisor 找不到 codex 可执行文件。
    if (-not (Test-Path (Join-Path $repoRoot 'node_modules'))) {
      Write-Info '安装依赖（npm ci）...'
      Push-Location $repoRoot
      try { npm ci } finally { Pop-Location }
      if ($LASTEXITCODE -ne 0) { throw "npm ci 失败（退出码 $LASTEXITCODE）" }
    }

    Write-Info '构建 web ...'
    Push-Location $repoRoot
    try { npm run build --workspace=@vibemobile/web } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { throw "web 构建失败（退出码 $LASTEXITCODE）" }

    Write-Info '构建 server ...'
    Push-Location $repoRoot
    try { npm run build --workspace=@vibemobile/server } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { throw "server 构建失败（退出码 $LASTEXITCODE）" }

    Write-Ok '构建完成'
  }

  # ------------------------------------------------------------------- nssm

  Write-Step '准备 NSSM'
  $nssm = Get-Nssm -RepoRoot $repoRoot

  # ----------------------------------------------------------- 处理已存在服务

  $existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  if ($existing) {
    if (-not $Force) {
      throw "服务 $ServiceName 已存在。如需重装，请加 -Force（会先停止并删除现有服务）。"
    }
    Write-Step "服务 $ServiceName 已存在，先停止并删除（-Force）"
    Invoke-Nssm -Nssm $nssm -Arguments @('stop', $ServiceName)
    if (-not $script:DryRun) { Start-Sleep -Seconds 2 }
    Invoke-Nssm -Nssm $nssm -Arguments @('remove', $ServiceName, 'confirm')
    if (-not $script:DryRun) { Start-Sleep -Seconds 1 }
    Write-Ok '已删除旧服务'
  }

  # --------------------------------------------------------------- 创建服务

  Write-Step "创建服务 $ServiceName"
  Invoke-Nssm -Nssm $nssm -Arguments @('install', $ServiceName, $nodeExe)
  # 入口路径可能含空格，必须加引号，否则 node 会把路径拆成两段参数。
  Invoke-Nssm -Nssm $nssm -Arguments @('set', $ServiceName, 'AppParameters', "`"$entry`"")
  Invoke-Nssm -Nssm $nssm -Arguments @('set', $ServiceName, 'AppDirectory', $repoRoot)
  Write-Ok '服务已注册'

  # --------------------------------------------------------------- 环境变量

  Write-Step '写入环境变量'

  if (-not $script:DryRun) {
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  }

  $envPairs = @(
    "PORT=$Port",
    'VIBEMOBILE_HOST=0.0.0.0',
    'VIBEMOBILE_LOG=info',
    "VIBEMOBILE_TERMINAL=$Terminal",
    "VIBEMOBILE_ROOTS=$WorkspaceRoot",
    "VIBEMOBILE_STATE_DIR=$stateDir"
  )
  if ($Pin) { $envPairs += "VIBEMOBILE_PIN=$Pin" }

  Invoke-Nssm -Nssm $nssm -Arguments (@('set', $ServiceName, 'AppEnvironmentExtra') + $envPairs)
  foreach ($pair in $envPairs) { Write-Info $pair }

  # ------------------------------------------------------------------- 日志

  Invoke-Nssm -Nssm $nssm -Arguments @('set', $ServiceName, 'AppStdout', (Join-Path $logDir 'service.out.log'))
  Invoke-Nssm -Nssm $nssm -Arguments @('set', $ServiceName, 'AppStderr', (Join-Path $logDir 'service.err.log'))
  Invoke-Nssm -Nssm $nssm -Arguments @('set', $ServiceName, 'AppRotateFiles', '1')
  Invoke-Nssm -Nssm $nssm -Arguments @('set', $ServiceName, 'AppRotateOnline', '1')
  Invoke-Nssm -Nssm $nssm -Arguments @('set', $ServiceName, 'AppRotateBytes', '5242880')
  Write-Ok "日志目录：$logDir"

  # ------------------------------------------------------------------- 账户

  Write-Step "设置运行账户 $RunAsUser"
  Invoke-Nssm -Nssm $nssm `
    -Arguments @('set', $ServiceName, 'ObjectName', $RunAsUser, $plain) `
    -Display "set $ServiceName ObjectName $RunAsUser ******"

  # ------------------------------------------------------- 自启 / 重启 / 停止

  Write-Step '配置自启、崩溃重启与优雅停止'
  Invoke-Nssm -Nssm $nssm -Arguments @('set', $ServiceName, 'Start', 'SERVICE_AUTO_START')
  Invoke-Nssm -Nssm $nssm -Arguments @('set', $ServiceName, 'AppExit', 'Default', 'Restart')
  Invoke-Nssm -Nssm $nssm -Arguments @('set', $ServiceName, 'AppRestartDelay', '10000')
  # 服务端注册了 SIGINT 处理；NSSM 默认给控制台程序发 Ctrl+C，等它自己收尾再强杀。
  Invoke-Nssm -Nssm $nssm -Arguments @('set', $ServiceName, 'AppStopMethodConsole', '15000')
  Write-Ok '开机自启、崩溃 10s 后重启、停止时最多等 15s 优雅退出'

  # ------------------------------------------------------------------- 启动

  Write-Step '启动服务'
  Invoke-Nssm -Nssm $nssm -Arguments @('start', $ServiceName)

  if ($script:DryRun) {
    Write-Host ''
    Write-Host '  预演结束，未改动系统。去掉 -DryRun 即正式安装。' -ForegroundColor Yellow
    Write-Host ''
    exit 0
  }

  Start-Sleep -Seconds 5
  $svc = Get-Service -Name $ServiceName
  Write-Ok "服务状态：$($svc.Status)"

  # ------------------------------------------------------------------- 汇报

  $pinShown = $Pin
  if (-not $pinShown) {
    $stateFile = Join-Path $stateDir 'state.json'
    if (Test-Path $stateFile) {
      try {
        $state = Get-Content $stateFile -Raw | ConvertFrom-Json
        if (@($state.PSObject.Properties.Name) -contains 'generatedPin') { $pinShown = $state.generatedPin }
      } catch { }
    }
  }

  $lan = @()
  try {
    $lan = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
      Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
      Select-Object -ExpandProperty IPAddress)
  } catch { }

  Write-Host ''
  Write-Host '========================================================' -ForegroundColor White
  Write-Host '  安装完成' -ForegroundColor Green
  Write-Host '========================================================' -ForegroundColor White
  Write-Host ''
  if ($lan.Count -gt 0) {
    foreach ($ip in $lan) { Write-Host "    手机访问：  http://${ip}:$Port" }
  } else {
    Write-Host "    本机访问：  http://localhost:$Port"
  }
  if ($pinShown) {
    Write-Host "    登录 PIN：  $pinShown"
  } else {
    Write-Host "    登录 PIN：  见 $logDir\service.out.log"
  }
  Write-Host ''
  Write-Host "    服务名：    $ServiceName（已随开机自启）"
  Write-Host "    日志：      $logDir\service.out.log"
  Write-Host "    管理：      services.msc"
  Write-Host ''
  Write-Host '    卸载：      .\uninstall-service.ps1' -ForegroundColor Gray
  Write-Host ''

  if ($svc.Status -ne 'Running') {
    Write-Warn2 "服务没能进入 Running 状态，请看 $logDir\service.err.log 排查。"
    exit 1
  }
} finally {
  $plain = $null
  Remove-Variable plain -ErrorAction SilentlyContinue
}
