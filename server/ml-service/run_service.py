"""The ml-service: a small FastAPI app over the one-job-at-a-time queue in pipeline/queue_worker.py.

    python run_service.py                      # serve on http://127.0.0.1:8077

The image-to-3D endpoints intentionally mirror Meshy's shape (POST -> {result: task_id},
GET -> {status, model_urls:{glb}}) so scripts/lib/image3d.mjs's `local` provider is a thin
wrapper, not a rewrite — see that file for the Node side of this integration.
"""
import uuid

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from pipeline import common
from pipeline.common import Job
from pipeline.queue_worker import JobQueue, JobStore

app = FastAPI(title="HomeTown AR ml-service")


@app.get("/health")
def health():
    return {"status": "ok"}


store = JobStore()
job_queue = JobQueue(store)

STATUS_TO_MESHY = {"pending": "PENDING", "running": "IN_PROGRESS", "done": "SUCCEEDED", "failed": "FAILED"}


def _require_job(task_id: str) -> Job:
    job = store.get(task_id)
    if job is None:
        raise HTTPException(404, "unknown task id")
    return job


class ImageToThreeDRequest(BaseModel):
    image_url: str | None = None  # required unless mesh_model is "hunyuan3d-2mv" (use image_urls instead)
    image_urls: dict[str, str] | None = None  # {"front": ..., "left": ..., "back": ...} — hunyuan3d-2mv only
    mesh_model: str | None = None  # "triposr" (default) or "hunyuan3d-2mv" (needs setup_and_run.ps1 -WithHunyuan3D)
    product_id: str | None = None  # if set, the normalised GLB is also copied to models/raw/<product_id>.glb


@app.post("/openapi/v1/image-to-3d")
def create_image_to_3d(req: ImageToThreeDRequest):
    job = Job(id=str(uuid.uuid4()), kind="furniture3d", payload=req.model_dump(exclude_none=True))
    job_queue.submit(job)
    return {"result": job.id}


@app.get("/openapi/v1/image-to-3d/{task_id}")
def get_image_to_3d(task_id: str):
    job = _require_job(task_id)
    body = {"status": STATUS_TO_MESHY[job.status], "progress": job.progress}
    if job.status == "done":
        body["model_urls"] = {"glb": f"http://127.0.0.1:8077{job.result['glb_url']}"}
    if job.status == "failed":
        body["task_error"] = {"message": job.error}
    return body


class RoomUnderstandingRequest(BaseModel):
    image_url: str


@app.post("/v1/room-understanding")
def create_room_understanding(req: RoomUnderstandingRequest):
    job = Job(id=str(uuid.uuid4()), kind="room_understanding", payload=req.model_dump())
    job_queue.submit(job)
    return {"result": job.id}


class RedesignRequest(BaseModel):
    image_url: str
    prompt: str | None = None
    negative_prompt: str | None = None
    steps: int | None = None
    seed: int | None = None
    conditioning_scale: float | None = None
    size: int | None = None  # SDXL resolution (default 768); raise it if your GPU has more headroom than this dev machine's
    device: str | None = None  # "cpu" to force CPU execution (slow, but sidesteps this GPU's CUDA corruption)


@app.post("/v1/redesign")
def create_redesign(req: RedesignRequest):
    job = Job(id=str(uuid.uuid4()), kind="redesign", payload=req.model_dump(exclude_none=True))
    job_queue.submit(job)
    return {"result": job.id}


@app.get("/v1/jobs/{task_id}")
def get_job(task_id: str):
    job = _require_job(task_id)
    return {
        "id": job.id,
        "kind": job.kind,
        "status": job.status,
        "progress": job.progress,
        "result": job.result,
        "error": job.error,
    }


@app.get("/files/{filename}")
def get_file(filename: str):
    path = common.OUTPUT_DIR / filename
    if not path.exists():
        raise HTTPException(404, "not found")
    return FileResponse(path)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8077)
