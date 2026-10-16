// Stage 1 benchmark: runs TripoSR and Hunyuan3D-2mv on the SAME real catalogue products and compares them with the same checks the
// production pipeline uses (scripts/publish-models.mjs normalise: real-size fit, shape error, file size), plus colour and run time.
//
//   node scripts/benchmark-models.mjs                    3 products per furniture type (about 20), both models
//   node scripts/benchmark-models.mjs --per-role 2 --models triposr,hunyuan3d-2mv
//
// Needs the local ml-service (server/ml-service, http://127.0.0.1:8077) with Hunyuan3D set up. Resumable: generated files are kept in
// models/bench/<model>/raw/ and skipped on the next run. Output: models/bench/report.md (the numbers) and models/bench/compare.html
// (photo + both models side by side; serve the models folder to view it: npx http-server models -p 8079 -> /bench/compare.html).
import fs from 'node:fs';
import path from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { local, photoFor, waitForModel } from './lib/image3d.mjs';
import { normalise } from './publish-models.mjs';

const opt = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const PER_ROLE = Number(opt('per-role', 3));
const MODELS = opt('models', 'triposr,hunyuan3d-2mv').split(',');
const ROLES = ['sofa', 'bed', 'wardrobe', 'dining-table', 'tv-unit', 'chair', 'coffee-table', 'storage'];
const BENCH = 'models/bench', RESULTS = path.join(BENCH, 'results.json');

const catalogue = JSON.parse(fs.readFileSync('src/data/catalogue.json', 'utf8'));
const sample = ROLES.flatMap((role) => catalogue
  .filter((p) => p.role === role && !p.model3D && !p.sizeReview && !p.demo && p.images?.[0])
  .sort((a, b) => a.id.localeCompare(b.id))
  .slice(0, PER_ROLE));
const results = fs.existsSync(RESULTS) ? JSON.parse(fs.readFileSync(RESULTS, 'utf8')) : {};
const save = () => { fs.writeFileSync(`${RESULTS}.part`, JSON.stringify(results, null, 1)); fs.renameSync(`${RESULTS}.part`, RESULTS); };
const provider = local({ baseUrl: opt('ml-service-url', undefined) });
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

/** Has colour: vertex colours or a base-colour texture. Also counts triangles (after normalise, so what the phone would load). */
async function inspect(file) {
  const doc = await io.read(file);
  let tris = 0, colour = false;
  for (const mesh of doc.getRoot().listMeshes()) for (const prim of mesh.listPrimitives()) {
    tris += (prim.getIndices()?.getCount() ?? prim.getAttribute('POSITION').getCount()) / 3;
    if (prim.getAttribute('COLOR_0') || prim.getMaterial()?.getBaseColorTexture()) colour = true;
  }
  return { tris: Math.round(tris), colour };
}

console.log(`Benchmark: ${sample.length} products x ${MODELS.join(' + ')}`);
for (const p of sample) {
  for (const model of MODELS) {
    const key = `${model}:${p.id}`;
    const raw = path.join(BENCH, model, 'raw', `${p.id}.glb`), out = path.join(BENCH, model, `${p.id}.glb`);
    fs.mkdirSync(path.dirname(raw), { recursive: true });
    const r = (results[key] ??= { model, id: p.id });
    try {
      if (!fs.existsSync(raw)) {
        const task = await provider.create(photoFor(p), { meshModel: model });
        let elapsedS;
        const url = await waitForModel({ status: async (t) => { const s = await provider.status(t); elapsedS = s.elapsedS; return s; } }, task,
          { onProgress: (s) => process.stdout.write(`\r  ${model.padEnd(14)} ${p.id}: ${s.status} ${s.progress ?? ''}%   `) });
        const res = await fetch(url);
        if (!res.ok) throw new Error(`download failed (${res.status})`);
        fs.writeFileSync(`${raw}.part`, Buffer.from(await res.arrayBuffer())); // atomic: a power cut never leaves a truncated .glb
        fs.renameSync(`${raw}.part`, raw);
        r.seconds = elapsedS ?? null;
        delete r.error;
      }
      const n = await normalise(raw, out, p.dimensionsCm, 0, { auto: true, role: p.role });
      Object.assign(r, { ok: n.issues.length === 0, stretch: Math.round(n.stretch * 100) / 100, mb: Math.round(n.mb * 100) / 100, issues: n.issues }, await inspect(out));
      console.log(`\r  ${model.padEnd(14)} ${r.ok ? 'OK    ' : 'REVIEW'} ${p.id}  stretch ${r.stretch}x  ${r.mb}MB  ${r.tris} tris  ${r.colour ? 'colour' : 'grey'}  ${r.seconds ?? '?'}s`);
    } catch (e) {
      r.error = e.message.split('\n')[0].slice(0, 200);
      console.log(`\r  ${model.padEnd(14)} FAILED ${p.id}: ${r.error}`);
    }
    save();
  }
}

