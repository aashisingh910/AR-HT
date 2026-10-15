<#
THE ONE COMMAND: runs the entire real-data ML pipeline — real catalogue products through
stage 1 (photo -> 3D model), and optionally a real room photo through stages 2+3 (room
understanding + AI redesign) — on the local GPU ml-service, against real data (src/data/
catalogue.json's 681 real HomeTown products; no test/demo photos involved).

    powershell -ExecutionPolicy Bypass -File generate-real-models.ps1
    powershell -ExecutionPolicy Bypass -File generate-real-models.ps1 -Count 20
    powershell -ExecutionPolicy Bypass -File generate-real-models.ps1 -RoomPhoto "<url-or-local-path>" -Prompt "make this room minimalist"
    powershell -ExecutionPolicy Bypass -File generate-real-models.ps1 -DryRun

RESUMING: if this is interrupted (power off, closed terminal, anything) — run the exact same
command again. Finished products are skipped (their output file already exists on disk);
catalogue entries already attached are skipped too; the one product that was mid-generation at
interruption time is detected and retried fresh automatically. Nothing ever restarts from zero.
See ML-PIPELINE.md at the repo root for the full command reference and the model list.

What it does, in order:
  1. Sets up server/ml-service (venv, deps, TripoSR) if not already done — same as that
     folder's own setup_and_run.ps1. Downloads every model's pretrained weights from Hugging
     Face on first use (several GB); these are pretrained foundation models used for
     inference, not something this script trains.
  2. Starts the ml-service in the background if it isn't already running (health-checked).
  3. Stage 1: runs scripts/image-to-3d.mjs against the REAL catalogue (its own pickProducts()
     picks real, model-less products — sample-room sofas/beds first, same order the hosted-
     Meshy path always used): for each, SAM2 + TripoSR turn the product's real photo into a
     mesh, then the existing Node pipeline auto-orients and scales it to that product's real
     catalogue dimensions and writes models/published/<id>.glb with an OK/REVIEW report.
  4. Serves models/published/ over plain HTTP on 127.0.0.1:8078 (http.server — fine for
     local testing; not a real CDN).
  5. Attaches those local models to src/data/catalogue.json (scripts/attach-local-models.mjs)
     so the app's existing model3D loading path picks them up — see the warning that script
     prints about the admin review step this skips.
  6. Only if -RoomPhoto is given: stages 2+3 on that real room photo — depth + object
     detection + an AI-restyled preview image. Stage 3 (SDXL) had been crashing on this dev
     machine's GPU (a CUDA memory-corruption bug tied to accelerate's cpu-offload hooks on
     this very new card); the fix (full GPU residency instead of offloading, smaller default
     resolution) is applied in pipeline/stage3_redesign.py. Pass -StageThreeDevice cpu if it
     still misbehaves on your hardware — slow, but avoids the GPU path entirely.

After it finishes: run the app (npx expo prebuild && npx expo run:android, per CLAUDE.md —
needs a real ARCore phone) and open one of the products it just generated; or just open the
.glb files under models/published/ in a 3D viewer to check them without a phone.
#>
param(
    [int]$Count = 5,
    [switch]$DryRun,
    [string]$RoomPhoto,
    [string]$Prompt = "make this room minimalist and keep the existing furniture",
    [int]$StageThreeSize = 768,
    [string]$StageThreeDevice
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }

# ---- 1 & 2: ml-service up and healthy ----
Push-Location "server\ml-service"
try {
    if (-not (Test-Path ".venv\Scripts\python.exe")) {
        Write-Step "First run: setting up server/ml-service (venv, deps, TripoSR) — this takes a while"
        & "powershell" -ExecutionPolicy Bypass -File "setup_and_run.ps1" -SelfTestOnly
    }

    $venvPy = Resolve-Path ".venv\Scripts\python.exe"
    $healthy = $false
    try { Invoke-RestMethod -Uri "http://127.0.0.1:8077/health" -TimeoutSec 2 | Out-Null; $healthy = $true } catch {}

    if (-not $healthy) {
        Write-Step "Starting the ml-service in the background (http://127.0.0.1:8077)"
        Start-Process -FilePath $venvPy -ArgumentList "run_service.py" -WorkingDirectory (Get-Location) -WindowStyle Hidden
        $deadline = (Get-Date).AddSeconds(60)
        while (-not $healthy -and (Get-Date) -lt $deadline) {
            Start-Sleep -Seconds 2
            try { Invoke-RestMethod -Uri "http://127.0.0.1:8077/health" -TimeoutSec 2 | Out-Null; $healthy = $true } catch {}
        }
        if (-not $healthy) { throw "ml-service did not come up on http://127.0.0.1:8077 within 60s — run setup_and_run.ps1 directly to see the error." }
    } else {
        Write-Host "ml-service already running."
    }
} finally {
    Pop-Location
}

# ---- 3: generate real models for real catalogue products ----
Write-Step "Generating 3D models for the next $Count real catalogue product(s)"
if ($DryRun) {
    node scripts/image-to-3d.mjs --provider local --next $Count
    Write-Host "`nDry run only (-DryRun was passed). Re-run without it to actually generate."
    exit 0
}
node scripts/image-to-3d.mjs --provider local --next $Count --yes
if ($LASTEXITCODE -ne 0) { throw "image-to-3d.mjs failed — see output above." }

# ---- 4: serve models/published/ locally ----
Write-Step "Serving models/published/ on http://127.0.0.1:8078"
$servePy = Resolve-Path "server\ml-service\.venv\Scripts\python.exe"
Start-Process -FilePath $servePy -ArgumentList "-m", "http.server", "8078", "--directory", "models/published" -WindowStyle Hidden
Start-Sleep -Seconds 1

# ---- 5: attach to the real catalogue ----
Write-Step "Attaching generated models to src/data/catalogue.json"
$env:MODEL_BASE_URL = "http://127.0.0.1:8078/"
node scripts/attach-local-models.mjs

Write-Host "`nStage 1 done. The models/published HTTP server and the ml-service are left running" -ForegroundColor Green
Write-Host "in the background for your next run or for the app to fetch from." -ForegroundColor Green

# ---- 6: optional stages 2+3 on a real room photo ----
if ($RoomPhoto) {
    Write-Step "Stages 2+3 on your room photo (room understanding + AI redesign)"
    $demoPy = Resolve-Path "server\ml-service\.venv\Scripts\python.exe"
    $demoArgs = @("demo_run.py", "--room-url", $RoomPhoto, "--prompt", $Prompt, "--size", "$StageThreeSize")
    if ($StageThreeDevice) { $demoArgs += @("--device", $StageThreeDevice) }
    Push-Location "server\ml-service"
    try { & $demoPy @demoArgs } finally { Pop-Location }
}

Write-Host "`nClose the ml-service and http.server python.exe processes (Task Manager, or" -ForegroundColor Green
Write-Host "Stop-Process) when you're done testing." -ForegroundColor Green
