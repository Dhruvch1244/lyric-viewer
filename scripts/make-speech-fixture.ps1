<#
.SYNOPSIS
  Write a raw f32 mono 16 kHz PCM fixture of spoken words, for the sidecar's
  end-to-end transcription test.

.DESCRIPTION
  The inference pipeline can be unit-tested piece by piece, but "does Whisper
  actually produce the right words with the right times" needs real speech, and
  shipping an audio file in the repository means shipping something with a
  licence attached.

  The Windows speech synthesiser is on every machine this app targets, so the
  fixture is generated instead: known words, known order, no licence question,
  and byte-identical output on repeat runs of the same machine.

  It is synthetic speech, which is cleaner than singing over a backing track.
  This proves the pipeline is correct, not that it is accurate on music -- for
  that there is no substitute for a real song.

.EXAMPLE
  ./scripts/make-speech-fixture.ps1 -OutFile speech.pcm
  $env:LYRIC_TEST_PCM = (Resolve-Path speech.pcm)
  $env:LYRIC_TEST_MODELS = "$env:APPDATA\com.dhruv.lyricoverlay\models"
  cargo test -p lyric-inference --test real_transcription -- --ignored --nocapture
#>
[CmdletBinding()]
param(
  [string]$OutFile = "speech.pcm",
  [string]$Text = "The quick brown fox jumps over the lazy dog. Testing one two three four five.",
  # Slightly slower than default: closer to the pace of a sung line, and it
  # gives the word-timing pass something to resolve.
  [int]$Rate = -1
)

Add-Type -AssemblyName System.Speech

$wav = [System.IO.Path]::GetTempFileName() + ".wav"
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $voice = $synth.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like 'en*' } | Select-Object -First 1
  if (-not $voice) { throw "no English voice is installed" }
  $synth.SelectVoice($voice.VoiceInfo.Name)
  $synth.Rate = $Rate

  # 16 kHz mono 16-bit: exactly what Whisper wants, so no resampling step can
  # be blamed for a bad result.
  $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
    16000,
    [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
    [System.Speech.AudioFormat.AudioChannel]::Mono)
  $synth.SetOutputToWaveFile($wav, $format)
  $synth.Speak($Text)
  $synth.SetOutputToNull()
} finally {
  $synth.Dispose()
}

# WAV to raw f32. The chunks are walked rather than assuming a 44-byte header,
# because the synthesiser writes a `fact` chunk before `data`.
$bytes = [System.IO.File]::ReadAllBytes($wav)
Remove-Item $wav -ErrorAction SilentlyContinue

$offset = 12
$dataStart = -1
$dataSize = 0
while ($offset + 8 -le $bytes.Length) {
  $id = [System.Text.Encoding]::ASCII.GetString($bytes, $offset, 4)
  $size = [BitConverter]::ToUInt32($bytes, $offset + 4)
  if ($id -eq 'data') { $dataStart = $offset + 8; $dataSize = $size; break }
  $offset = $offset + 8 + $size + ($size % 2)
}
if ($dataStart -lt 0) { throw "no data chunk in the synthesised wave file" }

$sampleCount = [int]($dataSize / 2)
$out = New-Object byte[] ($sampleCount * 4)
for ($i = 0; $i -lt $sampleCount; $i++) {
  $s = [BitConverter]::ToInt16($bytes, $dataStart + $i * 2)
  [BitConverter]::GetBytes([float]($s / 32768.0)).CopyTo($out, $i * 4)
}
[System.IO.File]::WriteAllBytes($OutFile, $out)

$seconds = [math]::Round($sampleCount / 16000.0, 2)
Write-Host "wrote $OutFile - $sampleCount samples, $seconds s of f32 mono 16 kHz PCM"
