import { collidingUids, checkFit, faceToward, floorHeight, freeSpot } from '../src/utils/geometry.ts';
import type { PlacedItem, Product } from '../src/types/furniture.ts';
import assert from 'node:assert/strict';

const prod = (w: number, d: number) => ({ id: 'x', dimensionsCm: { w, d, h: 80 } }) as unknown as Product;
const item = (uid: string, x: number, z: number, rot = 0): PlacedItem =>
  ({ uid, productId: 'x', position: [x, 0, z], rotationY: rot, scale: 1 });
const find = () => prod(200, 100);

// 2m x 1m footprints
assert.equal(collidingUids([item('a', 0, 0), item('b', 1.5, 0)], find).size, 2, 'overlap along width');
assert.equal(collidingUids([item('a', 0, 0), item('b', 2.1, 0)], find).size, 0, 'clear gap along width');
assert.equal(collidingUids([item('a', 0, 0), item('b', 0, 1.2)], find).size, 0, 'clear gap along depth');
assert.equal(collidingUids([item('a', 0, 0), item('b', 0, 0.9)], find).size, 2, 'overlap along depth');
assert.equal(collidingUids([item('a', 0, 0), item('b', 2.0, 0)], find).size, 0, 'touching is not a collision');
// Rotating b by 90deg makes it 1m wide in x: centre at x=1.4 -> b spans 0.9..1.9 in x, a spans -1..1 -> overlap.
assert.equal(collidingUids([item('a', 0, 0), item('b', 1.4, 0, 90)], find).size, 2, 'rotated overlap');
// ...and at x=1.6 the rotated b spans 1.1..2.1 -> clear.
assert.equal(collidingUids([item('a', 0, 0), item('b', 1.6, 0, 90)], find).size, 0, 'rotated clear');
// 45deg diagonal corner case: a 2x1 rect rotated 45deg at x=1.9 pokes into a's right edge.
assert.equal(collidingUids([item('a', 0, 0), item('b', 1.9, 0, 45)], find).size, 2, 'diagonal overlap');

assert.deepEqual(checkFit(210, 300), { status: 'fits', spareCm: 90 });
assert.deepEqual(checkFit(210, 230), { status: 'tight', spareCm: 20 });
assert.deepEqual(checkFit(210, 200), { status: 'no', shortByCm: 10 });
// a new piece faces the person placing it: front (+z) points at the viewer
assert.equal(faceToward([0, 0, 0], [0, 1.5, 2]), 0, 'viewer straight ahead along +z');
assert.equal(faceToward([0, 0, 0], [2, 1.5, 0]), 90, 'viewer to the +x side');
assert.equal(faceToward([0, 0, 0], [0, 1.5, -2]), 180, 'viewer behind');
assert.equal(faceToward([0, 0, 0], [-2, 1.5, 0]), 270);
assert.equal(faceToward([0, 0, 0], [1, 1.5, 1.05]), 45, 'snapped to 15 degrees');
{ // and the maths agrees with footprint's rotation convention: +z of the rotated piece points at the viewer
  const a = (faceToward([0, 0, 0], [3, 0, 1], 1) * Math.PI) / 180;
  assert.ok(Math.abs(Math.sin(a) * 1 - 3 / Math.hypot(3, 1)) < 0.02 && Math.abs(Math.cos(a) - 1 / Math.hypot(3, 1)) < 0.02);
}

// placing on top of another piece moves the new one to the nearest free spot
const sofa = item('s', 0, 0);
const spot = freeSpot(item('n', 0.2, 0), prod(200, 100), [sofa], find);
assert.equal(collidingUids([sofa, { ...item('n', 0, 0), position: spot }], find).size, 0, 'moved clear of the sofa');
assert.ok(Math.hypot(spot[0] - 0.2, spot[2]) <= 1.2, 'and not far: the nearest free ring');
assert.deepEqual(freeSpot(item('n', 5, 5), prod(200, 100), [sofa], find), [5, 0, 5], 'a free spot is kept as aimed');

// every floor piece stands on the same floor
assert.equal(floorHeight([], -1.31), -1.31);
assert.equal(floorHeight([{ ...item('a', 0, 0), position: [0, -1.3, 0] }, { ...item('b', 0, 0), position: [0, -1.32, 0] }, { ...item('c', 0, 0), position: [0, -0.9, 0] }], -1.0), -1.3, 'median: one bad hit does not move the floor');
console.log('geometry tests passed');
