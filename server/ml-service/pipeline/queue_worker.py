"""The single sequential worker. One job runs at a time, full stop — that is the whole strategy
for fitting furniture-3d / room-understanding / redesign (each wanting 3-7GB of its own) on an
8GB card: never let two of them be loaded together. A FastAPI request thread only ever enqueues
and reads job state; the model code below runs exclusively on this one worker thread.
"""
import json
import queue
import threading
import time
import traceback

from . import common
from .common import Job
from . import stage2_room_understanding, stage3_redesign
from .stage1_furniture3d import run_furniture3d
from .stage2_room_understanding import run_room_understanding
from .stage3_redesign import run_redesign


def run_warmup(job, progress) -> dict:
    """Loads the room-AI models into RAM so the first user request does not wait for ~7 GB to be read from disk."""
    stage2_room_understanding.warm_up()
    progress(50)
    stage3_redesign.warm_up()
    return {}


HANDLERS = {
    "furniture3d": run_furniture3d,
    "room_understanding": run_room_understanding,
    "redesign": run_redesign,
    "warmup": run_warmup,
}
# Lower runs first. A person is waiting on room jobs; catalogue models are a background batch, so they wait their turn.
PRIORITY = {"warmup": 0, "room_understanding": 1, "redesign": 1, "furniture3d": 5}


class JobStore:
    def __init__(self):
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()

    def put(self, job: Job) -> None:
        with self._lock:
            self._jobs[job.id] = job
        self.save(job)

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            return self._jobs.get(job_id)

    def discard(self, job_id: str) -> bool:
        """Forget a job and delete its files (jobs/<id>.json, outputs/<id>*). Room photos are private: the main API server
        calls this as soon as the user is done. A job that is still queued or running is only marked, and removed when it ends."""
        job = self.get(job_id)
        if job is None:
            return False
        if job.status in ("pending", "running"):
            job.discard = True
            return True
        with self._lock:
            self._jobs.pop(job_id, None)
        (common.JOBS_DIR / f"{job_id}.json").unlink(missing_ok=True)
        for f in common.OUTPUT_DIR.glob(f"{job_id}*"):
            f.unlink(missing_ok=True)
        return True

    def save(self, job: Job) -> None:
        if job.discard and job.status in ("done", "failed"):
            return
        """Every status change is written to jobs/<id>.json — the point of 'save the output':
        a job's progress and result survive a service restart and are inspectable from outside."""
        path = common.JOBS_DIR / f"{job.id}.json"
        path.write_text(
            json.dumps(
                {
                    "id": job.id,
                    "kind": job.kind,
                    "status": job.status,
                    "progress": job.progress,
                    "payload": job.payload,
                    "result": job.result,
                    "error": job.error,
                },
                indent=2,
            )
        )


class JobQueue:
    def __init__(self, store: JobStore):
        self.store = store
        self._q: queue.PriorityQueue[tuple[int, int, str]] = queue.PriorityQueue()
        self._seq = 0  # first-come first-served within one priority
        self._seq_lock = threading.Lock()
        self._thread = threading.Thread(target=self._worker, daemon=True, name="ml-job-worker")
        self._thread.start()

    def submit(self, job: Job) -> None:
        self.store.put(job)
        with self._seq_lock:
            self._seq += 1
            seq = self._seq
        self._q.put((PRIORITY.get(job.kind, 5), seq, job.id))

    def _worker(self) -> None:
        while True:
            _, _, job_id = self._q.get()
            job = self.store.get(job_id)
            if job is None:
                continue
            job.status = "running"
            self.store.save(job)
            started = time.monotonic()
            try:
                handler = HANDLERS[job.kind]
                job.result = handler(job, lambda pct: self._progress(job, pct))
                job.result["elapsed_s"] = round(time.monotonic() - started, 1)  # run time only, not time spent queued (benchmarks use this)
                job.status = "done"
            except Exception as exc:  # a failed job must not take the worker thread down with it
                job.error = f"{exc}\n{traceback.format_exc(limit=8)}"
                job.status = "failed"
            finally:
                common.free_gpu()
                self.store.save(job)
                if job.discard:
                    self.store.discard(job.id)

    def _progress(self, job: Job, pct: int) -> None:
        job.progress = pct
        self.store.save(job)
