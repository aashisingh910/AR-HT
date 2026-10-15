"""Stage 3 — a room photo + a text instruction becomes a styled concept image.

SDXL + a depth ControlNet keeps the room's walls/windows/perspective roughly fixed while
restyling it to the prompt.

Does NOT use `enable_model_cpu_offload()` — on this project's dev GPU, that accelerate-hooked
offload path corrupted GPU memory twice (two different attention kernels, two different CUDA
errors, both mid-UNet-forward). A third test, after removing it, still failed with yet another
CUDA error (this time inside plain sliced attention, no accelerate hooks at all) — but that run
had under 300MB of the card's 8GB free the whole time (an unrelated process held the rest), which
is the far more likely explanation for all three failures than a GPU/driver incompatibility: SDXL
+ ControlNet cannot succeed in a few hundred MB regardless of how it's loaded. See ML-PIPELINE.md
at the repo root ("Known hardware issue") for the full history. This has not yet been verified
under a clean multi-GB-free condition — do that before trusting its output. If your GPU has more
headroom, `height`/`width` in the job payload can go back up to 1024.

This is a design preview, not a measured scene: callers must not treat its output as geometry
(see the `note` in the result, and CLAUDE.md's "generated room images are previews, not
dimensionally correct" rule for this project).
"""
import torch
from PIL import Image

from . import common

DEFAULT_PROMPT = (
    "a tidy, well-lit, minimalist living room, photorealistic, interior design magazine photo"
)
DEFAULT_NEGATIVE = "blurry, distorted geometry, extra walls, warped furniture, text, watermark"
DEFAULT_SIZE = 768  # SDXL supports this natively (it's one of its trained bucket resolutions); lighter than 1024


def _depth_condition_image(image: Image.Image, size: int) -> Image.Image:
    from transformers import pipeline

    depther = pipeline(
        "depth-estimation",
        model="depth-anything/Depth-Anything-V2-Small-hf",
        device=0 if common.device() == "cuda" else -1,
    )
    try:
        depth = depther(image)["depth"]
    finally:
        del depther
        common.free_gpu()
    return depth.convert("RGB").resize((size, size))


def _load_pipe(device: str):
    from diffusers import (
        ControlNetModel,
        StableDiffusionXLControlNetPipeline,
        UniPCMultistepScheduler,
    )

    dtype = torch.float16 if device == "cuda" else torch.float32
    kwargs = {"torch_dtype": dtype, "variant": "fp16"} if device == "cuda" else {"torch_dtype": dtype}
    controlnet = ControlNetModel.from_pretrained("diffusers/controlnet-depth-sdxl-1.0", **kwargs)
    pipe = StableDiffusionXLControlNetPipeline.from_pretrained(
        "stabilityai/stable-diffusion-xl-base-1.0", controlnet=controlnet, **kwargs
    )
    pipe.scheduler = UniPCMultistepScheduler.from_config(pipe.scheduler.config)
    pipe.to(device)  # fully resident, no accelerate cpu-offload hooks — see module docstring for why
    pipe.enable_attention_slicing("max")
    pipe.vae.enable_slicing()
    pipe.vae.enable_tiling()
    return pipe


def run_redesign(job, progress) -> dict:
    payload = job.payload
    image = common.download_image(payload["image_url"])
    prompt = payload.get("prompt") or DEFAULT_PROMPT
    negative = payload.get("negative_prompt") or DEFAULT_NEGATIVE
    steps = int(payload.get("steps", 28))
    seed = int(payload.get("seed", 0))
    conditioning_scale = float(payload.get("conditioning_scale", 0.6))
    size = int(payload.get("size", DEFAULT_SIZE))
    # Explicit opt-out valve: pass {"device": "cpu"} in the job payload to force CPU execution
    # (slow — minutes, not seconds — but immune to this GPU's CUDA corruption) if a run is
    # critical and the GPU path is misbehaving again. Never auto-retried on CPU in-process:
    # once a CUDA context has thrown an illegal-memory-access, torch calls after it (even on
    # the CPU device) are not reliably safe in that same process.
    device = payload.get("device") or common.device()
    progress(10)

    condition = _depth_condition_image(image, size)
    progress(35)

    pipe = _load_pipe(device)
    try:
        generator = torch.Generator(device="cpu").manual_seed(seed)
        out = pipe(
            prompt=prompt,
            negative_prompt=negative,
            image=condition,
            num_inference_steps=steps,
            controlnet_conditioning_scale=conditioning_scale,
            generator=generator,
            height=size,
            width=size,
        )
        result_image = out.images[0]
    finally:
        del pipe
        common.free_gpu()
    progress(90)

    out_path = common.OUTPUT_DIR / f"{job.id}.png"
    result_image.save(out_path)
    progress(100)
    return {
        "image_url": f"/files/{job.id}.png",
        "prompt": prompt,
        "note": (
            "Design concept image only, not a measured 3D scene. Do not use for placement, "
            "clearance or scale decisions — keep it separate from the dimensionally correct AR view."
        ),
    }
