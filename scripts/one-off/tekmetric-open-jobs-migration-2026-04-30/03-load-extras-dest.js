/* eslint-disable */
/**
 * Tekmetric Open Jobs Migration — Snippet 3: LOAD-EXTRAS (destination shop)
 *
 * Paste this whole file into Chrome DevTools Console while you are on
 * shop.tekmetric.com with the DESTINATION shop active (same one Snippet 2
 * just wrote into).
 *
 * It will:
 *   1. prompt you to pick the dump JSON (Snippet 1) and the mapping JSON
 *      (Snippet 2)
 *   2. capture the live x-auth-token
 *   3. verify the active shop matches the dest shop in the mapping file and
 *      is NOT the dump source
 *   4. in dry-run mode (default) print inspection + photo counts per RO
 *      and stop
 *   5. with CONFIRM = true, for each source RO that has a mapped dest RO:
 *        - re-fetch the full inspection content from the source side
 *          (cross-shop with the same token; if Tekmetric refuses, see the
 *          README for the switch-back fallback)
 *        - skip already-attached inspections via a `[migrated]` title prefix
 *        - create equivalent inspections on the dest RO
 *        - download each photo from source and re-upload to dest, attaching
 *          it to the corresponding job / inspection item
 *
 * Re-running is safe: already-attached inspections / photos are detected and
 * skipped via the same kind of `[migrated]` marker used in Snippet 2.
 *
 * If photo upload turns out to be too painful (CORS / multipart S3 quirks)
 * during discovery, comment out the photo loop at the bottom of the run loop
 * and just ship inspections — handle photos manually after the migration.
 */
