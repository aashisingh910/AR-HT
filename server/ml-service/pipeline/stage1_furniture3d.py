"""Stage 1 — a product photo becomes a raw GLB mesh.

SAM2 cuts the product out from its background; a mesh-reconstruction model turns that into 3D;
trimesh keeps only the largest connected shell and fixes normals. The output is written straight
to this project's existing `models/raw/<product-id>.glb` convention — scale-to-catalogue-size,
orientation-fixing and triangle/texture budgets are already handled by the Node pipeline
(scripts/publish-models.mjs / scripts/image-to-3d.mjs --normalise), so this stage does not
duplicate that logic. It only needs to produce a plausible, upright-ish, roughly-oriented mesh.

Two interchangeable reconstruction backends, picked via `payload["mesh_model"]`:
- **"triposr"** (default) — single photo in, one mesh out. Verified working end to end on real
  catalogue photos on this project's dev GPU (see ML-PIPELINE.md at the repo root).
- **"hunyuan3d-2mv"** — Tencent's multiview model: needs 2-3 photos of the SAME product from
  different angles (`payload["image_urls"]`, a dict with at least a "front" key, optionally
  "left"/"back") and generally produces a more complete mesh (less invented geometry on the
  back/sides) when given real, distinct angles. Needs `vendor/Hunyuan3D-2` set up (opt-in:
  `setup_and_run.ps1 -WithHunyuan3D`, not part of the default setup — it needs ~6GB VRAM for
  shape generation alone, licensed under tencent-hunyuan-community (read that license before
  any production use), and has NOT been run end to end on real hardware from this project:
  see ML-PIPELINE.md for why (this dev machine's 8GB card had no headroom left to test it).
"""
import numpy as np
import torch
from PIL import Image

from . import common


def _load_sam2():
    from transformers import Sam2Model, Sam2Processor

    model = Sam2Model.from_pretrained("facebook/sam2.1-hiera-small").to(common.device())
    model.eval()
    processor = Sam2Processor.from_pretrained("facebook/sam2.1-hiera-small")
    return model, processor


def _segment_subject(image: Image.Image, progress) -> Image.Image:
    """Catalogue photos are a product on a plain background: a single point prompt at the
    image centre is enough for SAM2 to pick out the product without manual boxes."""
    model, processor = _load_sam2()
    try:
        w, h = image.size
        inputs = processor(
            images=image,
            input_points=[[[[w / 2, h / 2]]]],  # [image, object, point, (x, y)]
            return_tensors="pt",
        ).to(common.device())
        with torch.no_grad():
            outputs = model(**inputs)
        # post_process_masks returns a list (one per image); masks[0] is (point_batch, num_candidate_masks, H, W).
        # iou_scores (batch, point_batch, num_candidate_masks) picks the best of those candidates for our one point.
        masks = processor.post_process_masks(outputs.pred_masks, inputs["original_sizes"])
        scores = outputs.iou_scores[0, 0]
        best_mask = masks[0][0][int(scores.argmax())].cpu().numpy().astype(bool)
        rgb = np.array(image)
        alpha = (best_mask * 255).astype(np.uint8)
        return Image.fromarray(np.dstack([rgb, alpha]), mode="RGBA")
    finally:
        del model, processor
        common.free_gpu()
        progress(30)


def _tsr_module():
    """Imports TripoSR from vendor/TripoSR (cloned by setup_and_run.ps1 — see that script and
    README.md if this import fails: it means the clone step hasn't been run yet)."""
    import sys

    vendor_path = str(common.VENDOR_DIR / "TripoSR")
    if vendor_path not in sys.path:
        sys.path.insert(0, vendor_path)
    from . import torchmcubes_shim  # noqa: F401 — must run before `tsr.system` is imported

    from tsr.system import TSR  # type: ignore

    return TSR


def _remap_image_tokenizer_checkpoint(state_dict: dict) -> dict:
    """TripoSR's published `model.ckpt` was saved against an older `transformers` ViTModel
    parameter layout (`encoder.layer.N.attention.attention.query/key/value`,
    `attention.output.dense`, `intermediate.dense`, `layer.N.output.dense`). The transformers
    version this project needs for SAM2 + Grounding DINO renamed ViTModel's internals to
    `layers.N.attention.q_proj/k_proj/v_proj/o_proj` + `mlp.fc1/fc2`. Only `image_tokenizer.model.*`
    keys are affected (confirmed by running the real load and reading its exact missing/unexpected
    key lists) — everything else in the checkpoint (TripoSR's own backbone/decoder/renderer) is
    architecture `transformers` never touched, so it's passed through unchanged.
    """
    renamed = {}
    for key, value in state_dict.items():
        if "image_tokenizer.model." not in key:
            renamed[key] = value
            continue
        new_key = key
        new_key = new_key.replace("attention.attention.query", "attention.q_proj")
        new_key = new_key.replace("attention.attention.key", "attention.k_proj")
        new_key = new_key.replace("attention.attention.value", "attention.v_proj")
        new_key = new_key.replace("attention.output.dense", "attention.o_proj")  # must run before the generic output.dense rename below
        new_key = new_key.replace("intermediate.dense", "mlp.fc1")
        new_key = new_key.replace("output.dense", "mlp.fc2")  # only the FFN's second linear remains at this point
        new_key = new_key.replace("encoder.layer.", "layers.")
        renamed[new_key] = value
    return renamed


