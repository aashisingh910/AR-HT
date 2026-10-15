// Attaches already-published local models (models/published/<id>.glb, written by
// `node scripts/image-to-3d.mjs --provider local --yes` + its auto-normalise step) to the
// real catalogue in src/data/catalogue.json, for LOCAL TESTING ONLY.
//
//   MODEL_BASE_URL=http://127.0.0.1:8078/ node scripts/attach-local-models.mjs
//
// This deliberately skips the project's normal review gate (prompts/MODELS.md: "Always review
// each model next to its photos in the admin dashboard... reject the ones that look wrong" —
// the admin dashboard is step 13, not built yet). It attaches every product that has a
// models/published/<id>.glb file, regardless of whether image-to-3d.mjs printed OK or REVIEW
// for it — check that console output before trusting a model, and never point MODEL_BASE_URL
// at a real customer-facing build without a human having looked at each one first.
import fs from 'node:fs';

const BASE = process.env.MODEL_BASE_URL;
if (!BASE) { console.error('Set MODEL_BASE_URL (e.g. http://127.0.0.1:8078/).'); process.exit(1); }

const catPath = 'src/data/catalogue.json';
const catalogue = JSON.parse(fs.readFileSync(catPath, 'utf8'));
let attached = 0;
for (const p of catalogue) {
  if (p.model3D) continue;
  const file = `models/published/${p.id}.glb`;
  if (!fs.existsSync(file)) continue;
  p.model3D = { url: `${BASE}${p.id}.glb`, version: 1, unit: 'm' };
  attached++;
}
fs.writeFileSync(catPath, JSON.stringify(catalogue, null, 1));
console.log(`${attached} model(s) attached to src/data/catalogue.json (local testing only — the usual admin review was skipped).`);
console.log(`${catalogue.filter((p) => !p.model3D).length} product(s) still have no model (proxy shapes).`);
