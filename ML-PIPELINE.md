# ML pipeline — commands reference
powershell -ExecutionPolicy Bypass -File .\generate-real-models.ps1 -Count 20
Real, locally-run GPU models that turn real catalogue photos into 3D models, and real room
photos into an AI-estimated layout + restyled preview. See `server/ml-service/README.md` for
the full design writeup; this file is the command cheat-sheet.

**These are pretrained foundation models used for inference — nothing here is "trained."**
Running a command below downloads each model's published weights from Hugging Face the first
time it's used (several GB total, cached after that), then runs them against the real photo(s)
you give it. There is no training step in this project.

## The architecture, and where each stage lives

| Stage | What | Code | Run it |
|---|---|---|---|
| 1. Furniture → 3D | catalogue photo → SAM 2.1 cut-out → TripoSR or Hunyuan3D-2mv → GLB | `server/ml-service/pipeline/stage1_furniture3d.py`, `scripts/image-to-3d.mjs` | `node scripts/image-to-3d.mjs --provider local --next 483 --yes` (resumable; log with `> models/batch-triposr.log`) |
| 1b. Benchmark | the same products through both models, same checks, GPU run time | `scripts/benchmark-models.mjs` | `node scripts/benchmark-models.mjs` → `models/bench/report.md`, `models/bench/compare.html` |
| 2. Product-ready GLB | upright, scaled to the listed W×D×H, origin at floor centre, front +z, ≤ 8 MB, product id kept, OK/REVIEW | `scripts/publish-models.mjs` (normalise), `scripts/review-models.mjs`, `scripts/bundle-models.mjs` | review: `node scripts/review-models.mjs` then `npx http-server models -p 8079` → `/review.html`; bundle: `node scripts/bundle-models.mjs [--accept id,id]` |
| 3. Room understanding | Depth Anything V2 + Grounding DINO + SAM 2.1 → objects, relative depth, floor line | `pipeline/stage2_room_understanding.py` → API `POST /v1/room-ai/jobs` (kind `understand`) → app "Redesign my room" → "Shop <category>" | app, Rooms tab → Redesign my room |
| 4. Room redesign | SDXL + depth ControlNet → restyled picture (inspiration only; real products are placed true-size in AR) | `pipeline/stage3_redesign.py` → API kind `redesign` → app | app, Rooms tab → Redesign my room → a style |

Stages 3–4 send the one room photo the user picks, after a consent switch; the API deletes it once the ml-service has read it
(see CLAUDE.md "Camera frames"). To switch them on: start the ml-service, set `ML_SERVICE_URL=http://127.0.0.1:8077` in `server/.env`,
and build the app with `EXPO_PUBLIC_API_URL` pointing at the API (EAS profile `preview-lan` for a phone on the same network).

