import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SHOW_PRICES } from '../config';
import { getFurniture } from '../data/furniture';
import { budgetOf, rupees } from '../studio/studio';
import { discountPct } from '../utils/price';
import { colors } from '../theme';
import { t } from '../i18n';
import type { Product } from '../types/furniture';

/** A product's price, with the old price struck through and "% off" when it is on sale. Used on every product card and page. */
export function PriceTag({ product, size = 'small' }: { product: Pick<Product, 'priceInr' | 'compareAtInr' | 'setSize'>; size?: 'small' | 'large' }) {
  if (!SHOW_PRICES) return null;
  if (!product.priceInr) return <Text style={[s.none, size === 'large' && s.noneLarge]}>{t('price.onRequest')}</Text>;
  const off = discountPct(product.priceInr, product.compareAtInr);
  return (
    <View style={s.row} accessible accessibilityLabel={off ? t('price.saleLabel', { price: rupees(product.priceInr), was: rupees(product.compareAtInr!), off }) : rupees(product.priceInr)}>
      <Text style={[s.price, size === 'large' && s.priceLarge]}>{rupees(product.priceInr)}</Text>
      {off ? <Text style={[s.was, size === 'large' && s.wasLarge]}>{rupees(product.compareAtInr!)}</Text> : null}
      {off ? <Text style={[s.off, size === 'large' && s.offLarge]}>{t('price.off', { off })}</Text> : null}
      {product.setSize && size === 'large' ? <Text style={s.per}>{t('price.perSet', { n: product.setSize })}</Text> : null}
    </View>
  );
}

/** "Estimated total ₹… for N pieces" for any group of pieces (a design, a sample room, a shared layout). Sets are counted once. */
export function Estimate({ pieces, style }: { pieces: { productId: string }[]; style?: object }) {
  if (!SHOW_PRICES || pieces.length === 0) return null;
  const { total, unpriced } = budgetOf(pieces, getFurniture);
  if (!total) return null;
  return (
    <View style={[s.est, style]} accessible accessibilityLabel={t('price.estimateLabel', { total: rupees(total), count: pieces.length })}>
      <Text style={s.estLabel}>{t('price.estimate', { count: pieces.length })}</Text>
      <Text style={s.estTotal}>{rupees(total)}</Text>
      {unpriced ? <Text style={s.estNote}>{t('price.unpriced', { count: unpriced })}</Text> : null}
      <Text style={s.estNote}>{t('price.reference')}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', marginTop: 2 },
  price: { color: colors.accent, fontSize: 13, fontWeight: '800' },
  priceLarge: { fontSize: 22 },
  was: { color: colors.muted, fontSize: 11, textDecorationLine: 'line-through', marginLeft: 6 },
  wasLarge: { fontSize: 14 },
  off: { color: colors.danger, fontSize: 11, fontWeight: '700', marginLeft: 6 },
  offLarge: { fontSize: 14 },
  per: { color: colors.muted, fontSize: 12, marginLeft: 6 },
  none: { color: colors.muted, fontSize: 11, marginTop: 2 },
  noneLarge: { fontSize: 14 },
  est: { backgroundColor: colors.bg, borderRadius: 10, padding: 10, marginTop: 8 },
  estLabel: { color: colors.muted, fontSize: 12 },
  estTotal: { color: colors.ink, fontSize: 18, fontWeight: '800', marginTop: 2 },
  estNote: { color: colors.muted, fontSize: 11, marginTop: 2 },
});
