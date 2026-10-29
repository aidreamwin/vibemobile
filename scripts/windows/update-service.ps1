<#
.SYNOPSIS
  增量部署：只重建改动过的那一半，只在必要时重启服务。

.DESCRIPTION
  和 install-service.ps1 的分工：那个负责「装」，这个负责「更新」。它不碰服务的
  注册、运行账户、环境变量和日志配置 —— 那些装好之后就不该再动。这个脚本只做
  一件事：把当前工作区的内容变成线上正在跑的东西，并且尽量少做无用功。

  整个脚本的形状由三条事实决定：

    - 前端 `apps/web/dist` 由 @fastify/static 按请求读磁盘（server/src/index.ts），
      所以**重建即生效**，不需要重启进程。
    - 后端代码在进程启动时就载入内存了，改了**必须重启**才生效。
    - 启动时若 `apps/web/dist` 不存在，静态目录根本不会被注册（那一句
      `fs.existsSync`），这种情况下重建前端也必须重启，否则服务一直在答 404。

  所以「改了什么」同时决定「构建哪一半」和「要不要重启」。差集靠上次部署记下的
  commit 算：`git diff --name-only <基线>..HEAD`，再并上工作区里还没提交的改动
  （构建产物是从工作区长出来的，不是从 HEAD）。

  **先构建、后重启**：构建失败时线上仍跑着旧的可用版本，不会因为一次改坏的东西
  把服务弄下线。

.PARAMETER ServiceName
  服务名，默认 VibeMobile。

.PARAMETER Port
  健康检查用的端口。不传则从服务自身的环境变量里读 PORT，读不到按 3000。

.PARAMETER All
  跳过差集，前后端全量重建并重启。首次更新、或者差集算不出来时用它。

.PARAMETER DryRun
  只打印将要做什么。不构建、不重启、不写部署记录。

.EXAMPLE
  .\update-service.ps1 -DryRun
  先看一眼这次会构建哪一半、要不要重启。

.EXAMPLE
  .\update-service.ps1
  常规更新：改了前端就只重建前端，改到后端才重启。

.EXAMPLE
  .\update-service.ps1 -All
  全量重建并重启，用于排查「明明改了却没生效」这类问题。
#>
[CmdletBinding()]
param(
  [string]$ServiceName = 'VibeMobile',
  [int]$Port = 0,
  [switch]$All,
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
    throw '更新需要管理员权限（可能得重启服务）。请右键“以管理员身份运行”。'
  }
}

# 走 package.json 的 workspaces 字段定位仓库根，和 config.ts 里 repoRoot() 的逻辑
# 保持一致：脚本从哪个目录被调用都不影响结果。
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

# 服务实际监听哪个端口以它自己的环境变量为准 —— 装的时候允许 -Port 换端口，
# 硬编码 3000 会在那种机器上检查一个空端口然后误报失败。
function Get-ServicePort {
  param([string]$RepoRoot, [string]$ServiceName)

  $nssm = Join-Path $RepoRoot 'scripts\windows\tools\nssm.exe'
  if (Test-Path $nssm) {
    try {
      $lines = & $nssm get $ServiceName AppEnvironmentExtra 2>$null
      foreach ($line in @($lines)) {
        if ($line -match '^\s*PORT\s*=\s*(\d+)') { return [int]$Matches[1] }
      }
    } catch { }
  }
  return 3000
}

# ------------------------------------------------------------------ 差集

function Invoke-Git {
  param([string]$RepoRoot, [string[]]$Arguments)

  $out = & git -C $RepoRoot @Arguments 2>$null
  if ($LASTEXITCODE -ne 0) { return $null }
  # 同理用逗号保住数组形状，调用方靠 $null 区分「失败」和「没有输出」。
  return ,@($out)
}

function Get-Baseline {
  param([string]$MarkerPath)

  if (-not (Test-Path $MarkerPath)) { return $null }
  try {
    $m = Get-Content $MarkerPath -Raw | ConvertFrom-Json
    if (@($m.PSObject.Properties.Name) -contains 'commit') { return [string]$m.commit }
  } catch { }
  return $null
}

