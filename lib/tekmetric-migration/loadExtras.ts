/**
 * Server-side port of snippet 03-load-extras-dest.js — inspections + photos.
 *
 * Walks each successfully-mapped RO from the load-core step and:
 *   - Fetches the source inspection content (if not augmented in dump)
 *   - Skips already-migrated inspections by `[migrated ins#X]` title marker
 *   - Creates dest inspections with the marker baked into the title
 *   - Downloads each photo from source CDN, presign-uploads to dest, attaches
 *
 * Photo upload remains best-effort — per-photo failures are recorded into
 * the mapping `failures` field rather than aborting the RO. This mirrors
 * the snippet behaviour exactly.
 */
import {
  tekFetch,
  TekFetchError,
  inspectionTitleMarker,
  INSPECTION_TITLE_MARKER_RE,
  PHOTO_NOTE_MARKER,
} from "./client";

export const EXTRAS_SCHEMA_VERSION = "2026-04-30.1-server";

const ENDPOINTS = {
  inspectionList: (shopId: number, roId: number) =>
    `/api/shop/${shopId}/repair-orders/${roId}/inspections`,
  inspectionGet: (shopId: number, inspectionId: number) =>
    `/api/shop/${shopId}/inspection/${inspectionId}`,
  inspectionCreate: (shopId: number) => `/api/shop/${shopId}/inspection`,
  photoList: (shopId: number, roId: number) =>
    `/api/shop/${shopId}/repair-order/${roId}/photos`,
  photoPresign: (shopId: number) => `/api/shop/${shopId}/photo/presign`,
  photoAttach: (shopId: number) => `/api/shop/${shopId}/photo`,
};

export interface LoadExtrasOptions {
  /** dest shop id */
  destShopId: number;
  /** source shop id (for cross-shop inspection content fetch fallback) */
  sourceShopId: number;
  /** dest token (used for all dest writes + same-token cross-shop fetch) */
  destToken: string;
  /** optional source token — when present the orchestrator uses it for
   *  cross-shop reads (preferred for post-Tekmetric-account-transfer
   *  case where the dest token has no source-shop access). */
  sourceToken?: string | null;
  dump: any;
  mapping: any; // load-core mapping payload
  dryRun?: boolean;
  onProgress?: (msg: { phase: string; index?: number; total?: number; detail?: string }) => Promise<void> | void;
}

export interface LoadExtrasResult {
  successes: Array<{
    sourceRo: any;
    destRo: any;
    inspectionsCreated: number;
    photosCreated: number;
    photosFailed: number;
    sourcePhotosTotal: number;
  }>;
  failures: Array<{
    sourceRo: any;
    destRo?: any;
    kind?: string;
    sourcePhotoId?: any;
    sourcePhotoUrl?: any;
    destJobId?: any;
    destInspectionItemId?: any;
    step: string;
    error: string;
  }>;
}

function pickSrcToken(opts: LoadExtrasOptions): string {
  return opts.sourceToken || opts.destToken;
}

function resolvePhotoTarget(
  sourcePhoto: any,
  jobIdMap: Map<string, number>,
  inspectionItemIdMap: Map<string, number>,
) {
  const out: { destJobId: number | null; destInspectionItemId: number | null } = {
    destJobId: null,
    destInspectionItemId: null,
  };
  const srcJobId = sourcePhoto.jobId ?? sourcePhoto.repairOrderJobId ?? null;
  if (srcJobId != null) {
    const m = jobIdMap.get(String(srcJobId));
    if (m) out.destJobId = m;
  }
  const srcItemId =
    sourcePhoto.inspectionItemId ?? sourcePhoto.inspectionTaskId ?? sourcePhoto.taskId ?? null;
  if (srcItemId != null) {
    const m = inspectionItemIdMap.get(String(srcItemId));
    if (m) out.destInspectionItemId = m;
  }
  return out;
}

