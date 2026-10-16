import { useCallback, useEffect, useRef, useState } from 'react';
import * as ImagePicker from 'expo-image-picker';
import { forgetRoomAiJob, getRoomAiJob, startRoomAi } from '../../services/roomAi';
import { isFinished, pollDelayMs, STYLES, type RoomAiJob, type RoomAiKind, type StyleId } from '../../utils/roomAi';
import { t } from '../../i18n';

/** State for the Room AI screen: pick a photo, send it once, poll until done. The job (photo + results) is deleted when the screen closes. */
export function useRoomAi() {
  const [photo, setPhoto] = useState<string | null>(null);
  const [job, setJob] = useState<RoomAiJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const live = useRef<string | null>(null); // the job to delete on leave
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stop = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; };
  const forget = useCallback(() => {
    stop();
    if (live.current) forgetRoomAiJob(live.current).catch(() => {});
    live.current = null;
  }, []);
  useEffect(() => forget, [forget]);

  const pick = useCallback(async (from: 'camera' | 'library') => {
    setError(null);
    if (from === 'camera') {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) { setError(t('roomAi.cameraDenied')); return; }
    }
    const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 0.9, exif: false };
    const r = from === 'camera' ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
    if (r.canceled || !r.assets?.[0]) return;
    forget(); setJob(null);
    setPhoto(r.assets[0].uri);
  }, [forget]);

  const poll = useCallback((id: string) => {
    const tick = (attempt: number) => {
      timer.current = setTimeout(async () => {
        try {
          const j = await getRoomAiJob(id);
          setJob(j);
          if (!isFinished(j)) tick(attempt + 1);
          else if (j.status === 'failed') setError(j.error ?? t('roomAi.failed'));
        } catch (e) {
          setError(e instanceof Error ? e.message : t('roomAi.failed'));
        }
      }, pollDelayMs(attempt));
    };
    tick(0);
  }, []);

  const run = useCallback(async (kind: RoomAiKind, style?: StyleId) => {
    if (!photo) return;
    setBusy(true); setError(null); forget();
    try {
      const j = await startRoomAi(photo, kind, kind === 'redesign' && style ? STYLES[style] : undefined);
      live.current = j.id;
      setJob(j);
      poll(j.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('roomAi.failed'));
    } finally { setBusy(false); }
  }, [photo, forget, poll]);

  const clear = useCallback(() => { forget(); setJob(null); setPhoto(null); setError(null); }, [forget]);

  return { photo, job, error, busy, pick, run, clear };
}
