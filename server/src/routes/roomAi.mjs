import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { roomAiInput } from '../schemas.mjs';
import { err } from '../lib/http.mjs';

const TTL_MS = 60 * 60 * 1000; // a job (and anything left of it) is forgotten after an hour
const isJpeg = (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
const isPng = (b) => b.length > 8 && b.readUInt32BE(0) === 0x89504e47;

// What the ml-service returns for a job (server/ml-service/run_service.py GET /v1/jobs/{id}). Anything else is treated as a failure.
const mlJob = z.object({
  status: z.enum(['pending', 'running', 'done', 'failed']),
  progress: z.number().default(0),
  result: z.object({
    image_size: z.object({ w: z.number(), h: z.number() }).optional(),
    objects: z.array(z.object({ label: z.string(), score: z.number(), box_xyxy: z.array(z.number()).length(4) })).optional(),
    floor_hint_y_px: z.number().optional(),
    image_url: z.string().optional(),
  }).nullable().optional(),
});

/**
 * Room AI (architecture stages 3 + 4): a room photo the user chose to send -> the GPU ml-service -> detected furniture (understand) or a
 * restyled picture (redesign). This is the one place a room photo leaves the phone, so: signed-in users only, explicit consent on every
 * request, JPEG/PNG only, per-user limits, owner-only reads, and the photo is deleted as soon as the ml-service has read it (or after an hour).
 * Jobs live in memory, like the layout limits: fine for one server process next to one GPU.
 */
export function roomAiRouter({ auth, mlServiceUrl, roomAiDir, roomAiLimits, fetchImpl }) {
  const r = Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1 } });
  const jobs = new Map(); // id -> { userId, kind, mlId, photo, createdAt }
  const hits = new Map(); // userId -> request timestamps

  const ml = async (p, init) => {
    const res = await fetchImpl(mlServiceUrl.replace(/\/$/, '') + p, init);
    if (!res.ok) throw Object.assign(new Error(`ml-service ${res.status}`), { status: res.status });
    return res;
  };
  const dropPhoto = (job) => { if (job.photo) { fs.rm(job.photo, { force: true }, () => {}); job.photo = null; } };
  const forget = (id) => {
    const job = jobs.get(id); if (!job) return;
    dropPhoto(job); jobs.delete(id);
    ml(`/v1/jobs/${encodeURIComponent(job.mlId)}`, { method: 'DELETE' }).catch(() => {}); // removes its outputs too; best effort
  };
  const sweep = () => { const now = Date.now(); for (const [id, j] of jobs) if (now - j.createdAt > TTL_MS) forget(id); };
  // Don't rely on the app polling: every 30 s, delete photos the ml-service has finished with, and forget jobs older than an hour.
  const tidy = async () => {
    sweep();
    for (const job of jobs.values()) {
      if (!job.photo) continue;
      try {
        const s = await (await ml(`/v1/jobs/${encodeURIComponent(job.mlId)}`)).json();
        if (s.status === 'done' || s.status === 'failed') dropPhoto(job);
      } catch { /* ml-service down: the hourly sweep still removes it */ }
    }
  };
  if (mlServiceUrl) setInterval(() => { tidy().catch(() => {}); }, 30_000).unref();

  const own = (req) => {
    sweep();
    const job = jobs.get(req.params.id);
    if (!job || job.userId !== req.user.id) throw err(404, 'Not found');
    return job;
  };
  const configured = (_req, _res, next) => { if (!mlServiceUrl) throw err(503, 'Room AI is not configured on this server'); next(); };
  // Only photos the ml-service accepted count towards the limits; a refused upload (no consent, wrong type) does not use one up.
  const recentHits = (userId) => { const now = Date.now(); return (hits.get(userId) ?? []).filter((t) => now - t < 86_400_000); };
  const limit = (req, _res, next) => {
    const recent = recentHits(req.user.id);
    if (recent.length >= roomAiLimits.perDay) throw err(429, 'You have used today\'s room redesigns. Try again tomorrow.');
    if (recent.filter((t) => Date.now() - t < 60_000).length >= roomAiLimits.perMinute) throw err(429, 'Too many photos in a row. Wait a minute and try again.');
    next();
  };

  r.post('/jobs', auth, configured, limit, upload.single('photo'), async (req, res) => {
    const { kind, prompt } = roomAiInput.parse(req.body ?? {});
    const buf = req.file?.buffer;
    if (!buf?.length) throw err(400, 'Send the room photo in the "photo" field');
    if (!isJpeg(buf) && !isPng(buf)) throw err(415, 'The photo must be a JPEG or PNG');
    sweep();
    fs.mkdirSync(roomAiDir, { recursive: true });
    const id = randomUUID();
    const photo = path.join(roomAiDir, `${id}.${isPng(buf) ? 'png' : 'jpg'}`);
    fs.writeFileSync(photo, buf);
    // The ml-service runs on the same machine and reads the photo from disk (common.download_image accepts a path).
    const body = kind === 'understand' ? { image_url: photo } : { image_url: photo, ...(prompt && { prompt }) };
    let mlId;
    try {
      const out = await (await ml(kind === 'understand' ? '/v1/room-understanding' : '/v1/redesign', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
      mlId = z.object({ result: z.string().min(1) }).parse(out).result;
    } catch {
      fs.rmSync(photo, { force: true });
      throw err(502, 'The room AI service is unavailable. Try again later.');
    }
    jobs.set(id, { userId: req.user.id, kind, mlId, photo, createdAt: Date.now() });
    hits.set(req.user.id, [...recentHits(req.user.id), Date.now()]);
    res.status(202).json({ id, kind, status: 'pending', progress: 0 });
  });

  r.get('/jobs/:id', auth, configured, async (req, res) => {
    const job = own(req);
    let s;
    try { s = mlJob.parse(await (await ml(`/v1/jobs/${encodeURIComponent(job.mlId)}`)).json()); }
    catch (e) {
      if (e.status === 404) { forget(req.params.id); throw err(410, 'This redesign was lost (the AI service restarted). Send the photo again.'); }
      throw err(502, 'The room AI service is unavailable. Try again later.');
    }
    if (s.status === 'done' || s.status === 'failed') dropPhoto(job); // the ml-service has read it: the photo is no longer needed
    const out = { id: req.params.id, kind: job.kind, status: s.status, progress: s.status === 'done' ? 100 : Math.max(0, Math.min(99, Math.round(s.progress))) };
    if (s.status === 'failed') return res.json({ ...out, error: 'The AI could not process this photo. Try a brighter photo of the whole room.' });
    if (s.status !== 'done') return res.json(out);
    if (job.kind === 'understand') {
      const objects = (s.result?.objects ?? []).map((o) => ({ label: o.label.slice(0, 40), score: Math.round(o.score * 100) / 100, box: o.box_xyxy.map((v) => Math.round(v)) }));
      return res.json({ ...out, imageSize: s.result?.image_size ?? null, floorHintY: s.result?.floor_hint_y_px ?? null, objects });
    }
    res.json({ ...out, imageReady: !!s.result?.image_url });
  });

  r.get('/jobs/:id/image', auth, configured, async (req, res) => {
    const job = own(req);
    if (job.kind !== 'redesign') throw err(404, 'Not found');
    let png;
    try { png = Buffer.from(await (await ml(`/files/${encodeURIComponent(job.mlId)}.png`)).arrayBuffer()); }
    catch { throw err(404, 'The picture is not ready yet'); }
    res.set({ 'content-type': 'image/png', 'cache-control': 'private, no-store' }).send(png);
  });

  r.delete('/jobs/:id', auth, (req, res) => {
    own(req);
    forget(req.params.id);
    res.status(204).end();
  });

  return r;
}