def _load_tsr():
    import os

    from huggingface_hub import hf_hub_download
    from omegaconf import OmegaConf

    TSR = _tsr_module()
    repo_id = "stabilityai/TripoSR"
    if os.path.isdir(repo_id):
        config_path = os.path.join(repo_id, "config.yaml")
        weight_path = os.path.join(repo_id, "model.ckpt")
    else:
        config_path = hf_hub_download(repo_id=repo_id, filename="config.yaml")
        weight_path = hf_hub_download(repo_id=repo_id, filename="model.ckpt")

    cfg = OmegaConf.load(config_path)
    OmegaConf.resolve(cfg)
    model = TSR(cfg)
    ckpt = torch.load(weight_path, map_location="cpu")
    model.load_state_dict(_remap_image_tokenizer_checkpoint(ckpt))
    model.renderer.set_chunk_size(8192)
    model.to(common.device())
    return model


def _reconstruct_mesh(cutout: Image.Image, progress):
    model = _load_tsr()  # must run first: this is what puts vendor/TripoSR on sys.path
    try:
        from tsr.utils import resize_foreground  # type: ignore

        fg = resize_foreground(cutout, 0.85)
        arr = np.array(fg).astype(np.float32) / 255.0
        if arr.shape[-1] == 4:  # composite the RGBA cutout onto neutral grey, as TSR expects RGB
            arr = arr[:, :, :3] * arr[:, :, 3:4] + (1 - arr[:, :, 3:4]) * 0.5
        rgb_image = Image.fromarray((arr * 255).astype(np.uint8))
        with torch.no_grad():
            scene_codes = model([rgb_image], device=common.device())
        progress(70)
        meshes = model.extract_mesh(scene_codes, has_vertex_color=True, resolution=256)
        return meshes[0]
    finally:
        del model
        common.free_gpu()


def _hy3dgen_shapegen_module():
    """Imports Hunyuan3D-2's shape generator from vendor/Hunyuan3D-2 (cloned + `pip install -e .`
    by `setup_and_run.ps1 -WithHunyuan3D` — not part of the default setup).

    Only `hy3dgen.shapegen` (the mesh/shape model) is used. Texture *painting* is deliberately
    left out: it needs two custom CUDA extensions (`custom_rasterizer`, `differentiable_renderer`)
    built with raw `setup.py install`, which is exactly the kind of machine-specific native build
    this project avoids elsewhere (see torchmcubes_shim.py for the same call on TripoSR). The
    mesh comes back without baked textures; `_clean_mesh` and the Node normalise step downstream
    don't require them (TripoSR's output is vertex-coloured, not textured, either)."""
    import sys

    vendor_path = str(common.VENDOR_DIR / "Hunyuan3D-2")
    if vendor_path not in sys.path:
        sys.path.insert(0, vendor_path)
    from hy3dgen.shapegen import Hunyuan3DDiTFlowMatchingPipeline  # type: ignore

    return Hunyuan3DDiTFlowMatchingPipeline


def _remap_dinov2_conditioner_checkpoint(state_dict: dict) -> dict:
    """Same problem as `_remap_image_tokenizer_checkpoint`, for Hunyuan3D-2mv's DINOv2 image
    encoder: the published weights use the older `transformers` Dinov2 layout
    (`attention.attention.query/key/value`, `attention.output.dense`, SwiGLU `mlp.weights_in/out`),
    the installed version uses `attention.q_proj/k_proj/v_proj/o_proj` and
    `mlp.gate_proj/up_proj/down_proj` (confirmed from the real load's missing/unexpected key lists).
    The old SwiGLU computed `silu(x1) * x2` from `weights_in(x).chunk(2)`; the new one computes
    `silu(gate_proj(x)) * up_proj(x)`, so the first half of `weights_in` is `gate_proj`, the second `up_proj`.
    """
    renamed = {}
    for key, value in state_dict.items():
        if "main_image_encoder.model.encoder.layer." not in key:
            renamed[key] = value
            continue
        if ".mlp.weights_in." in key:
            gate, up = value.chunk(2, dim=0)
            renamed[key.replace(".mlp.weights_in.", ".mlp.gate_proj.")] = gate.contiguous()
            renamed[key.replace(".mlp.weights_in.", ".mlp.up_proj.")] = up.contiguous()
            continue
        new_key = key.replace("attention.attention.query", "attention.q_proj")
        new_key = new_key.replace("attention.attention.key", "attention.k_proj")
        new_key = new_key.replace("attention.attention.value", "attention.v_proj")
        new_key = new_key.replace("attention.output.dense", "attention.o_proj")
        new_key = new_key.replace(".mlp.weights_out.", ".mlp.down_proj.")
        renamed[new_key] = value
    return renamed


