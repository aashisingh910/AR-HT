import assert from 'node:assert/strict';
import { foundCategories, isFinished, MIN_SCORE, pollDelayMs, STYLES } from '../src/utils/roomAi.ts';

const o = (label: string, score: number) => ({ label, score, box: [0, 0, 10, 10] });

// furniture only, confident only, one row per category, most seen first
const found = foundCategories([o('sofa', 0.9), o('chair', 0.5), o('chair', 0.6), o('wall', 0.99), o('floor', 0.8), o('rug', 0.7), o('bed', MIN_SCORE - 0.01), o(' Cabinet ', 0.4)]);
assert.deepEqual(found.map((f) => f.category), ['Chair', 'Sofa', 'Storage']);
assert.equal(found[0].count, 2);
assert.equal(found[0].best, 0.6);
assert.equal(foundCategories([o('table', 0.5)], ['Sofa']).length, 0, 'only categories the catalogue has');
assert.deepEqual(foundCategories([]), []);
// real Grounding DINO output merges phrases: "wardrobe door" is a wardrobe, "door" alone is architecture
assert.deepEqual(foundCategories([o('wardrobe door', 0.5), o('door', 0.9)]).map((f) => [f.category, f.label]), [['Wardrobe', 'wardrobe']]);

assert.ok(isFinished({ status: 'done' }) && isFinished({ status: 'failed' }) && !isFinished({ status: 'running' }) && !isFinished({ status: 'pending' }));
assert.equal(pollDelayMs(0), 700, 'jobs take seconds: first check after 0.7 s');
assert.equal(pollDelayMs(100), 3000, 'capped');
for (const p of Object.values(STYLES)) assert.ok(p.length > 20 && p.length <= 300, 'prompts fit the server limit (3-300 chars)');
console.log('room AI tests passed');
