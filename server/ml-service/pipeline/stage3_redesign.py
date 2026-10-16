"""Stage 3 — a room photo + a text instruction becomes a styled concept image, in seconds.

SDXL + a depth ControlNet keeps the room's walls/windows/perspective roughly fixed while restyling it to the prompt.

Why it is fast (it took ~20 minutes per image on this project's 8 GB RTX 5060 before):
  * SDXL-Lightning 4-step LoRA, fused into the UNet: 4 denoising steps instead of 28, and no classifier-free guidance
    (guidance_scale=0, as Lightning is trained), so each step is one UNet pass instead of two. ~14x less work.
  * The *small* depth ControlNet (~0.3 GB) instead of the full one (~2.5 GB): the full one pushed SDXL past 8 GB, so the
    driver spilled into system RAM and every step took ~44 s.
  * `enable_model_cpu_offload()`: the weights wait in system RAM and each model (text encoders, UNet + ControlNet, VAE) is
    moved onto the GPU only while it runs, so the peak is the UNet (~5 GB) and furniture jobs still fit between requests.
    (An earlier version blamed this offload path for CUDA crashes; ML-PIPELINE.md shows those runs had under 300 MB of VRAM
    free because another process held the card. With the GPU free it runs cleanly.)
  * Everything is loaded once and kept (`_CACHE`), so a request does not re-read ~7 GB from disk. `warm_up()` preloads it.
  * Output keeps the photo's aspect ratio (it used to be squashed to a square).

This is a design preview, not a measured scene: callers must not treat its output as geometry (see the `note` in the
result). Real products are placed true-to-size in AR.
"""
import threading

import torch
from PIL import Image

from . import common

DEFAULT_PROMPT = "a tidy, well-lit, minimalist living room, photorealistic, interior design magazine photo"
DEFAULT_SIZE = 768  # longest side, px (SDXL is trained near 1024; 768 keeps it fast on 8 GB)
DEFAULT_STEPS = 4   # SDXL-Lightning 4-step
QUALITY_SUFFIX = ", photorealistic interior photo, high detail, natural light"

BASE = "stabilityai/stable-diffusion-xl-base-1.0"
CONTROLNET = "diffusers/controlnet-depth-sdxl-1.0-small"
LIGHTNING = ("ByteDance/SDXL-Lightning", "sdxl_lightning_4step_lora.safetensors")
DEPTH = "depth-anything/Depth-Anything-V2-Small-hf"

_CACHE: dict = {}
_LOCK = threading.Lock()


def _depth():
    """Depth Anything V2 Small (~100 MB) stays on the GPU: it is tiny and stage 2 uses it too."""
    if "depth" not in _CACHE:
        from transformers import pipeline

        _CACHE["depth"] = pipeline("depth-estimation", model=DEPTH, device=0 if common.device() == "cuda" else -1)
    return _CACHE["depth"]


def _pipe():
    with _LOCK:
        if "pipe" in _CACHE:
            return _CACHE["pipe"]
        from diffusers import ControlNetModel, EulerDiscreteScheduler, StableDiffusionXLControlNetPipeline
        from huggingface_hub import hf_hub_download

        cuda = common.device() == "cuda"
        dtype = torch.float16 if cuda else torch.float32
        kwargs = {"torch_dtype": dtype, "variant": "fp16"} if cuda else {"torch_dtype": dtype}
        controlnet = ControlNetModel.from_pretrained(CONTROLNET, **kwargs)
        pipe = StableDiffusionXLControlNetPipeline.from_pretrained(BASE, controlnet=controlnet, **kwargs)
        pipe.load_lora_weights(hf_hub_download(*LIGHTNING))
        pipe.fuse_lora()
        pipe.unload_lora_weights()  # the weights are merged into the UNet; drop the adapter copies
        # Lightning needs "trailing" timesteps (its model card); the default spacing gives washed-out images at 4 steps.
        pipe.scheduler = EulerDiscreteScheduler.from_config(pipe.scheduler.config, timestep_spacing="trailing")
        if cuda:
            pipe.enable_model_cpu_offload()
        pipe.set_progress_bar_config(disable=True)
        _CACHE["pipe"] = pipe
        return pipe


def warm_up() -> None:
    """Load everything into RAM ahead of the first request (run_service.py calls this through the queue at start)."""
    _depth()
    _pipe()


def _fit(image: Image.Image, longest: int) -> tuple[int, int]:
    """Output size with the photo's aspect ratio, longest side `longest`, both sides multiples of 64 (SDXL needs /8; 64 is safest)."""
    w, h = image.size
    scale = longest / max(w, h)
    snap = lambda v: max(384, round(v * scale / 64) * 64)  # noqa: E731 — very thin strips look bad, so never below 384
    return snap(w), snap(h)


def run_redesign(job, progress) -> dict:
    payload = job.payload
    image = common.download_image(payload["image_url"])
    prompt = (payload.get("prompt") or DEFAULT_PROMPT) + QUALITY_SUFFIX
    steps = int(payload.get("steps", DEFAULT_STEPS))
    seed = int(payload.get("seed", 0))
    conditioning_scale = float(payload.get("conditioning_scale", 0.6))
    width, height = _fit(image, int(payload.get("size", DEFAULT_SIZE)))
    progress(10)

    depth = _depth()(image)["depth"]
    condition = depth.convert("RGB").resize((width, height))
    progress(25)

    pipe = _pipe()
    progress(35)
    with torch.no_grad():
        out = pipe(
            prompt=prompt,
            image=condition,
            num_inference_steps=steps,
            guidance_scale=0.0,  # Lightning is distilled for no classifier-free guidance: one UNet pass per step
            controlnet_conditioning_scale=conditioning_scale,
            generator=torch.Generator(device="cpu").manual_seed(seed),
            width=width,
            height=height,
        )
    progress(90)

    out_path = common.OUTPUT_DIR / f"{job.id}.png"
    out.images[0].save(out_path)
    progress(100)
    return {
        "image_url": f"/files/{job.id}.png",
        "prompt": prompt,
        "size": {"w": width, "h": height},
        "note": (
            "Design concept image only, not a measured 3D scene. Do not use for placement, "
            "clearance or scale decisions — keep it separate from the dimensionally correct AR view."
        ),
    }
