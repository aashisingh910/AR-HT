// Image-to-3D: turns a product photo into a GLB through an external service. Pure logic with an injected fetch, so it is tested without
// a network or a paid account. Provider API details follow Meshy's public docs (https://docs.meshy.ai) and have NOT been run against the
// live service from here: check the first model by hand, and adjust `meshy` below if the service has changed.

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Meshy "image to 3D": POST the photo URL, poll the task, get a GLB URL. */
export function meshy({ apiKey, fetchImpl = fetch, baseUrl = 'https://api.meshy.ai/openapi/v1' }) {
  const call = async (path, init = {}) => {
    const res = await fetchImpl(baseUrl + path, { ...init, headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', ...init.headers } });
    const text = await res.text();
    let body = null; try { body = text ? JSON.parse(text) : null; } catch { body = { message: text }; }
    if (!res.ok) { const e = new Error(`Meshy ${res.status}: ${body?.message ?? text}`); e.status = res.status; throw e; }
    return body;
  };
  return {
    name: 'meshy',
    /** @returns {Promise<string>} task id */
    async create(imageUrl) {
      const r = await call('/image-to-3d', { method: 'POST', body: JSON.stringify({ image_url: imageUrl, enable_pbr: true, should_remesh: true, should_texture: true, target_polycount: 30000, topology: 'triangle' }) });
      if (!r?.result) throw new Error('Meshy did not return a task id');
      return r.result;
    },
    /** @returns {Promise<{status:'pending'|'running'|'done'|'failed', glbUrl?:string, error?:string, progress?:number}>} */
    async status(taskId) {
      const r = await call(`/image-to-3d/${encodeURIComponent(taskId)}`);
      const map = { PENDING: 'pending', IN_PROGRESS: 'running', SUCCEEDED: 'done', FAILED: 'failed', CANCELED: 'failed' };
      const status = map[r.status] ?? 'running';
      return { status, progress: r.progress, glbUrl: r.model_urls?.glb, error: status === 'failed' ? (r.task_error?.message || r.status) : undefined };
    },
  };
}

/** Local GPU ml-service (server/ml-service/): same create/status shape as meshy, so this file's
 * polling/orientation/scaling logic is unchanged. Needs no API key — `setup_and_run.ps1` on a
 * machine with an NVIDIA GPU starts it on http://127.0.0.1:8077. */
export function local({ fetchImpl = fetch, baseUrl = 'http://127.0.0.1:8077' } = {}) {
  const call = async (path, init = {}) => {
    const res = await fetchImpl(baseUrl + path, { ...init, headers: { 'content-type': 'application/json', ...init.headers } });
    const text = await res.text();
    let body = null; try { body = text ? JSON.parse(text) : null; } catch { body = { message: text }; }
    if (!res.ok) { const e = new Error(`local ml-service ${res.status}: ${body?.message ?? text}`); e.status = res.status; throw e; }
    return body;
  };
  return {
    name: 'local',
    /** `meshModel`: 'triposr' (default, one photo, coloured) or 'hunyuan3d-2mv' (better shape, uncoloured; the photo is its front view).
     * @returns {Promise<string>} task id */
    async create(imageUrl, { meshModel = 'triposr' } = {}) {
      const body = meshModel === 'hunyuan3d-2mv' ? { mesh_model: meshModel, image_urls: { front: imageUrl } } : { image_url: imageUrl };
      const r = await call('/openapi/v1/image-to-3d', { method: 'POST', body: JSON.stringify(body) });
      if (!r?.result) throw new Error('local ml-service did not return a task id');
      return r.result;
    },
    /** `elapsedS` is GPU run time only (not time spent queued behind other jobs).
     * @returns {Promise<{status:'pending'|'running'|'done'|'failed', glbUrl?:string, error?:string, progress?:number, elapsedS?:number}>} */
    async status(taskId) {
      const r = await call(`/openapi/v1/image-to-3d/${encodeURIComponent(taskId)}`);
      const map = { PENDING: 'pending', IN_PROGRESS: 'running', SUCCEEDED: 'done', FAILED: 'failed' };
      const status = map[r.status] ?? 'running';
      return { status, progress: r.progress, glbUrl: r.model_urls?.glb, elapsedS: r.elapsed_s ?? undefined, error: status === 'failed' ? (r.task_error?.message || r.status) : undefined };
    },
  };
}

export const PROVIDERS = { meshy, local };

/** Waits for a task: polls every `pollMs` up to `timeoutMs`. Returns the GLB URL or throws with the provider's reason. */
export async function waitForModel(provider, taskId, { pollMs = 8000, timeoutMs = 15 * 60_000, wait = sleep, onProgress } = {}) {
  const start = Date.now();
  for (;;) {
    const s = await provider.status(taskId);
    onProgress?.(s);
    if (s.status === 'done') { if (!s.glbUrl) throw new Error('The service finished but gave no GLB link'); return s.glbUrl; }
    if (s.status === 'failed') throw new Error(`Generation failed: ${s.error ?? 'unknown reason'}`);
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for the model (the task id is saved: run again to resume)');
    await wait(pollMs);
  }
}

/** Recreates a stale local task after the service was restarted and lost in-memory state. */
export async function retryLocalTask({ provider, taskId, createTask, waitForTask, onRetry }) {
  let currentTaskId = taskId;
  for (;;) {
    try {
      return await waitForTask(currentTaskId);
    } catch (e) {
      if (e?.status !== 404 || provider.name !== 'local') throw e;
      const staleTaskId = currentTaskId;
      currentTaskId = await createTask();
      onRetry?.({ staleTaskId, newTaskId: currentTaskId });
    }
  }
}

/**
 * Which products to model first: the products used in the sample rooms (fastest visible win, most used first), then the other furniture
 * types taken in turn (one sofa, one bed, one wardrobe, ... then the next of each), so any "top N" covers every kind of room instead of
 * being all sofas (the catalogue has 225 sofas and 44 beds). Skips anything that already has a model, is under size review, or is a demo
 * item. Wall pieces are skipped (flat art does not need a model).
 */
export function pickProducts(catalogue, rooms, count, exclude = new Set()) {
  const inRooms = new Map();
  for (const r of rooms) for (const p of r.pieces) inRooms.set(p.productId, (inRooms.get(p.productId) ?? 0) + 1);
  const order = { sofa: 0, bed: 1, wardrobe: 2, 'dining-table': 3, 'tv-unit': 4, chair: 5, desk: 6, storage: 7, 'coffee-table': 8, 'side-table': 9 };
  const pool = catalogue.filter((p) => !p.model3D && !p.sizeReview && !p.demo && p.category !== 'Wall' && p.images?.[0] && !exclude.has(p.id));
  const roomPieces = pool.filter((p) => inRooms.has(p.id))
    .sort((a, b) => inRooms.get(b.id) - inRooms.get(a.id) || (order[a.role] ?? 99) - (order[b.role] ?? 99) || a.id.localeCompare(b.id));
  const byRole = new Map();
  for (const p of pool.filter((x) => !inRooms.has(x.id)).sort((a, b) => a.id.localeCompare(b.id))) {
    if (!byRole.has(p.role)) byRole.set(p.role, []);
    byRole.get(p.role).push(p);
  }
  const queues = [...byRole.entries()].sort(([a], [b]) => (order[a] ?? 99) - (order[b] ?? 99) || a.localeCompare(b)).map(([, q]) => q);
  const rest = [];
  for (let i = 0; queues.some((q) => i < q.length); i++) for (const q of queues) if (i < q.length) rest.push(q[i]);
  return [...roomPieces, ...rest].slice(0, count);
}

/** Best photo for 3D: the first (the studio shot). Shopify can resize on request: ask for 1024 px so the upload is small and fast. */
export const photoFor = (p) => {
  const u = p.images[0];
  return u.includes('cdn.shopify.com') ? u + (u.includes('?') ? '&' : '?') + 'width=1024' : u;
};
