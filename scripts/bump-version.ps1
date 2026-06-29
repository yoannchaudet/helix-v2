#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Bump Helix's version to prepare a release, then open a pull request.

.DESCRIPTION
    Bumps the authoritative app version (semver) across the three files that track it
    (see docs/publishing.md):
      - src-tauri/tauri.conf.json  ("version" — the authoritative source)
      - src-tauri/Cargo.toml       (version)
      - src-tauri/Cargo.lock       (the `helix` package version line — targeted edit)

    The script refuses to run on a dirty working tree, syncs `main`, creates a
    `bump-v<new>` branch, commits the change, pushes it, and opens a PR with the GitHub
    CLI. package.json is not used for versioning and is left untouched.

.PARAMETER Type
    Which part of the semver to increment: major, minor, or patch. Defaults to `patch`
    (a +1 bump of the last component).

.EXAMPLE
    ./scripts/bump-version.ps1               # 0.2.0 -> 0.2.1
    ./scripts/bump-version.ps1 -Type minor   # 0.2.0 -> 0.3.0
    ./scripts/bump-version.ps1 -Type major   # 0.2.0 -> 1.0.0
#>
[CmdletBinding()]
param(
    [ValidateSet('major', 'minor', 'patch')]
    [string] $Type = 'patch'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# Make a non-zero exit from a native command (git/gh) throw, so failures can't slip past
# (PowerShell 7.3+). Without this, $ErrorActionPreference has no effect on native commands.
$PSNativeCommandUseErrorActionPreference = $true

function Fail([string] $message) {
    [Console]::Error.WriteLine("bump-version: $message")
    exit 1
}

# Replace exactly one occurrence of $pattern in $text, failing if the count isn't 1 (so a
# missing or ambiguous match is caught before we write anything).
function Replace-One([string] $text, [string] $pattern, [string] $replacement, [string] $where) {
    $count = ([regex]::Matches($text, $pattern)).Count
    if ($count -ne 1) { Fail "Expected exactly one version match in $where, found $count." }
    return [regex]::Replace($text, $pattern, $replacement)
}

# Resolve the repo root from this script's location, so it works from any CWD.
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$tauriConf = Join-Path $repoRoot 'src-tauri/tauri.conf.json'
$cargoToml = Join-Path $repoRoot 'src-tauri/Cargo.toml'
$cargoLock = Join-Path $repoRoot 'src-tauri/Cargo.lock'

# --- Preflight ------------------------------------------------------------------------

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail 'git is required but was not found on PATH.' }
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { Fail 'gh (GitHub CLI) is required but was not found on PATH.' }
foreach ($f in @($tauriConf, $cargoToml, $cargoLock)) {
    if (-not (Test-Path $f)) { Fail "Expected file not found: $f" }
}

Push-Location $repoRoot
$startBranch = $null
$onBumpBranch = $false
$committed = $false
$branch = $null
try {
    # Refuse to run on a dirty tree so the bump commit is clean and reviewable.
    if (git status --porcelain) {
        Fail 'Working tree is not clean. Commit or stash your changes before bumping the version.'
    }
    $startBranch = (git rev-parse --abbrev-ref HEAD).Trim()

    # --- Sync main FIRST, so we read + bump the version from the real tip of main --------

    git fetch --quiet origin
    git checkout --quiet main
    git pull --quiet --ff-only origin main

    # --- Read current version + compute the next one ------------------------------------

    $confText = Get-Content $tauriConf -Raw
    $confMatch = [regex]::Match($confText, '"version"\s*:\s*"(?<v>\d+\.\d+\.\d+)"')
    if (-not $confMatch.Success) { Fail "Could not find a semver `"version`" in $tauriConf." }
    $current = $confMatch.Groups['v'].Value

    $parts = $current.Split('.')
    [int] $major = $parts[0]; [int] $minor = $parts[1]; [int] $patch = $parts[2]
    switch ($Type) {
        'major' { $major++; $minor = 0; $patch = 0 }
        'minor' { $minor++; $patch = 0 }
        'patch' { $patch++ }
    }
    $new = "$major.$minor.$patch"
    $branch = "bump-v$new"
    Write-Host "Bumping version: $current -> $new ($Type)" -ForegroundColor Cyan

    # Abort early if the bump branch already exists locally (avoid clobbering work).
    if (git branch --list $branch) { Fail "Branch '$branch' already exists. Delete it or pick another bump." }

    # --- Pre-compute all three edits and validate BEFORE writing anything ----------------

    $esc = [regex]::Escape($current)
    $newConf = Replace-One $confText '("version"\s*:\s*")\d+\.\d+\.\d+(")' "`${1}$new`${2}" 'tauri.conf.json'

    $tomlText = Get-Content $cargoToml -Raw
    $newToml = Replace-One $tomlText "(?m)^(version\s*=\s*`")$esc(`")" "`${1}$new`${2}" 'Cargo.toml'

    $lockText = Get-Content $cargoLock -Raw
    $newLock = Replace-One $lockText "(name = `"helix`"\r?\nversion = `")$esc(`")" "`${1}$new`${2}" 'Cargo.lock'

    # --- Branch, write, commit, push, PR -------------------------------------------------

    git checkout --quiet -b $branch
    $onBumpBranch = $true

    Set-Content -Path $tauriConf -Value $newConf -NoNewline
    Set-Content -Path $cargoToml -Value $newToml -NoNewline
    Set-Content -Path $cargoLock -Value $newLock -NoNewline

    git add -- $tauriConf $cargoToml $cargoLock
    $commitMsg = @"
Bump version to $new

Prepare for release by bumping the version from $current to $new across the
three files that track it (see docs/publishing.md): tauri.conf.json (the
authoritative version), Cargo.toml, and Cargo.lock.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
"@
    git commit --quiet -m $commitMsg
    $committed = $true
    git push --quiet -u origin $branch

    $prBody = @"
Bump version ``$current`` -> ``$new`` ($Type) to prepare a release.

Updates the three version-tracking files per ``docs/publishing.md``:
- ``src-tauri/tauri.conf.json`` (authoritative)
- ``src-tauri/Cargo.toml``
- ``src-tauri/Cargo.lock`` (helix package line)

After merging, tag ``v$new`` on ``main`` to kick off the release workflow.
"@
    $prUrl = gh pr create --title "Bump version to $new" --body $prBody
    if (-not $prUrl) { Fail 'gh pr create did not return a URL.' }

    Write-Host "Opened PR: $prUrl" -ForegroundColor Green
    Write-Host "New version: $new" -ForegroundColor Green
}
catch {
    # On failure BEFORE the commit lands, undo any partial edits and return to the starting
    # branch so a retry starts clean. If the commit already landed (a push/PR failure), leave
    # the branch in place so you can finish pushing/opening the PR manually.
    if ($onBumpBranch -and -not $committed -and $startBranch) {
        git checkout --quiet --force $startBranch 2>$null
        if ($branch) { git branch -D $branch 2>$null | Out-Null }
    }
    Fail $_.Exception.Message
}
finally {
    Pop-Location
}
