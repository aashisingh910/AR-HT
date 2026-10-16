import { t } from '../../i18n';
import { Alert } from 'react-native';
import { hangOnWall, type Wall } from '../../utils/wall';
import { track } from '../../services/events';
import { MAX_PIECES } from '../../utils/perf';
import { isWallOnly, snap, type Vec3 } from './shared';
import { faceToward, floorHeight, freeSpot } from '../../utils/geometry';
import { getFurniture } from '../../data/furniture';
import type { PlacedItem, Product } from '../../types/furniture';

interface Args {
  hit: { current: Vec3 | null };
  /** Phone position, so a new piece is turned to face the person placing it. */
  camera?: { current: Vec3 | null };
  items: PlacedItem[];
  commit: (next: PlacedItem[]) => void;
  product?: Product;
  wall: Wall | null;
  selected: PlacedItem | null;
  setSelectedId: (uid: string | null) => void;
  isSuggested: (id: string) => boolean;
}

/** Placing one piece at the aim dot (floor or wall), and the actions on the selected piece. */
export function usePlacement({ hit, camera, items, commit, product, wall, selected, setSelectedId, isSuggested }: Args) {
  /** Returns true when a piece was placed. */
  const placePiece = (): boolean => {
    const at = hit.current;
    if (!at || !product) return false;
    if (items.length >= MAX_PIECES) { Alert.alert(t('usePlacement.thatIsALot'), t('placement.limitBody', { max: MAX_PIECES })); return false; }
    const stamp = String(Date.now());
    if (isWallOnly(product)) {
      if (!wall) { Alert.alert(t('usePlacement.markTheWallFirst'), t('usePlacement.openToolsTapMark')); return false; }
      const h = hangOnWall(wall, at, product.dimensionsCm);
      commit([...items, { uid: stamp, productId: product.id, position: h.position, rotationY: h.rotationY, scale: 1 }]);
      setSelectedId(stamp); track('wall_piece_hung', { id: product.id });
      return true;
    }
    // Same floor height as the pieces already down; facing the phone; moved to the nearest free spot if it would overlap.
    const floor = items.filter((i) => !isWallOnly(getFurniture(i.productId)));
    const aimed: Vec3 = [snap(at[0]), floorHeight(floor, at[1]), snap(at[2])];
    const draft: PlacedItem = { uid: stamp, productId: product.id, position: aimed, rotationY: camera?.current ? faceToward(aimed, camera.current) : 0, scale: 1 };
    commit([...items, { ...draft, position: freeSpot(draft, product, floor, getFurniture) }]);
    setSelectedId(stamp);
    track('piece_placed', { id: product.id });
    if (isSuggested(product.id)) track('rec_placed', { id: product.id });
    return true;
  };
  const duplicate = () => {
    if (!selected) return;
    if (items.length >= MAX_PIECES) { Alert.alert(t('usePlacement.thatIsALot'), t('placement.limitShort', { max: MAX_PIECES })); return; }
    const p = getFurniture(selected.productId);
    const draft: PlacedItem = { ...selected, uid: String(Date.now()) };
    // the copy goes right next to the original instead of 30 cm into it
    const copy: PlacedItem = { ...draft, position: p && !isWallOnly(p) ? freeSpot(draft, p, items.filter((i) => !isWallOnly(getFurniture(i.productId))), getFurniture, 3) : [selected.position[0] + 0.3, selected.position[1], selected.position[2] + 0.3] };
    commit([...items, copy]); setSelectedId(copy.uid);
  };
  const remove = () => { if (!selected) return; track('piece_removed', { id: selected.productId }); commit(items.filter((i) => i.uid !== selected.uid)); setSelectedId(null); };
  const rotate = (deg: number) => selected && commit(items.map((i) => (i.uid === selected.uid ? { ...i, rotationY: i.rotationY + deg } : i)));
  const swap = (id: string) => selected && commit(items.map((i) => (i.uid === selected.uid ? { ...i, productId: id, scale: 1 } : i)));
  return { placePiece, duplicate, remove, rotate, swap };
}
