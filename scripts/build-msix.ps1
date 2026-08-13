#requires -Version 5.1
<#
.SYNOPSIS
    Package Lyric Overlay as an MSIX for Microsoft Store submission.

.DESCRIPTION
    Builds the Tauri app with the `store` feature (self-updater compiled out),
    stages the executable + tile assets + manifest into a layout directory, and
    runs makeappx to produce a single .msix under dist-store/.

    The package is UNSIGNED by default — that is correct for Store submission,
    because Microsoft signs it on ingestion. Pass -SignForLocalTest to sign it
    with a throwaway self-signed cert (matching the manifest Publisher) so you
    can sideload and smoke-test it before uploading.

.PARAMETER Version
    Override the version. Defaults to the version in tauri.conf.json. Always
    packed as Major.Minor.Patch.0 (the Store reserves the 4th field).

.PARAMETER SkipBuild
    Skip `tauri build` and package the exe already in target/release. Use only
    if you know it was built with `--features store`.

.PARAMETER SignForLocalTest
    Sign the .msix with a self-signed cert for local sideload testing. Requires
    trusting the cert (the script prints how). Never used for Store upload.
#>
param(
    [string]$Version,
    [switch]$SkipBuild,
    [switch]$SignForLocalTest
)

$ErrorActionPreference = 'Stop'

$repo     = Split-Path -Parent $PSScriptRoot
$srcTauri = Join-Path $repo 'src-tauri'
$icons    = Join-Path $srcTauri 'icons'
$exe      = Join-Path $srcTauri 'target\release\lyric-overlay.exe'
$manifest = Join-Path $srcTauri 'msix\AppxManifest.xml'
$stage    = Join-Path $srcTauri 'target\msix'
$distDir  = Join-Path $repo 'dist-store'

# Locate an SDK tool (makeappx / signtool) on PATH or under the Windows Kits.
function Find-SdkTool([string]$name) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $kits = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
    if (Test-Path $kits) {
        $hit = Get-ChildItem $kits -Recurse -Filter $name -ErrorAction SilentlyContinue |
               Where-Object { $_.FullName -match '\\x64\\' } |
               Sort-Object FullName -Descending | Select-Object -First 1
        if ($hit) { return $hit.FullName }
    }
    throw "Could not find $name. Install the Windows 10/11 SDK."
}

# ---- version -> Major.Minor.Patch.0 -------------------------------------
if (-not $Version) {
    $conf = Get-Content (Join-Path $srcTauri 'tauri.conf.json') -Raw | ConvertFrom-Json
    $Version = $conf.version
}
$p = @($Version -split '\.')
while ($p.Count -lt 3) { $p += '0' }
$msixVersion = "{0}.{1}.{2}.0" -f $p[0], $p[1], $p[2]
Write-Host "==> MSIX version $msixVersion" -ForegroundColor Cyan

# ---- build the store exe (updater compiled out) -------------------------
if (-not $SkipBuild) {
    Push-Location $repo
    try {
        Write-Host "==> tauri build --no-bundle --features store" -ForegroundColor Cyan
        & npx tauri build --no-bundle --features store
        if ($LASTEXITCODE -ne 0) { throw "tauri build failed (exit $LASTEXITCODE)" }
    } finally {
        Pop-Location
    }
}
if (-not (Test-Path $exe)) { throw "Release exe not found: $exe (run without -SkipBuild)" }

# ---- stage the package layout -------------------------------------------
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
$assetsDir = Join-Path $stage 'Assets'
New-Item -ItemType Directory -Path $assetsDir -Force | Out-Null

Copy-Item $exe (Join-Path $stage 'lyric-overlay.exe') -Force

# Stamp the real version into a staged copy of the manifest. Replace ONLY the
# Identity placeholder Version="0.0.0.0" — case-sensitively (-creplace) so it
# never touches the xml declaration's lowercase version="1.0" or the
# MinVersion/MaxVersionTested attributes.
(Get-Content $manifest -Raw) -creplace 'Version="0\.0\.0\.0"', ('Version="{0}"' -f $msixVersion) |
    Set-Content (Join-Path $stage 'AppxManifest.xml') -Encoding UTF8

$tiles = @(
    'Square44x44Logo.png',
    'Square71x71Logo.png',
    'Square150x150Logo.png',
    'Square310x310Logo.png',
    'Wide310x150Logo.png',
    'StoreLogo.png'
)
foreach ($t in $tiles) {
    $srcTile = Join-Path $icons $t
    if (-not (Test-Path $srcTile)) { throw "Missing tile asset: $srcTile (run 'npm run icon')" }
    Copy-Item $srcTile (Join-Path $assetsDir $t) -Force
}

# ---- pack ---------------------------------------------------------------
New-Item -ItemType Directory -Path $distDir -Force | Out-Null
$msix = Join-Path $distDir ("Lyric-Overlay-{0}.msix" -f $msixVersion)
$makeappx = Find-SdkTool 'makeappx.exe'
Write-Host "==> makeappx pack" -ForegroundColor Cyan
& $makeappx pack /d $stage /p $msix /o
if ($LASTEXITCODE -ne 0) { throw "makeappx failed (exit $LASTEXITCODE)" }
Write-Host "==> MSIX written: $msix" -ForegroundColor Green

# ---- optional: sign for local sideload testing --------------------------
if ($SignForLocalTest) {
    # Sign a COPY so the pristine unsigned $msix stays uploadable to the Store.
    $testMsix = Join-Path $distDir ("Lyric-Overlay-{0}-localtest.msix" -f $msixVersion)
    Copy-Item $msix $testMsix -Force

    $subject = 'CN=96AC782F-5C01-4FEE-9316-A7B17837CEE4'  # must equal manifest Publisher
    Write-Host "==> Signing local-test copy with a self-signed cert ($subject)" -ForegroundColor Cyan
    $cert = New-SelfSignedCertificate -Type Custom -Subject $subject `
        -KeyUsage DigitalSignature -FriendlyName 'Lyric Overlay MSIX (local test only)' `
        -CertStoreLocation 'Cert:\CurrentUser\My' `
        -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3', '2.5.29.19={text}')
    $signtool = Find-SdkTool 'signtool.exe'
    & $signtool sign /fd SHA256 /a /sha1 $cert.Thumbprint $testMsix
    if ($LASTEXITCODE -ne 0) { throw "signtool failed (exit $LASTEXITCODE)" }

    $cerPath = Join-Path $distDir 'LyricOverlay-localtest.cer'
    Export-Certificate -Cert $cert -FilePath $cerPath | Out-Null
    Write-Host ""
    Write-Host "Signed test copy: $testMsix" -ForegroundColor Green
    Write-Host "To install it on THIS machine, in an ADMIN PowerShell:" -ForegroundColor Yellow
    Write-Host "  Import-Certificate -FilePath `"$cerPath`" -CertStoreLocation Cert:\LocalMachine\TrustedPeople"
    Write-Host "  Add-AppxPackage `"$testMsix`""
    Write-Host "Upload the UNSIGNED copy to the Store: $msix" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Next: upload $((Split-Path -Leaf $msix)) at Partner Center -> Lyric Overlay -> Packages." -ForegroundColor Green
