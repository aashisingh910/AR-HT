"""The single sequential worker. One job runs at a time, full stop — that is the whole strategy
for fitting furniture-3d / room-understanding / redesign (each wanting 3-7GB of its own) on an
8GB card: never let two of them be loaded together. A FastAPI request thread only ever enqueues
and reads job state; the model code below runs exclusively on this one worker thread.
"""
import json
import queue
import threading
import traceback

from . import common
from .common import Job
from .stage1_furniture3d import run_furniture3d
from .stage2_room_understanding import run_room_understanding
from .stage3_redesign import run_redesign

HANDLERS = {
    "furniture3d": run_furniture3d,
    "room_understanding": run_room_understanding,
    "redesign": run_redesign,
}


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

    def save(self, job: Job) -> None:
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
        self._q: queue.Queue[str] = queue.Queue()
        self._thread = threading.Thread(target=self._worker, daemon=True, name="ml-job-worker")
        self._thread.start()

    def submit(self, job: Job) -> None:
        self.store.put(job)
        self._q.put(job.id)

    def _worker(self) -> None:
        while True:
            job_id = self._q.get()
            job = self.store.get(job_id)
            if job is None:
                continue
            job.status = "running"
            self.store.save(job)
            try:
                handler = HANDLERS[job.kind]
                job.result = handler(job, lambda pct: self._progress(job, pct))
                job.status = "done"
            except Exception as exc:  # a failed job must not take the worker thread down with it
                job.error = f"{exc}\n{traceback.format_exc(limit=8)}"
                job.status = "failed"
            finally:
                common.free_gpu()
                self.store.save(job)

    def _progress(self, job: Job, pct: int) -> None:
        job.progress = pct
        self.store.save(job)
