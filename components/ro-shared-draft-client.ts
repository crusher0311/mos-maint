"use client";

import { confirmedRO, MAX_PHOTOS, MAX_PHOTO_BYTES, photoAllowed, type ROSession, type ArrivalPhoto } from "./ro-session-store";

/** Versioned contract. The server must opt in through the existing capability API.
 * No request to these endpoints is made on a server that has not opted in.
 */
export const SHARED_DRAFT_ENDPOINT = "/api/dashboard/protractor/check-in-drafts";
export type DraftFence = { id: string; revision: number; deviceId: string };
export type SharedPhoto = {
  requestId: string; name: string; mime: string; size: number; saved: boolean;
  uploaded?: ArrivalPhoto["uploaded"];
};
export type SharedDraft = {
  id: string; revision: number; ownerDeviceId: string; updatedAt: string;
  session: Omit<ROSession, "photos" | "shared">;
  photos: SharedPhoto[];
  transfer?: {from:string;to:string;recipientEmail:string;offeredAt:string} | null;
};
export const TRANSFER_ENDPOINT = `${SHARED_DRAFT_ENDPOINT}/transfer`;
export async function checkInTransferRequest(query = "", body?: unknown) {
  return json(`${TRANSFER_ENDPOINT}${query}`,body);
}
export class SharedDraftError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validSharedDraft(value: unknown, shopId: number, actorKey: string): value is SharedDraft {
  const d = value as SharedDraft | null;
  return !!d && uuid.test(d.id) && Number.isSafeInteger(d.revision) && d.revision > 0 &&
    uuid.test(d.ownerDeviceId) && typeof d.updatedAt === "string" &&
    d.session?.shopId === shopId && d.session.actorKey === actorKey && d.session.handoffRequestId === d.id &&
    Array.isArray(d.photos) && d.photos.length <= MAX_PHOTOS &&
    new Set(d.photos.map(p => p.requestId)).size === d.photos.length &&
    d.photos.every(p => uuid.test(p.requestId) && typeof p.name === "string" && p.name.length <= 255 &&
      ["image/jpeg", "image/png", "image/webp"].includes(p.mime) && Number.isSafeInteger(p.size) &&
      p.size > 0 && p.size <= MAX_PHOTO_BYTES && typeof p.saved === "boolean");
}
export function sharedSnapshot(value: ROSession) {
  const { photos, shared: _shared, ...session } = value;
  return { session, photos: photos.map(p => ({ requestId: p.requestId, name: p.name.slice(0, 255),
    mime: p.blob.type, size: p.originalSize ?? p.blob.size })) };
}
function stable(value: unknown): string {
  function ordered(v: unknown): unknown {
    return Array.isArray(v) ? v.map(ordered) : v && typeof v === "object"
      ? Object.fromEntries(Object.entries(v).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, ordered(item)])) : v;
  }
  return JSON.stringify(ordered(value));
}
/** Native receipts may arrive independently of a save response. They are never
 * replaced with an older browser snapshot; device timestamps are not content.
 */