# 返回改动文件数组；返回 $null 表示「算不出来，按全量处理」。
function Get-ChangedSet {
  param([string]$RepoRoot, [string]$Baseline)

  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Warn2 'PATH 里没有 git，无法计算差集 —— 按全量处理。'
    return $null
  }

  $files = New-Object 'System.Collections.Generic.HashSet[string]'

  if ($Baseline) {
    # 基线那个 commit 还在吗？rebase / amend 之后可能已经不存在了。
    # PowerShell 7 会把原生命令的 stderr 当成 NativeCommandError；临时放宽错误策略，
    # 否则下面本应走的「按全量处理」分支会在 cat-file 这里提前中断。
    $previousErrorAction = $ErrorActionPreference
    try {
      $ErrorActionPreference = 'Continue'
      $null = & git -C $RepoRoot cat-file -e "$Baseline^{commit}" 2>$null
      $baselineExitCode = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $previousErrorAction
    }
    if ($baselineExitCode -ne 0) {
      Write-Warn2 "记录的基线 commit $Baseline 已不存在（rebase 过？）—— 按全量处理。"
      return $null
    }

    $committed = Invoke-Git -RepoRoot $RepoRoot -Arguments @('diff', '--name-only', "$Baseline..HEAD")
    if ($null -eq $committed) {
      Write-Warn2 'git diff 失败 —— 按全量处理。'
      return $null
    }
    foreach ($f in $committed) { if ($f) { [void]$files.Add($f.Trim()) } }
  }

  # 未提交的改动也算：构建读的是工作区，不是 HEAD。
  $status = Invoke-Git -RepoRoot $RepoRoot -Arguments @('status', '--porcelain')
  if ($status) {
    foreach ($line in $status) {
      if (-not $line -or $line.Length -lt 4) { continue }
      $p = $line.Substring(3).Trim()
      # 重命名是 "old -> new"，两边都要算进去。
      if ($p -match '->') {
        foreach ($part in ($p -split '->')) { [void]$files.Add($part.Trim().Trim('"')) }
      } else {
        [void]$files.Add($p.Trim('"'))
      }
    }
  }

  # 逗号不能省：PowerShell 会把返回的数组摊进管道，空数组摊完什么都不剩，
  # 赋值方拿到的是 $null —— 那正好和上面「算不出来」的哨兵值撞车，于是
  # 「没有改动」会被当成「无法计算」而触发一次全量重建。
  return ,@($files)
}

# 把改动文件按「影响哪一半」归类。依赖清单算两边：lockfile 一动，两边的产物都
# 可能变。apps/web/dist 是自己刚生成的东西，不算改动。
function Classify-Changes {
  param([string[]]$Files)

  $web = $false
  $server = $false
  $deps = $false
  $other = New-Object 'System.Collections.Generic.List[string]'

  foreach ($f in $Files) {
    $p = ($f -replace '\\', '/').Trim()
    if (-not $p) { continue }

    # 依赖清单/构建配置改动按「两端都可能受影响」处理。这里保守是刻意的：判断
    # 「这次 lockfile 变动到底涉不涉及服务端那棵依赖树」需要把两棵依赖闭包都算出来
    # 再比，成本远超它省下的那几秒；而漏判的后果是服务端跑着旧依赖却不重启。
    if ($p -eq 'package.json' -or $p -eq 'package-lock.json' -or $p -like 'tsconfig*.json') {
      $deps = $true; $web = $true; $server = $true; continue
    }
    # dist 是构建产物自己，列出来只是噪音。
    if ($p -like 'apps/web/dist/*' -or $p -like 'apps/server/dist/*') { continue }
    if ($p -like 'apps/web/*') { $web = $true; continue }
    if ($p -like 'apps/server/*' -or $p -like 'packages/*') { $server = $true; continue }
    [void]$other.Add($p)
  }

  return [pscustomobject]@{ Web = $web; Server = $server; Deps = $deps; Other = $other }
}

# ------------------------------------------------------------------ 构建 / 重启