async function uploadPhotoToDest(args: {
  destToken: string;
  destShopId: number;
  sourcePhoto: any;
  destRoId: number;
  destJobId: number | null;
  destInspectionItemId: number | null;
}) {
  const { destToken, destShopId, sourcePhoto, destRoId, destJobId, destInspectionItemId } = args;
  const srcUrl = sourcePhoto.url || sourcePhoto.fileUrl || sourcePhoto.location;
  if (!srcUrl) throw new Error("source photo has no url");
  const blobRes = await fetch(srcUrl);
  if (!blobRes.ok) throw new Error(`source download ${blobRes.status} on ${srcUrl}`);
  const blob = await blobRes.blob();
  const filename = sourcePhoto.fileName || sourcePhoto.name || `migrated-${Date.now()}.jpg`;

  const presign: any = await tekFetch(destToken, ENDPOINTS.photoPresign(destShopId), {
    method: "POST",
    body: { fileName: filename, contentType: blob.type || "image/jpeg", size: blob.size },
  });
  if (!presign?.url) throw new Error("presign returned no url");

  if (presign.fields) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(presign.fields)) fd.append(k, v as any);
    fd.append("file", blob, filename);
    const s3res = await fetch(presign.url, { method: "POST", body: fd });
    if (!s3res.ok) throw new Error(`S3 multipart POST ${s3res.status}`);
  } else {
    const s3res = await fetch(presign.url, {
      method: "PUT",
      headers: { "content-type": blob.type || "image/jpeg" },
      body: blob,
    });
    if (!s3res.ok) throw new Error(`S3 PUT ${s3res.status}`);
  }

  return tekFetch(destToken, ENDPOINTS.photoAttach(destShopId), {
    method: "POST",
    body: {
      key: presign.key || presign.objectKey,
      fileName: filename,
      contentType: blob.type || "image/jpeg",
      repairOrderId: destRoId || null,
      jobId: destJobId || null,
      inspectionItemId: destInspectionItemId || null,
      note: `${PHOTO_NOTE_MARKER} from src photo id=${sourcePhoto.id || ""}`,
    },
  });
}

