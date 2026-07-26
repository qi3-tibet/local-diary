param(
  [Parameter(Mandatory = $true)]
  [string]$AppPath,
  [Parameter(Mandatory = $true)]
  [string]$UserDataRoot,
  [string]$ReportPath
)

$ErrorActionPreference = "Stop"
$resolvedApp = (Resolve-Path -LiteralPath $AppPath).Path
$resolvedUserData = [System.IO.Path]::GetFullPath($UserDataRoot)
if (Test-Path -LiteralPath $resolvedUserData) {
  throw "Release smoke requires a new user data root: $resolvedUserData"
}
New-Item -ItemType Directory -Path $resolvedUserData | Out-Null
$expectedDataPath = Join-Path (Join-Path $resolvedUserData "data") "diary.sqlite"
$previousBackupRoot = $env:DIARY_BACKUP_ROOT
$env:DIARY_BACKUP_ROOT = Join-Path $resolvedUserData "backups"

function Get-ProcessTreeIds([int]$RootId) {
  $ids = [System.Collections.Generic.HashSet[int]]::new()
  [void]$ids.Add($RootId)
  do {
    $changed = $false
    foreach ($process in Get-CimInstance Win32_Process) {
      if ($ids.Contains([int]$process.ParentProcessId) -and $ids.Add([int]$process.ProcessId)) {
        $changed = $true
      }
    }
  } while ($changed)
  return @($ids)
}

function Get-TreeListeners([int]$RootId) {
  $ids = Get-ProcessTreeIds $RootId
  return @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $ids -contains [int]$_.OwningProcess })
}

