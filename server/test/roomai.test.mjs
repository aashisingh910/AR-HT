import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.mjs';
import { createApp } from '../src/app.mjs';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]);

// A fake ml-service: records calls, answers like server/ml-service/run_service.py.
function fakeMl() {
  const calls = [];
  const state = { status: 'running', progress: 40, down: false, lost: false };
  const reply = (status, body, bin) => ({ ok: status < 400, status, json: async () => body, arrayBuffer: async () => bin ?? new ArrayBuffer(0) });
  const fetchImpl = async (url, init = {}) => {
    const p = url.replace('http://ml.test', ''); calls.push(`${init.method ?? 'GET'} ${p}`);
    if (state.down) throw new Error('ECONNREFUSED');
    if (init.method === 'POST') { calls.body = JSON.parse(init.body); return reply(200, { result: 'ml-1' }); }
    if (init.method === 'DELETE') return reply(204, {});
    if (p.startsWith('/files/')) return reply(200, {}, PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.length));
    if (state.lost) return reply(404, { detail: 'unknown task id' });
    const result = state.status !== 'done' ? null : { image_size: { w: 1024, h: 768 }, floor_hint_y_px: 500.4, image_url: '/files/ml-1.png', objects: [{ label: 'sofa', score: 0.876, box_xyxy: [10.2, 20, 300, 400.7], mask_area_px: 5 }] };
    return reply(200, { id: 'ml-1', status: state.status, progress: state.progress, result });
  };
  return { calls, state, fetchImpl };
}

async function setup(t, opts = {}) {
  const ml = fakeMl();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roomai-'));
  const app = createApp({ db: await openDb(), jwtSecret: 't', uploadDir: dir, authLimit: 1000, mlServiceUrl: 'http://ml.test', roomAiDir: path.join(dir, 'photos'), fetchImpl: ml.fetchImpl, ...opts });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://localhost:${server.address().port}/v1`;
  const register = async (email) => (await (await fetch(base + '/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'Hometown-Pass-77' }) })).json()).token;
  const send = (token, fields = {}, file = JPEG) => {
    const f = new FormData();
    for (const [k, v] of Object.entries({ kind: 'understand', consent: 'yes', ...fields })) if (v !== undefined) f.set(k, v);
    if (file) f.set('photo', new Blob([file]), 'room.jpg');
    return fetch(base + '/room-ai/jobs', { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {}, body: f });
  };
  const get = (token, p, method = 'GET') => fetch(base + p, { method, headers: { authorization: `Bearer ${token}` } });
  const photos = () => (fs.existsSync(path.join(dir, 'photos')) ? fs.readdirSync(path.join(dir, 'photos')) : []);
  return { ml, server, base, register, send, get, photos };
}

test('room AI: needs sign-in, consent and a real photo; off without ML_SERVICE_URL', async (t) => {
  const off = await setup(t, { mlServiceUrl: '' });
  const t0 = await off.register('off@x.com');
  assert.equal((await off.send(t0)).status, 503);

  const s = await setup(t);
  const tok = await s.register('a@x.com');
  assert.equal((await s.send(null)).status, 401);
  assert.equal((await s.send(tok, { consent: undefined })).status, 400, 'no consent, no upload');
  assert.equal((await s.send(tok, { kind: 'paint' })).status, 400);
  assert.equal((await s.send(tok, {}, null)).status, 400, 'photo is required');
  assert.equal((await s.send(tok, {}, Buffer.from('<svg/>'))).status, 415, 'only JPEG / PNG');
  assert.equal(s.photos().length, 0, 'nothing refused is kept');
});

test('room AI: understand -> progress -> objects; the photo is deleted once the ml-service has read it; owner only', async (t) => {
  const s = await setup(t);
  const tok = await s.register('b@x.com'), other = await s.register('c@x.com');
  const r = await s.send(tok);
  assert.equal(r.status, 202);
  const { id } = await r.json();
  assert.equal(s.photos().length, 1, 'photo waits on disk for the ml-service');
  assert.ok(path.isAbsolute(s.ml.calls.body.image_url) && s.ml.calls.includes('POST /v1/room-understanding'));

  let j = await (await s.get(tok, `/room-ai/jobs/${id}`)).json();
  assert.deepEqual([j.status, j.progress], ['running', 40]);
  assert.equal(s.photos().length, 1);
  assert.equal((await s.get(other, `/room-ai/jobs/${id}`)).status, 404, 'another user cannot see it');

  s.ml.state.status = 'done';
  j = await (await s.get(tok, `/room-ai/jobs/${id}`)).json();
  assert.equal(j.status, 'done'); assert.equal(j.progress, 100);
  assert.deepEqual(j.objects, [{ label: 'sofa', score: 0.88, box: [10, 20, 300, 401] }]);
  assert.deepEqual(j.imageSize, { w: 1024, h: 768 });
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(s.photos().length, 0, 'photo deleted after processing');

  assert.equal((await s.get(tok, `/room-ai/jobs/${id}/image`)).status, 404, 'understand jobs have no picture');
  assert.equal((await s.get(other, `/room-ai/jobs/${id}`, 'DELETE')).status, 404);
  assert.equal((await s.get(tok, `/room-ai/jobs/${id}`, 'DELETE')).status, 204);
  assert.ok(s.ml.calls.includes('DELETE /v1/jobs/ml-1'), 'ml-service outputs are deleted too');
  assert.equal((await s.get(tok, `/room-ai/jobs/${id}`)).status, 404);
});

test('room AI: redesign sends the prompt and serves the private PNG', async (t) => {
  const s = await setup(t);
  const tok = await s.register('d@x.com');
  const { id } = await (await s.send(tok, { kind: 'redesign', prompt: 'make it minimalist' }, PNG)).json();
  assert.equal(s.ml.calls.body.prompt, 'make it minimalist');
  assert.ok(s.ml.calls.includes('POST /v1/redesign'));
  s.ml.state.status = 'done';
  assert.equal((await (await s.get(tok, `/room-ai/jobs/${id}`)).json()).imageReady, true);
  const img = await s.get(tok, `/room-ai/jobs/${id}/image`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.match(img.headers.get('cache-control'), /no-store/);
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), PNG);
});

test('room AI: failures are explained, the ml-service being down or restarted is handled, limits apply', async (t) => {
  const s = await setup(t, { roomAiLimits: { perMinute: 2, perDay: 3 } });
  const tok = await s.register('e@x.com');
  const { id } = await (await s.send(tok)).json();
  s.ml.state.status = 'failed';
  const f = await (await s.get(tok, `/room-ai/jobs/${id}`)).json();
  assert.equal(f.status, 'failed'); assert.match(f.error, /could not process/);

  s.ml.state.lost = true;
  assert.equal((await s.get(tok, `/room-ai/jobs/${id}`)).status, 410, 'service restarted: job is gone, ask to resend');

  s.ml.state.down = true;
  assert.equal((await s.send(tok)).status, 502);
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(s.photos().length, 0, 'photo removed when the ml-service could not take it');

  s.ml.state.down = false;
  assert.equal((await s.send(tok, { consent: undefined })).status, 400);
  assert.equal((await s.send(tok)).status, 202, 'refused and failed uploads did not use up the limit');
  assert.equal((await s.send(tok)).status, 429, 'per-minute limit: 2 accepted photos');
});
