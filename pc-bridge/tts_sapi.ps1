# Synthesises Chinese speech with the built-in Windows SAPI voice and writes a
# 16 kHz mono 16-bit WAV. The watch has no TextToSpeech engine (the framework
# service is absent), so the DSH host speaks on its behalf and streams the clip
# back over the LAN.
#
# Usage: tts_sapi.ps1 -Text "要朗读的内容" -Out "C:\path\out.wav" [-Voice "Microsoft Huihui Desktop"]
# Prints a single JSON line: {"ok":true,"path":"...","bytes":12345}
param(
    [Parameter(Mandatory = $true)][string]$Text,
    [Parameter(Mandatory = $true)][string]$Out,
    [string]$Voice = ""
)

$ErrorActionPreference = "Stop"
try {
    Add-Type -AssemblyName System.Speech
    $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer

    # Prefer an explicit voice, otherwise the first Chinese one available.
    $zh = $null
    foreach ($v in $synth.GetInstalledVoices()) {
        if (-not $v.Enabled) { continue }
        if ($Voice -and $v.VoiceInfo.Name -eq $Voice) { $zh = $v.VoiceInfo.Name; break }
        if (-not $Voice -and $v.VoiceInfo.Culture.Name -like "zh-*") { $zh = $v.VoiceInfo.Name }
    }
    if ($zh) { $synth.SelectVoice($zh) }

    $fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
        16000,
        [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
        [System.Speech.AudioFormat.AudioChannel]::Mono)
    $synth.SetOutputToWaveFile($Out, $fmt)
    $synth.Speak($Text)
    $synth.Dispose()

    $bytes = (Get-Item $Out).Length
    Write-Output (ConvertTo-Json -Compress @{ ok = $true; path = $Out; bytes = $bytes; voice = $zh })
} catch {
    Write-Output (ConvertTo-Json -Compress @{ ok = $false; error = $_.Exception.Message })
    exit 1
}
