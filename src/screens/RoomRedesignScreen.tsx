import React, { useMemo, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Button } from '../components/ui';
import { useRoomAi } from '../features/roomAi/useRoomAi';
import { roomAiAvailable, roomAiImageSource } from '../services/roomAi';
import { useAuthStatus } from '../store/authStore';
import { useCategories, useProducts } from '../data/furniture';
import { foundCategories, STYLES, type StyleId } from '../utils/roomAi';
import { lowestPrice } from '../utils/price';
import { rupees } from '../studio/studio';
import { SHOW_PRICES } from '../config';
import { colors } from '../theme';
import { t } from '../i18n';
import type { RootStackParamList } from '../navigation/AppNavigator';

const STYLE_IDS = Object.keys(STYLES) as StyleId[];

/**
 * Room AI (architecture stages 3 + 4): one photo of the user's room -> the furniture the AI sees (with links to shop the same kinds),
 * or an AI-restyled picture for inspiration. Real products are still placed true-to-size in AR; the picture is only a mood board.
 */
export default function RoomRedesignScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const status = useAuthStatus();
  const categories = useCategories();
  const { photo, job, error, busy, pick, run, clear } = useRoomAi();
  const [agreed, setAgreed] = useState(false);
  const [style, setStyle] = useState<StyleId>('minimal');
  const found = useMemo(() => foundCategories(job?.objects ?? [], categories), [job, categories]);
  const working = !!job && (job.status === 'pending' || job.status === 'running');
  const products = useProducts();
  const fromPrice = (category: string) => (SHOW_PRICES ? lowestPrice(products.filter((p) => p.category === category && !p.demo)) : null);

  if (!roomAiAvailable()) return <Message text={t('roomAi.offline')} />;
  if (status === 'guest') {
    return (
      <Message text={t('roomAi.signIn')}>
        <Button label={t('nav.signIn')} onPress={() => nav.navigate('SignIn')} />
      </Message>
    );
  }

  return (
    <ScrollView style={{ backgroundColor: colors.bg }} contentContainerStyle={s.page}>
      <Text style={s.h} accessibilityRole="header">{t('roomAi.title')}</Text>
      <Text style={s.sub}>{t('roomAi.sub')}</Text>

      <View style={s.card}>
        <Text style={s.cardH}>{t('roomAi.privacyTitle')}</Text>
        <Text style={s.body}>{t('roomAi.privacyBody')}</Text>
        <View style={s.row}>
          <Switch value={agreed} onValueChange={setAgreed} accessibilityLabel={t('roomAi.agree')} />
          <Text style={[s.body, { flex: 1, marginLeft: 8 }]}>{t('roomAi.agree')}</Text>
        </View>
      </View>

      <View style={s.row}>
        <Button label={t('roomAi.takePhoto')} onPress={() => pick('camera')} disabled={!agreed || working} style={{ flex: 1, marginRight: 6 }} />
        <Button label={t('roomAi.choosePhoto')} variant="outline" onPress={() => pick('library')} disabled={!agreed || working} style={{ flex: 1, marginLeft: 6 }} />
      </View>

      {photo ? <Image source={{ uri: photo }} style={s.photo} accessibilityLabel={t('roomAi.yourPhoto')} /> : null}

      {photo && !working ? (
        <View style={s.card}>
          <Button label={t('roomAi.findFurniture')} onPress={() => run('understand')} disabled={!agreed || busy} />
          <Text style={[s.cardH, { marginTop: 14 }]}>{t('roomAi.restyle')}</Text>
          <View style={s.chips}>
            {STYLE_IDS.map((id) => (
              <Pressable key={id} accessibilityRole="button" accessibilityState={{ selected: style === id }} accessibilityLabel={t(`roomAi.styles.${id}`)}
                onPress={() => setStyle(id)} style={[s.chip, style === id && s.chipOn]}>
                <Text style={[s.chipText, style === id && { color: colors.accentInk }]}>{t(`roomAi.styles.${id}`)}</Text>
              </Pressable>
            ))}
          </View>
          <Button label={t('roomAi.redesign')} variant="outline" onPress={() => run('redesign', style)} disabled={!agreed || busy} />
          <Text style={s.note}>{t('roomAi.redesignNote')}</Text>
        </View>
      ) : null}

      {busy || working ? (
        <View style={[s.card, s.row]} accessibilityLiveRegion="polite">
          <ActivityIndicator color={colors.accent} />
          <Text style={[s.body, { marginLeft: 10 }]}>{t('roomAi.working', { pct: job?.progress ?? 0 })}</Text>
        </View>
      ) : null}

      {error ? <Text style={s.error} accessibilityRole="alert">{error}</Text> : null}

      {job?.status === 'done' && job.kind === 'understand' ? (
        <View style={s.card}>
          <Text style={s.cardH}>{found.length ? t('roomAi.weSee') : t('roomAi.nothingFound')}</Text>
          {found.map((f) => (
            <View key={f.category} style={s.found}>
              <View style={{ flex: 1 }}>
                <Text style={s.body}>{t('roomAi.seen', { label: f.label, count: f.count })}</Text>
                {fromPrice(f.category) ? <Text style={s.note}>{t('price.from', { price: rupees(fromPrice(f.category)!) })}</Text> : null}
              </View>
              <Button label={t('roomAi.shop', { category: f.category })} variant="outline"
                onPress={() => nav.navigate('Tabs', { screen: 'Library', params: { category: f.category } } as never)} />
            </View>
          ))}
        </View>
      ) : null}

      {job?.status === 'done' && job.kind === 'redesign' && job.imageReady ? (
        <View style={s.card}>
          <Image source={roomAiImageSource(job.id)} style={s.photo} resizeMode="contain" accessibilityLabel={t('roomAi.redesigned')} />
          <Text style={s.note}>{t('roomAi.inspiration')}</Text>
          <Button label={t('roomAi.placeReal')} onPress={() => nav.navigate('AR', {})} />
        </View>
      ) : null}

      {job || photo ? <Button label={t('roomAi.deleteNow')} variant="danger" onPress={clear} style={{ marginTop: 12 }} /> : null}
    </ScrollView>
  );
}

