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

function Get-ShortcutDetails([string]$ShortcutPath) {
  $shortcutShell = New-Object -ComObject WScript.Shell
  $shortcut = $shortcutShell.CreateShortcut($ShortcutPath)
  return [pscustomobject]@{
    TargetPath = $shortcut.TargetPath
    Arguments = $shortcut.Arguments
  }
}

function Test-SmokeShortcutMatches($Details, [string]$ExpectedTarget, [string]$ExpectedArguments) {
  if ($null -eq $Details -or [string]::IsNullOrWhiteSpace($Details.TargetPath)) {
    return $false
  }
  return (
    [string]::Equals(
      [System.IO.Path]::GetFullPath($Details.TargetPath),
      [System.IO.Path]::GetFullPath($ExpectedTarget),
      [System.StringComparison]::OrdinalIgnoreCase
    ) -and
    $Details.Arguments -ceq $ExpectedArguments
  )
}

function Test-AllExistingShortcutsOwned([string[]]$ShortcutPaths, [string]$ExpectedTarget) {
  if ([string]::IsNullOrWhiteSpace($ExpectedTarget)) {
    return $false
  }
  for ($index = 0; $index -lt $ShortcutPaths.Count; $index++) {
    $shortcutPath = $ShortcutPaths[$index]
    if (-not (Test-Path -LiteralPath $shortcutPath)) {
      continue
    }
    $expectedArguments = if ($index -in @(1, 3)) { "--browser" } else { "" }
    try {
      $details = Get-ShortcutDetails $shortcutPath
      if (-not (Test-SmokeShortcutMatches $details $ExpectedTarget $expectedArguments)) {
        return $false
      }
    } catch {
      return $false
    }
  }
  return $true
}

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
$ownedInstallRoot = $false
$installedApp = $null
$uninstaller = $null
$uninstallCompleted = $false

try {
  $installProcess = Start-Process -FilePath $installer -ArgumentList @("/S", "/D=$install") -PassThru -Wait -WindowStyle Hidden
  if ($installProcess.ExitCode -ne 0) {
    throw "Installer returned exit code $($installProcess.ExitCode)."
  }
  $ownedInstallRoot = $true
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

  $desktopShortcut = Get-ShortcutDetails $links[0]
  $browserShortcut = Get-ShortcutDetails $links[1]
  $startMenuShortcut = Get-ShortcutDetails $links[2]
  $startMenuBrowserShortcut = Get-ShortcutDetails $links[3]
  foreach ($shortcut in @($desktopShortcut, $startMenuShortcut)) {
    if (-not (Test-SmokeShortcutMatches $shortcut $installedApp "")) {
      throw "Ordinary shortcut target or arguments are incorrect."
    }
  }
  foreach ($shortcut in @($browserShortcut, $startMenuBrowserShortcut)) {
    if (-not (Test-SmokeShortcutMatches $shortcut $installedApp "--browser")) {
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
    startMenuShortcut = @{ target = $startMenuShortcut.TargetPath; arguments = $startMenuShortcut.Arguments }
    startMenuBrowserShortcut = @{ target = $startMenuBrowserShortcut.TargetPath; arguments = $startMenuBrowserShortcut.Arguments }
    uninstallRemovedShortcuts = $true
    uninstallPreservedExternalData = $true
    uninstallPreservedDefaultUserData = $true
  } | ConvertTo-Json -Depth 4
} finally {
  $allExistingShortcutsOwned = (
    $ownedInstallRoot -and
    (Test-AllExistingShortcutsOwned $links $installedApp)
  )
  if (
    -not $uninstallCompleted -and
    $null -ne $uninstaller -and
    (Test-Path -LiteralPath $uninstaller)
  ) {
    if ($allExistingShortcutsOwned) {
      try {
        Start-Process -FilePath $uninstaller -ArgumentList "/S" -PassThru -Wait -WindowStyle Hidden | Out-Null
      } catch {
        Write-Warning "Best-effort uninstall after smoke failure did not complete: $_"
      }
    } else {
      Write-Warning "Shortcut ownership changed or cannot be proven; skipping best-effort uninstall and preserving the installation."
    }
  }
  foreach ($link in $links) {
    if (Test-Path -LiteralPath $link) {
      $expectedArguments = if ($link -eq $links[1] -or $link -eq $links[3]) { "--browser" } else { "" }
      try {
        $currentShortcut = Get-ShortcutDetails $link
        if (
          $null -ne $installedApp -and
          (Test-SmokeShortcutMatches $currentShortcut $installedApp $expectedArguments)
        ) {
          Remove-Item -LiteralPath $link -Force
        } else {
          Write-Warning "Installer smoke does not own shortcut; preserving: $link"
        }
      } catch {
        Write-Warning "Could not revalidate installer-smoke shortcut ownership; preserving $link`: $_"
      }
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