export function sharedSnapshotMatches(local: ROSession, remote: SharedDraft) {
  const expected = sharedSnapshot(local);
  const { updatedAt: _localTime, ...session } = expected.session;
  const { updatedAt: _serverTime, ...saved } = remote.session;
  const compare = { ...session, ...(saved.payload ? { payload: saved.payload } : {}),
    ...(saved.result ? { result: saved.result } : {}) };
  if (session.payload && saved.payload !== session.payload) return false;
  if (session.result && stable(session.result) !== stable(saved.result)) return false;
  return stable(compare) === stable(saved) && stable(expected.photos) === stable(remote.photos.map(({ saved: _saved, uploaded: _uploaded, ...photo }) => photo));
}
export function sharedSnapshotSaved(local: ROSession, remote: SharedDraft) {
  return sharedSnapshotMatches(local, remote) && remote.photos.every(photo => photo.saved);
}
export function draftFence(value: ROSession): { _guidedDraft: DraftFence } | Record<string, never> {
  return value.shared ? { _guidedDraft: { ...value.shared } } : {};
}
export function handoffHref(origin: string, id: string) {
  if (!uuid.test(id)) throw new Error("Invalid check-in draft identity.");
  // No auth token, email, customer, VIN or other PII belongs in this URL.
  return `${origin}/dashboard/check-in?draft=${encodeURIComponent(id)}`;
}
async function json(path: string, body?: unknown) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(path, { credentials: "include", cache: "no-store", signal: controller.signal,
      ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
    const result = await response.json();
    if (!response.ok) throw new SharedDraftError(result.error || "Shared draft could not be confirmed.", response.status);
    return result;
  } catch (cause) {
    if (cause instanceof SharedDraftError) throw cause;
    throw new SharedDraftError("Server save is not confirmed. Your device copy is retained. Reconnect and retry before switching devices.", 0);
  } finally { clearTimeout(timeout); }
}
function decodeDraft(value: unknown, session: Pick<ROSession, "shopId" | "actorKey">): SharedDraft {
  if (!validSharedDraft(value, session.shopId, session.actorKey))
    throw new SharedDraftError("The server returned an invalid draft. Nothing new was sent to Protractor.", 503);
  return value;
}
export async function getSharedDraft(session: Pick<ROSession, "shopId" | "actorKey">, id?: string): Promise<SharedDraft | null> {
  if (id && !uuid.test(id)) throw new SharedDraftError("Invalid draft link. Open check-in from your dashboard.", 400);
  const result = await json(`${SHARED_DRAFT_ENDPOINT}${id ? `?id=${encodeURIComponent(id)}` : ""}`);
  return result.draft === null ? null : decodeDraft(result.draft, session);
}
export async function writeSharedDraft(action: "create" | "save" | "claim", session: ROSession, deviceId: string,
  existing?: SharedDraft): Promise<SharedDraft> {
  const fence = existing ? { id: existing.id, revision: existing.revision, deviceId } :
    session.shared ?? { id: session.handoffRequestId, revision: 0, deviceId };
  try {
    const result = await json(SHARED_DRAFT_ENDPOINT, { action, ...fence,
      ...(action === "claim" ? {} : sharedSnapshot(session)) });
    return decodeDraft(result.draft, session);
  } catch (cause) {
    // A lost acknowledgement is resolved by a read, NEVER by replaying the
    // mutation. Only the exact snapshot and current device's ownership qualify.
    if (cause instanceof SharedDraftError && (cause.status === 0 || cause.status === 409)) {
      try {
        const remote = await getSharedDraft(session, fence.id);
        if (remote && remote.ownerDeviceId === deviceId &&
          (action === "claim" ? remote.revision > fence.revision : remote.revision >= fence.revision && sharedSnapshotMatches(session, remote)))
          return remote;
      } catch { /* Preserve the original uncertainty/conflict. */ }
    }
    throw cause;
  }
}
export async function deleteSharedDraft(session: ROSession) {
  if (!session.shared) return;
  try { await json(SHARED_DRAFT_ENDPOINT, { action: "discard", ...session.shared }); }
  catch (cause) {
    if (cause instanceof SharedDraftError && (cause.status === 0 || cause.status === 404)) {
      try {
        const remote = await getSharedDraft(session, session.shared.id);
        if (!remote) return;
      } catch (readError) {
        if (readError instanceof SharedDraftError && readError.status === 404) return;
      }
    }
    throw cause;
  }
}
export async function uploadSharedPhoto(session: ROSession, photo: ArrivalPhoto): Promise<SharedDraft> {
  if (!session.shared || !photoAllowed(photo.blob) || photo.missingOnDevice)
    throw new Error("An arrival photo is only on the other device. Save it there, or explicitly remove it here before continuing.");
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(new Error("The device copy of this photo could not be read."));
    reader.readAsDataURL(photo.blob);
  });
  try {
    const result = await json(SHARED_DRAFT_ENDPOINT, { action: "photo", ...session.shared,
      requestId: photo.requestId, mime: photo.blob.type, base64 });
    return decodeDraft(result.draft, session);
  } catch (cause) {
    if (cause instanceof SharedDraftError && (cause.status === 0 || cause.status === 409)) {
      try {
        const remote = await getSharedDraft(session, session.shared.id);
        const saved = remote?.photos.find(p => p.requestId === photo.requestId);
        if (remote && remote.ownerDeviceId === session.shared.deviceId && remote.revision >= session.shared.revision &&
          saved?.saved && saved.mime === photo.blob.type && saved.size === photo.blob.size) {
          // A same-size image is not proof of exact identity. Verify the private
          // saved bytes before recovering a missing binary acknowledgement.
          const recovered = await readSharedPhoto(remote.id, saved);
          const left = new Uint8Array(await photo.blob.arrayBuffer()), right = new Uint8Array(await recovered.arrayBuffer());
          if (left.length === right.length && left.every((byte, index) => byte === right[index])) return remote;
        }
      } catch { /* Never invent a server-saved claim on an unverified image. */ }
    }
    throw cause;
  }
}
export function applySharedReceipt(local: ROSession, draft: SharedDraft, deviceId: string): ROSession {
  if (!validSharedDraft(draft, local.shopId, local.actorKey) || draft.id !== local.handoffRequestId || draft.ownerDeviceId !== deviceId)
    throw new SharedDraftError("This check-in is active on another device. Resume it here explicitly before editing.", 409);
  if (local.payload && draft.session.payload && local.payload !== draft.session.payload)
    throw new SharedDraftError("The immutable server creation request differs from this device. Resume the original saved request.", 409);
  if (draft.session.result && (!draft.session.payload || !confirmedRO({ ...draft.session.result, ok: true })))
    throw new SharedDraftError("The server creation confirmation is invalid. Keep the retained original request.", 503);
  return { ...local, ...(draft.session.payload ? { payload: draft.session.payload } : {}),
    ...(draft.session.result ? { result: draft.session.result } : {}),
    shared: { id: draft.id, revision: draft.revision, deviceId },
    photos: local.photos.map(p => ({ ...p, serverSaved: draft.photos.some(s => s.requestId === p.requestId && s.saved),
      uploaded: draft.photos.find(s => s.requestId === p.requestId)?.uploaded ?? p.uploaded })) };
}
async function readSharedPhoto(draftId: string, photo: SharedPhoto): Promise<Blob> {
  const response = await fetch(`${SHARED_DRAFT_ENDPOINT}?id=${encodeURIComponent(draftId)}&photo=${encodeURIComponent(photo.requestId)}`,
    { credentials: "include", cache: "no-store", signal: AbortSignal.timeout(30_000) });
  if (!response.ok || Number(response.headers.get("content-length")) > MAX_PHOTO_BYTES ||
    response.headers.get("content-type")?.split(";")[0].trim() !== photo.mime)
    throw new Error("A server-saved arrival photo could not be retrieved. Retry resume; the server copy has not been deleted.");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Arrival photo response was empty.");
  const chunks: Uint8Array[] = []; let length = 0;
  for (;;) {
    const next = await reader.read(); if (next.done) break;
    length += next.value.byteLength;
    if (length > MAX_PHOTO_BYTES) { await reader.cancel(); throw new Error("Arrival photo exceeds safe download limits."); }
    chunks.push(next.value);
  }
  const blob = new Blob(chunks as BlobPart[], { type: photo.mime });
  if (!photoAllowed(blob) || blob.size !== photo.size) throw new Error("The server photo could not be verified. Retry resume.");
  return blob;
}
export async function hydrateSharedDraft(draft: SharedDraft, deviceId: string): Promise<ROSession> {
  if (draft.ownerDeviceId !== deviceId)
    throw new SharedDraftError("The server has not transferred this check-in to this device. Refresh and resume explicitly.", 409);
  const photos: ArrivalPhoto[] = [];
  for (const p of draft.photos) {
    let blob = new Blob([], { type: p.mime });
    if (p.saved) {
      blob = await readSharedPhoto(draft.id, p);
    }
    photos.push({ requestId: p.requestId, name: p.name, blob, originalSize: p.size, serverSaved: p.saved,
      missingOnDevice: !p.saved, uploaded: p.uploaded });
  }
  return { ...draft.session, photos, shared: { id: draft.id, revision: draft.revision, deviceId } };
}
