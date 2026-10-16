// Price helpers: pure, no React / RN imports (tested in scripts/price.test.ts). Prices are HomeTown's reference prices in rupees
// (lowest variant), shown everywhere; the app has no checkout.

/** Whole-number discount when the product is on sale ("was" price above the current one), else null. */
export function discountPct(price?: number | null, compareAt?: number | null): number | null {
  if (!price || !compareAt || compareAt <= price) return null;
  const pct = Math.round((1 - price / compareAt) * 100);
  return pct >= 1 ? pct : null;
}

/** Lowest price among products (for "from ₹…"), ignoring unpriced ones; null when none has a price. */
export function lowestPrice(products: { priceInr?: number }[]): number | null {
  let low: number | null = null;
  for (const p of products) if (p.priceInr && (low === null || p.priceInr < low)) low = p.priceInr;
  return low;
}