function Invoke-Build {
  param([string]$RepoRoot, [string]$Workspace, [string]$Label)

  if ($script:DryRun) {
    Write-Info "[dry-run] npm run build --workspace=$Workspace"
    return
  }
  Write-Info "构建 $Label ..."
  Push-Location $RepoRoot
  try { npm run build "--workspace=$Workspace" } finally { Pop-Location }
  if ($LASTEXITCODE -ne 0) { throw "$Label 构建失败（退出码 $LASTEXITCODE）。服务未重启，线上仍是上一个可用版本。" }
}

function Test-Health {
  param([int]$Port, [int]$TimeoutSeconds = 30)

  $url = "http://127.0.0.1:$Port/api/health"
  for ($i = 1; $i -le $TimeoutSeconds; $i++) {
    try {
      return Invoke-RestMethod -Uri $url -TimeoutSec 4
    } catch {
      Start-Sleep -Seconds 1
    }
  }
  return $null
}

# --------------------------------------------------------------------- 主流程

Write-Host '========================================================' -ForegroundColor White
if ($script:DryRun) {
  Write-Host '     VibeMobile 增量部署（预演，不改动系统）' -ForegroundColor Yellow
} else {
  Write-Host '        VibeMobile 增量部署' -ForegroundColor White
}
Write-Host '========================================================' -ForegroundColor White

Write-Step '检查权限与环境'
Assert-Administrator
Write-Ok '管理员权限 OK'

$repoRoot = Find-RepoRoot -Start $PSScriptRoot
Write-Ok "仓库根目录：$repoRoot"

$nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodeExe) { throw 'PATH 里找不到 node.exe，请先安装 Node.js（>=20）。' }
Write-Ok "node：$(& $nodeExe -v)"

$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if (-not $service) {
  throw "找不到服务 $ServiceName。先跑 install-service.ps1 装上，或者用 -ServiceName 指定别的名字。"
}
Write-Ok "服务 $ServiceName 现状：$($service.Status)"

if ($Port -le 0) { $Port = Get-ServicePort -RepoRoot $repoRoot -ServiceName $ServiceName }
$healthUrl = "http://127.0.0.1:$Port/api/health"
Write-Ok "健康检查：$healthUrl"

$stateDir = Join-Path $repoRoot '.vibemobile'
$markerPath = Join-Path $stateDir 'last-deploy.json'
$webDist = Join-Path $repoRoot 'apps\web\dist\index.html'
$serverEntry = Join-Path $repoRoot 'apps\server\dist\index.js'

# --------------------------------------------------------------- 决定做什么

Write-Step '计算改动范围'

$buildWeb = $false
$buildServer = $false
$needRestart = $false
$reasons = New-Object 'System.Collections.Generic.List[string]'

if ($All) {
  $buildWeb = $true; $buildServer = $true; $needRestart = $true
  [void]$reasons.Add('-All：全量重建并重启')
} else {
  $baseline = Get-Baseline -MarkerPath $markerPath
  if ($baseline) {
    Write-Info "上次部署的基线：$baseline"
    $changes = Get-ChangedSet -RepoRoot $repoRoot -Baseline $baseline
  } else {
    # 差集是相对于「某一次部署」而言的，没有记录就没有基准可言。这时候只能
    # 按全量处理 —— 若退化成「只看未提交的改动」，一个干净的工作区会得出
    # 「无事可做」，而线上跑的可能是几个月前的产物。跑完记下基线，之后才是增量的。
    Write-Info '没有部署记录，这是第一次增量部署 —— 按全量处理，并记下基线'
    $changes = $null
  }

  if ($null -eq $changes) {
    $buildWeb = $true; $buildServer = $true; $needRestart = $true
    [void]$reasons.Add('没有可用的基线差集：全量重建并重启')
  } else {
    $count = @($changes).Count
    if ($count -eq 0) {
      Write-Ok '工作区与基线一致，没有改动'
    } else {
      Write-Info "$count 个文件有改动（含未提交的部分）"
      $kind = Classify-Changes -Files $changes
      # 依赖清单的改动会同时打开两端，所以要说清楚是"清单变了"而不是
      # "服务端源码变了" —— 否则日志会指向一个根本没被改过的目录。
      if ($kind.Deps) {
        $buildWeb = $true; $buildServer = $true; $needRestart = $true
        [void]$reasons.Add('依赖清单或构建配置有改动：两端都重建，并重启')
      } else {
        if ($kind.Web) { $buildWeb = $true; [void]$reasons.Add('apps/web 有改动：重建前端（无需重启）') }
        if ($kind.Server) { $buildServer = $true; $needRestart = $true; [void]$reasons.Add('apps/server 或 packages 有改动：重建后端并重启') }
      }
      if ($kind.Other.Count -gt 0 -and -not $kind.Web -and -not $kind.Server) {
        Write-Info "改动都不影响构建产物（$($kind.Other.Count) 个，如文档、脚本）：$($kind.Other -join ', ')"
      }
    }
  }
}