Hunyuan3D-2mv note: its published DINOv2 encoder weights use an older `transformers` layout; `_remap_dinov2_conditioner_checkpoint`
in stage1 renames them on load (same approach as TripoSR's). Hunyuan output is shape-only (no colour) in this project.

## The one command

```powershell
powershell -ExecutionPolicy Bypass -File generate-real-models.ps1
```

Sets up the ml-service if needed (first run only — installs Python deps, clones TripoSR,
downloads model weights), generates real 3D models for the next 5 real catalogue products
(`src/data/catalogue.json`, not test photos), serves them locally, and attaches them to the
catalogue so the app picks them up.

```powershell
# more products at once
powershell -ExecutionPolicy Bypass -File generate-real-models.ps1 -Count 20

# also run stage 2 (room understanding) + stage 3 (AI redesign) on a real room photo
powershell -ExecutionPolicy Bypass -File generate-real-models.ps1 -RoomPhoto "<url-or-local-path>" -Prompt "make this room minimalist"

# plan only — see which real products would be picked, generate nothing
powershell -ExecutionPolicy Bypass -File generate-real-models.ps1 -DryRun

# if stage 3 misbehaves on your GPU again, force it onto CPU (slow, but avoids the GPU path)
powershell -ExecutionPolicy Bypass -File generate-real-models.ps1 -RoomPhoto "<url>" -StageThreeDevice cpu
```

## Resuming after a power-off / interruption

**Run the exact same command again.** Nothing restarts from the beginning:
- Products already generated → skipped (their `models/published/<id>.glb` already exists).
- Catalogue entries already attached → skipped (`attach-local-models.mjs` checks `model3D` first).
- The one product that was mid-generation at the moment of interruption → detected (its saved
  task id is now unknown to the restarted ml-service) and retried fresh automatically —
  this was a real gap, fixed in `scripts/image-to-3d.mjs`.

So `powershell -ExecutionPolicy Bypass -File generate-real-models.ps1 -Count 20` is both
"run everything" and "resume from where it was left" — the same command either way.

## Individual pieces (if you want them separately)

```powershell
cd server\ml-service

# setup only, verify imports + CUDA, no weights downloaded
powershell -ExecutionPolicy Bypass -File setup_and_run.ps1 -SelfTestOnly

# setup + start the HTTP service (http://127.0.0.1:8077), left running for the Node scripts to call
powershell -ExecutionPolicy Bypass -File setup_and_run.ps1

# setup + run all 3 stages once, in-process, on sample photos (no server)
powershell -ExecutionPolicy Bypass -File setup_and_run.ps1 -Demo
```

```bash
# from the project root, once the ml-service is running:
node scripts/image-to-3d.mjs --provider local --next 5           # plan only
node scripts/image-to-3d.mjs --provider local --next 5 --yes     # generate 5 real products
node scripts/image-to-3d.mjs --normalise                         # re-check everything in models/raw/, no network

# from server/ml-service, with its venv active:
python demo_run.py --furniture-url <product-photo-url>
python demo_run.py --room-url <room-photo-url> --prompt "..." --size 768
python demo_run.py --room-url <room-photo-url> --prompt "..." --device cpu   # force CPU for stage 3
```

## Models in use

| Stage | Task | Model |
|---|---|---|
| 1 — Furniture photo → 3D | Segment product from background | SAM 2.1 (hiera-small) — `facebook/sam2.1-hiera-small` |
| | Single-image mesh reconstruction | TripoSR — `stabilityai/TripoSR` |
| 2 — Room understanding | Depth | Depth Anything V2 (Small) — `depth-anything/Depth-Anything-V2-Small-hf` |
| | Object detection | Grounding DINO (tiny) — `IDEA-Research/grounding-dino-tiny` |
| | Per-object mask | SAM 2.1 (hiera-small) |
| 3 — AI redesign | Depth-conditioned generation | SDXL base 1.0 + ControlNet (SDXL depth) — `stabilityai/stable-diffusion-xl-base-1.0` + `diffusers/controlnet-depth-sdxl-1.0` |

All run locally via `transformers`/`diffusers`, one model family resident at a time
(`server/ml-service/pipeline/queue_worker.py`) so the pipeline fits in 8GB VRAM.

## Known hardware issue — stage 3, fix applied, real blocker is VRAM starvation

Stage 3's original code — SDXL + ControlNet using `accelerate`'s `enable_model_cpu_offload()` —
crashed with CUDA errors three times total, each a *different* low-level failure in a different
code path: `misaligned address` (offload hooks, fused attention), `illegal memory access`
(offload hooks, math attention), then — after applying the fix below and re-testing —
`CUBLAS_STATUS_INTERNAL_ERROR` inside a plain sliced-attention matmul, no accelerate hooks
involved at all.

That third result changes the diagnosis: three *different* errors in three *different* code
paths is not the signature of one bad kernel or one incompatible mechanism — it is the signature
of running a multi-GB model on a card that has almost no memory to give it. **This dev machine's
GPU had only 59–330MB of its 8GB free for virtually this entire session**, because a separate,
unrelated process (not part of this project) held the other ~7.5-7.8GB continuously throughout.
SDXL + ControlNet, even lean (768px, sliced attention, no offloading), needs several GB just for
weights and activations — it cannot succeed with a few hundred MB free, and exactly how it fails
under that kind of pressure (clean OOM vs. a corrupted allocation vs. a cuBLAS workspace failure)
is inconsistent by nature. None of the three test runs had more than ~300MB free at any point.

**The fix applied** (`server/ml-service/pipeline/stage3_redesign.py`) is still worth keeping
regardless: it stopped using `enable_model_cpu_offload()` (a real source of the first two
crashes, accelerate-hooks-specific), loads fully GPU-resident instead, with attention slicing +
VAE slicing/tiling, at a reduced default resolution (768px). A `device`/`size` knob was added to
the job payload and CLI so you can force CPU (`--device cpu`, slow but needs no VRAM at all) as a
fallback. But **the actual next step is getting real free VRAM**, not another code change: stop
whatever is holding this GPU (check with `nvidia-smi`) and re-run the exact same command, or run
it on the other machine you mentioned. This has not been verified under a clean multi-GB-free
condition yet — do that before trusting stage 3's output.
