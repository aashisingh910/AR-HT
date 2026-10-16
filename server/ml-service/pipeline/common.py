"""Shared helpers: paths, GPU memory hygiene, image IO, the Job record.

Nothing in this module loads a model — model loading lives in the stage_*.py files, each of
which loads on first use and frees VRAM in a `finally` block, because the whole point of the
queue (see queue_worker.py) is that only one heavy model is ever resident on an 8GB card at a time.
"""
import gc
import io
import pathlib
import time
from dataclasses import dataclass, field
from typing import Literal, Optional

import requests
import torch

ROOT = pathlib.Path(__file__).resolve().parent.parent
JOBS_DIR = ROOT / "jobs"
OUTPUT_DIR = ROOT / "outputs"
VENDOR_DIR = ROOT / "vendor"
for _d in (JOBS_DIR, OUTPUT_DIR, VENDOR_DIR):
    _d.mkdir(parents=True, exist_ok=True)


def device() -> str:
    return "cuda" if torch.cuda.is_available() else "cpu"


def free_gpu() -> None:
    """Call after `del model` for every stage, every time — this is what makes the whole
    pipeline fit in 8GB: at most one model's weights are resident at any point.

    Wrapped in try/except: a CUDA error earlier in the same job (illegal memory access, etc.)
    leaves the CUDA context unusable, and even `empty_cache()` itself then raises — this is
    best-effort cleanup, not something that should mask the original error or crash the worker.
    """
    gc.collect()
    if torch.cuda.is_available():
        try:
            torch.cuda.empty_cache()
            torch.cuda.synchronize()
        except RuntimeError as exc:
            print(f"warning: GPU cleanup failed ({exc}) — the CUDA context may be unusable until this process restarts")


def download_image(url_or_path: str):
    from PIL import Image

    if url_or_path.startswith(("http://", "https://")):
        # The product CDN sometimes drops a connection: retry 4 times with back-off before failing the job.
        for attempt in range(5):
            try:
                resp = requests.get(url_or_path, timeout=60)
                resp.raise_for_status()
                return Image.open(io.BytesIO(resp.content)).convert("RGB")
            except (requests.ConnectionError, requests.Timeout) as exc:
                if attempt == 4:
                    raise RuntimeError(f"could not download the photo after 5 tries: {exc}") from exc
                time.sleep(2 ** attempt)
    return Image.open(url_or_path).convert("RGB")


JobKind = Literal["furniture3d", "room_understanding", "redesign", "warmup"]
JobStatus = Literal["pending", "running", "done", "failed"]


@dataclass
class Job:
    id: str
    kind: JobKind
    payload: dict
    status: JobStatus = "pending"
    progress: int = 0
    result: Optional[dict] = None
    error: Optional[str] = None
    created_at: float = field(default_factory=time.time)
    discard: bool = False  # set by JobStore.discard while the job is still running: delete its files when it ends
