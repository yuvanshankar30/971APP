$ErrorActionPreference = 'Stop'

$HubUrl = if ($env:JPROG_OUTPUT_HUB_URL) { $env:JPROG_OUTPUT_HUB_URL } else { '__JPROG_OUTPUT_HUB_ORIGIN__' }
$OutputRepository = 'https://github.com/yuvanshankar30/output.git'
$DesktopOutputDir = if ($env:JPROG_OUTPUT_DIR) { $env:JPROG_OUTPUT_DIR } else { Join-Path ([Environment]::GetFolderPath('Desktop')) 'Output' }
$SupportDir = Join-Path $env:LOCALAPPDATA 'SpartansHub\JProgOutput'
$RepoDir = Join-Path $SupportDir 'repository'
$SyncScript = Join-Path $SupportDir 'sort_and_push.ps1'
$WorkerScript = Join-Path $SupportDir 'sync-worker.ps1'
$TaskName = 'SpartansHub JProg Output Sync'

function Require-Command($name, $message) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    throw $message
  }
}

Write-Host "Installing shared JProg output from $HubUrl ..."
Require-Command git 'Git is required. Install Git for Windows, then run this command again.'

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Host 'Installing GitHub CLI...'
    winget install --id GitHub.cli --exact --accept-source-agreements --accept-package-agreements
  } else {
    throw 'GitHub CLI is required for automatic commits and pushes. Install it from https://cli.github.com/, then run this command again.'
  }
}

gh auth status *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Host 'Sign in to GitHub so this folder can commit and push your changes.'
  gh auth login --web --git-protocol https
}
gh auth setup-git

New-Item -ItemType Directory -Force -Path (Split-Path $DesktopOutputDir -Parent), $SupportDir | Out-Null

if (Test-Path -LiteralPath $DesktopOutputDir) {
  $desktopItem = Get-Item -LiteralPath $DesktopOutputDir -Force
  if ($desktopItem.LinkType) {
    $RepoDir = (Resolve-Path -LiteralPath $DesktopOutputDir).Path
  } else {
    & git -C $DesktopOutputDir rev-parse --is-inside-work-tree | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "$DesktopOutputDir already exists but is not a Git checkout. Move it aside before installing." }
    $legacyOrigin = & git -C $DesktopOutputDir remote get-url origin
    if ($legacyOrigin -notmatch 'github\.com[/:]yuvanshankar30/output') { throw "$DesktopOutputDir is not the shared yuvanshankar30/output checkout. Refusing to move it." }
    if (Test-Path -LiteralPath $RepoDir) { throw "A shared output checkout already exists at $RepoDir. Resolve it before migrating $DesktopOutputDir." }
    Write-Host 'Moving the existing shared checkout behind the Desktop Output link ...'
    Move-Item -LiteralPath $DesktopOutputDir -Destination $RepoDir
    New-Item -ItemType Junction -Path $DesktopOutputDir -Target $RepoDir | Out-Null
  }
} else {
  Write-Host 'Cloning the shared JProg output folder ...'
  & git clone --quiet $OutputRepository $RepoDir
  if ($LASTEXITCODE -ne 0) { throw 'Could not clone the shared output repository.' }
  New-Item -ItemType Junction -Path $DesktopOutputDir -Target $RepoDir | Out-Null
}

& git -C $RepoDir rev-parse --is-inside-work-tree | Out-Null
if ($LASTEXITCODE -ne 0) { throw "$RepoDir is not a Git checkout. Refusing to install sync services." }
$origin = & git -C $RepoDir remote get-url origin
if ($origin -notmatch 'github\.com[/:]yuvanshankar30/output') { throw "$RepoDir is not the shared yuvanshankar30/output checkout. Refusing to use it." }
& git -C $RepoDir fetch --quiet origin main
$fetchSucceeded = $LASTEXITCODE -eq 0
& git -C $RepoDir diff --quiet
$workingTreeClean = $LASTEXITCODE -eq 0
& git -C $RepoDir diff --cached --quiet
$indexClean = $LASTEXITCODE -eq 0
if ($fetchSucceeded -and $workingTreeClean -and $indexClean) {
  & git -C $RepoDir pull --ff-only --quiet origin main
}

if (-not (& git -C $RepoDir config user.name)) {
  $login = gh api user --jq .login
  & git -C $RepoDir config user.name $login
  & git -C $RepoDir config user.email "$login@users.noreply.github.com"
}

$requiredSyncBehavior = @('git pull --rebase --autostash', 'git diff --cached --name-status -M')
$sharedScript = Get-Content -LiteralPath (Join-Path $RepoDir 'sort_and_push.sh') -Raw
foreach ($behavior in $requiredSyncBehavior) {
  if (-not $sharedScript.Contains($behavior)) {
    throw 'The shared output repository is missing required sync behavior; refusing to install an incomplete local service.'
  }
}

