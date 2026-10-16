<#
Live dashboard for the 3D / room-AI pipeline: services, GPU use, each job's progress and estimated finish time, latest log lines.

    powershell -ExecutionPolicy Bypass -File scripts\pipeline-status.ps1          refreshes every 5 s (Ctrl+C to stop)
    powershell -ExecutionPolicy Bypass -File scripts\pipeline-status.ps1 -Once    print once

Estimates come from how fast models were actually finished in the last hour, so they include the GPU being shared between jobs.
If something is not running after a restart or power cut: powershell -ExecutionPolicy Bypass -File scripts\resume-pipeline.ps1
#>
param([switch]$Once, [int]$Every = 5)

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root
$SDXL_GB = 9.6  # controlnet fp16 + SDXL base fp16 files that prefetch_weights.py downloads
$prev = $null

function Up($url) { try { Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 2 | Out-Null; $true } catch { $false } }
function Procs { Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='python.exe'" | Select-Object ProcessId, CommandLine }
function Has($procs, $pattern) { [bool]($procs | Where-Object { $_.CommandLine -match $pattern }) }
function Eta($remaining, $files) {
    # products per minute from model files finished in the last hour
    $recent = $files | Where-Object { $_.LastWriteTime -gt (Get-Date).AddHours(-1) } | Sort-Object LastWriteTime
    if ($remaining -le 0) { return 'done' }
    if ($recent.Count -lt 2) { return 'estimating...' }
    $mins = ($recent[-1].LastWriteTime - $recent[0].LastWriteTime).TotalMinutes
    if ($mins -le 0) { return 'estimating...' }
    $perMin = ($recent.Count - 1) / $mins
    $left = [TimeSpan]::FromMinutes($remaining / $perMin)
    '{0:N1}/min, ~{1}h {2:D2}m left, done about {3:HH:mm}' -f $perMin, [int][Math]::Floor($left.TotalHours), $left.Minutes, (Get-Date).Add($left)
}
function Bar($done, $total) {
    if ($total -le 0) { return '' }
    $n = [int][Math]::Round(30 * [Math]::Min(1.0, [double]$done / $total))  # 1.0, not 1: Min(int,int) would truncate the fraction to 0
    '[' + ('#' * $n) + ('.' * (30 - $n)) + ('] {0}/{1} ({2:P0})' -f $done, $total, ($done / $total))
}
function LastLine($file) {
    if (-not (Test-Path $file)) { return '' }
    # progress lines overwrite themselves with \r: the newest segment is what is happening now; also show the last finished result
    $tail = Get-Content $file -Tail 400
    $now = (($tail | Select-Object -Last 1) -split "`r" | Where-Object { $_.Trim() } | Select-Object -Last 1)
    $last = $tail | ForEach-Object { ($_ -split "`r") | Where-Object { $_ -match '^\s*(\S+\s+)?(OK|REVIEW|FAILED)\s' } } | Select-Object -Last 1
    "now:  $("$now".Trim())`n  last: $("$last".Trim())"
}

do {
    $procs = Procs
    $out = New-Object System.Collections.Generic.List[string]
    $out.Add("HomeTown pipeline  $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')")
    $out.Add('')

    # ---- services + GPU ----
    $out.Add(('Services   ml-service {0}   API {1}' -f $(if (Up 'http://127.0.0.1:8077/health') { 'UP' } else { 'DOWN' }), $(if (Up 'http://127.0.0.1:4000/ready') { 'UP' } else { 'DOWN' })))
    try {
        $g = (nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits) -split ',\s*'
        $out.Add(('GPU        {0}: {1}% busy, memory {2}/{3} MB, {4} C, {5} W' -f $g[0], $g[1], $g[2], $g[3], $g[4], $g[5]))
    } catch { $out.Add('GPU        nvidia-smi not available') }
    $job = Get-ChildItem 'server\ml-service\jobs\*.json' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 15 |
        ForEach-Object { Get-Content $_.FullName -Raw | ConvertFrom-Json } | Where-Object { $_.status -eq 'running' } | Select-Object -First 1
    if ($job) {
        $what = if ($job.kind -eq 'furniture3d') { "3D model ($(if ($job.payload.mesh_model) { $job.payload.mesh_model } else { 'triposr' }))" } else { $job.kind }
        $out.Add("GPU job    $what  $($job.progress)%")
    } else { $out.Add('GPU job    idle') }
    $out.Add('')

    # ---- TripoSR batch ----
    $batchLog = 'models\batch-triposr.log'
    if (Test-Path $batchLog) {
        $lines = Get-Content $batchLog
        $status = @{}
        foreach ($l in $lines) { if ($l -match '^(OK|REVIEW|FAILED)\s+([^\s:]+)') { $status[$Matches[2]] = $Matches[1] } }
        $planAt = ($lines | Select-String 'Plan: (\d+) product' | Select-Object -Last 1)  # not anchored: a resumed run can start mid-line
        $plan = if ($planAt) { [int]$planAt.Matches[0].Groups[1].Value } else { 0 }
        $sinceRun = if ($planAt) { @($lines[$planAt.LineNumber..($lines.Count - 1)] | Where-Object { $_ -match '^(OK|REVIEW|FAILED)\s' }).Count } else { 0 }
        $raw = Get-ChildItem 'models\raw\*.glb' -ErrorAction SilentlyContinue | Where-Object { $_.Name -notlike '_*' }
        $done = $raw.Count; $total = $done + [Math]::Max(0, $plan - $sinceRun)
        $count = { param($s) @($status.Values | Where-Object { $_ -eq $s }).Count }
        $out.Add(('TripoSR batch  {0}' -f $(if (Has $procs 'image-to-3d\.mjs') { 'RUNNING' } elseif ($plan -and $sinceRun -ge $plan) { 'FINISHED' } else { 'STOPPED (run resume-pipeline.ps1)' })))
        $out.Add('  ' + (Bar $done $total))
        $out.Add(('  OK {0} | REVIEW {1} | FAILED {2}' -f (& $count 'OK'), (& $count 'REVIEW'), (& $count 'FAILED')))
        $out.Add('  ' + (Eta ([Math]::Max(0, $plan - $sinceRun)) $raw))
        $out.Add('  ' + (LastLine $batchLog))
        $out.Add('')
    }

    # ---- benchmark ----
    if (Test-Path 'models\bench\results.json') {
        $res = (Get-Content 'models\bench\results.json' -Raw | ConvertFrom-Json).PSObject.Properties.Value
        $ok = @($res | Where-Object { -not $_.error -and $null -ne $_.stretch }).Count
        $benchFiles = Get-ChildItem 'models\bench\*\raw\*.glb' -ErrorAction SilentlyContinue
        $out.Add(('Benchmark  {0}' -f $(if (Has $procs 'benchmark-models\.mjs') { 'RUNNING' } elseif ($ok -ge 48) { 'FINISHED: models\bench\report.md' } else { 'STOPPED (run resume-pipeline.ps1)' })))
        $out.Add('  ' + (Bar $ok 48))
        foreach ($m in 'triposr', 'hunyuan3d-2mv') {
            $mine = @($res | Where-Object { $_.model -eq $m -and -not $_.error -and $null -ne $_.stretch })
            if ($mine.Count) { $out.Add(('  {0,-14} {1} done, {2} OK, avg {3:N0}s GPU each' -f $m, $mine.Count, @($mine | Where-Object ok).Count, ($mine | Where-Object seconds | Measure-Object seconds -Average).Average)) }
        }
        $out.Add('  ' + (Eta (48 - $ok) $benchFiles))
        $out.Add('')
    }

    # ---- SDXL weights ----
    $hub = Join-Path $env:USERPROFILE '.cache\huggingface\hub'
    $gb = (Get-ChildItem $hub -Recurse -File -Force -ErrorAction SilentlyContinue | Where-Object { $_.FullName -match 'stable-diffusion-xl-base|controlnet-depth-sdxl' } | Measure-Object Length -Sum).Sum / 1GB
    $doneSdxl = (Test-Path 'models\sdxl-prefetch.log') -and (Select-String 'models\sdxl-prefetch.log' -Pattern 'sdxl done' -Quiet) -or
                ((Test-Path "$env:TEMP\sdxl-prefetch.out") -and (Select-String "$env:TEMP\sdxl-prefetch.out" -Pattern 'sdxl done' -Quiet))
    $speed = ''
    if ($prev -and $gb -gt $prev.gb) {
        $mbps = ($gb - $prev.gb) * 1024 / ((Get-Date) - $prev.t).TotalSeconds
        $left = [TimeSpan]::FromSeconds(($SDXL_GB - $gb) * 1024 / $mbps)
        $speed = ', {0:N1} MB/s, ~{1}h {2:D2}m left' -f $mbps, [int][Math]::Floor($left.TotalHours), $left.Minutes
    }
    $prev = @{ gb = $gb; t = Get-Date }
    $out.Add(('SDXL weights (stage 4)  {0}' -f $(if ($doneSdxl) { 'COMPLETE' } elseif (Has $procs 'prefetch_') { 'DOWNLOADING' } else { 'STOPPED (run resume-pipeline.ps1)' })))
    $out.Add('  ' + $(if ($doneSdxl) { '{0:N1} GB downloaded' -f $gb } else { (Bar ([Math]::Round([Math]::Min([double]$gb, $SDXL_GB), 1)) $SDXL_GB) + ' GB' + $speed }))

    if (-not $Once) { Clear-Host }
    $out | ForEach-Object { Write-Host $_ }
    if (-not $Once) { Start-Sleep $Every }
} while (-not $Once)
