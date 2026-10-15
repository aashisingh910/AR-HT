"""The single-command, no-server demo: runs all three stages in-process, strictly one after
another (same ordering guarantee as the queue, just without HTTP), and prints where each
output landed. This is what `setup_and_run.ps1 -Demo` calls.

    python demo_run.py --furniture-url <photo> [--room-url <photo>] [--prompt "..."]
    python demo_run.py --mesh-model hunyuan3d-2mv --front <url> --left <url> --back <url>

Pass only --furniture-url to exercise stage 1 alone (TripoSR, the default); add --room-url to
also run stages 2 and 3 against a room photo (stage 3 reuses stage 2's room photo with --prompt
as the redesign ask). For stage 1 with Hunyuan3D-2mv instead of TripoSR, pass --mesh-model
hunyuan3d-2mv and at least --front (optionally --left/--back too — real photos of the SAME
product from different angles, not three photos of different products).
"""
import argparse
import json
import sys
import uuid

from pipeline import common
from pipeline.stage1_furniture3d import run_furniture3d
from pipeline.stage2_room_understanding import run_room_understanding
from pipeline.stage3_redesign import run_redesign


def _run(kind, handler, payload):
    job = common.Job(id=str(uuid.uuid4()), kind=kind, payload=payload)
    print(f"\n=== {kind} ({job.id}) ===")

    def progress(pct):
        print(f"  {pct:3d}%", end="\r")

    try:
        result = handler(job, progress)
    finally:
        common.free_gpu()
    print(f"  done.\n{json.dumps(result, indent=2)}")
    return result


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--furniture-url", help="a product photo (URL or local path) for stage 1 (TripoSR, single view)")
    ap.add_argument("--mesh-model", choices=["triposr", "hunyuan3d-2mv"], default="triposr", help="stage 1 backend")
    ap.add_argument("--front", help="front-view photo for --mesh-model hunyuan3d-2mv (required for that backend)")
    ap.add_argument("--left", help="left-view photo for --mesh-model hunyuan3d-2mv (optional)")
    ap.add_argument("--back", help="back-view photo for --mesh-model hunyuan3d-2mv (optional)")
    ap.add_argument("--product-id", help="optional catalogue id: also copies the GLB to models/raw/<id>.glb")
    ap.add_argument("--room-url", help="a room photo (URL or local path) for stages 2 and 3")
    ap.add_argument("--prompt", default=None, help="redesign instruction for stage 3 (needs --room-url)")
    ap.add_argument("--size", type=int, default=None, help="stage 3 resolution (default 768); raise it if your GPU has more headroom")
    ap.add_argument("--device", default=None, help="force stage 3 onto a device, e.g. --device cpu (slow, but sidesteps GPU CUDA errors)")
    args = ap.parse_args()

    if not args.furniture_url and not args.front and not args.room_url:
        ap.error("pass --furniture-url, or --front (for --mesh-model hunyuan3d-2mv), and/or --room-url")

    if args.mesh_model == "hunyuan3d-2mv":
        if not args.front:
            ap.error("--mesh-model hunyuan3d-2mv needs at least --front")
        image_urls = {"front": args.front}
        if args.left:
            image_urls["left"] = args.left
        if args.back:
            image_urls["back"] = args.back
        payload = {"mesh_model": "hunyuan3d-2mv", "image_urls": image_urls}
        if args.product_id:
            payload["product_id"] = args.product_id
        _run("furniture3d", run_furniture3d, payload)
    elif args.furniture_url:
        payload = {"image_url": args.furniture_url}
        if args.product_id:
            payload["product_id"] = args.product_id
        _run("furniture3d", run_furniture3d, payload)

    if args.room_url:
        _run("room_understanding", run_room_understanding, {"image_url": args.room_url})
        redesign_payload = {"image_url": args.room_url, "prompt": args.prompt}
        if args.size:
            redesign_payload["size"] = args.size
        if args.device:
            redesign_payload["device"] = args.device
        _run("redesign", run_redesign, redesign_payload)

    print(f"\nAll outputs are under {common.OUTPUT_DIR}")


if __name__ == "__main__":
    sys.exit(main())