# dist 不存在的话，光重建还不够 —— 静态目录的注册发生在进程启动时。
if (-not (Test-Path $webDist)) {
  $buildWeb = $true; $needRestart = $true
  [void]$reasons.Add('apps/web/dist 不存在：重建前端，且必须重启才能注册静态目录')
}
if (-not (Test-Path $serverEntry)) {
  $buildServer = $true; $needRestart = $true
  [void]$reasons.Add('apps/server/dist 不存在：重建后端')
}
# 服务没在跑就无所谓"需不需要"重启了，直接拉起来。
if ($service.Status -ne 'Running') {
  $needRestart = $true
  [void]$reasons.Add('服务当前不是 Running：需要启动')
}

# ------------------------------------------------------------------ 行动计划

Write-Step '本次将执行'
if ($reasons.Count -eq 0) {
  Write-Ok '无事可做 —— 没有改动，服务也在跑。'
} else {
  foreach ($r in $reasons) { Write-Info "- $r" }
}
Write-Host ''
Write-Host ("    构建前端：{0}" -f $(if ($buildWeb) { '是' } else { '否' }))
Write-Host ("    构建后端：{0}" -f $(if ($buildServer) { '是' } else { '否' }))
Write-Host ("    重启服务：{0}" -f $(if ($needRestart) { '是' } else { '否' })) -ForegroundColor $(if ($needRestart) { 'Yellow' } else { 'Gray' })

if ($reasons.Count -eq 0 -and -not $DryRun) {
  # 没有改动也要确认服务是活的，否则"无事可做"会掩盖一个已经挂掉的服务。
  $h = Test-Health -Port $Port -TimeoutSeconds 5
  if ($null -eq $h) {
    Write-Warn2 '但是健康检查没有响应 —— 服务可能处于崩溃循环，看 .vibemobile\logs\service.err.log'
    exit 1
  }
  Write-Ok '健康检查通过'
  exit 0
}

if ($script:DryRun) {
  Write-Host ''
  Write-Host '  预演结束，未改动任何东西。去掉 -DryRun 即正式执行。' -ForegroundColor Yellow
  Write-Host ''
  exit 0
}

# ------------------------------------------------------------------ 构建阶段
#
# 构建全部做完再重启。中途失败就直接退出，线上继续跑旧版本 —— 一次改坏的提交
# 不该把正在用的服务弄下线。

if ($buildWeb) {
  Write-Step '构建前端'
  Invoke-Build -RepoRoot $repoRoot -Workspace '@vibemobile/web' -Label 'web'
  Write-Ok '前端构建完成'
}

if ($buildServer) {
  Write-Step '构建后端'
  Invoke-Build -RepoRoot $repoRoot -Workspace '@vibemobile/server' -Label 'server'
  Write-Ok '后端构建完成'
}

# ------------------------------------------------------------------ 重启阶段

