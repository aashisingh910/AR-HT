// Builds models/review.html: every generated model next to its product photo, with its OK / REVIEW result, so you can decide which to bundle.
//   node scripts/review-models.mjs [--log models/batch-triposr.log]
//   then serve the models folder (model-viewer cannot load GLBs from file://):  npx http-server models -p 8079   ->  http://127.0.0.1:8079/review.html
// Tick the models you accept; the page builds the `node scripts/bundle-models.mjs --accept ...` command for you to copy.
import fs from 'node:fs';
import path from 'node:path';

const opt = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const LOG = opt('log', 'models/batch-triposr.log'), OUT = 'models/published', PAGE = 'models/review.html';

const catalogue = JSON.parse(fs.readFileSync('src/data/catalogue.json', 'utf8'));
const byId = new Map(catalogue.map((p) => [p.id, p]));

// Last result line per product wins (a re-run replaces an earlier verdict). Format: "OK     <id>  ..." / "REVIEW <id>  ... <issues>" / "FAILED <id>: <why>"
const result = new Map();
if (fs.existsSync(LOG)) {
  for (const line of fs.readFileSync(LOG, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^(OK|REVIEW|FAILED)\s+([^\s:]+):?\s*(.*)$/);
    if (m) result.set(m[2], { status: m[1], note: m[3].trim() });
  }
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const files = fs.existsSync(OUT) ? fs.readdirSync(OUT).filter((f) => f.endsWith('.glb')).map((f) => f.slice(0, -4)) : [];
const ids = [...new Set([...files, ...result.keys()])].filter((id) => byId.has(id)).sort();

const cards = ids.map((id) => {
  const p = byId.get(id), r = result.get(id) ?? { status: files.includes(id) ? 'OK' : 'FAILED', note: '' };
  const { w, d, h } = p.dimensionsCm;
  const viewer = files.includes(id)
    ? `<button class="load" data-src="published/${esc(id)}.glb" aria-label="Load 3D model of ${esc(p.name)}">Load 3D</button>`
    : '<div class="none">no model</div>';
  return `<article class="card" data-status="${r.status}" data-id="${esc(id)}">
  <div class="pair"><img src="${esc(p.images?.[0] ?? '')}" alt="${esc(p.name)}" loading="lazy"><div class="mv">${viewer}</div></div>
  <h3>${esc(p.name)}</h3><p class="dims">${w} × ${d} × ${h} cm · ${esc(p.category)}</p>
  <p class="st ${r.status}">${r.status}</p>${r.note ? `<p class="note">${esc(r.note)}</p>` : ''}
  ${files.includes(id) ? `<label><input type="checkbox" class="acc" value="${esc(id)}"${r.status === 'OK' ? ' checked' : ''}> bundle in app</label>` : ''}
</article>`;
}).join('\n');

const count = (s) => ids.filter((id) => (result.get(id)?.status ?? (files.includes(id) ? 'OK' : 'FAILED')) === s).length;
const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Model review</title>
<script type="module" src="https://cdn.jsdelivr.net/npm/@google/model-viewer@4.0.0/dist/model-viewer.min.js"></script>
<style>
body{font:14px system-ui,sans-serif;margin:0;padding:16px;background:#f6f5f2;color:#222}
header{position:sticky;top:0;background:#f6f5f2;padding:8px 0;z-index:2}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}
.card{background:#fff;border-radius:10px;padding:10px;box-shadow:0 1px 3px #0002}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:6px;height:150px}
.pair img{width:100%;height:150px;object-fit:contain;background:#fafafa}
.mv{background:#eef;display:flex;align-items:center;justify-content:center}
model-viewer{width:100%;height:150px}
h3{font-size:14px;margin:8px 0 2px}.dims,.note{margin:2px 0;color:#666;font-size:12px}
.st{font-weight:600;margin:4px 0}.OK{color:#17733a}.REVIEW{color:#a35c00}.FAILED{color:#b3261e}
textarea{width:100%;height:60px;font:12px monospace}
</style>
<header>
  <strong>${ids.length} models</strong> · OK ${count('OK')} · REVIEW ${count('REVIEW')} · FAILED ${count('FAILED')} ·
  show <select id="f" aria-label="Filter by result"><option value="">all</option><option>OK</option><option>REVIEW</option><option>FAILED</option></select>
  <p>Bundle command (copy and run in the project folder):</p><textarea id="cmd" readonly aria-label="Bundle command"></textarea>
</header>
<div class="grid">${cards}</div>
<script>
const cmd = document.getElementById('cmd');
const update = () => {
  const acc = [...document.querySelectorAll('.acc:checked')].filter((c) => c.closest('.card').dataset.status !== 'OK').map((c) => c.value);
  const drop = [...document.querySelectorAll('.acc:not(:checked)')].filter((c) => c.closest('.card').dataset.status === 'OK').map((c) => c.value);
  cmd.value = 'node scripts/bundle-models.mjs' + (acc.length ? ' --accept ' + acc.join(',') : '') + (drop.length ? '\\n# unticked OK models: delete models/raw/<id>.glb for ' + drop.join(', ') + ' before bundling' : '');
};
document.addEventListener('change', (e) => { if (e.target.classList.contains('acc')) update(); });
document.getElementById('f').addEventListener('change', (e) => document.querySelectorAll('.card').forEach((c) => { c.hidden = !!e.target.value && c.dataset.status !== e.target.value; }));
document.addEventListener('click', (e) => {
  const b = e.target.closest('.load'); if (!b) return;
  const mv = document.createElement('model-viewer');
  mv.setAttribute('src', b.dataset.src); mv.setAttribute('camera-controls', ''); mv.setAttribute('auto-rotate', ''); mv.setAttribute('shadow-intensity', '1');
  b.replaceWith(mv);
});
update();
</script>`;
fs.writeFileSync(PAGE, html);
console.log(`Wrote ${PAGE}: ${ids.length} models (OK ${count('OK')}, REVIEW ${count('REVIEW')}, FAILED ${count('FAILED')}).`);
console.log(`View it: npx http-server ${path.dirname(PAGE)} -p 8079   then open http://127.0.0.1:8079/review.html`);
