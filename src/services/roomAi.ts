import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { API_URL } from '../config';
import { useAuth } from '../store/authStore';
import { ApiError, http, request } from './http';
import type { RoomAiJob, RoomAiKind } from '../utils/roomAi';

/**
 * Room AI: the one feature that sends a room photo off the phone, and only the photo the user picked for it, after they agreed.
 * The photo is shrunk to 1024 px and re-encoded first (this also drops EXIF, so no location or camera details go with it).
 * The server deletes it as soon as the AI has read it; `forget` deletes the results too.
 */
export const roomAiAvailable = () => !!API_URL;

async function prepare(uri: string): Promise<string> {
  const small = await manipulateAsync(uri, [{ resize: { width: 1024 } }], { compress: 0.85, format: SaveFormat.JPEG });
  return small.uri;
}

/** Multipart upload (the JSON client cannot send files). Refreshes the session once on 401, like the JSON client. */
async function post(form: () => FormData): Promise<Response> {
  const send = () => fetch(`${API_URL}/room-ai/jobs`, { method: 'POST', headers: { authorization: `Bearer ${useAuth.getState().token ?? ''}` }, body: form() });
  let res: Response;
  try { res = await send(); if (res.status === 401 && (await http.refresh())) res = await send(); }
  catch { throw new ApiError(0, 'Could not reach the server. Check your connection.'); }
  return res;
}

export async function startRoomAi(photoUri: string, kind: RoomAiKind, prompt?: string): Promise<RoomAiJob> {
  const uri = await prepare(photoUri);
  const res = await post(() => {
    const f = new FormData();
    f.append('kind', kind);
    f.append('consent', 'yes');
    if (prompt) f.append('prompt', prompt);
    f.append('photo', { uri, name: 'room.jpg', type: 'image/jpeg' } as unknown as Blob); // React Native's FormData file shape
    return f;
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body?.error ?? `Request failed (${res.status})`, body);
  return body as RoomAiJob;
}

export const getRoomAiJob = (id: string) => request<RoomAiJob>(`/room-ai/jobs/${encodeURIComponent(id)}`);
export const forgetRoomAiJob = (id: string) => request<void>(`/room-ai/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' });

/** Image source for the private redesigned picture (needs the sign-in header). */
export const roomAiImageSource = (id: string) => ({
  uri: `${API_URL}/room-ai/jobs/${encodeURIComponent(id)}/image`,
  headers: { authorization: `Bearer ${useAuth.getState().token ?? ''}` },
});
