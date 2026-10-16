// Checks that GLBs are AR-ready: one mesh with no node transforms, normals, a non-metallic material, standing on y=0, centred,
// the listed size, and (sofas, chairs, beds) the back at -z.   node scripts/glb-check.mjs [file.glb ...]   (default: all of assets/models)
import fs from 'node:fs';
import path from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { getBounds } from '@gltf-transform/functions';
import { BACK_HEAVY, tallSideZ } from './publish-models.mjs';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const byId = new Map(JSON.parse(fs.readFileSync('src/data/catalogue.json', 'utf8')).map((p) => [p.id, p]));
const files = process.argv.slice(2).length ? process.argv.slice(2) : fs.readdirSync('assets/models').filter((f) => f.endsWith('.glb')).map((f) => path.join('assets/models', f));

export async function check(file) {
  const doc = await io.read(file);
  const p = byId.get(path.basename(file, '.glb'));
  const issues = [];
  const nodes = doc.getRoot().listNodes();
  const identity = (n) => n.getTranslation().every((v) => Math.abs(v) < 1e-6) && n.getScale().every((v) => Math.abs(v - 1) < 1e-6) && Math.abs(n.getRotation()[3]) > 1 - 1e-6;
  if (!nodes.every(identity)) issues.push('node transforms not baked');
  for (const mesh of doc.getRoot().listMeshes()) for (const prim of mesh.listPrimitives()) {
    if (!prim.getAttribute('NORMAL')) issues.push('no normals');
    const m = prim.getMaterial();
    if (!m) issues.push('no material'); else if (m.getMetallicFactor() > 0.2) issues.push(`metallic ${m.getMetallicFactor()}`);
  }
  const { min, max } = getBounds(doc.getRoot().listScenes()[0]);
  if (Math.abs(min[1]) > 0.005) issues.push(`base at y=${min[1].toFixed(3)} m (should be 0)`);
  const cx = (min[0] + max[0]) / 2, cz = (min[2] + max[2]) / 2;
  if (Math.abs(cx) > 0.01 || Math.abs(cz) > 0.01) issues.push(`not centred (${cx.toFixed(3)}, ${cz.toFixed(3)})`);
  if (p) {
    const d = p.dimensionsCm, got = { w: (max[0] - min[0]) * 100, h: (max[1] - min[1]) * 100, d: (max[2] - min[2]) * 100 };
    for (const k of ['w', 'h', 'd']) if (Math.abs(got[k] - d[k]) / d[k] > 0.1) issues.push(`${k} ${got[k].toFixed(0)} cm vs listed ${d[k]}`);
    if (BACK_HEAVY.has(p.role) && tallSideZ(doc) > 0.04) issues.push('back faces forward');
  }
  return { file, issues };
}

let bad = 0;
for (const f of files) { const r = await check(f); if (r.issues.length) { bad++; console.log(`BAD ${path.basename(f)}: ${[...new Set(r.issues)].join('; ')}`); } }
console.log(`${files.length - bad}/${files.length} AR-ready`);
process.exitCode = bad ? 1 : 0;
