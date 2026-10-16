import assert from 'node:assert/strict';
import { discountPct, lowestPrice } from '../src/utils/price.ts';
import { budgetOf, rupees } from '../src/studio/studio.ts';

assert.equal(discountPct(75000, 100000), 25);
assert.equal(discountPct(100000, 100000), null, 'same price is not a sale');
assert.equal(discountPct(100000, 90000), null, 'a "was" price below the price is ignored');
assert.equal(discountPct(99900, 100000), null, 'under 1 % is not shown');
assert.equal(discountPct(undefined, 100000), null);
assert.equal(discountPct(50000, undefined), null);

assert.equal(lowestPrice([{ priceInr: 30000 }, {}, { priceInr: 12000 }]), 12000);
assert.equal(lowestPrice([{}, {}]), null);

// the estimate used on designs, rooms and shared layouts: sets counted once, unpriced counted
const find = (id: string) => ({ chair: { id, name: 'Chair', priceInr: 20000, setSize: 2 }, sofa: { id, name: 'Sofa', priceInr: 80000 }, lamp: { id, name: 'Lamp' } } as Record<string, any>)[id];
const b = budgetOf([{ productId: 'chair' }, { productId: 'chair' }, { productId: 'chair' }, { productId: 'sofa' }, { productId: 'lamp' }], find);
assert.equal(b.total, 2 * 20000 + 80000, '3 chairs sold in 2s = 2 sets');
assert.equal(b.unpriced, 1);
assert.equal(rupees(1234567), '₹12,34,567', 'Indian digit grouping');
console.log('price tests passed');
