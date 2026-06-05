param(
  [string]$Version = "",
  [string]$TemplateTag = "v0.2.0",
  [string]$Repo = "liubinghan41-dotcom/novel-translation-workbench-complete",
  [string]$TemplateApk = ""
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

$JavaHome = "C:\Program Files\Eclipse Adoptium\jdk-21.0.11.10-hotspot"
$Keytool = Join-Path $JavaHome "bin\keytool.exe"
$ApkSigner = "$env:LOCALAPPDATA\Android\Sdk\build-tools\36.0.0\apksigner.bat"
$ZipAlign = "$env:LOCALAPPDATA\Android\Sdk\build-tools\36.0.0\zipalign.exe"
if (-not (Test-Path -LiteralPath $Keytool)) { throw "keytool not found: $Keytool" }
if (-not (Test-Path -LiteralPath $ApkSigner)) { throw "apksigner not found: $ApkSigner" }
if (-not (Test-Path -LiteralPath $ZipAlign)) { throw "zipalign not found: $ZipAlign" }

$ReleaseRoot = Join-Path $Root ("release\v{0}" -f $Version)
$SigningDir = Join-Path $Root "release\android-signing"
$WorkRoot = Join-Path $ReleaseRoot "_apk-work"
$UnsignedZip = Join-Path $WorkRoot "unsigned.zip"
$UnsignedApk = Join-Path $WorkRoot "unsigned.apk"
$AlignedApk = Join-Path $WorkRoot "aligned.apk"
$FinalApk = Join-Path $ReleaseRoot ("Novel-Translation-Workbench-{0}-android-release.apk" -f $Version)
$Alias = "novel-translation-workbench"
$Keystore = Join-Path $SigningDir "novel-translation-workbench-release.jks"
$PasswordFile = Join-Path $SigningDir "keystore-password.txt"
$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)

function New-CleanDirectory {
  param([string]$Path)
  if (Test-Path -LiteralPath $Path) {
    Remove-Item -LiteralPath $Path -Recurse -Force
  }
  New-Item -ItemType Directory -Path $Path -Force | Out-Null
}

function Copy-WebAssets {
  param([string]$PublicDir)
  New-CleanDirectory -Path $PublicDir
  foreach ($file in @("index.html", "styles.css", "app.js", "native-adapter.js")) {
    Copy-Item -LiteralPath (Join-Path $Root $file) -Destination (Join-Path $PublicDir $file) -Force
  }
}

function Write-Checksum {
  param([string]$Path)
  $hash = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  $line = "{0}  {1}" -f $hash, (Split-Path -Leaf $Path)
  [System.IO.File]::WriteAllText("$Path.sha256", "$line`n", $Utf8NoBom)
}

New-Item -ItemType Directory -Path $ReleaseRoot -Force | Out-Null
New-Item -ItemType Directory -Path $SigningDir -Force | Out-Null
New-CleanDirectory -Path $WorkRoot

try {
  $DownloadedTemplate = Join-Path $WorkRoot "template.apk"
  if ($TemplateApk) {
    Copy-Item -LiteralPath $TemplateApk -Destination $DownloadedTemplate -Force
  } else {
    gh release download $TemplateTag --repo $Repo --pattern "*.apk" --dir $WorkRoot
    $downloaded = Get-ChildItem -LiteralPath $WorkRoot -Filter *.apk | Select-Object -First 1
    if (-not $downloaded) { throw "Template APK was not downloaded from $Repo $TemplateTag" }
    Move-Item -LiteralPath $downloaded.FullName -Destination $DownloadedTemplate -Force
  }

  $ExtractDir = Join-Path $WorkRoot "apk"
  New-CleanDirectory -Path $ExtractDir
  tar -xf $DownloadedTemplate -C $ExtractDir

  $metaInf = Join-Path $ExtractDir "META-INF"
  if (Test-Path -LiteralPath $metaInf) {
    Remove-Item -LiteralPath $metaInf -Recurse -Force
  }
  Copy-WebAssets -PublicDir (Join-Path $ExtractDir "assets\public")

  $items = Get-ChildItem -LiteralPath $ExtractDir -Force
  Compress-Archive -LiteralPath $items.FullName -DestinationPath $UnsignedZip -Force
  Move-Item -LiteralPath $UnsignedZip -Destination $UnsignedApk -Force
  & $ZipAlign -f -p 4 $UnsignedApk $AlignedApk

  if (-not (Test-Path -LiteralPath $PasswordFile)) {
    $passwordBytes = New-Object byte[] 24
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
      $rng.GetBytes($passwordBytes)
    } finally {
      $rng.Dispose()
    }
    $password = [Convert]::ToBase64String($passwordBytes).TrimEnd("=")
    [System.IO.File]::WriteAllText($PasswordFile, "$password`n", $Utf8NoBom)
  } else {
    $password = (Get-Content -Raw -LiteralPath $PasswordFile).Trim()
  }
  if (-not (Test-Path -LiteralPath $Keystore)) {
    & $Keytool -genkeypair `
      -keystore $Keystore `
      -storepass $password `
      -keypass $password `
      -alias $Alias `
      -keyalg RSA `
      -keysize 2048 `
      -validity 10000 `
      -dname "CN=Novel Translation Workbench,O=Local,C=US" `
      -noprompt | Out-Null
  }

  if (Test-Path -LiteralPath $FinalApk) {
    Remove-Item -LiteralPath $FinalApk -Force
  }
  & $ApkSigner sign `
    --ks $Keystore `
    --ks-key-alias $Alias `
    --ks-pass "pass:$password" `
    --key-pass "pass:$password" `
    --out $FinalApk `
    $AlignedApk
  & $ApkSigner verify --verbose --print-certs $FinalApk
  Write-Checksum -Path $FinalApk

  Write-Host "APK package created: $FinalApk"
  Get-ChildItem -LiteralPath $ReleaseRoot -File | Where-Object { $_.Name -match 'android-release\.apk|android-release\.apk\.sha256$' } | Select-Object Name, Length
} finally {
  if (Test-Path -LiteralPath $WorkRoot) {
    Remove-Item -LiteralPath $WorkRoot -Recurse -Force
  }
}
