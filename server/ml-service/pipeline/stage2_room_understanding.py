"""Stage 2 — a room photo becomes depth + detected furniture/architecture + rough masks.

Depth Anything V2 gives relative depth (NOT metric: see the note in the result — a single
ordinary photo cannot give trustworthy real-world distances, only relative "nearer/farther").
Grounding DINO finds furniture and architectural elements by open-vocabulary text prompt;
SAM2 turns each detection box into a precise mask. This is deliberately read-only / advisory:
it feeds a future layout-planning step, it does not place anything itself.
"""
import json

import numpy as np
import torch
from PIL import Image

from . import common

LABELS = "sofa. chair. bed. table. wardrobe. cabinet. wall. window. door. floor. rug."
ARCHITECTURAL = {"wall", "window", "door", "floor"}


def _load_depth():
    from transformers import pipeline

    return pipeline(
        "depth-estimation",
        model="depth-anything/Depth-Anything-V2-Small-hf",
        device=0 if common.device() == "cuda" else -1,
    )


def _load_detector():
    from transformers import AutoModelForZeroShotObjectDetection, AutoProcessor

    processor = AutoProcessor.from_pretrained("IDEA-Research/grounding-dino-tiny")
    model = AutoModelForZeroShotObjectDetection.from_pretrained(
        "IDEA-Research/grounding-dino-tiny"
    ).to(common.device())
    model.eval()
    return model, processor


def _load_sam2():
    from transformers import Sam2Model, Sam2Processor

    model = Sam2Model.from_pretrained("facebook/sam2.1-hiera-small").to(common.device())
    model.eval()
    processor = Sam2Processor.from_pretrained("facebook/sam2.1-hiera-small")
    return model, processor


def _run_depth(image: Image.Image, job_id: str, progress) -> str:
    depther = _load_depth()
    try:
        depth = depther(image)["depth"]
    finally:
        del depther
        common.free_gpu()
    depth_arr = np.array(depth).astype(np.float32)
    span = max(depth_arr.max() - depth_arr.min(), 1e-6)
    depth_norm = (255 * (depth_arr - depth_arr.min()) / span).astype(np.uint8)
    depth_path = common.OUTPUT_DIR / f"{job_id}_depth.png"
    Image.fromarray(depth_norm).save(depth_path)
    progress(45)
    return f"/files/{job_id}_depth.png"


def _run_detection(image: Image.Image, w: int, h: int, progress):
    model, processor = _load_detector()
    try:
        inputs = processor(images=image, text=LABELS, return_tensors="pt").to(common.device())
        with torch.no_grad():
            outputs = model(**inputs)
        results = processor.post_process_grounded_object_detection(
            outputs,
            inputs["input_ids"],
            threshold=0.3,
            text_threshold=0.25,
            target_sizes=[(h, w)],
        )[0]
    finally:
        del model, processor
        common.free_gpu()
    progress(65)
    return results


def _run_masks(image: Image.Image, detections, progress):
    model, processor = _load_sam2()
    objects = []
    try:
        boxes = detections["boxes"].cpu().numpy().tolist()
        labels = detections["labels"]
        scores = detections["scores"].cpu().numpy().tolist()
        for box, label, score in zip(boxes, labels, scores):
            inputs = processor(
                images=image, input_boxes=[[box]], return_tensors="pt"
            ).to(common.device())
            with torch.no_grad():
                out = model(**inputs)
            # post_process_masks returns a list (one per image); masks[0] is (point_batch, num_candidate_masks, H, W)
            masks = processor.post_process_masks(out.pred_masks, inputs["original_sizes"])
            best = int(out.iou_scores[0, 0].argmax())
            mask = masks[0][0][best].cpu().numpy().astype(bool)
            ys, xs = np.where(mask)
            objects.append(
                {
                    "label": label.strip(". "),
                    "score": float(score),
                    "box_xyxy": [float(v) for v in box],
                    "mask_bbox_px": (
                        [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())]
                        if len(xs)
                        else None
                    ),
                    "mask_area_px": int(mask.sum()),
                }
            )
    finally:
        del model, processor
        common.free_gpu()
    progress(90)
    return objects


def run_room_understanding(job, progress) -> dict:
    payload = job.payload
    image = common.download_image(payload["image_url"])
    w, h = image.size
    progress(5)

    depth_png = _run_depth(image, job.id, progress)
    detections = _run_detection(image, w, h, progress)
    objects = _run_masks(image, detections, progress)

    furniture_bottoms = [o["box_xyxy"][3] for o in objects if o["label"] not in ARCHITECTURAL]
    floor_boxes = [o["box_xyxy"] for o in objects if o["label"] == "floor"]
    floor_hint_y = min([b[1] for b in floor_boxes], default=max(furniture_bottoms, default=h * 0.55))

    result = {
        "image_size": {"w": w, "h": h},
        "depth_png": depth_png,
        "objects": objects,
        "floor_hint_y_px": float(floor_hint_y),
        "note": (
            "Depth is relative, not metric, and the floor line is a heuristic from detected "
            "boxes — both are advisory only. For anything placement-critical, use the catalogue's "
            "measured dimensions and a device room scan (src/ar), not this single-photo estimate."
        ),
    }
    result_path = common.OUTPUT_DIR / f"{job.id}.json"
    result_path.write_text(json.dumps(result, indent=2))
    progress(100)
    return {"result_url": f"/files/{job.id}.json", **result}