function Message({ text, children }: { text: string; children?: React.ReactNode }) {
  return (
    <View style={[s.page, { flex: 1, backgroundColor: colors.bg, justifyContent: 'center' }]}>
      <Text style={[s.body, { textAlign: 'center', marginBottom: 14 }]}>{text}</Text>
      {children}
    </View>
  );
}

const s = StyleSheet.create({
  page: { padding: 16, paddingBottom: 40 },
  h: { fontSize: 22, fontWeight: '800', color: colors.ink },
  sub: { color: colors.muted, marginTop: 4, marginBottom: 12, lineHeight: 20 },
  card: { backgroundColor: colors.surface, borderRadius: 14, padding: 14, marginBottom: 12 },
  cardH: { color: colors.ink, fontWeight: '700', fontSize: 15, marginBottom: 6 },
  body: { color: colors.ink, lineHeight: 20 },
  note: { color: colors.muted, fontSize: 12, marginTop: 8, lineHeight: 17 },
  row: { flexDirection: 'row', alignItems: 'center', marginTop: 8, marginBottom: 8 },
  photo: { width: '100%', aspectRatio: 4 / 3, borderRadius: 12, marginBottom: 12, backgroundColor: colors.surface },
  chips: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 8 },
  chip: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 14, borderRadius: 22, borderWidth: 1, borderColor: colors.line, marginRight: 8, marginBottom: 8 },
  chipOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipText: { color: colors.ink },
  found: { flexDirection: 'row', alignItems: 'center', marginTop: 8 },
  error: { color: colors.danger, marginBottom: 12, lineHeight: 20 },
});