export async function executeLoadExtras(opts: LoadExtrasOptions): Promise<LoadExtrasResult> {
  const { destShopId, sourceShopId, destToken, dump, mapping } = opts;
  const srcToken = pickSrcToken(opts);

  const mapBySourceRoId = new Map<string, any>();
  for (const m of mapping.mapping || []) mapBySourceRoId.set(String(m.sourceRoId), m);

  const work: Array<{ src: any; dest: any }> = [];
  for (const r of dump.repairOrders || []) {
    const m = mapBySourceRoId.get(String(r.sourceRoId));
    if (!m || !r.repairOrder) continue;
    work.push({ src: r, dest: m });
  }

  const successes: LoadExtrasResult["successes"] = [];
  const failures: LoadExtrasResult["failures"] = [];

  if (opts.dryRun) {
    // No mutations — return a planning-shaped result for the wizard.
    for (const w of work) {
      successes.push({
        sourceRo: w.src.sourceRoNumber,
        destRo: w.dest.destRoNumber,
        inspectionsCreated: (w.src.inspections || []).length,
        photosCreated: 0,
        photosFailed: 0,
        sourcePhotosTotal: 0,
      });
    }
    return { successes, failures };
  }

  for (let i = 0; i < work.length; i++) {
    const w = work[i];
    let step = "start";
    let inspectionsCreated = 0;
    let photosCreated = 0;
    let photosFailed = 0;
    let srcPhotosCount = 0;
    try {
      const jobIdMap = new Map<string, number>();
      for (const jm of w.dest.jobMappings || []) {
        if (jm.srcJobId != null && jm.destJobId != null) {
          jobIdMap.set(String(jm.srcJobId), jm.destJobId);
        }
      }
      const inspectionIdMap = new Map<string, number>();
      const inspectionItemIdMap = new Map<string, number>();

      step = "listDestInspections";
      let existingDest: any[] = [];
      try {
        const r: any = await tekFetch(destToken, ENDPOINTS.inspectionList(destShopId, w.dest.destRoId));
        existingDest = Array.isArray(r) ? r : r?.content || [];
      } catch {
        existingDest = [];
      }
      const alreadyHaveBySrcInsId = new Map<string, any>();
      for (const ins of existingDest) {
        const t = ins.title || ins.name || "";
        const m = t.match(INSPECTION_TITLE_MARKER_RE);
        if (m) alreadyHaveBySrcInsId.set(m[1], ins);
      }

      function pairInspectionItems(srcIns: any, destIns: any) {
        const srcGroups = srcIns.inspectionTasks || srcIns.groups || [];
        const destGroups = destIns.inspectionTasks || destIns.groups || [];
        for (let g = 0; g < srcGroups.length && g < destGroups.length; g++) {
          const sTasks = srcGroups[g].tasks || [];
          const dTasks = destGroups[g].tasks || [];
          for (let t = 0; t < sTasks.length && t < dTasks.length; t++) {
            const sId = sTasks[t].id ?? sTasks[t].taskId;
            const dId = dTasks[t].id ?? dTasks[t].taskId;
            if (sId != null && dId != null) inspectionItemIdMap.set(String(sId), dId);
          }
        }
      }

      for (const insSummary of w.src.inspections || []) {
        const baseTitle = (insSummary.title || `Inspection ${insSummary.id}`).trim();
        const srcInsKey = String(insSummary.id);

        if (alreadyHaveBySrcInsId.has(srcInsKey)) {
          const destIns = alreadyHaveBySrcInsId.get(srcInsKey);
          inspectionIdMap.set(srcInsKey, destIns.id);
          if (insSummary.fullContent) {
            try {
              const destFull: any = await tekFetch(
                destToken,
                ENDPOINTS.inspectionGet(destShopId, destIns.id),
              );
              pairInspectionItems(insSummary.fullContent, destFull);
            } catch {/* */}
          }
          continue;
        }

        step = `getSourceInspection(id=${insSummary.id})`;
        let srcIns: any;
        if (insSummary.fullContent) {
          srcIns = insSummary.fullContent;
        } else {
          try {
            srcIns = await tekFetch(srcToken, ENDPOINTS.inspectionGet(sourceShopId, insSummary.id));
          } catch (e: any) {
            throw new Error(
              `source inspection fetch failed: ${e.message}. Re-run dump with augmented inspections (or supply a source token).`,
            );
          }
        }

        step = `createDestInspection("${baseTitle}")`;
        const createBody = {
          repairOrderId: w.dest.destRoId,
          title: `${inspectionTitleMarker(insSummary.id)} ${baseTitle}`,
          inspectionTasks: srcIns.inspectionTasks || srcIns.groups || [],
          notes: srcIns.notes || null,
        };
        const createdIns: any = await tekFetch(destToken, ENDPOINTS.inspectionCreate(destShopId), {
          method: "POST",
          body: createBody,
        });
        if (createdIns?.id != null) {
          inspectionIdMap.set(String(insSummary.id), createdIns.id);
          pairInspectionItems(srcIns, createdIns);
        }
        inspectionsCreated++;
      }

      step = "listSourcePhotos";
      let srcPhotos: any[] = [];
      try {
        const r: any = await tekFetch(srcToken, ENDPOINTS.photoList(sourceShopId, w.src.sourceRoId));
        srcPhotos = Array.isArray(r) ? r : r?.content || [];
      } catch {
        srcPhotos = [];
      }
      srcPhotosCount = srcPhotos.length;

      step = "listDestPhotos";
      let destPhotos: any[] = [];
      try {
        const r: any = await tekFetch(destToken, ENDPOINTS.photoList(destShopId, w.dest.destRoId));
        destPhotos = Array.isArray(r) ? r : r?.content || [];
      } catch {
        destPhotos = [];
      }
      const alreadyMigratedPhotoSrcIds = new Set<string>();
      for (const p of destPhotos) {
        const note = p.note || p.description || "";
        const m = note.match(/from src photo id=(\S+)/);
        if (m) alreadyMigratedPhotoSrcIds.add(m[1]);
      }

      for (const photo of srcPhotos) {
        if (photo.id && alreadyMigratedPhotoSrcIds.has(String(photo.id))) continue;
        const target = resolvePhotoTarget(photo, jobIdMap, inspectionItemIdMap);
        step = `uploadPhoto(id=${photo.id || "?"})`;
        try {
          await uploadPhotoToDest({
            destToken,
            destShopId,
            sourcePhoto: photo,
            destRoId: w.dest.destRoId,
            destJobId: target.destJobId,
            destInspectionItemId: target.destInspectionItemId,
          });
          photosCreated++;
        } catch (pe: any) {
          photosFailed++;
          failures.push({
            sourceRo: w.src.sourceRoNumber,
            destRo: w.dest.destRoNumber,
            kind: "photo",
            sourcePhotoId: photo.id ?? null,
            sourcePhotoUrl: photo.url || photo.fileUrl || null,
            destJobId: target.destJobId,
            destInspectionItemId: target.destInspectionItemId,
            step,
            error: (pe.body || pe.message || "").slice(0, 300),
          });
        }
      }

      successes.push({
        sourceRo: w.src.sourceRoNumber,
        destRo: w.dest.destRoNumber,
        inspectionsCreated,
        photosCreated,
        photosFailed,
        sourcePhotosTotal: srcPhotosCount,
      });
      if (opts.onProgress) {
        await opts.onProgress({
          phase: "load-extras",
          index: i + 1,
          total: work.length,
          detail: `#${w.src.sourceRoNumber} → #${w.dest.destRoNumber}`,
        });
      }
    } catch (err: any) {
      const msg =
        err instanceof TekFetchError ? `${err.status} ${err.message}` : err.message || String(err);
      failures.push({
        sourceRo: w.src.sourceRoNumber,
        destRo: w.dest.destRoNumber,
        step,
        error: msg.slice(0, 300),
      });
    }
  }

  return { successes, failures };
}
