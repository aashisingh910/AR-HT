"""Downloads the stage 4 (redesign) weights ahead of time, outside the GPU job queue, so the first redesign request does not block
every other job for the length of a ~9.5 GB download. Resumable: re-running continues partial files. Uses no GPU.

    .venv\\Scripts\\python.exe prefetch_weights.py
"""
from huggingface_hub import snapshot_download

snapshot_download("diffusers/controlnet-depth-sdxl-1.0", allow_patterns=["*.json", "diffusion_pytorch_model.fp16.safetensors"])
print("controlnet done", flush=True)
snapshot_download(
    "stabilityai/stable-diffusion-xl-base-1.0",
    allow_patterns=[
        "model_index.json", "scheduler/*", "tokenizer/*", "tokenizer_2/*", "*/config.json",
        "unet/diffusion_pytorch_model.fp16.safetensors", "text_encoder/model.fp16.safetensors",
        "text_encoder_2/model.fp16.safetensors", "vae/diffusion_pytorch_model.fp16.safetensors",
    ],
)
print("sdxl done", flush=True)
# Fast redesign path (stage3_redesign.py): small depth ControlNet (~0.3 GB) + SDXL-Lightning 4-step LoRA (~0.4 GB).
snapshot_download("diffusers/controlnet-depth-sdxl-1.0-small", allow_patterns=["config.json", "diffusion_pytorch_model.fp16.safetensors"])
snapshot_download("ByteDance/SDXL-Lightning", allow_patterns=["sdxl_lightning_4step_lora.safetensors"])
print("fast redesign done", flush=True)