def _load_hunyuan3d_mv():
    import safetensors.torch

    Pipeline = _hy3dgen_shapegen_module()
    # hy3dgen reads the checkpoint with safetensors.torch.load_file inside from_pretrained; remap the
    # encoder keys on the way through rather than patching the vendored source.
    original_load = safetensors.torch.load_file
    safetensors.torch.load_file = lambda *a, **kw: _remap_dinov2_conditioner_checkpoint(original_load(*a, **kw))
    try:
        return Pipeline.from_pretrained(
            "tencent/Hunyuan3D-2mv",
            subfolder="hunyuan3d-dit-v2-mv",
            use_safetensors=True,
            device=common.device(),
        )
    finally:
        safetensors.torch.load_file = original_load


def _reconstruct_mesh_hunyuan3d_mv(views: dict[str, Image.Image], progress):
    """`views` is a dict of up to {"front", "left", "back"} -> SAM2-segmented RGBA cutouts.
    "front" is required; Hunyuan3D-2mv is a *multiview* model, so passing only one view runs but
    gives up its main advantage over single-view TripoSR (see the module docstring)."""
    if "front" not in views:
        raise ValueError('hunyuan3d-2mv needs at least a "front" view in payload["image_urls"]')
    pipeline = _load_hunyuan3d_mv()
    try:
        with torch.no_grad():
            result = pipeline(
                image=views,
                num_inference_steps=30,
                octree_resolution=380,
                num_chunks=20000,
                generator=torch.manual_seed(0),
                output_type="trimesh",
            )
        progress(70)
        return result[0]
    finally:
        del pipeline
        common.free_gpu()


def _clean_mesh(mesh):
    import trimesh

    if isinstance(mesh, trimesh.Scene):
        mesh = mesh.dump(concatenate=True)
    parts = mesh.split(only_watertight=False)
    if parts:
        mesh = max(parts, key=lambda m: m.area)  # drop floating fragments, keep the main body
    mesh.remove_unreferenced_vertices()
    mesh.fix_normals()
    return mesh


def run_furniture3d(job, progress) -> dict:
    payload = job.payload
    mesh_model = payload.get("mesh_model", "triposr")

    if mesh_model == "hunyuan3d-2mv":
        image_urls: dict[str, str] = payload.get("image_urls") or {}
        if "front" not in image_urls:
            raise ValueError('mesh_model "hunyuan3d-2mv" needs payload["image_urls"] with at least a "front" key')
        progress(5)
        views = {}
        for role, url in image_urls.items():  # up to {"front", "left", "back"}
            views[role] = _segment_subject(common.download_image(url), progress)
        progress(35)
        mesh = _reconstruct_mesh_hunyuan3d_mv(views, progress)
    else:
        image = common.download_image(payload["image_url"])
        progress(10)
        cutout = _segment_subject(image, progress)
        progress(35)
        mesh = _reconstruct_mesh(cutout, progress)

    progress(75)
    mesh = _clean_mesh(mesh)
    progress(90)

    out_path = common.OUTPUT_DIR / f"{job.id}.glb"
    mesh.export(out_path.as_posix(), file_type="glb")

    product_id = payload.get("product_id")
    raw_path = None
    if product_id:
        raw_dir = common.ROOT.parent.parent / "models" / "raw"
        raw_dir.mkdir(parents=True, exist_ok=True)
        raw_path = raw_dir / f"{product_id}.glb"
        raw_path.write_bytes(out_path.read_bytes())

    progress(100)
    return {
        "glb_path": str(out_path),
        "glb_url": f"/files/{job.id}.glb",
        "raw_model_path": str(raw_path) if raw_path else None,
        "note": "Unoriented/unscaled mesh. Run `node scripts/image-to-3d.mjs --normalise` "
        "(from the project root) to orient, scale to the catalogue size and check it.",
    }
