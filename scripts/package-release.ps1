param(
  [string]$Version = ""
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
if (-not $Version) {
  $package = Get-Content -Raw -LiteralPath (Join-Path $Root "package.json") | ConvertFrom-Json
  $Version = [string]$package.version
}
if (-not $Version) {
  throw "Release version is empty."
}

$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$ReleaseRoot = Join-Path $Root ("release\v{0}" -f $Version)
$WorkRoot = Join-Path $ReleaseRoot "_work"
$NodePath = (Get-Command node -ErrorAction Stop).Source
$NodeVersion = (& $NodePath --version).Trim()

$AppFiles = @(
  ".gitignore",
  "LICENSE",
  "NOTICE",
  "README.md",
  "app.js",
  "index.html",
  "styles.css",
  "server.js",
  "package.json"
)
$AppDirs = @("lib", "scripts")

function New-CleanDirectory {
  param([string]$Path)
  if (Test-Path -LiteralPath $Path) {
    Remove-Item -LiteralPath $Path -Recurse -Force
  }
  New-Item -ItemType Directory -Path $Path -Force | Out-Null
}

function Copy-AppSource {
  param([string]$Destination)
  New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  foreach ($file in $AppFiles) {
    $source = Join-Path $Root $file
    if (Test-Path -LiteralPath $source) {
      $target = Join-Path $Destination $file
      $targetDir = Split-Path -Parent $target
      if (-not (Test-Path -LiteralPath $targetDir)) {
        New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
      }
      Copy-Item -LiteralPath $source -Destination $target -Force
    }
  }
  foreach ($dir in $AppDirs) {
    $source = Join-Path $Root $dir
    if (Test-Path -LiteralPath $source) {
      Copy-Item -LiteralPath $source -Destination (Join-Path $Destination $dir) -Recurse -Force
    }
  }
}

function Compress-Directory {
  param(
    [string]$Directory,
    [string]$ZipPath
  )
  if (Test-Path -LiteralPath $ZipPath) {
    Remove-Item -LiteralPath $ZipPath -Force
  }
  Compress-Archive -LiteralPath $Directory -DestinationPath $ZipPath -Force
}

function Write-Checksum {
  param([string]$Path)
  $hash = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  $line = "{0}  {1}" -f $hash, (Split-Path -Leaf $Path)
  [System.IO.File]::WriteAllText("$Path.sha256", "$line`n", $Utf8NoBom)
}

New-CleanDirectory -Path $ReleaseRoot
New-Item -ItemType Directory -Path $WorkRoot -Force | Out-Null

$SourceName = "novel-translation-workbench-source-v$Version"
$SourceDir = Join-Path $WorkRoot $SourceName
Copy-AppSource -Destination $SourceDir
$SourceZip = Join-Path $ReleaseRoot "$SourceName.zip"
Compress-Directory -Directory $SourceDir -ZipPath $SourceZip
Write-Checksum -Path $SourceZip

$WindowsName = "novel-translation-workbench-windows-portable-v$Version"
$WindowsDir = Join-Path $WorkRoot $WindowsName
$WindowsAppDir = Join-Path $WindowsDir "app"
$WindowsRuntimeDir = Join-Path $WindowsDir "runtime"
Copy-AppSource -Destination $WindowsAppDir
New-Item -ItemType Directory -Path $WindowsRuntimeDir -Force | Out-Null
Copy-Item -LiteralPath $NodePath -Destination (Join-Path $WindowsRuntimeDir "node.exe") -Force

$StartCmd = @"
@echo off
setlocal
cd /d "%~dp0app"
set "PORT=4173"
start "" "http://127.0.0.1:%PORT%"
"%~dp0runtime\node.exe" server.js
echo.
echo Server stopped. Press any key to close.
pause >nul
"@
[System.IO.File]::WriteAllText((Join-Path $WindowsDir "Start Novel Translation Workbench.cmd"), $StartCmd.Replace("`n", "`r`n"), $Utf8NoBom)

$WindowsReadme = @"
Novel Translation Workbench v$Version - Windows portable

Run:
  Start Novel Translation Workbench.cmd

The app opens at:
  http://127.0.0.1:4173

Runtime data is stored under:
  app\data\

This package includes $NodeVersion from:
  $NodePath

API keys are not included in this release package.
"@
[System.IO.File]::WriteAllText((Join-Path $WindowsDir "README-WINDOWS.txt"), $WindowsReadme.Replace("`n", "`r`n"), $Utf8NoBom)

$WindowsZip = Join-Path $ReleaseRoot "$WindowsName.zip"
Compress-Directory -Directory $WindowsDir -ZipPath $WindowsZip
Write-Checksum -Path $WindowsZip

$AndroidName = "novel-translation-workbench-android-termux-v$Version"
$AndroidDir = Join-Path $WorkRoot $AndroidName
Copy-AppSource -Destination $AndroidDir
$AndroidStart = @'
#!/data/data/com.termux/files/usr/bin/sh
set -eu
cd "$(dirname "$0")"
: "${PORT:=4173}"
echo "Novel Translation Workbench is starting on http://127.0.0.1:${PORT}"
PORT="${PORT}" node server.js
'@
[System.IO.File]::WriteAllText((Join-Path $AndroidDir "start-android-termux.sh"), $AndroidStart.Replace("`r`n", "`n"), $Utf8NoBom)

$AndroidReadme = @"
Novel Translation Workbench v$Version - Android Termux package

This is not a standalone APK. The workbench requires a local Node.js backend, so
the Android release runs through Termux.

Install in Termux:
  pkg update
  pkg install nodejs unzip

Run:
  unzip novel-translation-workbench-android-termux-v$Version.zip
  cd novel-translation-workbench-android-termux-v$Version
  sh start-android-termux.sh

Then open in an Android browser:
  http://127.0.0.1:4173

API keys are not included in this release package.
"@
[System.IO.File]::WriteAllText((Join-Path $AndroidDir "README-ANDROID-TERMUX.txt"), $AndroidReadme, $Utf8NoBom)

$AndroidZip = Join-Path $ReleaseRoot "$AndroidName.zip"
Compress-Directory -Directory $AndroidDir -ZipPath $AndroidZip
Write-Checksum -Path $AndroidZip

$ReleaseNotes = @"
# Novel Translation Workbench v$Version

## Highlights

- Dynamic provider model refresh with manual model fallback.
- Token-based cost estimates, normalized usage, and per-job billing totals.
- Preserved EPUB export that keeps cover assets, nav/toc, heading levels, footnotes, ruby/furigana, and basic styles.
- Optional bilingual EPUB export with original paragraphs followed by translated paragraphs.
- Secret-safety hardening for common credential/config files.

## Assets

- novel-translation-workbench-windows-portable-v$Version.zip
- novel-translation-workbench-android-termux-v$Version.zip
- novel-translation-workbench-source-v$Version.zip

The Android asset is a Termux package, not an APK, because the current app architecture depends on the local Node.js backend.
"@
[System.IO.File]::WriteAllText((Join-Path $ReleaseRoot "RELEASE_NOTES.md"), $ReleaseNotes, $Utf8NoBom)

Remove-Item -LiteralPath $WorkRoot -Recurse -Force

Write-Host "Release packages created under $ReleaseRoot"
Get-ChildItem -LiteralPath $ReleaseRoot -File | Select-Object Name, Length
