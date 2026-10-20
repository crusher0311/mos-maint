// Browser-only persistence. Never expire an unresolved provider write.
export type ArrivalPhoto = { requestId: string; blob: Blob; name: string; uploaded?: { id: string; mime: string; url: string } };
export type ConfirmedRO = { workOrderId: string; workOrderNumber: number; packagesWithoutLines: Array<{ title: string; code?: string }> };
export type ROSession = {
  shopId: number;
  actorKey: string;
  photos: ArrivalPhoto[];
  payload?: string;
  result?: ConfirmedRO;
  handoffRequestId: string;
};
export const MAX_PHOTOS = 12;
export const MAX_PHOTO_BYTES = 4 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function confirmedRO(value: unknown): ConfirmedRO | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  if (data.ok !== true || data.pendingVerification === true || typeof data.workOrderId !== "string" || !UUID.test(data.workOrderId) ||
      typeof data.workOrderNumber !== "number" || !Number.isSafeInteger(data.workOrderNumber) || data.workOrderNumber <= 0) return null;
  return { workOrderId: data.workOrderId, workOrderNumber: data.workOrderNumber,
    packagesWithoutLines: Array.isArray(data.packagesWithoutLines) ? data.packagesWithoutLines : [] };
}
export function photoAllowed(file: Blob) {
  return ["image/jpeg", "image/png", "image/webp"].includes(file.type) && file.size > 0 && file.size <= MAX_PHOTO_BYTES;
}
export function safeLocalHref(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") && !/[\\\u0000-\u0020]/.test(value);
}
function openStore(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("mos-confirmed-ro", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("sessions", { keyPath: ["shopId", "actorKey"] });
    request.onerror = () => reject(new Error("Secure draft storage is unavailable. Nothing new was sent."));
    request.onblocked = () => reject(new Error("Close other MOS tabs to recover draft storage."));
    request.onsuccess = () => resolve(request.result);
  });
}
export async function readROSession(shopId: number, actorKey: string): Promise<ROSession | null> {
  const db = await openStore();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("sessions", "readonly");
    const request = tx.objectStore("sessions").get([shopId, actorKey]);
    let value: ROSession | null = null;
    request.onsuccess = () => { value = request.result ?? null; };
    tx.oncomplete = () => { db.close(); resolve(value); };
    tx.onabort = tx.onerror = () => { db.close(); reject(new Error("Saved RO could not be recovered. Do not create another.")); };
  });
}
// Atomic initial claim: a second tab must verify the saved payload, never send a
// second provider write. Limit records as well as per-record blobs.
export async function saveROSession(value: ROSession, claim = false): Promise<{ session: ROSession; claimed: boolean }> {
  const db = await openStore();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("sessions", "readwrite");
    const store = tx.objectStore("sessions");
    let session = value;
    let claimed = true;
    const request = store.get([value.shopId, value.actorKey]);
    request.onsuccess = () => {
      const existing = request.result as ROSession | undefined;
      if (existing?.payload && (claim || !value.payload || value.payload !== existing.payload)) { session = existing; claimed = false; return; }
      if (existing?.result && !value.result) session = { ...value, result: existing.result };
      const count = store.count();
      count.onsuccess = () => {
        if (!existing && count.result >= 20) { tx.abort(); return; }
        store.put(session);
      };
    };
    tx.oncomplete = () => { db.close(); resolve({ session, claimed }); };
    tx.onabort = tx.onerror = () => { db.close(); reject(new Error("Cannot preserve the RO safely. Free browser storage and retry; no new write was sent.")); };
  });
}
export async function removeROSession(value: ROSession) {
  const db = await openStore();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction("sessions", "readwrite");
    const store = tx.objectStore("sessions");
    const request = store.get([value.shopId, value.actorKey]);
    request.onsuccess = () => {
      // A stale tab cannot discard a different newly-created request.
      if (request.result?.payload !== value.payload) { tx.abort(); return; }
      store.delete([value.shopId, value.actorKey]);
    };
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onabort = tx.onerror = () => { db.close(); reject(new Error("Could not clear this completed RO. Reload to check the retained request.")); };
  });
}
export type JsonPost = (path: string, body: unknown) => Promise<{ ok: boolean; data: unknown }>;
export async function submitFrozenRO(session: ROSession, recoveryOnly: boolean, post: JsonPost,
  persist: (value: ROSession) => Promise<unknown>): Promise<ROSession> {
  if (!session.payload) throw new Error("Creation payload is missing.");
  if (session.result) return session;
  // Persistence must succeed BEFORE any network write.
  await persist(session);
  const response = await post("/api/dashboard/protractor/create-work-order", {
    ...JSON.parse(session.payload), expectedShopId:session.shopId, ...(recoveryOnly ? { recoveryOnly: true } : {}),
  });
  const result = response.ok ? confirmedRO(response.data) : null;
  if (!result) throw new Error("Creation is not confirmed. The original request is retained. Use Verify creation; do not create another RO.");
  const confirmed = { ...session, result };
  await persist(confirmed);
  return confirmed;
}