$syncTemplate = @'
$ErrorActionPreference = 'Stop'
$RepoDir = '__REPO_DIR__'
$DropDir = Join-Path $RepoDir 'JustinProgOutput'
$LogFile = Join-Path $env:TEMP 'jprog-output-sort.log'

function Write-Log([string]$message) {
  Add-Content -LiteralPath $LogFile -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $message"
}

function Push-PendingCommits {
  $ahead = [int](& git -C $RepoDir rev-list --count origin/main..HEAD 2>$null)
  if ($ahead -le 0) { return }
  & git -C $RepoDir push origin main
  if ($LASTEXITCODE -eq 0) { Write-Log "Pushed $ahead previously queued commit(s)" }
  else { Write-Log "PUSH FAILED for $ahead previously queued commit(s); will retry" }
}

try {
  & git -C $RepoDir fetch --quiet origin main
  if ($LASTEXITCODE -eq 0) {
    $head = & git -C $RepoDir rev-parse HEAD
    $remoteHead = & git -C $RepoDir rev-parse origin/main
    if ($head -ne $remoteHead) {
      & git -C $RepoDir pull --rebase --autostash --quiet origin main
      if ($LASTEXITCODE -eq 0) { Write-Log 'Pulled remote changes onto local copy' }
      else { Write-Log 'Pull failed; local files were left in place for resolution' }
    }
  } else { Write-Log 'Fetch failed; skipping pull while offline' }

  $pacific = [TimeZoneInfo]::FindSystemTimeZoneById('Pacific Standard Time')
  $today = [TimeZoneInfo]::ConvertTimeFromUtc([DateTime]::UtcNow, $pacific).ToString('yyyyMMdd')
  foreach ($scanDir in @($RepoDir, $DropDir)) {
    if (-not (Test-Path -LiteralPath $scanDir)) { continue }
    Get-ChildItem -LiteralPath $scanDir -File | Where-Object { $_.Extension -in '.ngc', '.tap' } | ForEach-Object {
      $destinationDir = Join-Path $DropDir $today
      New-Item -ItemType Directory -Force -Path $destinationDir | Out-Null
      $destination = Join-Path $destinationDir $_.Name
      if (Test-Path -LiteralPath $destination) {
        $destination = Join-Path $destinationDir "$(Get-Date -Format 'HHmmss')-$($_.Name)"
      }
      Move-Item -LiteralPath $_.FullName -Destination $destination
      Write-Log "Moved $($_.Name) -> JustinProgOutput/$today/"
    }
  }

  & git -C $RepoDir add -A -- $DropDir
  & git -C $RepoDir diff --cached --quiet -- $DropDir
  if ($LASTEXITCODE -eq 0) { Push-PendingCommits; exit 0 }

  $deletions = & git -C $RepoDir diff --cached --name-status -M -- $DropDir
  foreach ($line in $deletions) {
    $parts = $line -split "`t"
    if ($parts[0] -ne 'D') { continue }
    $extension = [IO.Path]::GetExtension($parts[1]).ToLowerInvariant()
    if ($extension -notin '.ngc', '.tap') {
      & git -C $RepoDir restore --staged --worktree -- $parts[1]
      Write-Log "Restored $($parts[1]); only G-code deletions synchronize"
    } else { Write-Log "Deleting $($parts[1])" }
  }

  & git -C $RepoDir diff --cached --quiet -- $DropDir
  if ($LASTEXITCODE -eq 0) { Push-PendingCommits; exit 0 }
  & git -C $RepoDir commit -q -m 'Update JustinProgOutput'
  if ($LASTEXITCODE -ne 0) { throw 'Could not commit local JProg output changes.' }
  & git -C $RepoDir push origin main
  if ($LASTEXITCODE -eq 0) { Write-Log 'Pushed local JProg output changes' }
  else { Write-Log 'PUSH FAILED; local commit is queued for retry' }
} catch {
  Write-Log "Sync failed: $($_.Exception.Message)"
}
'@
$syncTemplate.Replace('__REPO_DIR__', $RepoDir.Replace("'", "''")) | Set-Content -LiteralPath $SyncScript -Encoding utf8

$worker = @"
while (`$true) {
  & '$SyncScript'
  Start-Sleep -Seconds 30
}
"@
$worker | Set-Content -LiteralPath $WorkerScript -Encoding utf8

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$WorkerScript`""
$trigger = New-ScheduledTaskTrigger -AtLogOn
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

Write-Host "Shared JProg output folder installed at: $DesktopOutputDir"
Write-Host "Drop .ngc or .tap files into $DesktopOutputDir or $DesktopOutputDir\JustinProgOutput."
Write-Host 'The folder will sort, commit, push, and pull Hub changes automatically.'
