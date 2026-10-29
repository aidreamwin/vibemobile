<#
.SYNOPSIS
  Deploy prebuilt artifacts from an independent Scheduled Task, with rollback.
.DESCRIPTION
  Use SYSTEM only for this deployment task. The NSSM service retains its existing
  login account and agent credentials. Candidate and backup paths must be outside
  the service tree. No build, package installation or agent turn runs here.
#>
param(
  [Parameter(Mandatory=$true)][string]$Manifest,
  [switch]$VerifyOnly
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$config = Get-Content -LiteralPath $Manifest -Raw -Encoding UTF8 | ConvertFrom-Json
$root = [IO.Path]::GetFullPath($config.root).TrimEnd('\')
$job = [IO.Path]::GetFullPath((Split-Path $Manifest -Parent)).TrimEnd('\')
if ($job.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Deployment job must live outside the service tree' }
$log = Join-Path $job $(if ($VerifyOnly) { 'rehearsal.log' } else { 'deployment.log' })
$result = Join-Path $job $(if ($VerifyOnly) { 'rehearsal-result.json' } else { 'result.json' })
Start-Transcript -LiteralPath $log -Append | Out-Null
$changed = New-Object 'System.Collections.Generic.List[object]'
$serviceTouched = $false

function Check-Health([string]$File) {
  & $config.node (Join-Path $job 'verify-deployment.mjs') $File
  if ($LASTEXITCODE -ne 0) { throw 'Health verification failed' }
}
function Stop-Bounded {
  $svc = Get-CimInstance Win32_Service -Filter "Name='$($config.service)'"
  if ($svc.State -eq 'Stopped') { return }
  $wrapperPid = [int]$svc.ProcessId
  & sc.exe stop $config.service | Out-Host
  $deadline = (Get-Date).AddSeconds(25)
  do {
    if ((Get-Service $config.service).Status -eq 'Stopped') { return }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)
  # NSSM sometimes remains StopPending. Limit termination to this service's
  # verified wrapper and its children; never terminate unrelated Node processes.
  $wrapper = Get-CimInstance Win32_Process -Filter "ProcessId=$wrapperPid"
  if (-not $wrapper -or [IO.Path]::GetFullPath($wrapper.ExecutablePath) -ne [IO.Path]::GetFullPath($config.nssm)) { throw 'Cannot verify NSSM process identity' }
  & taskkill.exe /PID $wrapperPid /T /F | Out-Host
  if ($LASTEXITCODE -ne 0) { throw 'Cannot terminate stuck NSSM wrapper' }
  (Get-Service $config.service).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(10))
}
function Start-Bounded {
  & sc.exe start $config.service | Out-Host
  (Get-Service $config.service).WaitForStatus('Running', [TimeSpan]::FromSeconds(25))
}
function Write-Result([string]$Status, [string]$Detail) {
  @{ status=$Status; detail=$Detail; time=(Get-Date).ToString('o'); log=$log } | ConvertTo-Json | Set-Content -LiteralPath $result -Encoding UTF8
}

try {
  foreach ($half in @('server','web')) {
    $candidate = Join-Path $job $half
    $required = if ($half -eq 'server') { 'distributed\hub.js' } else { 'index.html' }
    if (-not (Test-Path -LiteralPath (Join-Path $candidate $required))) { throw "Missing candidate $half" }
  }
  Check-Health (Join-Path $job 'baseline.json')
  if ($VerifyOnly) {
    Write-Result 'rehearsal-passed' 'Independent task can read artifacts, authenticate and verify the running deployment.'
    exit 0
  }
  $serviceTouched = $true
  Stop-Bounded
  foreach ($half in @('server','web')) {
    $active = [IO.Path]::GetFullPath((Join-Path $root "apps\$half\dist"))
    $backup = [IO.Path]::GetFullPath((Join-Path $job "backup-$half"))
    if (-not $active.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase) -or -not $backup.StartsWith($job + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Artifact path outside allowed roots' }
    if (Test-Path -LiteralPath $backup) { throw "Backup already exists: $backup" }
    Move-Item -LiteralPath $active -Destination $backup
    $changed.Add(@{active=$active; backup=$backup; half=$half})
    Copy-Item -LiteralPath (Join-Path $job $half) -Destination $active -Recurse
  }
  Start-Bounded
  Check-Health (Join-Path $job 'expected.json')
  Write-Result 'deployed' 'New build, HTTPS, runner links, Codex readiness, session queries and SPA assets verified.'
} catch {
  $failure = $_.Exception.Message
  Write-Warning $failure
  try {
    if ($serviceTouched) {
      Stop-Bounded
      foreach ($entry in $changed) {
        if (Test-Path -LiteralPath $entry.active) {
          $failed = [IO.Path]::GetFullPath((Join-Path $job "failed-$($entry.half)"))
          if (-not $failed.StartsWith($job + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid failed artifact path' }
          Move-Item -LiteralPath $entry.active -Destination $failed
        }
        Move-Item -LiteralPath $entry.backup -Destination $entry.active
      }
      Start-Bounded
      Check-Health (Join-Path $job 'baseline.json')
    }
    Write-Result $(if ($serviceTouched) { 'rolled-back' } else { 'preflight-failed' }) $failure
  } catch {
    Write-Result 'rollback-failed' "$failure; rollback: $($_.Exception.Message)"
  }
  exit 1
} finally {
  Stop-Transcript | Out-Null
}
