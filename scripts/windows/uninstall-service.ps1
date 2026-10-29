<#
.SYNOPSIS
  停止并卸载 VibeMobile 的 Windows 服务。

.DESCRIPTION
  只删服务本身，不动 .vibemobile/（登录 PIN、JWT 密钥、日志）和构建产物，
  重装后可以直接续用原来的 PIN。想彻底清干净，卸载完手动删 .vibemobile 即可。

.PARAMETER ServiceName
  服务名，默认 VibeMobile。

.PARAMETER KeepNssm
  保留 scripts\windows\tools\nssm.exe（重装时省一次下载）。

.EXAMPLE
  .\uninstall-service.ps1
#>
[CmdletBinding()]
param(
  [string]$ServiceName = 'VibeMobile',
  [switch]$KeepNssm
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg) { Write-Host "    $msg" -ForegroundColor Green }
function Write-Info($msg) { Write-Host "    $msg" -ForegroundColor Gray }

function Assert-Administrator {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($id)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw '卸载服务需要管理员权限。请右键“以管理员身份运行”。'
  }
}

Write-Host '========================================================' -ForegroundColor White
Write-Host '        VibeMobile Windows 服务卸载' -ForegroundColor White
Write-Host '========================================================' -ForegroundColor White

Write-Step '检查权限'
Assert-Administrator
Write-Ok '管理员权限 OK'

$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if (-not $svc) {
  Write-Info "服务 $ServiceName 不存在，无需卸载。"
  exit 0
}

# 优先用 tools 里那份 nssm.exe；万一被删了就用 sc.exe，删服务一样有效。
$nssm = Join-Path $PSScriptRoot 'tools\nssm.exe'

Write-Step "停止服务 $ServiceName"
if (Test-Path $nssm) {
  & $nssm stop $ServiceName | Out-Null
} else {
  Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 3
Write-Ok '已停止'

Write-Step "删除服务 $ServiceName"
if (Test-Path $nssm) {
  & $nssm remove $ServiceName confirm | Out-Null
} else {
  & sc.exe delete $ServiceName | Out-Null
}
Start-Sleep -Seconds 1

if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
  throw "服务 $ServiceName 仍然存在，删除失败。"
}
Write-Ok '已删除'

if (-not $KeepNssm) {
  $tools = Join-Path $PSScriptRoot 'tools'
  if (Test-Path $tools) {
    Write-Step '清理 nssm.exe'
    Remove-Item $tools -Recurse -Force -ErrorAction SilentlyContinue
    Write-Ok '已清理'
  }
}

Write-Host ''
Write-Host '  卸载完成。' -ForegroundColor Green
Write-Host ''
Write-Host '  .vibemobile\（PIN、密钥、日志）和构建产物都保留着，' -ForegroundColor Gray
Write-Host '  重新安装会复用同一个 PIN。想彻底清干净就手动删掉 .vibemobile\。' -ForegroundColor Gray
Write-Host ''
