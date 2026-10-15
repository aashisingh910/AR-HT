# HomeTown AR ml-service

Real, locally-run GPU models for the three stages that make sense to run off-device (an RN/Expo
phone app can't run these itself):

1. **Furniture photo -> 3D GLB** — SAM2 (segment the product) + TripoSR (single-image mesh) ->
   `models/raw/<product-id>.glb`, picked up by the existing `scripts/publish-models.mjs` /
   `scripts/image-to-3d.mjs --normalise` pipeline (orientation, scale-to-catalogue-size, triangle
   and texture budget — all already written, not duplicated here).
2. **Room photo -> depth + detected furniture/architecture** — Depth Anything V2 (relative depth)
   + Grounding DINO (open-vocabulary detection) + SAM2 (masks). Advisory input for a future
   layout-planning step; not metric, not used for placement.
3. **Room photo + instruction -> styled concept image** — SDXL + a depth ControlNet. A design
   preview only (CLAUDE.md: "generated room images are design previews, not automatically
   accurate 3D rooms" — this project's own rule, kept here).

There is **no AR-placement stage here** — that's the existing native Viro code under `src/ar/`,
which needs a real phone and is out of scope for a GPU/Python service.

## Why a queue, not a server that loads everything

One RTX 5060 (8GB VRAM) cannot hold SAM2 + TripoSR + Depth Anything V2 + Grounding DINO +
SDXL+ControlNet in memory at once. `pipeline/queue_worker.py` runs a single background thread
that processes one job at a time, end to end — load model(s) for that job -> run -> `del` +
`torch.cuda.empty_cache()` -> save the result to `outputs/` and `jobs/<id>.json` -> next job.
Three jobs submitted back-to-back run furniture3d, then room_understanding, then redesign, never
overlapping, regardless of which order they were submitted in.

## Quickest path on a fresh machine (same GPU/driver as this one)

```powershell
cd server/ml-service
powershell -ExecutionPolicy Bypass -File setup_and_run.ps1 -SelfTestOnly   # installs everything, checks imports + CUDA, downloads nothing
powershell -ExecutionPolicy Bypass -File setup_and_run.ps1 -Demo           # also runs all 3 stages on sample photos (downloads several GB of weights on first run)
powershell -ExecutionPolicy Bypass -File setup_and_run.ps1                 # starts the API service on http://127.0.0.1:8077 instead
```

What the script does: installs Python 3.11 (via winget) if missing, creates `.venv`, installs
`requirements.txt`, clones TripoSR into `vendor/TripoSR` (needed for stage 1's mesh step — see
"Portability" below), runs `selftest.py`, then either serves, demos, or stops.

### Single command, no PowerShell needed

If you'd rather not use the `.ps1`, the equivalent by hand:

```bash
py -3.14 -m venv .venv                               # 3.11-3.13 also work; see Portability if your driver needs cu121/cu124 instead of cu128
.venv/Scripts/pip install -r requirements.txt        # NOT vendor/TripoSR/requirements.txt — see Portability for why
git clone --depth 1 https://github.com/VAST-AI-Research/TripoSR.git vendor/TripoSR
.venv/Scripts/python selftest.py
.venv/Scripts/python demo_run.py --furniture-url <photo-url> --room-url <photo-url> --prompt "make it minimalist"
```

### Notebook

`notebooks/pipeline_walkthrough.ipynb` runs the same three stages cell by cell (no FastAPI
server), with each result displayed inline — useful for trying different photos/prompts
interactively instead of round-tripping through job files.

## Wiring into the existing Node tooling (stage 1 only)

`scripts/lib/image3d.mjs` now has a `local` provider alongside `meshy`, with the same
create/poll/download contract, so the existing CLI needs no new logic:

```bash
# with the ml-service running (setup_and_run.ps1, no -Demo flag) in another terminal:
node scripts/image-to-3d.mjs --provider local --next 5           # plan only, nothing spent (no credits needed either — it's local)
node scripts/image-to-3d.mjs --provider local --next 5 --yes     # generates 5 models
node scripts/image-to-3d.mjs --normalise                         # orient / scale-to-catalogue-size / check, same as any provider
```

Stages 2 and 3 have no Node/app wiring yet (there's no room-photo screen in the app to send them
from) — they're exposed over HTTP (`POST /v1/room-understanding`, `POST /v1/redesign`, poll
`GET /v1/jobs/{id}`) and via `demo_run.py`/the notebook, ready for whichever future step adds
that screen. Per CLAUDE.md, this intentionally stops short of touching `src/screens` or
navigation — that's its own step.

## Portability ("I'll run this on a different machine")

- **Python version**: `requirements.txt` pins `+cu128` wheels for `torch`/`torchvision`, which
  (as of this writing) publish Windows wheels up to Python 3.14 — so on a machine with the same
  generation of Python already installed, nothing extra needs installing.`setup_and_run.ps1`
  tries `py -3.14` down to `py -3.11` and uses whichever is found (falling back to installing
  3.14 via winget only if none exist), so it adapts either way.
- **CUDA wheel tag**: pinned to `cu128`. If the target machine's driver is older and can't run
  CUDA 12.8 (check with `nvidia-smi`, top-right "CUDA Version"), switch the `--extra-index-url`
  line in `requirements.txt` to `cu121` or `cu124` instead
  (https://pytorch.org/get-started/locally/) — note those two only publish wheels up to Python
  3.13, so you'd also want an older Python for the venv in that case.
- **`torchmcubes` (TripoSR's usual mesh-extraction dependency) needs a compiled CUDA extension**,
  which needs the CUDA *toolkit* (`nvcc`) + a matching compiler — a plain driver install (just
  `nvidia-smi`) doesn't have that. `pipeline/torchmcubes_shim.py` installs a pure-Python
  (scikit-image) fallback under the same module name *before* TripoSR imports it, used
  automatically whenever the real compiled package isn't importable.
- **`vendor/TripoSR/requirements.txt` (TripoSR's own file) is intentionally never installed** —
  it hard-pins years-old versions (Pillow 10.1.0, transformers 4.35.0, trimesh 4.0.5, ...) that
  conflict with this project's own pins and mostly predate Python 3.14 wheels entirely. Every
  package `tsr.system`/`tsr.utils` actually need to import (`omegaconf`, `einops`, `rembg`,
  `imageio[ffmpeg]`) is already in this project's `requirements.txt`, at versions confirmed (by
  `pip install --dry-run`, all packages together) to resolve with no conflicts.
- **`selftest.py`** checks every model class this code imports by name, and CUDA availability —
  run it right after setup, before a slow/expensive real job, to catch a library API drift fast.

## What was and wasn't verified from here

`nvidia-smi` on the machine this was built on showed only ~72MB VRAM free (a different,
already-running process — `dr-project-python-fixed` — held the rest), so actual GPU model
inference was **not** run end-to-end in this session. What *was* checked here, against the real
packages (not from memory):
- Every pin in `requirements.txt` resolves together with no conflicts (`pip install --dry-run`
  with all of them listed at once), on this exact machine's Python 3.14 + driver.
- TripoSR's real source (cloned into `vendor/TripoSR`) was read, not guessed from memory: this
  confirmed `TSR.from_pretrained(...)`'s exact argument names, that `extract_mesh` returns plain
  `trimesh.Trimesh` objects, that `tsr.models.isosurface` does `from torchmcubes import
  marching_cubes` and calls it as `mc_func(level_tensor, 0.0)` — exactly the call shape
  `torchmcubes_shim.py` implements — and that `tsr.utils`/`tsr.system` unconditionally import
  `rembg`/`imageio`/`omegaconf`/`einops` (now in `requirements.txt`) but never `xatlas`/
  `moderngl` (texture-baking/rendering only, so correctly left out).
- `transformers.Sam2Model`/`Sam2Processor`, `AutoModelForZeroShotObjectDetection`, the
  `depth-estimation` pipeline, and `diffusers.StableDiffusionXLControlNetPipeline`/
  `ControlNetModel`/`UniPCMultistepScheduler` all actually exist in the pinned library versions
  (checked by installing them and importing each by name — not assumed).
- Python syntax of every file (`py_compile`) and the notebook's JSON.
- The Node-side integration: `scripts/image3d.test.mjs`'s new `local`-provider test, plus the
  full existing `npm test` / `npm run typecheck` / `server && npm test` suites — all passing.

**Not verified**: an actual GPU inference run of any stage (needs the VRAM the other process is
holding, plus several GB of model-weight downloads). Before trusting this for real products, run
`setup_and_run.ps1 -SelfTestOnly` first, then `-Demo` on one photo, and look at the output
GLB/images before pointing it at the real catalogue.

## Known limitations (by design, not oversights)

- TripoSR invents the back/sides of furniture from one photo — same caveat `prompts/MODELS.md`
  already documents for the hosted Meshy path. Review every generated model before publishing.
- Room depth and the floor-line heuristic in stage 2 are relative/approximate, not measured —
  this project's convention (CLAUDE.md) is that AR placement relies on catalogue `dimensionsCm`
  and the phone's own ARCore/ARKit tracking, never on single-photo depth.
- Stage 3's images are concept art. They are never a source of truth for scale or geometry.
