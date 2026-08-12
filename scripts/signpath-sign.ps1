#requires -Version 5.1
<#
.SYNOPSIS
    SignPath Authenticode signing hook for Tauri's bundle.windows.signCommand.

.DESCRIPTION
    Tauri invokes this once per Windows artifact (the app .exe, the NSIS setup
    .exe, the WiX .msi) with the artifact path as %1. We submit the file to
    SignPath, wait for the signed result, and overwrite the original IN PLACE.

    In-place is deliberate: Tauri computes the minisign updater signature (.sig)
    AFTER signCommand returns, so it must hash the *signed* bytes. Signing a copy
    or signing after bundling would leave the updater .sig over the unsigned file
    and break auto-update with a hash mismatch.

    Requires the SignPath PowerShell module (Submit-SigningRequest) and the
    SIGNPATH_API_TOKEN environment variable. If the token is absent the build
    fails loudly rather than shipping an unsigned installer.

.PARAMETER Path
    Absolute path to the artifact Tauri wants signed.
#>
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Path
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($env:SIGNPATH_API_TOKEN)) {
    throw "SIGNPATH_API_TOKEN is not set - refusing to produce an unsigned build for $Path"
}

if (-not (Test-Path -LiteralPath $Path)) {
    throw "Artifact to sign does not exist: $Path"
}

Import-Module SignPath -ErrorAction Stop

# SignPath organisation / project coordinates. These identify *whose* key signs
# the artifact; the token authorises the request. See docs/SIGNING.md.
$organizationId  = '7948f666-346b-4610-bd68-e09e4d594e6b'
$projectSlug     = 'Lyric-Overlay'
$signingPolicy   = 'Release'

$output = "$Path.signed"

Write-Host "SignPath: submitting $(Split-Path -Leaf $Path) ..."

Submit-SigningRequest `
    -InputArtifactPath  $Path `
    -ApiToken           $env:SIGNPATH_API_TOKEN `
    -OrganizationId     $organizationId `
    -ProjectSlug        $projectSlug `
    -SigningPolicySlug  $signingPolicy `
    -OutputArtifactPath $output `
    -WaitForCompletion

if (-not (Test-Path -LiteralPath $output)) {
    throw "SignPath returned success but no signed artifact was written for $Path"
}

Move-Item -LiteralPath $output -Destination $Path -Force
Write-Host "SignPath: signed $(Split-Path -Leaf $Path)"
