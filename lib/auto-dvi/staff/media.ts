import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { digest } from "../../shop-dispatch/service";
import { requireThat } from "../../shop-dispatch/model";
import { writeContext, snapshot, type StaffDependencies } from "./service";
import type { StaffMediaStorage } from "../../data/repositories/workflow-inspections";
import type { StaffInspection } from "./model";
const uploadRequest = z.object({
  visitId: z.string().min(1).max(100), sheet: z.string().min(1).max(80), item: z.string().min(1).max(80),
  revision: z.number().int().nonnegative(), requestId: z.string().uuid(), provenance: z.enum(["camera", "upload"]),
  mime: z.enum(["image/jpeg", "image/png", "image/webp"]),
}).strict();
export async function attachStaffPhoto(raw: unknown, bytes: Buffer, deps: StaffDependencies, media: StaffMediaStorage) {
  const req = uploadRequest.parse(raw), context = await writeContext(req.visitId, deps);
  const {access} = context;
  const authorize = async () => {
    const latest = await writeContext(req.visitId, deps, {...access, identity: context.record.identity});
    requireThat(digest(latest.access.config) === digest(access.config), "Inspection policy changed", 409);
  };
  const hash = digest({...req, sha256: createHash("sha256").update(bytes).digest("hex")});
  const reservation = await deps.repository.reservePhoto(access.shopId, {
    requestId: req.requestId, digest: hash, actor: access.actor, visitId: req.visitId, sheet: req.sheet, item: req.item,
    revision: req.revision, state: "reserved", photo: {id: randomBytes(12).toString("hex"), mime: req.mime,
      provenance: req.provenance, actor: access.actor, at: deps.now()},
  }, authorize);
  await authorize();
  if (reservation.state !== "committed")
    await media.upload(reservation.photo.id, bytes, {...req, shopId: access.shopId, actor: access.actor});
  await deps.repository.mutate({
    shopId: access.shopId, visitId: req.visitId, requestId: req.requestId, expectedRevision: req.revision,
    actor: access.actor, at: reservation.photo.at,
    command: {type: "photo", sheet: req.sheet, item: req.item, photo: reservation.photo},
    catalog: access.config!.sheets, defaultSheet: access.config!.defaultSheet, canReview: access.canReview, authorize,
  });
  return snapshot(req.visitId, deps);
}
export async function readStaffPhoto(visitId: string, sheetId: string, itemId: string, mediaId: string, deps: StaffDependencies, media: StaffMediaStorage) {
  const before = await deps.access();
  const inspect = async () => {
    const s = await snapshot(visitId, deps);
    const state = s.inspection as StaffInspection | null;
    const photo = state?.sheets.find(x => x.key === sheetId)?.results[itemId]?.photos.find(p => p.id === mediaId);
    requireThat(photo, "Photo not attached to this visit item", 404);
    return photo;
  };
  const photo = await inspect();
  const file = await media.read(mediaId, before.shopId, visitId);
  await inspect();
  const after = await deps.access();
  requireThat(before.shopId === after.shopId && before.actor === after.actor && file.mime === photo.mime, "Photo access changed", 403);
  return file;
}
