// Synthetic browser-only contract fixture. No DB, real auth, provider or OCR I/O.
import type { SharedDraft } from "../../components/ro-shared-draft-client";
import { SHARED_DRAFT_ENDPOINT } from "../../components/ro-shared-draft-client";

function digest(value: any): string {
  const sorted = (v: any): any => Array.isArray(v) ? v.map(sorted) : v && typeof v === "object"
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sorted(v[k])])) : v;
  const { _guidedDraft, expectedShopId, recoveryOnly, ...body } = value;
  return JSON.stringify(sorted(body));
}
/** Synthetic native admission mirrors server revision advancement. No providers. */
export function reserveSharedCheckInFixture(shopId: number, actorKey: string, body: Record<string, any>, kind: string) {
  if (!body._guidedDraft) return null;
  const slot = `offline-shared-check-in:${shopId}:${actorKey}`, draft: SharedDraft | null = JSON.parse(localStorage.getItem(slot) ?? "null");
  const f = body._guidedDraft;
  const reject = (error: string) => ({ response: Response.json({ error }, { status: 409 }), send: false, complete: (_result: unknown) => {} });
  if (!draft || draft.id !== f.id || draft.ownerDeviceId !== f.deviceId || draft.revision !== f.revision) return reject("Synthetic native fence rejected a stale device/revision.");
  const key = `${slot}:operations:${draft.id}`;
  const operations = JSON.parse(localStorage.getItem(key) ?? "{}"), prior = operations[kind];
  if (prior) {
    if (prior.digest !== digest(body)) return reject("Synthetic native payload changed.");
    return { response: Response.json(prior.result ?? { pendingVerification: true }, { status: prior.result ? 200 : 202 }), send: false, complete: (_result: unknown) => {} };
  }
  if (kind === "ro" && (!draft.session.payload || digest(JSON.parse(draft.session.payload)) !== digest(body))) return reject("Exact frozen RO snapshot must precede native send.");
  if (kind === "contact" || kind === "vehicle") {
    const pending = draft.session.pendingCreates?.[kind];
    if (!pending || digest(pending) !== digest(body)) return reject("Exact related snapshot must precede native send.");
  }
  operations[kind] = { digest: digest(body) };
  localStorage.setItem(key, JSON.stringify(operations));
  localStorage.setItem(slot, JSON.stringify({ ...draft, revision: draft.revision + 1 }));
  return { response: null, send: true, complete(result: any) {
    const latest = JSON.parse(localStorage.getItem(slot)!), ops = JSON.parse(localStorage.getItem(key)!);
    ops[kind].result = result;
    localStorage.setItem(key, JSON.stringify(ops));
    latest.revision++;
    if (kind === "ro") latest.session.result = { workOrderId: result.workOrderId, workOrderNumber: result.workOrderNumber, packagesWithoutLines: result.packagesWithoutLines ?? [] };
    localStorage.setItem(slot, JSON.stringify(latest));
  } };
}
export function createSharedCheckInFixture(shopId: number, actorKey: string) {
  const slot = `offline-shared-check-in:${shopId}:${actorKey}`;
  const read = (): SharedDraft | null => JSON.parse(localStorage.getItem(slot) ?? "null");
  const save = (draft: SharedDraft) => { localStorage.setItem(slot, JSON.stringify(draft)); return Response.json({ draft }); };
  const fail = (error: string, status = 409) => Response.json({ error }, { status });
  return async (path: string, init?: RequestInit): Promise<Response | null> => {
    if (!path.startsWith(SHARED_DRAFT_ENDPOINT)) return null;
    const url = new URL(path, location.origin), draft = read();
    if (!init?.body) {
      if (url.searchParams.has("id") && url.searchParams.get("id") !== draft?.id) return fail("Draft not found for this actor/shop.", 404);
      if (url.searchParams.has("photo")) {
        if (!draft) return fail("Draft not found.", 404);
        const requestId = url.searchParams.get("photo"), photo = draft.photos.find(p => p.requestId === requestId);
        const data = localStorage.getItem(`${slot}:photo:${draft.id}:${requestId}`);
        if (!photo?.saved || !data) return fail("Photo not found.", 404);
        const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
        return new Response(bytes, { headers: { "Content-Type": photo.mime, "Content-Length": String(bytes.length) } });
      }
      return Response.json({ draft });
    }
    const body = JSON.parse(String(init.body));
    if (body.action === "create") {
      if (draft) return draft.id === body.id ? Response.json({ draft }) : fail("A different server draft is active.");
      return save({ id: body.id, revision: 1, ownerDeviceId: body.deviceId, updatedAt: new Date().toISOString(),
        session: body.session, photos: body.photos.map((p: object) => ({ ...p, saved: false })) });
    }
    if (!draft || body.id !== draft.id) return fail("Draft not found.", 404);
    if (body.revision !== draft.revision) return fail("Draft revision changed. Refresh and resume explicitly.");
    if (body.action !== "claim" && body.deviceId !== draft.ownerDeviceId) return fail("This check-in is active on another device.");
    const next = { ...draft, revision: draft.revision + 1, updatedAt: new Date().toISOString() };
    if (body.action === "claim") return save({ ...next, ownerDeviceId: body.deviceId });
    if (body.action === "save") {
      if (draft.session.payload && draft.session.payload !== body.session.payload) return fail("Creation details are frozen.");
      if (draft.session.result && JSON.stringify(draft.session.result) !== JSON.stringify(body.session.result)) return fail("Confirmed native result cannot be dropped or replaced.");
      for (const kind of ["contact", "vehicle"] as const) {
        if (draft.session.pendingCreates?.[kind] && body.session.pendingCreates?.[kind] &&
          JSON.stringify(draft.session.pendingCreates[kind]) !== JSON.stringify(body.session.pendingCreates[kind]))
          return fail("Pending creation details are immutable.");
        if (draft.session.pendingCreates?.[kind] && !body.session.pendingCreates?.[kind]) {
          const operation = JSON.parse(localStorage.getItem(`${slot}:operations:${draft.id}`) ?? "{}")[kind];
          const fields = JSON.parse(body.session.draft?.fields ?? "{}");
          if (!operation?.result || fields[kind === "contact" ? "selectedContact" : "selectedVehicle"]?.id !== operation.result[`${kind}Id`])
            return fail("Confirmed matching selection is required before clearing pending creation.");
        }
      }
      return save({ ...next, session: body.session, photos: body.photos.map((p: { requestId: string }) => ({
        ...p, saved: draft.photos.some(existing => existing.requestId === p.requestId && existing.saved),
        uploaded: draft.photos.find(existing => existing.requestId === p.requestId)?.uploaded,
      })) });
    }
    if (body.action === "photo") {
      const photo = draft.photos.find(p => p.requestId === body.requestId);
      if (!photo || photo.mime !== body.mime) return fail("Photo metadata required.");
      const key = `${slot}:photo:${draft.id}:${body.requestId}`, existing = localStorage.getItem(key);
      if (existing && existing !== body.base64) return fail("Image identity already belongs to another image.");
      if (atob(body.base64).length !== photo.size || photo.size > 4 * 1024 * 1024) return fail("Invalid image size.", 400);
      localStorage.setItem(key, body.base64);
      return save({ ...next, photos: draft.photos.map(p => p.requestId === photo.requestId ? { ...p, saved: true } : p) });
    }
    if (body.action === "discard") {
      if ((draft.session.payload && !draft.session.result) || draft.session.pendingCreates?.contact || draft.session.pendingCreates?.vehicle)
        return fail("Unresolved native operations cannot be deleted.");
      localStorage.removeItem(slot); return Response.json({ ok: true });
    }
    return fail("Unsupported fixture operation.", 400);
  };
}
