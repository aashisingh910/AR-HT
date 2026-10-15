"""Cheap sanity check: imports every model class this project's code calls by name, and checks
CUDA, WITHOUT downloading any weights. Run this right after setup, before a real (slow, multi-GB)
job — if a library's API has drifted since this was written, this is where it is caught fast.

    python selftest.py
"""
import sys


def check(label, fn):
    try:
        fn()
        print(f"OK    {label}")
        return True
    except Exception as exc:
        print(f"FAIL  {label}: {exc}")
        return False


def main():
    ok = True

    import torch

    print(f"torch {torch.__version__}  cuda available: {torch.cuda.is_available()}")
    if torch.cuda.is_available():
        print(f"  device: {torch.cuda.get_device_name(0)}")
        free, total = torch.cuda.mem_get_info()
        print(f"  free VRAM: {free / 1e9:.2f} GB / {total / 1e9:.2f} GB total")
    else:
        ok = False
        print("  WARNING: no CUDA device visible — every stage will fall back to CPU and be very slow.")

    ok &= check("transformers Sam2Model/Sam2Processor", lambda: __import__("transformers", fromlist=["Sam2Model", "Sam2Processor"]))
    ok &= check(
        "transformers Grounding DINO classes",
        lambda: __import__(
            "transformers", fromlist=["AutoModelForZeroShotObjectDetection", "AutoProcessor"]
        ),
    )
    ok &= check("transformers depth-estimation pipeline", lambda: __import__("transformers", fromlist=["pipeline"]))
    ok &= check(
        "diffusers SDXL + ControlNet classes",
        lambda: __import__(
            "diffusers",
            fromlist=["StableDiffusionXLControlNetPipeline", "ControlNetModel", "UniPCMultistepScheduler"],
        ),
    )
    ok &= check("trimesh", lambda: __import__("trimesh"))

    from pipeline import common

    vendor_tsr = common.VENDOR_DIR / "TripoSR" / "tsr"
    if vendor_tsr.exists():
        ok &= check("vendor/TripoSR present", lambda: None)
        sys.path.insert(0, str(common.VENDOR_DIR / "TripoSR"))

        def _import_tsr_with_shim():
            from pipeline import torchmcubes_shim  # noqa: F401 — must run before tsr.system is imported

            __import__("tsr.system", fromlist=["TSR"])

        ok &= check("torchmcubes shim + tsr.system import", _import_tsr_with_shim)
    else:
        ok = False
        print(f"FAIL  vendor/TripoSR not found at {vendor_tsr} — run setup_and_run.ps1 first")

    vendor_hy3dgen = common.VENDOR_DIR / "Hunyuan3D-2" / "hy3dgen"
    if vendor_hy3dgen.exists():
        ok &= check("vendor/Hunyuan3D-2 present", lambda: None)
        sys.path.insert(0, str(common.VENDOR_DIR / "Hunyuan3D-2"))
        ok &= check(
            "hy3dgen.shapegen.Hunyuan3DDiTFlowMatchingPipeline import",
            lambda: __import__("hy3dgen.shapegen", fromlist=["Hunyuan3DDiTFlowMatchingPipeline"]),
        )
    else:
        print(f"skip  vendor/Hunyuan3D-2 not set up (optional — run setup_and_run.ps1 -WithHunyuan3D to add it)")

    print("\nAll checks passed." if ok else "\nSome checks failed — fix those before running a real job.")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