(async () => {
  const VERSION = '2026-05-01.1-tokenfix';

  // ============================================================
  // SAFETY GATE — defaults to DRY RUN.
  // ============================================================
  const CONFIRM = false;

  // Inspection title marker. Includes the source inspection ID so each
  // migrated inspection is uniquely identifiable on a re-run, even when
  // a single source RO has multiple inspections sharing the same title.
  // Format: "[migrated ins#<srcInspectionId>]"
  const INSPECTION_TITLE_MARKER_PREFIX = '[migrated';
  const INSPECTION_TITLE_MARKER_RE = /\[migrated ins#(\S+?)\]/;
  const INSPECTION_TITLE_MARKER = (srcInspectionId) => `[migrated ins#${srcInspectionId}]`;
  const PHOTO_NOTE_MARKER = '[migrated]';

  // ----- ENDPOINTS (best-effort defaults; confirm against fixtures/) -----
  const ENDPOINTS = {
    base: location.origin,
    inspectionList: (shopId, roId) =>
      `/api/shop/${shopId}/repair-orders/${roId}/inspections`,
    inspectionGet: (shopId, inspectionId) =>
      `/api/shop/${shopId}/inspection/${inspectionId}`,
    inspectionCreate: (shopId) => `/api/shop/${shopId}/inspection`,
    photoList: (shopId, roId) =>
      `/api/shop/${shopId}/repair-order/${roId}/photos`,
    // Photo upload is expected to be a 2-step flow:
    //   1. POST presign request → get { url, fields, key } for S3 PUT/POST
    //   2. PUT/POST file to that S3 url
    //   3. POST attach with the returned key + the dest entity id
    photoPresign: (shopId) => `/api/shop/${shopId}/photo/presign`,
    photoAttach: (shopId) => `/api/shop/${shopId}/photo`,
  };

  // ----- COMMON HELPERS (same shape as Snippets 1+2) ---------------------
  function readShopIdFromUrl() {
    const m = location.pathname.match(/\/(?:admin\/)?shop\/(\d+)/);
    return m ? m[1] : null;
  }
  function readShopNameFromDom() {
    const candidates = document.querySelectorAll(
      '[class*="ShopSwitcher"], [class*="shop-switcher"], [data-testid*="shop"], header'
    );
    for (const el of candidates) {
      const t = (el.textContent || '').trim();
      if (t && t.length < 80 && /[A-Za-z]/.test(t)) {
        return t.replace(/\s+/g, ' ').slice(0, 60);
      }
    }
    return null;
  }
  async function captureXAuthToken() {
    // Same proven extraction as 00-print-token.js — scan localStorage for
    // a JWT-shaped value (raw or wrapped in JSON under .token /
    // .accessToken). The earlier fetch-monkey-patch approach failed
    // because Tekmetric's auth interceptor doesn't run on probe requests
    // fired from this snippet.
    const JWT_RE = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
    for (const k of Object.keys(localStorage)) {
      const v = localStorage.getItem(k) || '';
      if (JWT_RE.test(v)) return v;
      try {
        const parsed = JSON.parse(v);
        if (parsed && typeof parsed.token === 'string' && parsed.token.startsWith('eyJ')) {
          return parsed.token;
        }
        if (parsed && typeof parsed.accessToken === 'string' && parsed.accessToken.startsWith('eyJ')) {
          return parsed.accessToken;
        }
      } catch (_) {}
    }
    return null;
  }
  async function jsonFetch(path, token, init) {
    const url = path.startsWith('http') ? path : `${ENDPOINTS.base}${path}`;
    const res = await fetch(url, {
      ...(init || {}),
      headers: {
        'x-auth-token': token,
        'content-type': 'application/json',
        'accept': 'application/json',
        ...((init && init.headers) || {}),
      },
      credentials: 'include',
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const e = new Error(`${res.status} ${res.statusText} on ${path} :: ${body.slice(0, 300)}`);
      e.status = res.status; e.body = body;
      throw e;
    }
    if (res.status === 204) return null;
    return res.json();
  }
  async function pickJsonFile(promptText) {
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/json,.json';
      input.style.position = 'fixed';
      input.style.top = '20px';
      input.style.left = '20px';
      input.style.zIndex = 999999;
      input.style.padding = '12px';
      input.style.background = '#fff';
      input.style.border = '2px solid #0a0';
      input.title = promptText;
      input.onchange = async () => {
        const f = input.files && input.files[0];
        input.remove();
        if (!f) return reject(new Error('No file picked'));
        try {
          const text = await f.text();
          resolve({ name: f.name, json: JSON.parse(text) });
        } catch (e) {
          reject(e);
        }
      };
      document.body.appendChild(input);
      console.log(`%c[LOAD-EXTRAS] ${promptText}`, 'color:#0a0;font-weight:bold');
      console.log('[LOAD-EXTRAS] (file picker is in the top-left corner of the page)');
    });
  }

  // Translate a source photo's attachment context (jobId / inspectionItemId)
  // to the equivalent destination IDs using the mappings carried forward
  // from Snippet 2 (job mappings) and from this snippet's inspection-create
  // step (inspection + inspection-item mappings). Falls back to RO-level
  // attachment when no equivalent dest entity exists.
  function resolvePhotoTarget(sourcePhoto, ctx) {
    const out = { destJobId: null, destInspectionItemId: null };
    const srcJobId = sourcePhoto.jobId ?? sourcePhoto.repairOrderJobId ?? null;
    if (srcJobId != null) {
      const m = ctx.jobIdMap.get(String(srcJobId));
      if (m) out.destJobId = m;
    }
    const srcItemId = sourcePhoto.inspectionItemId ?? sourcePhoto.inspectionTaskId ?? sourcePhoto.taskId ?? null;
    if (srcItemId != null) {
      const m = ctx.inspectionItemIdMap.get(String(srcItemId));
      if (m) out.destInspectionItemId = m;
    }
    return out;
  }

  // Photo upload helper. Mirrors the expected presign-then-PUT-then-attach
  // flow. Adjust as needed once you have the captured fixtures.
  async function uploadPhotoToDest({
    token, destShopId, sourcePhoto, destRoId, destJobId, destInspectionItemId,
  }) {
    // 1. Download photo bytes from source CDN.
    const srcUrl = sourcePhoto.url || sourcePhoto.fileUrl || sourcePhoto.location;
    if (!srcUrl) throw new Error('source photo has no url');
    const blobRes = await fetch(srcUrl, { credentials: 'include' });
    if (!blobRes.ok) throw new Error(`source download ${blobRes.status} on ${srcUrl}`);
    const blob = await blobRes.blob();
    const filename = sourcePhoto.fileName || sourcePhoto.name || `migrated-${Date.now()}.jpg`;

    // 2. Ask dest for a presigned upload URL.
    const presign = await jsonFetch(ENDPOINTS.photoPresign(destShopId), token, {
      method: 'POST',
      body: JSON.stringify({
        fileName: filename,
        contentType: blob.type || 'image/jpeg',
        size: blob.size,
      }),
    });
    if (!presign || !presign.url) throw new Error('presign returned no url');

    // 3. PUT bytes to S3 (presign.fields means a multipart POST instead).
    if (presign.fields) {
      const fd = new FormData();
      for (const [k, v] of Object.entries(presign.fields)) fd.append(k, v);
      fd.append('file', blob, filename);
      const s3res = await fetch(presign.url, { method: 'POST', body: fd });
      if (!s3res.ok) throw new Error(`S3 multipart POST ${s3res.status}`);
    } else {
      const s3res = await fetch(presign.url, {
        method: 'PUT',
        headers: { 'content-type': blob.type || 'image/jpeg' },
        body: blob,
      });
      if (!s3res.ok) throw new Error(`S3 PUT ${s3res.status}`);
    }

    // 4. Attach to the dest entity.
    const attachBody = {
      key: presign.key || presign.objectKey,
      fileName: filename,
      contentType: blob.type || 'image/jpeg',
      repairOrderId: destRoId || null,
      jobId: destJobId || null,
      inspectionItemId: destInspectionItemId || null,
      note: `${PHOTO_NOTE_MARKER} from src photo id=${sourcePhoto.id || ''}`,
    };
    return jsonFetch(ENDPOINTS.photoAttach(destShopId), token, {
      method: 'POST',
      body: JSON.stringify(attachBody),
    });
  }

  // ----- MAIN ------------------------------------------------------------
  console.log(`%c[Tekmetric Migration LOAD-EXTRAS v${VERSION}] starting…`, 'color:#0a0;font-weight:bold');

  const destShopId = readShopIdFromUrl();
  if (!destShopId) {
    console.error('[LOAD-EXTRAS] No shop ID detected in URL. Open the destination shop and re-paste.');
    return;
  }
  const destShopName = readShopNameFromDom() || `shop-${destShopId}`;

  const { name: dumpName, json: dump } = await pickJsonFile('Pick the tekmetric-open-jobs-dump-*.json from Snippet 1');
  if (dump.schema !== 'tekmetric-open-jobs-dump') {
    console.error('[LOAD-EXTRAS] First file is not a Snippet-1 dump.');
    return;
  }
  const { name: mapName, json: mapPayload } = await pickJsonFile('Pick the tekmetric-migration-mapping-*.json from Snippet 2');
  if (mapPayload.schema !== 'tekmetric-migration-mapping') {
    console.error('[LOAD-EXTRAS] Second file is not a Snippet-2 mapping.');
    return;
  }

  if (Number(dump.source.shopId) === Number(destShopId)) {
    console.error(`[LOAD-EXTRAS] REFUSING TO RUN: dump source shop id (${dump.source.shopId}) equals active shop id (${destShopId}). You appear to be on the source shop. Switch to the destination and re-paste.`);
    return;
  }
  if (Number(mapPayload.dest.shopId) !== Number(destShopId)) {
    console.error(`[LOAD-EXTRAS] REFUSING TO RUN: mapping was written for dest shop id ${mapPayload.dest.shopId} but the active shop is ${destShopId}. Switch to the correct destination and re-paste.`);
    return;
  }

  console.log('[LOAD-EXTRAS] Capturing x-auth-token from live session…');
  const token = await captureXAuthToken();
  if (!token) {
    console.error('[LOAD-EXTRAS] Could not capture x-auth-token. Click around in Tekmetric to trigger a request, then re-paste.');
    return;
  }

  // Index mapping by sourceRoId / sourceRoNumber for quick lookup.
  const mapBySourceRoId = new Map();
  for (const m of (mapPayload.mapping || [])) mapBySourceRoId.set(String(m.sourceRoId), m);

  const dumpByRoId = new Map();
  for (const r of dump.repairOrders) dumpByRoId.set(String(r.sourceRoId), r);

  const work = [];
  for (const r of dump.repairOrders) {
    const m = mapBySourceRoId.get(String(r.sourceRoId));
    if (!m) continue; // unmigrated — Snippet 2 either failed or hasn't run for it
    if (!r.repairOrder) continue;
    work.push({ src: r, dest: m });
  }

  // ----- PLAN -----------------------------------------------------------
  const inspectionTotal = work.reduce((acc, w) => acc + (w.src.inspections || []).length, 0);
  // Note: photo counts are intentionally NOT prefetched here. Doing so would
  // require one extra `photoList` call per source RO (and a cross-shop API
  // call at that), which doubles the discovery surface area and roughly
  // doubles the dry-run runtime for no real planning benefit — we still
  // list and skip-or-upload each photo individually during the write
  // phase. The plan therefore just labels the photo column "fetched per-RO
  // during run". If you need an exact count up front, look at the source
  // shop's RO detail screens directly.
  console.log('%c[LOAD-EXTRAS] Plan:', 'color:#0a0;font-weight:bold');
  console.table([{
    sourceShop: dump.source.shopName,
    sourceShopId: dump.source.shopId,
    destShop: destShopName,
    destShopId,
    rosToProcess: work.length,
    inspectionsToCopy: inspectionTotal,
    photosToCopy: 'fetched per-RO during run (not prefetched in dry-run for perf)',
    confirm: CONFIRM,
  }]);

  console.log('[LOAD-EXTRAS] First few RO-mappings:');
  console.table(work.slice(0, 5).map((w) => ({
    sourceRo: w.src.sourceRoNumber,
    destRo: w.dest.destRoNumber,
    inspections: (w.src.inspections || []).length,
  })));

  if (!CONFIRM) {
    console.log('%c[LOAD-EXTRAS] DRY RUN — no writes performed.', 'color:#a60;font-weight:bold');
    console.log('[LOAD-EXTRAS] Photo counts are not prefetched in dry-run (see plan note). Inspection counts are exact.');
    console.log('[LOAD-EXTRAS] Set CONFIRM = true at the top of this snippet and re-paste to actually copy.');
    return;
  }

  const promptMsg =
    `COPY inspections + photos for ${work.length} ROs from\n` +
    `  ${dump.source.shopName} (id=${dump.source.shopId}) [source]\n` +
    `into\n` +
    `  ${destShopName} (id=${destShopId}) [dest] ?\n\n` +
    `Type the destination shop id (${destShopId}) to confirm.`;
  const typed = window.prompt(promptMsg, '');
  if (String(typed).trim() !== String(destShopId)) {
    console.error('[LOAD-EXTRAS] Confirmation failed. Aborted.');
    return;
  }

  // ----- WRITE PHASE ----------------------------------------------------
  const successes = [];
  const failures = [];

  for (let i = 0; i < work.length; i++) {
    const w = work[i];
    const srcShopId = dump.source.shopId;
    let step = 'start';
    let inspectionsCreated = 0;
    let photosCreated = 0;
    let srcPhotos = [];
    try {
      // -------- ID MAPPINGS for photo target resolution --------
      // Job-id mapping comes from Snippet 2's mapping output.
      const jobIdMap = new Map();
      for (const jm of (w.dest.jobMappings || [])) {
        if (jm.srcJobId != null && jm.destJobId != null) jobIdMap.set(String(jm.srcJobId), jm.destJobId);
      }
      // Inspection + inspection-item id maps are populated below as we
      // create inspections.
      const inspectionIdMap = new Map(); // srcInspectionId -> destInspectionId
      const inspectionItemIdMap = new Map(); // srcItemId -> destItemId

      // -------- INSPECTIONS --------
      // Pull existing dest inspection list to skip ones already migrated.
      step = 'listDestInspections';
      let existingDest = [];
      try {
        const r = await jsonFetch(ENDPOINTS.inspectionList(destShopId, w.dest.destRoId), token);
        existingDest = Array.isArray(r) ? r : (r.content || []);
      } catch (_) { existingDest = []; }
      // Key dest inspections by SOURCE inspection ID extracted from the
      // marker. Title-only matching would mis-associate two source
      // inspections that share the same title on the same RO.
      const alreadyHaveBySrcInsId = new Map(); // srcInspectionId(string) -> existing dest inspection
      for (const ins of existingDest) {
        const t = (ins.title || ins.name || '');
        const m = t.match(INSPECTION_TITLE_MARKER_RE);
        if (m) alreadyHaveBySrcInsId.set(m[1], ins);
      }

      // Helper to walk a source inspection's task tree and pair it to a
      // freshly-created dest inspection's task tree by group+ordinal index.
      // Tekmetric inspection task IDs are not stable across shops, so we
      // rely on the structural shape we just sent.
      function pairInspectionItems(srcIns, destIns) {
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

      for (const insSummary of (w.src.inspections || [])) {
        const baseTitle = (insSummary.title || `Inspection ${insSummary.id}`).trim();
        const srcInsKey = String(insSummary.id);

        // If this inspection is already migrated, recover the item id map by
        // re-fetching the dest inspection's content and pairing to the
        // source's full content (only possible if the dump was augmented).
        if (alreadyHaveBySrcInsId.has(srcInsKey)) {
          const destIns = alreadyHaveBySrcInsId.get(srcInsKey);
          inspectionIdMap.set(srcInsKey, destIns.id);
          if (insSummary.fullContent) {
            try {
              const destFull = await jsonFetch(ENDPOINTS.inspectionGet(destShopId, destIns.id), token);
              pairInspectionItems(insSummary.fullContent, destFull);
            } catch (_) {}
          }
          continue;
        }

        // Resolve full source inspection content. Prefer augmented dump
        // (`fullContent` already attached via 01b-augment-source-inspections.js);
        // fall back to live cross-shop fetch.
        step = `getSourceInspection(id=${insSummary.id})`;
        let srcIns;
        if (insSummary.fullContent) {
          srcIns = insSummary.fullContent;
        } else {
          try {
            srcIns = await jsonFetch(ENDPOINTS.inspectionGet(srcShopId, insSummary.id), token);
          } catch (e) {
            throw new Error(`source inspection fetch failed: ${e.message}. The current Tekmetric session may not allow cross-shop reads. Re-run 01b-augment-source-inspections.js on the source shop and re-paste this snippet with the augmented dump file. See README "Cross-shop inspection read".`);
          }
        }

        step = `createDestInspection("${baseTitle}")`;
        const createBody = {
          repairOrderId: w.dest.destRoId,
          title: `${INSPECTION_TITLE_MARKER(insSummary.id)} ${baseTitle}`,
          inspectionTasks: srcIns.inspectionTasks || srcIns.groups || [],
          notes: srcIns.notes || null,
        };
        const createdIns = await jsonFetch(ENDPOINTS.inspectionCreate(destShopId), token, {
          method: 'POST',
          body: JSON.stringify(createBody),
        });
        if (createdIns && createdIns.id != null) {
          inspectionIdMap.set(String(insSummary.id), createdIns.id);
          pairInspectionItems(srcIns, createdIns);
        }
        inspectionsCreated++;
      }

      // -------- PHOTOS --------
      step = 'listSourcePhotos';
      try {
        const r = await jsonFetch(ENDPOINTS.photoList(srcShopId, w.src.sourceRoId), token);
        srcPhotos = Array.isArray(r) ? r : (r.content || []);
      } catch (e) {
        console.warn(`[LOAD-EXTRAS] photo list failed for source RO #${w.src.sourceRoNumber}: ${e.message}`);
        srcPhotos = [];
      }

      step = 'listDestPhotos';
      let destPhotos = [];
      try {
        const r = await jsonFetch(ENDPOINTS.photoList(destShopId, w.dest.destRoId), token);
        destPhotos = Array.isArray(r) ? r : (r.content || []);
      } catch (_) { destPhotos = []; }
      const alreadyMigratedPhotoSrcIds = new Set();
      for (const p of destPhotos) {
        const note = p.note || p.description || '';
        // Photo IDs in Tekmetric are usually numeric, but match any
        // non-space token here so UUID/string IDs also dedupe correctly.
        const m = note.match(/from src photo id=(\S+)/);
        if (m) alreadyMigratedPhotoSrcIds.add(m[1]);
      }

      let photosFailed = 0;
      for (const photo of srcPhotos) {
        if (photo.id && alreadyMigratedPhotoSrcIds.has(String(photo.id))) continue;
        const target = resolvePhotoTarget(photo, { jobIdMap, inspectionItemIdMap });
        step = `uploadPhoto(id=${photo.id || '?'} → job=${target.destJobId || '-'} item=${target.destInspectionItemId || '-'})`;
        try {
          await uploadPhotoToDest({
            token,
            destShopId,
            sourcePhoto: photo,
            destRoId: w.dest.destRoId,
            destJobId: target.destJobId,
            destInspectionItemId: target.destInspectionItemId,
          });
          photosCreated++;
        } catch (pe) {
          // Per-photo failures must not abort the RO, but they MUST show up
          // in the failures table so the operator can manually re-attach
          // them later. (RO-level success can otherwise hide several
          // dropped photos.)
          photosFailed++;
          console.warn(`[LOAD-EXTRAS] photo failed on src RO #${w.src.sourceRoNumber} photo id=${photo.id || '?'}: ${pe.message}`);
          failures.push({
            sourceRo: w.src.sourceRoNumber,
            destRo: w.dest.destRoNumber,
            kind: 'photo',
            sourcePhotoId: photo.id ?? null,
            sourcePhotoUrl: photo.url || photo.fileUrl || photo.signedUrl || null,
            destJobId: target.destJobId || null,
            destInspectionItemId: target.destInspectionItemId || null,
            step,
            error: (pe.body || pe.message || '').slice(0, 300),
          });
        }
      }

      successes.push({
        sourceRo: w.src.sourceRoNumber,
        destRo: w.dest.destRoNumber,
        inspectionsCreated,
        photosCreated,
        photosFailed,
        sourcePhotosTotal: srcPhotos.length,
      });
      console.log(`[LOAD-EXTRAS] (${i + 1}/${work.length}) #${w.src.sourceRoNumber} → #${w.dest.destRoNumber}: +${inspectionsCreated} inspections, +${photosCreated} photos`);
    } catch (err) {
      console.error(`[LOAD-EXTRAS] FAILED RO #${w.src.sourceRoNumber} at step "${step}": ${err.message}`);
      failures.push({
        sourceRo: w.src.sourceRoNumber,
        destRo: w.dest.destRoNumber,
        step,
        error: (err.body || err.message || '').slice(0, 300),
      });
    }
  }

  console.log('%c[LOAD-EXTRAS] Successes:', 'color:#0a0;font-weight:bold');
  console.table(successes);
  if (failures.length) {
    console.log('%c[LOAD-EXTRAS] Failures:', 'color:#a00;font-weight:bold');
    console.table(failures);
  } else {
    console.log('[LOAD-EXTRAS] No failures.');
  }
  console.log('[LOAD-EXTRAS] Done. Spot-check a handful of ROs in the destination Tekmetric UI to verify inspections + photos look right.');
})();
