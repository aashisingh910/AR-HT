"""Makes TripoSR work without a compiled CUDA extension.

TripoSR's mesh extraction calls `torchmcubes.marching_cubes`, a small package that compiles a
CUDA/C++ extension at install time. That build needs the CUDA toolkit + a matching MSVC/gcc
present, which this script cannot guarantee on "a different machine with the same configuration" —
driver-only CUDA installs (just `nvidia-smi`, no `nvcc`) are common and would otherwise hard-fail here.

Importing this module BEFORE `tsr.system` registers a pure-Python fallback (scikit-image's
marching_cubes) under the name `torchmcubes` in `sys.modules`, but only if the real compiled
package isn't already importable — if it is, that one is used as-is (faster).
"""
import sys
import types

try:
    import torchmcubes  # noqa: F401  — real compiled package already present, nothing to do
except Exception:
    import numpy as np
    import torch
    from skimage import measure

    def marching_cubes(vol, thresh):
        vol_np = vol.detach().cpu().numpy() if hasattr(vol, "detach") else np.asarray(vol)
        verts, faces, _normals, _values = measure.marching_cubes(vol_np, level=float(thresh))
        verts_t = torch.from_numpy(verts.copy()).float()
        faces_t = torch.from_numpy(faces.copy().astype(np.int64))
        return verts_t, faces_t

    shim = types.ModuleType("torchmcubes")
    shim.marching_cubes = marching_cubes
    sys.modules["torchmcubes"] = shim
