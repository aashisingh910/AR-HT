<#
HomeTown AR ml-service — one-command setup + run for a fresh machine with an NVIDIA GPU.

  Setup + start the API service:
      powershell -ExecutionPolicy Bypass -File setup_and_run.ps1

  Setup + run the self-test only (no server, no weights downloaded):
      powershell -ExecutionPolicy Bypass -File setup_and_run.ps1 -SelfTestOnly

  Setup + run the full demo against sample photo URLs (downloads several GB of model weights
  on first run; processes stage 1, then 2, then 3, strictly one at a time):
      powershell -ExecutionPolicy Bypass -File setup_and_run.ps1 -Demo
      powershell -ExecutionPolicy Bypass -File setup_and_run.ps1 -Demo -FurnitureUrl "https://.../sofa.jpg" -RoomUrl "https://.../room.jpg" -Prompt "make this room minimalist, keep the sofa"

  Also set up Hunyuan3D-2mv, the multiview alternative to TripoSR for stage 1 (opt-in: heavier
  download, needs ~6GB VRAM on top of everything else, and its own tencent-hunyuan-community
  license — read that before any production use):
      powershell -ExecutionPolicy Bypass -File setup_and_run.ps1 -SelfTestOnly -WithHunyuan3D

What it does: finds a Python (3.11-3.14 all work — requirements.txt's cu128 wheels cover
Python 3.14 directly, so nothing extra needs installing on a machine that already has a recent
Python), creates a venv in .venv, installs requirements.txt, clones TripoSR into vendor/TripoSR
(for stage 1's mesh reconstruction; torchmcubes_shim.py removes the need for its usual
CUDA-compiled dependency), then either starts run_service.py or runs demo_run.py / selftest.py.
#>
param(
    [switch]$Demo,
    [switch]$SelfTestOnly,
    [switch]$WithHunyuan3D,
    [string]$FurnitureUrl = "https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=1024",
    [string]$RoomUrl = "https://images.unsplash.com/photo-1484154218962-a197022b5858?w=1024",
    [string]$Prompt = "make this room minimalist and keep the existing sofa"
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }

Write-Step "Finding a Python interpreter (3.11-3.14 all work)"
$pyVersion = $null
foreach ($candidate in @("3.14", "3.13", "3.12", "3.11")) {
    try {
        $found = (py "-$candidate" -c "import sys; print(sys.executable)" 2>$null)
        if ($found) { $pyVersion = $candidate; Write-Host "Using Python $candidate -> $found"; break }
    } catch {}
}
if (-not $pyVersion) {
    Write-Step "No usable Python found — installing Python 3.14 via winget"
    winget install -e --id Python.Python.3.14 --accept-package-agreements --accept-source-agreements
    $pyVersion = "3.14"
}

Write-Step "Checking for an NVIDIA GPU"
try {
    nvidia-smi --query-gpu=name,memory.total,memory.free --format=csv,noheader | Write-Host
} catch {
    Write-Warning "nvidia-smi not found — this will run on CPU (correct, but very slow)."
}

Write-Step "Creating venv (.venv) if missing"
if (-not (Test-Path ".venv")) {
    py "-$pyVersion" -m venv .venv
}
$venvPy = ".venv\Scripts\python.exe"
$venvPip = ".venv\Scripts\pip.exe"

Write-Step "Installing Python dependencies (requirements.txt)"
& $venvPip install --upgrade pip
& $venvPip install -r requirements.txt

Write-Step "Fetching TripoSR source (stage 1's image-to-3D model) into vendor/TripoSR"
if (-not (Test-Path "vendor\TripoSR\tsr")) {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        throw "git is required to fetch TripoSR. Install Git for Windows and re-run this script."
    }
    git clone --depth 1 https://github.com/VAST-AI-Research/TripoSR.git vendor\TripoSR
    # Deliberately NOT installing vendor/TripoSR/requirements.txt: it hard-pins much older
    # versions (Pillow 10.1.0, transformers 4.35.0, trimesh 4.0.5, ...) that conflict with this
    # project's own requirements.txt and mostly predate Python 3.14 wheels anyway. Everything
    # tsr.system/tsr.utils actually need to import (omegaconf, einops, rembg, imageio[ffmpeg])
    # is already in requirements.txt above, at versions verified to resolve together.
    # torchmcubes (TripoSR's usual mesh-extraction dependency) is skipped on purpose too — it
    # needs a CUDA toolkit + compiler to build; pipeline/torchmcubes_shim.py supplies a
    # pure-Python fallback instead, used automatically if the real package isn't importable.
} else {
    Write-Host "vendor/TripoSR already present, skipping clone."
}

if ($WithHunyuan3D) {
    Write-Step "Fetching Hunyuan3D-2 source (stage 1's optional multiview model) into vendor/Hunyuan3D-2"
    if (-not (Test-Path "vendor\Hunyuan3D-2\hy3dgen")) {
        if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
            throw "git is required to fetch Hunyuan3D-2. Install Git for Windows and re-run this script."
        }
        git clone --depth 1 https://github.com/Tencent/Hunyuan3D-2.git vendor\Hunyuan3D-2
        # Only shape generation is used (hy3dgen.shapegen) — see the docstring in
        # pipeline/stage1_furniture3d.py. Texture painting needs two custom CUDA extensions
        # built with raw `setup.py install` (custom_rasterizer, differentiable_renderer), which
        # this project deliberately never builds, for the same portability reason as
        # torchmcubes_shim.py: those build steps are not reliably reproducible on an arbitrary
        # machine. requirements.txt there also pins its own (likely conflicting, likely stale
        # for this Python version) versions, same situation as TripoSR's requirements.txt — so
        # this installs only the editable package itself, not its requirements.txt wholesale.
        & $venvPip install -e "vendor\Hunyuan3D-2" --no-deps
    } else {
        Write-Host "vendor/Hunyuan3D-2 already present, skipping clone."
    }
}

Write-Step "Self-test (imports + CUDA check, no weights downloaded)"
& $venvPy selftest.py
if ($LASTEXITCODE -ne 0) {
    Write-Warning "Self-test reported problems above. Fix those before trusting a real run."
}
if ($SelfTestOnly) { exit $LASTEXITCODE }

if ($Demo) {
    Write-Step "Running the demo pipeline (first run downloads several GB of model weights)"
    & $venvPy demo_run.py --furniture-url $FurnitureUrl --room-url $RoomUrl --prompt $Prompt
    exit $LASTEXITCODE
}

Write-Step "Starting the ml-service on http://127.0.0.1:8077"
Write-Host "Leave this running, then from the project root: node scripts/image-to-3d.mjs --provider local --next 1 --yes"
& $venvPy run_service.py
