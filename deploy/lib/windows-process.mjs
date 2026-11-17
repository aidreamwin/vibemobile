import { spawnSync } from 'node:child_process'

function powershell(script) {
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { encoding: 'utf8', windowsHide: true },
  )
  if (result.error || result.status !== 0) throw new Error('could not inspect or stop the Windows process tree')
  return result.stdout.trim()
}

/** Snapshot descendants before PM2 removes their parent, without inspecting ports or process names. */
export function windowsDescendants(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return []
  const raw = powershell(`
$ErrorActionPreference = 'Stop'
$processes = @(Get-CimInstance Win32_Process)
$pending = [System.Collections.Generic.Queue[object]]::new()
$seen = [System.Collections.Generic.HashSet[uint32]]::new()
$root = $processes | Where-Object { $_.ProcessId -eq ${pid} }
if ($null -ne $root) { $pending.Enqueue($root); [void]$seen.Add($root.ProcessId) }
$result = [System.Collections.Generic.List[object]]::new()
while ($pending.Count) {
  $parent = $pending.Dequeue()
  foreach ($item in $processes) {
    if ($item.ParentProcessId -eq $parent.ProcessId -and $item.CreationDate -ge $parent.CreationDate -and $seen.Add($item.ProcessId)) {
      $pending.Enqueue($item)
      $result.Add(@{ pid = [int]$item.ProcessId; created = $item.CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.ffffffZ') })
    }
  }
}
ConvertTo-Json -InputObject @($result.ToArray()) -Compress
`)
  return JSON.parse(raw)
}

/** Only reap captured descendants that still have the same creation time (PID reuse is possible). */
export function reapWindowsDescendants(snapshot) {
  if (!snapshot.length) return
  const payload = Buffer.from(JSON.stringify([...snapshot].reverse())).toString('base64')
  powershell(`
$ErrorActionPreference = 'Stop'
$items = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')))
foreach ($item in $items) {
  $current = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$item.pid)
  if ($null -ne $current -and $current.CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.ffffffZ') -eq $item.created) {
    $process = Get-Process -Id $item.pid -ErrorAction SilentlyContinue
    if ($null -ne $process -and $process.StartTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.ffffffZ') -eq $item.created) {
      $process | Stop-Process -Force -ErrorAction SilentlyContinue
    }
  }
}
`)
}