// ---- report ----
const rows = Object.values(results).filter((r) => sample.some((p) => p.id === r.id) && MODELS.includes(r.model));
const median = (xs) => { const s = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
const summary = MODELS.map((m) => {
  const mine = rows.filter((r) => r.model === m), done = mine.filter((r) => !r.error);
  return { model: m, products: mine.length, failed: mine.length - done.length, ok: done.filter((r) => r.ok).length,
    stretch: median(done.map((r) => r.stretch)), seconds: median(done.map((r) => r.seconds)), mb: median(done.map((r) => r.mb)), tris: median(done.map((r) => r.tris)),
    colour: done.filter((r) => r.colour).length };
});
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '-');
const byId = new Map(catalogue.map((p) => [p.id, p]));
const lines = [
  '# Stage 1 benchmark: TripoSR vs Hunyuan3D-2mv', '',
  `Same ${sample.length} real catalogue products (${PER_ROLE} per furniture type, first photo of each), same checks as production`,
  '(`scripts/publish-models.mjs` normalise: stretched to the listed W×D×H; REVIEW when any axis needs more than a 1.4× stretch).',
  'Generated by `node scripts/benchmark-models.mjs`. "Seconds" is GPU run time on this machine, not queue time.', '',
  '| Model | Pass (OK) | Failed to generate | Median shape error | Median seconds | Median MB | Median triangles | Coloured |',
  '|---|---|---|---|---|---|---|---|',
  ...summary.map((s) => `| ${s.model} | ${s.ok}/${s.products - s.failed} (${pct(s.ok, s.products - s.failed)}) | ${s.failed} | ${s.stretch ?? '-'}× | ${s.seconds ?? '-'} | ${s.mb ?? '-'} | ${s.tris ?? '-'} | ${s.colour}/${s.products - s.failed} |`),
  '', '## Per product', '',
  `| Product | Type | ${MODELS.map((m) => `${m} (shape error, result)`).join(' | ')} |`, `|---|---|${MODELS.map(() => '---').join('|')}|`,
  ...sample.map((p) => `| ${p.name} | ${p.role} | ${MODELS.map((m) => { const r = results[`${m}:${p.id}`]; return !r ? '-' : r.error ? 'failed' : `${r.stretch}× ${r.ok ? 'OK' : 'REVIEW'}`; }).join(' | ')} |`),
];
fs.writeFileSync(path.join(BENCH, 'report.md'), lines.join('\n') + '\n');

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const cell = (m, id) => { const r = results[`${m}:${id}`]; return !r || r.error ? `<div class="none">${esc(r?.error ?? 'not run')}</div>`
  : `<model-viewer src="${esc(m)}/${esc(id)}.glb" camera-controls auto-rotate loading="lazy"></model-viewer><p class="${r.ok ? 'ok' : 'rv'}">${r.ok ? 'OK' : 'REVIEW'} · ${r.stretch}× · ${r.colour ? 'colour' : 'grey'} · ${r.seconds ?? '?'}s</p>`; };
fs.writeFileSync(path.join(BENCH, 'compare.html'), `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Stage 1 benchmark</title>
<script type="module" src="https://cdn.jsdelivr.net/npm/@google/model-viewer@4.0.0/dist/model-viewer.min.js"></script>
<style>body{font:14px system-ui,sans-serif;margin:0;padding:16px;background:#f6f5f2;color:#222}table{border-collapse:collapse;width:100%}td,th{padding:6px;border-bottom:1px solid #ddd;vertical-align:top;text-align:left}
img,model-viewer{width:220px;height:180px;background:#fff;object-fit:contain}.ok{color:#17733a}.rv{color:#a35c00}.none{color:#b3261e;width:220px}p{margin:4px 0}</style>
<h1>Stage 1 benchmark</h1><p>${summary.map((s) => `<b>${esc(s.model)}</b>: ${s.ok}/${s.products - s.failed} OK, median shape error ${s.stretch ?? '-'}×, median ${s.seconds ?? '-'}s, ${s.colour} coloured`).join(' · ')}</p>
<table><tr><th>Product</th><th>Photo</th>${MODELS.map((m) => `<th>${esc(m)}</th>`).join('')}</tr>
${sample.map((p) => `<tr><td>${esc(p.name)}<br><small>${p.dimensionsCm.w}×${p.dimensionsCm.d}×${p.dimensionsCm.h} cm</small></td><td><img src="${esc(byId.get(p.id).images[0])}" alt="${esc(p.name)}" loading="lazy"></td>${MODELS.map((m) => `<td>${cell(m, p.id)}</td>`).join('')}</tr>`).join('\n')}
</table>`);
console.log(`\n${summary.map((s) => `${s.model}: ${s.ok}/${s.products - s.failed} OK, median shape error ${s.stretch}x, median ${s.seconds}s, coloured ${s.colour}`).join('\n')}`);
console.log(`Wrote ${BENCH}/report.md and ${BENCH}/compare.html`);
