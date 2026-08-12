#requires -Version 5.1
<#
.SYNOPSIS
    SignPath Authenticode signing hook for Tauri's bundle.windows.signCommand.

.DESCRIPTION
    Tauri invokes this once per Windows artifact (the app .exe and the NSIS
    setup .exe) with the artifact path as %1. We submit the file to SignPath,
    wait for the signed result, and overwrite the original IN PLACE.

    Note: the .msi target is intentionally not built. SignPath's self-signed
    policy signs PE files but rejects the MSI (structured storage), and the
    NSIS .exe is the primary installer.

    In-place is deliberate: Tauri computes the minisign updater signature (.sig)
    AFTER signCommand returns, so it must hash the *signed* bytes. Signing a copy
    or signing after bundling would leave the updater .sig over the unsigned file
    and break auto-update with a hash mismatch.

    Tauri runs this via .output(), which CAPTURES stdout/stderr, so on failure
    none of it reaches the CI log. We therefore also append a transcript to
    signpath-sign.log (under GITHUB_WORKSPACE when in CI, else TEMP) which the
    workflow prints on failure.

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

# ---- logging -------------------------------------------------------------
$logDir = if ($env:GITHUB_WORKSPACE) { $env:GITHUB_WORKSPACE } else { $env:TEMP }
$logFile = Join-Path $logDir 'signpath-sign.log'
function Log($msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $msg
    Write-Host $line
    Add-Content -LiteralPath $logFile -Value $line -ErrorAction SilentlyContinue
}

try {
    Log "signpath-sign invoked with Path = [$Path]"
    Log "working directory = $(Get-Location)"
    Log "SIGNPATH_API_TOKEN present = $([bool]$env:SIGNPATH_API_TOKEN)"

    if ($Path -eq '%1') {
        throw "Received the literal '%1' - Tauri did not substitute the artifact path"
    }
    if ([string]::IsNullOrWhiteSpace($env:SIGNPATH_API_TOKEN)) {
        throw "SIGNPATH_API_TOKEN is not set - refusing to produce an unsigned build for $Path"
    }
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Artifact to sign does not exist: $Path"
    }

    $module = Get-Module -ListAvailable SignPath | Select-Object -First 1
    if (-not $module) {
        throw "SignPath PowerShell module is not installed on this runner"
    }
    Log "SignPath module $($module.Version) at $($module.ModuleBase)"
    Import-Module SignPath -ErrorAction Stop

    # SignPath organisation / project coordinates. These identify *whose* key
    # signs the artifact; the token authorises the request. See docs/SIGNING.md.
    $organizationId = '7948f666-346b-4610-bd68-e09e4d594e6b'
    $projectSlug    = 'Lyric-Overlay'
    $signingPolicy  = 'Release'

    $output = "$Path.signed"
    Log "Submitting $(Split-Path -Leaf $Path) to SignPath ..."

    Submit-SigningRequest `
        -InputArtifactPath  $Path `
        -ApiToken           $env:SIGNPATH_API_TOKEN `
        -OrganizationId     $organizationId `
        -ProjectSlug        $projectSlug `
        -SigningPolicySlug  $signingPolicy `
        -OutputArtifactPath $output `
        -WaitForCompletion

    if (-not (Test-Path -LiteralPath $output)) {
        throw "SignPath reported success but no signed artifact was written for $Path"
    }

    Move-Item -LiteralPath $output -Destination $Path -Force
    Log "Signed $(Split-Path -Leaf $Path)"
}
catch {
    Log "ERROR: $($_.Exception.Message)"
    Log "STACK: $($_.ScriptStackTrace)"
    throw
}
