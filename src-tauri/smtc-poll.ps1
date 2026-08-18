<#
.SYNOPSIS
    Streams Windows System Media Transport Controls (SMTC) state as JSON lines on stdout.

.NOTES
    DIAGNOSTIC TOOL ONLY — the app no longer runs this.

    The app used to spawn this script as a long-lived child process and read
    its JSON from a pipe. That is now done natively in-process (src/smtc.rs),
    which removed a ~92MB PowerShell 5.1 process and the dependency on a
    Windows PowerShell version Microsoft no longer develops.

    It is kept because `npm run probe` uses it to answer "what does Windows
    actually report right now?" without launching the app — useful when a
    media app's now-playing looks wrong and you need to tell "the app is
    misreading it" apart from "Windows itself reports it that way".

.DESCRIPTION
    Reads the active media session for ANY media app (Spotify desktop, a browser
    playing YouTube Music, etc.) via the WinRT GlobalSystemMediaTransportControls API.

    Emits one compact JSON object per line so a parent process can read it as a stream.

    IMPORTANT: Must run under Windows PowerShell 5.1 (powershell.exe). PowerShell 7+
    (pwsh) removed the built-in WinRT type projection this script relies on.

.PARAMETER IntervalMs
    Timeline poll interval. Defaults to 250ms.

.PARAMETER PropertyIntervalMs
    How often to re-read track metadata (title/artist/album). Metadata reads are
    async and comparatively expensive, so they run less often than timeline reads.

.PARAMETER Once
    Emit a single sample and exit. Used by `npm run probe` for diagnostics.
#>
param(
    [int]$IntervalMs = 250,
    [int]$PropertyIntervalMs = 1000,
    [switch]$Once
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Runtime.WindowsRuntime

# WinRT async methods return IAsyncOperation<T>; bridge them to .NET Tasks so we can block.
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and
    $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($WinRtTask, $ResultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    $netTask.Result
}

function Write-Line([string]$Text) {
    [Console]::Out.WriteLine($Text)
    [Console]::Out.Flush()
}

[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media, ContentType = WindowsRuntime] | Out-Null

$manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) `
                 ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])

$lastPropertyFetch = [datetime]::MinValue
$cachedTitle = $null
$cachedArtist = $null
$cachedAlbum = $null
$cachedApp = $null

while ($true) {
    try {
        $session = $manager.GetCurrentSession()

        if ($null -eq $session) {
            $cachedApp = $null
            Write-Line (@{ ok = $true; session = $null } | ConvertTo-Json -Compress)
        }
        else {
            $app = $session.SourceAppUserModelId
            $now = Get-Date

            # Re-read metadata when the source app changed or the refresh window elapsed.
            $stale = ($app -ne $cachedApp) -or
                     (($now - $lastPropertyFetch).TotalMilliseconds -ge $PropertyIntervalMs)

            if ($stale) {
                $props = Await ($session.TryGetMediaPropertiesAsync()) `
                               ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
                $cachedTitle = $props.Title
                $cachedArtist = $props.Artist
                $cachedAlbum = $props.AlbumTitle
                $cachedApp = $app
                $lastPropertyFetch = $now
            }

            $timeline = $session.GetTimelineProperties()
            $playback = $session.GetPlaybackInfo()

            # SMTC does not tick Position continuously — most apps only push a new
            # timeline on play/pause/seek. LastUpdatedTime tells us when the value
            # was actually captured, so the consumer can project forward from it
            # instead of trusting a value that may be seconds old.
            $stalenessMs = -1
            try {
                $lastUpdate = $timeline.LastUpdatedTime.UtcDateTime
                if ($lastUpdate -gt [datetime]::new(1601, 1, 2, 0, 0, 0, [System.DateTimeKind]::Utc)) {
                    $stalenessMs = [int64](([datetime]::UtcNow) - $lastUpdate).TotalMilliseconds
                }
            }
            catch {
                # Some sources leave LastUpdatedTime unset; fall back to raw position.
                $stalenessMs = -1
            }

            $payload = [ordered]@{
                ok      = $true
                session = [ordered]@{
                    sourceApp   = $app
                    title       = $cachedTitle
                    artist      = $cachedArtist
                    album       = $cachedAlbum
                    status      = $playback.PlaybackStatus.ToString()
                    positionMs  = [int64]$timeline.Position.TotalMilliseconds
                    endMs       = [int64]$timeline.EndTime.TotalMilliseconds
                    # Age of positionMs in ms at the moment we sampled it.
                    # -1 means the source did not provide a usable timestamp.
                    stalenessMs = $stalenessMs
                }
            }

            Write-Line ($payload | ConvertTo-Json -Depth 4 -Compress)
        }
    }
    catch {
        # Never let a transient WinRT hiccup kill the stream.
        Write-Line (@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress)
    }

    if ($Once) { break }
    Start-Sleep -Milliseconds $IntervalMs
}
