param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath,
  [Parameter(Mandatory = $true)]
  [string]$InstallRoot,
  [Parameter(Mandatory = $true)]
  [string]$RetentionProbeRoot
)

$ErrorActionPreference = "Stop"
$installer = (Resolve-Path -LiteralPath $InstallerPath).Path
$install = [System.IO.Path]::GetFullPath($InstallRoot)
$retention = [System.IO.Path]::GetFullPath($RetentionProbeRoot)
$defaultUserData = [System.IO.Path]::GetFullPath((Join-Path $env:APPDATA "Local Diary"))
$expectedDefaultUserData = [System.IO.Path]::GetFullPath((Join-Path ([System.IO.Path]::GetFullPath($env:APPDATA)) "Local Diary"))
$desktop = [Environment]::GetFolderPath("Desktop")
$programs = [Environment]::GetFolderPath("Programs")
$links = @(
  (Join-Path $desktop "Local Diary.lnk"),
  (Join-Path $desktop "Local Diary - Browser.lnk"),
  (Join-Path $programs "Local Diary.lnk"),
  (Join-Path $programs "Local Diary - Browser.lnk")
)

$existing = @($links | Where-Object { Test-Path -LiteralPath $_ })
if ($existing.Count -gt 0) {
  throw "Installer smoke will not overwrite existing Local Diary shortcuts: $($existing -join ', ')"
}
if (Test-Path -LiteralPath $install) {
  throw "Installer smoke requires a new install directory: $install"
}
if (Test-Path -LiteralPath $retention) {
  throw "Installer smoke requires a new retention probe directory: $retention"
}
if (Test-Path -LiteralPath $defaultUserData) {
  throw "Installer smoke will not touch existing Local Diary user data: $defaultUserData"
}
New-Item -ItemType Directory -Path $retention | Out-Null
$probe = Join-Path $retention "preserve-me.txt"
[System.IO.File]::WriteAllText($probe, "Local Diary data must survive uninstall.`n")
$defaultProbeToken = [Guid]::NewGuid().ToString("N")
$defaultProbe = Join-Path $defaultUserData ".installer-smoke-ownership"
$ownedDefaultUserData = $false
$uninstaller = $null
$uninstallCompleted = $false

try {
  $installProcess = Start-Process -FilePath $installer -ArgumentList @("/S", "/D=$install") -PassThru -Wait -WindowStyle Hidden
  if ($installProcess.ExitCode -ne 0) {
    throw "Installer returned exit code $($installProcess.ExitCode)."
  }
  $installedApp = Join-Path $install "Local Diary.exe"
  $uninstaller = Join-Path $install "Uninstall Local Diary.exe"
  if (-not (Test-Path -LiteralPath $installedApp) -or -not (Test-Path -LiteralPath $uninstaller)) {
    throw "Installer did not create the expected application and uninstaller."
  }
  New-Item -ItemType Directory -Path $defaultUserData | Out-Null
  $ownedDefaultUserData = $true
  [System.IO.File]::WriteAllText($defaultProbe, $defaultProbeToken)
  foreach ($link in $links) {
    if (-not (Test-Path -LiteralPath $link)) {
      throw "Installer did not create shortcut: $link"
    }
  }

  $shell = New-Object -ComObject WScript.Shell
  $desktopShortcut = $shell.CreateShortcut($links[0])
  $browserShortcut = $shell.CreateShortcut($links[1])
  $startBrowserShortcut = $shell.CreateShortcut($links[3])
  if ([System.IO.Path]::GetFullPath($desktopShortcut.TargetPath) -ne $installedApp) {
    throw "Desktop shortcut target is incorrect."
  }
  foreach ($shortcut in @($browserShortcut, $startBrowserShortcut)) {
    if ([System.IO.Path]::GetFullPath($shortcut.TargetPath) -ne $installedApp -or $shortcut.Arguments -ne "--browser") {
      throw "Browser shortcut target or arguments are incorrect."
    }
  }

  $uninstallProcess = Start-Process -FilePath $uninstaller -ArgumentList "/S" -PassThru -Wait -WindowStyle Hidden
  if ($uninstallProcess.ExitCode -ne 0) {
    throw "Uninstaller returned exit code $($uninstallProcess.ExitCode)."
  }
  $uninstallCompleted = $true
  foreach ($link in $links) {
    if (Test-Path -LiteralPath $link) {
      throw "Uninstaller left shortcut behind: $link"
    }
  }
  if (-not (Test-Path -LiteralPath $probe)) {
    throw "Uninstaller deleted the external diary data retention probe."
  }
  if (
    -not (Test-Path -LiteralPath $defaultProbe) -or
    ([System.IO.File]::ReadAllText($defaultProbe) -ne $defaultProbeToken)
  ) {
    throw "Uninstaller deleted or changed the default Local Diary user data probe."
  }

  [ordered]@{
    installer = $installer
    installRoot = $install
    desktopShortcut = @{ target = $desktopShortcut.TargetPath; arguments = $desktopShortcut.Arguments }
    browserShortcut = @{ target = $browserShortcut.TargetPath; arguments = $browserShortcut.Arguments }
    startMenuBrowserShortcut = @{ target = $startBrowserShortcut.TargetPath; arguments = $startBrowserShortcut.Arguments }
    uninstallRemovedShortcuts = $true
    uninstallPreservedExternalData = $true
    uninstallPreservedDefaultUserData = $true
  } | ConvertTo-Json -Depth 4
} finally {
  if (
    -not $uninstallCompleted -and
    $null -ne $uninstaller -and
    (Test-Path -LiteralPath $uninstaller)
  ) {
    try {
      Start-Process -FilePath $uninstaller -ArgumentList "/S" -PassThru -Wait -WindowStyle Hidden | Out-Null
    } catch {
      Write-Warning "Best-effort uninstall after smoke failure did not complete: $_"
    }
  }
  foreach ($link in $links) {
    if (Test-Path -LiteralPath $link) {
      Remove-Item -LiteralPath $link -Force
    }
  }
  $defaultRootOwnedAtCleanup = $false
  $defaultRootWasCreatedBySmoke = (
    $ownedDefaultUserData -and
    [string]::Equals(
      $defaultUserData,
      $expectedDefaultUserData,
      [System.StringComparison]::OrdinalIgnoreCase
    ) -and
    (Test-Path -LiteralPath $defaultUserData)
  )
  if ($defaultRootWasCreatedBySmoke -and (Test-Path -LiteralPath $defaultProbe)) {
    try {
      $defaultChildren = @(Get-ChildItem -LiteralPath $defaultUserData -Force)
      $defaultRootOwnedAtCleanup = (
        ([System.IO.File]::ReadAllText($defaultProbe) -eq $defaultProbeToken) -and
        ($defaultChildren.Count -eq 1) -and
        [string]::Equals(
          [System.IO.Path]::GetFullPath($defaultChildren[0].FullName),
          [System.IO.Path]::GetFullPath($defaultProbe),
          [System.StringComparison]::OrdinalIgnoreCase
        )
      )
    } catch {
      Write-Warning "Could not revalidate the installer-smoke ownership marker: $_"
    }
  }
  if ($defaultRootOwnedAtCleanup) {
    Remove-Item -LiteralPath $defaultUserData -Recurse -Force
  } elseif ($defaultRootWasCreatedBySmoke) {
    Write-Warning "Default user-data root changed during installer smoke; preserving it instead of deleting: $defaultUserData"
  }
}