function Wait-ForHealth([System.Diagnostics.Process]$Process) {
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  do {
    if ($Process.HasExited) {
      throw "Local Diary exited before its health endpoint became available."
    }
    $listeners = Get-TreeListeners $Process.Id
    $nonLoopback = @($listeners | Where-Object { $_.LocalAddress -notin @("127.0.0.1", "::1") })
    if ($nonLoopback.Count -gt 0) {
      throw "Local Diary opened a non-loopback listener."
    }
    $loopback = @($listeners | Where-Object { $_.LocalAddress -eq "127.0.0.1" })
    foreach ($listener in $loopback) {
      $url = "http://127.0.0.1:$($listener.LocalPort)"
      try {
        $health = Invoke-RestMethod -Uri "$url/api/v1/health" -TimeoutSec 2
        if ($health.status -eq "ok") {
          return [pscustomobject]@{
            Url = $url
            Port = [int]$listener.LocalPort
            ListenerCount = $loopback.Count
          }
        }
      } catch {
        # Electron may have created the process before Fastify completed startup.
      }
    }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "Timed out waiting for the loopback health endpoint."
}

function Stop-ProcessTree([System.Diagnostics.Process]$Process) {
  if ($Process.HasExited) { return }
  $ids = Get-ProcessTreeIds $Process.Id | Sort-Object -Descending
  foreach ($id in $ids) {
    Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
  }
  $Process.WaitForExit(10000) | Out-Null
}

function Close-DesktopCleanly([System.Diagnostics.Process]$Process, [int]$Port) {
  $tree = Get-ProcessTreeIds $Process.Id
  $windowOwner = Get-Process -Id $tree -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } |
    Select-Object -First 1
  if (-not $windowOwner -or -not $windowOwner.CloseMainWindow()) {
    throw "Could not send WM_CLOSE to the desktop window."
  }
  if (-not $Process.WaitForExit(15000)) {
    throw "Desktop process did not exit after its window closed."
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  do {
    $listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
    if (-not $listener) { return }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "The local service listener remained after clean desktop shutdown."
}

function Start-Diary([string[]]$Arguments) {
  if ($Arguments -contains "--browser") {
    return Start-Process -FilePath $resolvedApp -ArgumentList $Arguments -PassThru -WindowStyle Hidden
  }
  return Start-Process -FilePath $resolvedApp -ArgumentList $Arguments -PassThru
}

$active = $null
try {
  # Start-Process joins ArgumentList items into one command line. Quote the
  # value explicitly so workspace paths containing spaces remain one Electron
  # switch instead of being truncated at the first space.
  $commonArguments = @("--user-data-dir=`"$resolvedUserData`"")
  $active = Start-Diary $commonArguments
  $first = Wait-ForHealth $active
  if ($first.ListenerCount -ne 1) {
    throw "Expected one loopback listener, found $($first.ListenerCount)."
  }

  $marker = "release-smoke-$([Guid]::NewGuid().ToString('N'))"
  Invoke-RestMethod -Method Put -Uri "$($first.Url)/api/v1/draft" -ContentType "application/json" -Body (
    @{ title = "Release smoke"; markdown = $marker; tags = @("release") } | ConvertTo-Json
  ) | Out-Null
  Invoke-RestMethod -Method Post -Uri "$($first.Url)/api/v1/draft/publish" -ContentType "application/json" -Body "{}" | Out-Null
  if (-not (Test-Path -LiteralPath $expectedDataPath)) {
    throw "Release smoke did not create its diary database in the isolated user data root: $expectedDataPath"
  }

  $secondLaunch = Start-Diary @($commonArguments + "--browser")
  if (-not $secondLaunch.WaitForExit(10000)) {
    Stop-ProcessTree $secondLaunch
    throw "The second shortcut launch did not hand off to the existing instance."
  }
  $afterHandoff = Get-TreeListeners $active.Id |
    Where-Object { $_.LocalAddress -eq "127.0.0.1" }
  if (@($afterHandoff).Count -ne 1 -or [int]$afterHandoff.LocalPort -ne $first.Port) {
    throw "Cross-mode launch did not preserve exactly one service instance."
  }

  Close-DesktopCleanly $active $first.Port
  $active = $null

  $active = Start-Diary $commonArguments
  $reopened = Wait-ForHealth $active
  $days = Invoke-RestMethod -Uri "$($reopened.Url)/api/v1/entries/days?limit=120&direction=older"
  $reused = @($days.days.entries.markdown) -contains $marker
  if (-not $reused) {
    throw "The second launch did not reuse the existing diary data directory."
  }
  Close-DesktopCleanly $active $reopened.Port
  $active = $null

  $active = Start-Diary @($commonArguments + "--browser")
  $browser = Wait-ForHealth $active
  if ($browser.ListenerCount -ne 1) {
    throw "Browser mode did not own exactly one loopback listener."
  }
  $browserDays = Invoke-RestMethod -Uri "$($browser.Url)/api/v1/entries/days?limit=120&direction=older"
  if (-not (@($browserDays.days.entries.markdown) -contains $marker)) {
    throw "Browser mode did not reuse desktop-mode data."
  }

  $report = [ordered]@{
    appPath = $resolvedApp
    userDataRoot = $resolvedUserData
    dataPath = $expectedDataPath
    dataPathVerified = $true
    firstLaunch = @{ url = $first.Url; loopbackListeners = $first.ListenerCount }
    secondInstance = @{ samePort = $true; serviceInstances = 1 }
    cleanShutdown = $true
    dataReused = $true
    browserMode = @{ url = $browser.Url; loopbackListeners = $browser.ListenerCount }
    nonLoopbackListeners = 0
  }
  $json = $report | ConvertTo-Json -Depth 5
  if ($ReportPath) {
    $resolvedReport = [System.IO.Path]::GetFullPath($ReportPath)
    [System.IO.File]::WriteAllText($resolvedReport, "$json`n", [System.Text.UTF8Encoding]::new($false))
  }
  Write-Output $json
} finally {
  if ($active) {
    Stop-ProcessTree $active
  }
  $env:DIARY_BACKUP_ROOT = $previousBackupRoot
}