if ($needRestart) {
  Write-Step "重启服务 $ServiceName"

  # 服务端注册了 SIGINT 处理，NSSM 设了 AppStopMethodConsole 15s；停止可能要等
  # 十几秒，Restart-Service 会一直等到 SCM 确认状态变化，不要以为它卡住了。
  try {
    Restart-Service -Name $ServiceName -Force
  } catch {
    throw "重启失败：$($_.Exception.Message)。看 .vibemobile\logs\service.err.log"
  }
  $svc = Get-Service -Name $ServiceName
  Write-Ok "服务状态：$($svc.Status)"
  if ($svc.Status -ne 'Running') {
    throw "服务没有进入 Running 状态。看 .vibemobile\logs\service.err.log 排查。"
  }
} else {
  Write-Step '跳过重启'
  Write-Ok '改动只影响前端产物，服务按请求读盘，已经是新的了'
}

# ------------------------------------------------------------------ 验证阶段

Write-Step '验证'

$health = Test-Health -Port $Port
if ($null -eq $health) {
  Write-Warn2 "健康检查失败：$healthUrl 30 秒内没有响应。"
  Write-Warn2 '服务可能正处于崩溃循环 —— /api/health 是唯一权威判据，SCM 说 Running 不算数。'
  Write-Warn2 '看 .vibemobile\logs\service.err.log；部署记录未更新，下次会重试。'
  exit 1
}

$ready = $false
if (@($health.PSObject.Properties.Name) -contains 'providers') {
  $ready = @($health.providers | Where-Object { $_.ready -eq $true }).Count -gt 0
}
if (-not $ready) {
  # 服务活着但 Codex 没就绪 —— 最常见的原因是登录态过期，界面能开但发不出任务。
  Write-Warn2 '服务活着，但 Codex 未就绪（providers[].ready 为 false）。'
  Write-Warn2 '通常是登录态过期：在服务运行的账户下重新 codex login，然后重启服务。'
} else {
  # StrictMode 下访问不存在的属性会抛异常，而 uptime 只是拿来说明的，不值得为它
  # 让整个验证阶段失败。
  $uptime = if (@($health.PSObject.Properties.Name) -contains 'uptime') { "$($health.uptime)s" } else { '未知' }
  Write-Ok "健康检查通过（uptime $uptime，Codex 已就绪）"
}

# ------------------------------------------------------------------ 记录基线
#
# 只有真正部署成功才更新基线。验证失败时保留旧基线，下次重跑会重做这次的工作。

$commit = $null
try {
  $head = & git -C $repoRoot rev-parse HEAD 2>$null
  if ($LASTEXITCODE -eq 0) { $commit = "$head".Trim() }
} catch { }

if ($commit) {
  if (-not (Test-Path $stateDir)) { New-Item -ItemType Directory -Force -Path $stateDir | Out-Null }
  $dirty = $false
  $st = & git -C $repoRoot status --porcelain 2>$null
  if ($st) { $dirty = @($st).Count -gt 0 }

  $record = [ordered]@{
    commit    = $commit
    deployedAt = (Get-Date).ToString('o')
    port      = $Port
    built     = @(if ($buildWeb) { 'web' }; if ($buildServer) { 'server' })
    restarted = $needRestart
    # 工作区不干净意味着线上跑的东西不完全是这个 commit —— 记下来，免得下次
    # 有人对着这个 commit 想不通「为什么线上的行为对不上代码」。
    dirtyTree = $dirty
  }
  ($record | ConvertTo-Json) | Set-Content -Path $markerPath -Encoding UTF8
  Write-Info "部署记录已更新：$markerPath"
  if ($dirty) { Write-Warn2 '注意：工作区有未提交的改动，线上跑的不完全是这个 commit。' }
} else {
  Write-Warn2 '读不到 git HEAD，本次不更新部署记录 —— 下次会按全量处理。'
}

Write-Host ''
Write-Host '========================================================' -ForegroundColor White
Write-Host '  更新完成' -ForegroundColor Green
Write-Host '========================================================' -ForegroundColor White
Write-Host ''
Write-Host "    访问：    http://localhost:$Port" -ForegroundColor Gray
Write-Host '    日志：    .vibemobile\logs\service.out.log' -ForegroundColor Gray
Write-Host '    全量重来：.\update-service.ps1 -All' -ForegroundColor Gray
Write-Host ''
