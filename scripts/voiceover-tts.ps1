# Speak each voice-over line with the Windows female voice (Microsoft Zira) into a WAV file.
# A line that would run past its caption is spoken a little faster.
param([string]$Lines = "scripts/voiceover-lines.json", [string]$OutDir = "submission/recordings/voiceover")
Add-Type -AssemblyName System.Speech
New-Item -ItemType Directory -Force $OutDir | Out-Null
$items = Get-Content $Lines -Raw | ConvertFrom-Json
$i = 0
$report = @()
foreach ($item in $items) {
  $window = [double]$item.until - [double]$item.at - 0.2
  $file = Join-Path $OutDir ("line-{0:D2}.wav" -f $i)
  foreach ($rate in 0, 1, 2, 3, 4) {
    $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $s.SelectVoice("Microsoft Zira Desktop")
    $s.Rate = $rate
    $s.SetOutputToWaveFile($file)
    $s.Speak($item.text)
    $s.Dispose()
    $bytes = (Get-Item $file).Length
    $seconds = ($bytes - 44) / 32000.0   # 16 kHz, 16-bit mono
    if ($seconds -le $window) { break }
  }
  $report += "{0:D2} at {1,6} rate {2} {3:N1}s of {4:N1}s" -f $i, $item.at, $rate, $seconds, $window
  $i++
}
$report
