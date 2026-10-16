// Room AI (stages 3 + 4) pure logic: no React / RN imports. The server is server/src/routes/roomAi.mjs.

export type RoomAiKind = 'understand' | 'redesign';
export type RoomAiStatus = 'pending' | 'running' | 'done' | 'failed';
export interface DetectedObject { label: string; score: number; box: number[] }
export interface RoomAiJob {
  id: string; kind: RoomAiKind; status: RoomAiStatus; progress: number; error?: string;
  imageReady?: boolean; imageSize?: { w: number; h: number } | null; floorHintY?: number | null; objects?: DetectedObject[];
}

/** Detector labels (server/ml-service stage 2 LABELS) -> the catalogue category to shop. Architecture (wall, floor...) maps to nothing. */
const CATEGORY: Record<string, string> = { sofa: 'Sofa', chair: 'Chair', bed: 'Bed', table: 'Table', wardrobe: 'Wardrobe', cabinet: 'Storage' };
export const MIN_SCORE = 0.35;

export interface FoundCategory { category: string; label: string; count: number; best: number }

/** What furniture the photo shows, as catalogue categories: confident detections only, one entry per category, most seen first. */
export function foundCategories(objects: DetectedObject[], categories?: readonly string[]): FoundCategory[] {
  const by = new Map<string, FoundCategory>();
  for (const o of objects) {
    // The detector can merge phrases ("wardrobe door", "chair table"): use the first furniture word in the label.
    const label = o.label.toLowerCase().split(/\s+/).find((w) => CATEGORY[w]) ?? '';
    const category = CATEGORY[label];
    if (!category || o.score < MIN_SCORE || (categories && !categories.includes(category))) continue;
    const f = by.get(category) ?? { category, label, count: 0, best: 0 };
    f.count++; f.best = Math.max(f.best, o.score);
    by.set(category, f);
  }
  return [...by.values()].sort((a, b) => b.count - a.count || b.best - a.best || a.category.localeCompare(b.category));
}

/** Ready-made redesign styles. The text is the SDXL prompt (English, whatever the app language). */
export const STYLES = {
  minimal: 'a bright minimalist living space, light wood, white walls, uncluttered, natural light, keep the room layout',
  warm: 'a warm cosy room, earthy tones, soft textiles, wooden furniture, warm lighting, keep the room layout',
  modern: 'a modern contemporary room, neutral greys, clean lines, accent lighting, keep the room layout',
  classic: 'a classic elegant room, rich fabrics, carved wood, warm neutral palette, keep the room layout',
} as const;
export type StyleId = keyof typeof STYLES;

export const isFinished = (j: Pick<RoomAiJob, 'status'>) => j.status === 'done' || j.status === 'failed';

/** Wait before the next status check. Both jobs take seconds (find furniture ~3 s, restyle ~5 s on the GPU), so check often,
 * then back off to every 3 s in case the GPU is busy with someone else's request. */
export const pollDelayMs = (attempt: number) => Math.min(3000, 700 + attempt * 300);
