<#
Starts (or resumes) everything the 3D / room-AI pipeline needs. Safe to run any number of times: anything already running is left alone,
and every job continues from where it stopped (finished models are skipped, half-written files are never counted as done).

    powershell -ExecutionPolicy Bypass -File scripts\resume-pipeline.ps1            start / resume everything
    powershell -ExecutionPolicy Bypass -File scripts\resume-pipeline.ps1 -InstallBoot  run it every time the PC starts, before anyone logs in (asks for admin once)
    powershell -ExecutionPolicy Bypass -File scripts\resume-pipeline.ps1 -Install      run it when you log in instead (no admin needed)
    powershell -ExecutionPolicy Bypass -File scripts\resume-pipeline.ps1 -Uninstall    remove both

-InstallBoot registers the scheduled task "HomeTown pipeline resume": trigger "At startup" (+2 min), runs as your own account in S4U mode
("run whether the user is logged on or not", no password stored), so your files and the Hugging Face model cache are the same as when you
run it yourself. Check it in Task Scheduler (taskschd.msc) or: Get-ScheduledTask "HomeTown pipeline resume" | Get-ScheduledTaskInfo

What it starts, in order:
  1. ml-service (GPU, http://127.0.0.1:8077)         server/ml-service/run_service.py
  2. API server (http://<this PC>:4000)               server/src/index.mjs with server/.env
  3. SDXL weight download (no GPU) until complete     server/ml-service/prefetch_weights.py
  4. TripoSR batch over the catalogue                 scripts/image-to-3d.mjs  -> models/batch-triposr.log (appended)
  5. TripoSR vs Hunyuan3D benchmark                   scripts/benchmark-models.mjs -> models/bench/benchmark.log (appended)
Watch it all with: powershell -ExecutionPolicy Bypass -File scripts\pipeline-status.ps1
#>
param([switch]$Install, [switch]$InstallBoot, [switch]$Uninstall, [string]$ForUser)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root
$startup = Join-Path ([Environment]::GetFolderPath('Startup')) 'HomeTown-pipeline-resume.cmd'
$me = Join-Path $root 'scripts\resume-pipeline.ps1'
$taskName = 'HomeTown pipeline resume'
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if ($InstallBoot -or ($Uninstall -and (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue))) {
    if (-not $isAdmin) {
        # A startup trigger needs admin: relaunch elevated (one UAC prompt), passing who the task should run as.
        $flag = if ($InstallBoot) { '-InstallBoot' } else { '-Uninstall' }
        $p = Start-Process powershell -Verb RunAs -Wait -PassThru -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$me`" $flag -ForUser `"$(whoami)`""
        Remove-Item $startup -ErrorAction SilentlyContinue  # the boot task replaces the login shortcut (both at once could race)
        Write-Host $(if ($p.ExitCode -eq 0) { 'Done (see models\resume.log).' } else { "The elevated step failed (exit $($p.ExitCode)); see models\resume.log." })
        exit $p.ExitCode
    }
    $user = if ($ForUser) { $ForUser } else { whoami }
    try {
        if ($InstallBoot) {
            $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$me`"" -WorkingDirectory $root
            $trigger = New-ScheduledTaskTrigger -AtStartup; $trigger.Delay = 'PT2M'
            $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType S4U -RunLevel Limited
            # No time limit, run on battery, start if a boot was missed; the script itself only launches the jobs and exits.
            $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
            Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Resumes the HomeTown 3D / room-AI pipeline after a restart or power cut (scripts\resume-pipeline.ps1).' -Force | Out-Null
            Add-Content (Join-Path $root 'models\resume.log') "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  installed boot task '$taskName' for $user"
        } else {
            Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
            Add-Content (Join-Path $root 'models\resume.log') "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  removed boot task '$taskName'"
        }
        exit 0
    } catch { Add-Content (Join-Path $root 'models\resume.log') "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  boot task step FAILED: $($_.Exception.Message)"; exit 1 }
}
if ($Uninstall) { Remove-Item $startup -ErrorAction SilentlyContinue; Write-Host 'Removed: the pipeline no longer starts automatically.'; exit 0 }
if ($Install) {
    # The Startup folder needs no admin rights. A short delay lets the network and GPU driver come up after login.
    Set-Content $startup -Encoding ascii -Value "@echo off`r`ntimeout /t 60 /nobreak >nul`r`npowershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$me`""
    Write-Host "Installed: $startup"
}

$log = Join-Path $root 'models\resume.log'
New-Item -ItemType Directory -Force (Join-Path $root 'models\bench') | Out-Null
function Say($m) { $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $m"; Write-Host $line; Add-Content $log $line }
function Running($pattern) { [bool](Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='python.exe'" | Where-Object { $_.CommandLine -match $pattern }) }
function Up($url) { try { Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 3 | Out-Null; $true } catch { $false } }
# cmd's >> appends, so a resumed run adds to the same log instead of replacing it.
function StartLogged($exe, $argline, $dir, $logFile) {
    Start-Process cmd.exe -ArgumentList "/c `"`"$exe`" $argline >> `"$logFile`" 2>&1`"" -WorkingDirectory $dir -WindowStyle Hidden
}

# At boot the network can come up after this starts: product photos come from the Shopify CDN, so wait (up to 10 min) for it.
function Online { try { $c = New-Object Net.Sockets.TcpClient; $ok = $c.ConnectAsync('cdn.shopify.com', 443).Wait(3000) -and $c.Connected; $c.Close(); $ok } catch { $false } }
$deadline = (Get-Date).AddMinutes(10)
while (-not (Online) -and (Get-Date) -lt $deadline) { Start-Sleep 10 }
if (-not (Online)) { Say 'network: still offline after 10 min, starting anyway (failed products are retried on the next resume)' }

$ml = Join-Path $root 'server\ml-service'
$py = Join-Path $ml '.venv\Scripts\python.exe'
$node = (Get-Command node).Source

if (Up 'http://127.0.0.1:8077/health') { Say 'ml-service: already running' } else {
    StartLogged $py 'run_service.py' $ml (Join-Path $root 'models\ml-service.log')
    $deadline = (Get-Date).AddSeconds(90)
    while (-not (Up 'http://127.0.0.1:8077/health') -and (Get-Date) -lt $deadline) { Start-Sleep 3 }
    if (Up 'http://127.0.0.1:8077/health') { Say 'ml-service: started' } else { Say 'ml-service: FAILED to start, see models\ml-service.log'; exit 1 }
}

if (Up 'http://127.0.0.1:4000/ready') { Say 'API: already running' } else {
    StartLogged $node '--env-file-if-exists=.env src/index.mjs' (Join-Path $root 'server') (Join-Path $root 'models\api.log')
    Start-Sleep 5
    Say ("API: " + $(if (Up 'http://127.0.0.1:4000/ready') { 'started' } else { 'FAILED to start, see models\api.log' }))
}

$prefetchLog = Join-Path $root 'models\sdxl-prefetch.log'
if (Running 'prefetch_weights|prefetch_sdxl') { Say 'SDXL download: already running' }
elseif ((Test-Path $prefetchLog) -and (Select-String -Path $prefetchLog -Pattern 'fast redesign done' -Quiet)) { Say 'SDXL download: complete' }
else { StartLogged $py 'prefetch_weights.py' $ml $prefetchLog; Say 'SDXL download: started / resumed' }

if (Running 'image-to-3d\.mjs') { Say 'TripoSR batch: already running' } else {
    StartLogged $node 'scripts/image-to-3d.mjs --provider local --next 1000 --yes' $root (Join-Path $root 'models\batch-triposr.log')
    Say 'TripoSR batch: started / resumed (finished products are skipped)'
}

if (Running 'benchmark-models\.mjs') { Say 'Benchmark: already running' }
elseif ((Test-Path 'models\bench\report.md') -and -not (Get-ChildItem 'models\bench\*\raw\*.part' -ErrorAction SilentlyContinue) -and
        ((Get-Content 'models\bench\results.json' -Raw | ConvertFrom-Json).PSObject.Properties.Value | Where-Object { -not $_.error }).Count -ge 48) { Say 'Benchmark: complete (models\bench\report.md)' }
else { StartLogged $node 'scripts/benchmark-models.mjs' $root (Join-Path $root 'models\bench\benchmark.log'); Say 'Benchmark: started / resumed' }
