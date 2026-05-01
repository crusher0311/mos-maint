/* eslint-disable */
/**
 * Tekmetric Open Jobs Migration — Snippet 2: LOAD-CORE (destination shop)
 *
 * Paste this whole file into Chrome DevTools Console while you are on
 * shop.tekmetric.com with the DESTINATION shop active.
 *
 * It will:
 *   1. prompt you to pick the dump JSON file produced by Snippet 1
 *   2. capture the live x-auth-token
 *   3. verify the active shop is NOT the same one the dump came from
 *   4. in dry-run mode (default), print exactly what it WOULD create and stop
 *   5. with CONFIRM = true (see flag below), for each source RO:
 *        - skip if a `[migrated from RO#X]` marker is already present in dest
 *        - create or match the customer
 *        - create or match the vehicle, attached to the customer
 *        - create the RO with header / mileage / service writer / appointment
 *          and the customer concerns prefixed with the migration marker
 *        - POST every job (with labor + parts) onto the new RO
 *   6. download a tekmetric-migration-mapping-{ts}.json with the
 *      sourceRoId/sourceRoNumber → destRoId/destRoNumber map for Snippet 3.
 *
 * Re-running is safe: already-migrated source ROs are skipped via the marker.
 *
 * After it finishes successfully, paste 03-load-extras-dest.js.
 */
(async () => {
  const VERSION = '2026-05-01.1-tokenfix';

  // ============================================================
  // SAFETY GATE — defaults to DRY RUN. Flip to true to actually
  // create ROs / jobs in the destination.
  // ============================================================
  const CONFIRM = false;

  // Same-shop smoke test toggle. Defaults to false: refuses to load a dump
  // back into the same shop it came from (safety net against picking the
  // wrong active shop pre-transfer).
  //
  // Set to true to allow same-shop loading. Useful for an end-to-end smoke
  // of the dump-then-load pipeline against your own shop (Service Solutions
  // Garage / 14245) before the real run. With source IDs preserved (see
  // USE_SOURCE_IDS_DIRECT below) the new ROs will reuse the existing
  // customer / vehicle / labor-rate rows in your shop, so no duplicates
  // get created — only new ROs do.
  const ALLOW_SAME_SHOP_SMOKE_TEST = false;

  // For tonight's real run, Tekmetric's account transfer preserves customer,
  // vehicle, and labor-rate IDs across the transfer. The dumped source IDs
  // therefore still resolve in the destination shop and can be used directly
  // as `customer.id` / `vehicle.id` / `laborRate.id` on the RO-create payload.
  // This matches the proven flow from 04-clone-ro-same-shop.js.
  //
  // Set to false ONLY if you discover post-transfer that IDs were NOT
  // preserved — that flips on the legacy match-by-email/VIN-or-create path
  // (kept for safety, but unused by default).
  const USE_SOURCE_IDS_DIRECT = true;

  // On any per-job failure during a load, set the partially-populated
  // destination RO to status=DELETED so the dest Job Board doesn't fill up
  // with broken half-ROs that someone has to clean up by hand. The RO
  // sticks around in DELETED state for forensics.
  const AUTO_ROLLBACK_PARTIAL_RO = true;

  // Marker prefixed onto the destination RO's first customer concern so we
  // can detect already-migrated ROs on a re-run.
  const MIGRATION_MARKER = (sourceRoNumber) => `[migrated from RO#${sourceRoNumber}]`;
  const MIGRATION_MARKER_RE = /\[migrated from RO#(\d+)\]/;

  // ----- ENDPOINTS (confirmed against HAR captures + 04-clone-ro-same-shop
  //                  smoke test that successfully cloned RO #62 in shop 14245
  //                  with all 5 concerns and 12 jobs verbatim) --------------
  const ENDPOINTS = {
    base: location.origin,
    // Job Board listing on DEST — used to scan for already-migrated markers.
    jobBoardList: (shopId, page, size) =>
      `/api/shop/${shopId}/repair-order?status=ESTIMATE,WORK_IN_PROGRESS&page=${page}&size=${size}&sort=updatedDate,desc`,
    // RO header / metadata. NOTE: returns jobs:null and may return concerns
    // depending on Tekmetric build, hence the dedicated concerns endpoint.
    repairOrderDetail: (shopId, roId) =>
      `/api/shop/${shopId}/repair-order/${roId}`,
    // Concerns — authoritative per-RO list. Used during marker pre-scan
    // when RO summary/detail doesn't expose customerConcerns.
    repairOrderConcerns: (roId) =>
      `/api/repair-orders/${roId}/customer-concerns`,
    // Legacy customer/vehicle search — only used if USE_SOURCE_IDS_DIRECT=false.
    customerSearch: (shopId, q) =>
      `/api/shop/${shopId}/customer?search=${encodeURIComponent(q)}&page=0&size=20`,
    customerCreate: (shopId) => `/api/shop/${shopId}/customer`,
    vehicleSearch: (shopId, q) =>
      `/api/shop/${shopId}/vehicle?search=${encodeURIComponent(q)}&page=0&size=20`,
    vehicleCreate: (shopId) => `/api/shop/${shopId}/vehicle`,
    // Create RO — confirmed-working endpoint from 04-clone-ro-same-shop.js.
    // NOT the per-shop variant (`/api/shop/{shopId}/repair-order`) — that
    // one is the GET listing endpoint; POSTing to it returns 404/405.
    repairOrderCreate: () => `/api/repair-order/create`,
    // Set vehicle mileage (PUT) — proven in 04 smoke test.
    vehicleMileage: (newRoId) => `/api/repair-order/${newRoId}/vehicle-mileage`,
    // Append a customer concern to an RO (POST). Proven in 04 smoke test.
    addConcern: (newRoId) => `/api/repair-orders/${newRoId}/customer-concerns`,
    // Job create — both empty-create and populate POST to the same path
    // (the body shape decides which mode).
    jobCreate: (shopId) => `/api/shop/${shopId}/job`,
    // Status PUT — used by auto-rollback to set partial ROs to DELETED.
    roStatus: (roId) => `/api/repair-order/${roId}/status`,
  };

  // appointmentOption: GET returns string enum, POST expects numeric Long.
  // Confirmed in HAR: "DROP" -> 2. Default to 2 (drop-off) for any string
  // we don't recognize so the create doesn't 400 on an unknown enum.
  const APPT_OPTION_MAP = { DROP: 2, WAIT: 1, PICKUP: 3 };
  function normalizeApptOption(v) {
    if (typeof v === 'number') return v;
    if (typeof v === 'string') return APPT_OPTION_MAP[v] ?? 2;
    return 2;
  }

  const PAGE_SIZE = 50;

  // ----- COMMON HELPERS (same shape as Snippet 1) ------------------------
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
      e.status = res.status;
      e.body = body;
      throw e;
    }
    if (res.status === 204) return null;
    return res.json();
  }
  function downloadJson(filename, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
  }
  function ts() {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
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
      console.log(`%c[LOAD-CORE] ${promptText}`, 'color:#0a0;font-weight:bold');
      console.log('[LOAD-CORE] (file picker is in the top-left corner of the page)');
    });
  }

  // ----- DOMAIN HELPERS --------------------------------------------------
  //
  // All helpers below are ported verbatim from 04-clone-ro-same-shop.js,
  // which we proved end-to-end against shop 14245 / RO #62 (5 concerns,
  // 12 jobs, all parts + labor preserved).
  //
  // Why job-create is two-step:
  //   A single fat POST with id=null does NOT work — Tekmetric 500s.
  //   The real flow is:
  //     1. POST {name, repairOrderId, syncPartsAttachedToNonQuotedOrders:false}
  //        -> returns the freshly minted empty job (with id, defaults).
  //     2. POST that returned object back, mutated to set the source job's
  //        name/status/technician/etc and with parts/labor REPLACED by lean
  //        items each carrying a `tempId: <random float>` and `jobId: <new id>`.
  //   Most of the bloat Tekmetric returns on the GET is server-managed and
  //   ignored on input — sending the GET shape verbatim is what triggers
  //   the 500.

  // Lean part shape — matches the populate POST captured in HAR. We carry
  // commonly-meaningful descriptor / tire fields and drop everything tied
  // to source-RO state (orders, inventory, invoices, etc.).
  function leanPart(p, newJobId) {
    const out = {
      tempId: Math.random(),
      jobId: newJobId,
      partType: p.partType ? { id: p.partType.id, code: p.partType.code } : { id: 1, code: 'PART' },
      name: p.name ?? '',
      partNumber: p.partNumber ?? '',
      position: p.position ?? '',
      quantity: p.quantity ?? 1,
      cost: p.cost ?? 0,
      retail: p.retail ?? 0,
      oemPartNumber: p.oemPartNumber ?? '',
    };
    for (const k of ['brand', 'description', 'model', 'fet', 'msrp', 'quote', 'notes',
      'pcdbPartTypeId', 'pcdbPartTypeName', 'partsTechPartId', 'unitOfMeasure',
      'maxCapacity', 'specStandard', 'warrantyLabel', 'sortOrder',
      // tire-specific
      'width', 'ratio', 'diameter', 'constructionType', 'loadIndex', 'speedRating',
      'tireType', 'mileageWarranty', 'loadRange', 'tireCategory', 'runFlat',
      'sideWallStyle', 'treadwear', 'traction', 'temperature']) {
      if (p[k] !== undefined && p[k] !== null) out[k] = p[k];
    }
    return out;
  }

  // Lean labor shape — matches the populate POST captured in HAR.
  function leanLabor(l, newJobId) {
    const out = {
      tempId: Math.random(),
      jobId: newJobId,
      name: l.name ?? '',
      hours: l.hours ?? 0,
      rate: l.rate ?? 0,
      autoApplyLaborMatrixId: l.autoApplyLaborMatrixId ?? null,
      technician: l.technician ? { id: l.technician.id } : null,
    };
    for (const k of ['complete', 'position', 'warrantyLabel', 'sortOrder', 'sectionApplication']) {
      if (l[k] !== undefined && l[k] !== null) out[k] = l[k];
    }
    return out;
  }

  // Build the populate POST body from the empty-job response + source job.
  // Strategy: take the server's freshly minted empty-job object as the base
  // (so all server-managed defaults are correct), then overwrite the human-
  // meaningful fields from the source job and replace parts/labor with lean
  // items carrying tempId.
  function buildPopulatePayload(emptyJobResp, sourceJob) {
    const newJobId = emptyJobResp.id;
    const populated = { ...emptyJobResp };
    populated.name = sourceJob.name ?? populated.name;
    populated.status = sourceJob.status ?? populated.status;
    populated.selected = sourceJob.selected ?? populated.selected;
    populated.authorized = sourceJob.authorized ?? populated.authorized;
    populated.technician = sourceJob.technician
      ? { id: sourceJob.technician.id }
      : null;
    populated.note = sourceJob.note ?? null;
    populated.declinedNote = sourceJob.declinedNote ?? null;
    populated.jobCategoryCode = sourceJob.jobCategoryCode ?? null;
    populated.jobCategoryName = sourceJob.jobCategoryName ?? null;
    for (const k of ['taxParts', 'taxLabor', 'taxFees', 'taxTires', 'taxTiresFet']) {
      if (sourceJob[k] !== undefined && sourceJob[k] !== null) populated[k] = sourceJob[k];
    }
    for (const k of ['packagePrice', 'packagePriceMethod', 'packagePriceSurplusOilMethod',
      'packagePriceModsHidden', 'feeable']) {
      if (sourceJob[k] !== undefined && sourceJob[k] !== null) populated[k] = sourceJob[k];
    }
    populated.parts = (sourceJob.parts || []).map((p) => leanPart(p, newJobId));
    populated.labor = (sourceJob.labor || sourceJob.laborItems || []).map((l) => leanLabor(l, newJobId));
    // Force empty for tonight's run — matches 04-clone-ro-same-shop.js
    // proven behavior. These substructures reference server-managed entities
    // (discount rules, fee schedules, smart-job catalog rows, technician
    // assignment rows) that may not exist with the same shape in the dest
    // shop and have triggered populate-POST 500s in earlier experiments.
    // If a real RO surfaces non-empty data here we'll handle it case-by-case
    // post-migration; the marker pre-scan + reconcile path keeps that safe.
    populated.discounts = [];
    populated.fees = [];
    populated.smartJobIds = [];
    populated.smartJobs = [];
    populated.laborTechnicians = [];
    return populated;
  }

  // Two-step job create. Returns { ok, populated } on success, throws on
  // failure (so caller can record the failure + auto-rollback). `shopId` is
  // the DESTINATION shop. `newRoId` is the freshly created dest RO. `srcJob`
  // is the source job from the dump (with parts + labor inline).
  async function createJobTwoStep(shopId, newRoId, srcJob, token) {
    // 1. empty-job create
    const emptyPayload = {
      name: srcJob.name || 'New Job',
      repairOrderId: newRoId,
      syncPartsAttachedToNonQuotedOrders: false,
    };
    const emptyJob = await jsonFetch(ENDPOINTS.jobCreate(shopId), token, {
      method: 'POST',
      body: JSON.stringify(emptyPayload),
    });
    if (!emptyJob || !emptyJob.id) {
      throw new Error(`empty-create returned no id (got ${JSON.stringify(emptyJob).slice(0, 200)})`);
    }
    // 2. populate POST
    const populatePayload = buildPopulatePayload(emptyJob, srcJob);
    const populated = await jsonFetch(ENDPOINTS.jobCreate(shopId), token, {
      method: 'POST',
      body: JSON.stringify(populatePayload),
    });
    return { emptyJob, populated };
  }

  async function rollbackPartialRo(token, partialRoId) {
    try {
      await jsonFetch(ENDPOINTS.roStatus(partialRoId), token, {
        method: 'PUT',
        body: JSON.stringify({ repairOrderStatus: { code: 'DELETED', name: 'Deleted', id: 7 } }),
      });
      console.warn(`[LOAD-CORE] auto-rolled-back partial RO ${partialRoId} (set to DELETED).`);
    } catch (e) {
      console.warn(`[LOAD-CORE] auto-rollback FAILED for RO ${partialRoId}: ${e.message}; delete it manually.`);
    }
  }

  // ----- MAIN ------------------------------------------------------------
  console.log(`%c[Tekmetric Migration LOAD-CORE v${VERSION}] starting…`, 'color:#0a0;font-weight:bold');

  const destShopId = readShopIdFromUrl();
  if (!destShopId) {
    console.error('[LOAD-CORE] No shop ID detected in URL. Open the destination shop and re-paste.');
    return;
  }
  const destShopName = readShopNameFromDom() || `shop-${destShopId}`;

  const { name: dumpFileName, json: dump } = await pickJsonFile('Pick the tekmetric-open-jobs-dump-*.json file produced by Snippet 1');
  if (dump.schema !== 'tekmetric-open-jobs-dump') {
    console.error('[LOAD-CORE] That file does not look like a dump from Snippet 1.', dump);
    return;
  }
  console.log(`[LOAD-CORE] Loaded dump: ${dumpFileName} (${dump.repairOrders.length} ROs from ${dump.source.shopName} id=${dump.source.shopId})`);

  // Hard safety check: do not allow loading back into the source shop UNLESS
  // ALLOW_SAME_SHOP_SMOKE_TEST=true (intended for end-to-end pipeline testing
  // pre-transfer — see flag docs at top of file).
  if (Number(dump.source.shopId) === Number(destShopId)) {
    if (!ALLOW_SAME_SHOP_SMOKE_TEST) {
      console.error(`[LOAD-CORE] REFUSING TO RUN: dump source shop id (${dump.source.shopId}) equals active shop id (${destShopId}). You appear to be trying to load the dump back into the source shop. Switch the active Tekmetric shop to the destination and re-paste, or set ALLOW_SAME_SHOP_SMOKE_TEST=true at the top of this snippet for an intentional same-shop pipeline test.`);
      return;
    }
    console.warn(`[LOAD-CORE] %cSAME-SHOP MODE: dump source = active shop (${destShopId}). Proceeding because ALLOW_SAME_SHOP_SMOKE_TEST=true. New ROs will be created alongside the originals (which still exist in this shop).`, 'color:#a60;font-weight:bold');
  }

  console.log('[LOAD-CORE] Capturing x-auth-token from live session…');
  const token = await captureXAuthToken();
  if (!token) {
    console.error('[LOAD-CORE] Could not capture x-auth-token. Click around in Tekmetric to trigger a request, then re-paste.');
    return;
  }

  // Pre-scan dest Job Board for already-migrated markers, so a re-run skips them.
  // We can't trust that the Job Board summary payload exposes customerConcerns
  // (different Tekmetric builds vary), so for any summary that doesn't carry
  // the marker in a top-level field we fall back to fetching the RO detail
  // and checking there. This makes idempotency independent of summary shape.
  console.log('[LOAD-CORE] Pre-scanning destination Job Board for [migrated from RO#X] markers…');
  const alreadyMigrated = new Map(); // sourceRoNumber -> { destRoId, destRoNumber }
  function extractMarkerFromConcernsField(field) {
    if (!field) return null;
    if (typeof field === 'string') {
      const m = field.match(MIGRATION_MARKER_RE);
      return m ? m[1] : null;
    }
    if (Array.isArray(field)) {
      for (const c of field) {
        const text = typeof c === 'string' ? c : (c?.concern || c?.text || '');
        const m = text.match(MIGRATION_MARKER_RE);
        if (m) return m[1];
      }
    }
    if (typeof field === 'object' && field?.concern) {
      const m = field.concern.match(MIGRATION_MARKER_RE);
      return m ? m[1] : null;
    }
    return null;
  }
  function summaryHasConcernField(ro) {
    return ('customerConcerns' in ro) || ('customerConcern' in ro);
  }
  // Authoritative concerns lookup: hits the dedicated endpoint that always
  // returns the concerns array regardless of which Tekmetric build is
  // serving the summary/detail payloads. Used as the final fallback when
  // summary + detail both fail to surface a marker.
  async function fetchConcernsArray(roId) {
    try {
      const resp = await jsonFetch(ENDPOINTS.repairOrderConcerns(roId), token);
      if (Array.isArray(resp)) return resp;
      if (resp && Array.isArray(resp.content)) return resp.content;
      if (resp && Array.isArray(resp.customerConcerns)) return resp.customerConcerns;
      return [];
    } catch (e) {
      return [];
    }
  }
  const summariesNeedingDetail = [];
  let page = 0;
  while (true) {
    let resp;
    try {
      resp = await jsonFetch(ENDPOINTS.jobBoardList(destShopId, page, PAGE_SIZE), token);
    } catch (err) {
      console.warn(`[LOAD-CORE] Job Board pre-scan failed at page ${page}: ${err.message}. Falling through; the per-RO defensive marker recheck (vehicle-VIN-scoped) below will still catch already-migrated ROs before any duplicates are created.`);
      break;
    }
    const content = Array.isArray(resp) ? resp : (resp.content || resp.repairOrders || resp.data || []);
    if (!content.length) break;
    for (const ro of content) {
      let srcRoNum = null;
      if (summaryHasConcernField(ro)) {
        srcRoNum = extractMarkerFromConcernsField(ro.customerConcerns ?? ro.customerConcern);
      }
      if (srcRoNum) {
        alreadyMigrated.set(String(srcRoNum), { destRoId: ro.id, destRoNumber: ro.repairOrderNumber });
      } else {
        // Defer to deterministic per-RO check below — covers both summaries
        // missing the field AND summaries that have it but were truncated /
        // didn't carry the marker text.
        summariesNeedingDetail.push({ id: ro.id, repairOrderNumber: ro.repairOrderNumber });
      }
    }
    if (content.length < PAGE_SIZE) break;
    page++;
    if (page > 200) break;
  }
  if (summariesNeedingDetail.length) {
    console.log(`[LOAD-CORE] Pre-scan: doing deterministic concern check for ${summariesNeedingDetail.length} dest RO(s) (detail+concerns endpoint)…`);
    let detailMatches = 0;
    for (let i = 0; i < summariesNeedingDetail.length; i++) {
      const s = summariesNeedingDetail[i];
      let srcRoNum = null;
      // Try RO detail first (may carry concerns inline on some builds).
      try {
        const detail = await jsonFetch(ENDPOINTS.repairOrderDetail(destShopId, s.id), token);
        srcRoNum = extractMarkerFromConcernsField(detail.customerConcerns ?? detail.customerConcern);
      } catch (e) {
        console.warn(`[LOAD-CORE] detail fetch for dest RO #${s.repairOrderNumber} failed: ${e.message}; falling back to concerns endpoint.`);
      }
      // Authoritative fallback: always hit the dedicated concerns endpoint
      // when detail didn't yield a marker. This is what makes the marker
      // pre-scan reliable across Tekmetric build variants.
      if (!srcRoNum) {
        const concerns = await fetchConcernsArray(s.id);
        srcRoNum = extractMarkerFromConcernsField(concerns);
      }
      if (srcRoNum) {
        alreadyMigrated.set(String(srcRoNum), { destRoId: s.id, destRoNumber: s.repairOrderNumber });
        detailMatches++;
      }
      if ((i + 1) % 25 === 0) {
        console.log(`[LOAD-CORE] pre-scan detail ${i + 1}/${summariesNeedingDetail.length} (${detailMatches} markers found so far)`);
      }
    }
  }
  console.log(`[LOAD-CORE] Pre-scan found ${alreadyMigrated.size} already-migrated RO(s) in destination.`);

  // ----- PLAN (dry-run summary) -----------------------------------------
  const toMigrate = dump.repairOrders.filter((r) => r.repairOrder); // skip dump errors
  const skippedBecauseAlreadyMigrated = toMigrate.filter((r) => alreadyMigrated.has(String(r.sourceRoNumber)));
  const willCreate = toMigrate.filter((r) => !alreadyMigrated.has(String(r.sourceRoNumber)));
  const totalJobs = willCreate.reduce((acc, r) => acc + ((r.repairOrder.jobs || r.repairOrder.repairOrderJobs || []).length), 0);

  console.log('%c[LOAD-CORE] Plan:', 'color:#0a0;font-weight:bold');
  console.table([{
    sourceShop: dump.source.shopName,
    sourceShopId: dump.source.shopId,
    destShop: destShopName,
    destShopId,
    rosInDump: dump.repairOrders.length,
    rosWithDumpError: dump.repairOrders.length - toMigrate.length,
    rosAlreadyMigrated: skippedBecauseAlreadyMigrated.length,
    rosWillCreate: willCreate.length,
    jobsWillCreate: totalJobs,
    confirm: CONFIRM,
  }]);

  console.log('[LOAD-CORE] First few that will be created:');
  console.table(willCreate.slice(0, 5).map((r) => ({
    sourceRo: r.sourceRoNumber,
    customer: (r.repairOrder.customer && (r.repairOrder.customer.firstName + ' ' + r.repairOrder.customer.lastName)) || '?',
    vehicle: (r.repairOrder.vehicle && `${r.repairOrder.vehicle.year || ''} ${r.repairOrder.vehicle.make || ''} ${r.repairOrder.vehicle.model || ''}`.trim()) || '?',
    jobs: (r.repairOrder.jobs || r.repairOrder.repairOrderJobs || []).length,
  })));

  if (!CONFIRM) {
    console.log('%c[LOAD-CORE] DRY RUN — no writes performed.', 'color:#a60;font-weight:bold');
    console.log('[LOAD-CORE] When you are ready, edit this snippet and set CONFIRM = true at the top, then re-paste.');
    return;
  }

  // ----- CONFIRMATION PROMPT --------------------------------------------
  const promptMsg =
    `MIGRATE ${willCreate.length} ROs (${totalJobs} jobs) from\n` +
    `  ${dump.source.shopName} (id=${dump.source.shopId})\n` +
    `into\n` +
    `  ${destShopName} (id=${destShopId}) ?\n\n` +
    `Type the destination shop id (${destShopId}) to confirm.`;
  const typed = window.prompt(promptMsg, '');
  if (String(typed).trim() !== String(destShopId)) {
    console.error('[LOAD-CORE] Confirmation failed (typed value did not match destination shop id). Aborted.');
    return;
  }

  // ----- WRITE PHASE -----------------------------------------------------
  const successes = [];
  const failures = [];
  const mapping = []; // sourceRoId/sourceRoNumber → destRoId/destRoNumber

  // Resume helper. Called when we detect an already-migrated dest RO
  // (either via Job Board pre-scan or the per-RO defensive recheck).
  // Compares source jobs to dest jobs by name and creates whichever ones
  // are missing — so a partial-failure run from a previous attempt
  // (marker present, but only some jobs posted) gets reconciled instead
  // of being silently skipped. This is what makes the [migrated from
  // RO#X] marker safe to write at RO-create time. Returns the full
  // jobMappings array for the mapping JSON.
  async function reconcileJobsOnReusedRo(srcRepairOrder, destRoId, sourceRoNumber) {
    let destDetail;
    try {
      destDetail = await jsonFetch(ENDPOINTS.repairOrderDetail(destShopId, destRoId), token);
    } catch (e) {
      console.warn(`[LOAD-CORE] could not fetch dest RO detail for already-migrated #${sourceRoNumber}: ${e.message}; jobs cannot be reconciled this run.`);
      return { jobMappings: [], created: 0, missing: 0 };
    }
    const srcJobs = srcRepairOrder.jobs || srcRepairOrder.repairOrderJobs || [];
    // Dest RO detail returns jobs:null on most builds. Fetch the dest's
    // estimate to get its real job list for name-matching.
    let destJobs = destDetail.jobs || destDetail.repairOrderJobs || [];
    if (!destJobs.length) {
      try {
        const est = await jsonFetch(`/api/repair-order/${destRoId}/estimate`, token);
        destJobs = (est && (est.jobs || est.repairOrderJobs)) || [];
      } catch (_) { /* fall through with empty list */ }
    }
    const destByName = new Map();
    for (const dj of destJobs) {
      const arr = destByName.get(dj.name) || [];
      arr.push(dj);
      destByName.set(dj.name, arr);
    }
    const jobMappings = [];
    let created = 0;
    let missing = 0;
    for (let j = 0; j < srcJobs.length; j++) {
      const sj = srcJobs[j];
      const candidates = destByName.get(sj.name) || [];
      let match = candidates.shift() || null;
      if (!match) {
        // Resume: this job was missing from the previous run. Create it
        // using the proven two-step pattern (empty-create + populate).
        missing++;
        try {
          const { populated } = await createJobTwoStep(destShopId, destRoId, sj, token);
          const id = populated && (populated.id ?? populated.jobId);
          const name = populated && populated.name;
          match = { id, name };
          created++;
          console.log(`[LOAD-CORE]   resumed missing job "${sj.name}" on dest RO id=${destRoId} (was missing from prior partial run)`);
        } catch (jobErr) {
          console.warn(`[LOAD-CORE]   failed to resume missing job "${sj.name}" on dest RO id=${destRoId}: ${jobErr.message}`);
          failures.push({
            sourceRo: sourceRoNumber,
            sourceRoId: srcRepairOrder.id,
            step: `resumeMissingJob[${j}](${sj.name || 'unnamed'})`,
            status: jobErr.status || '',
            error: (jobErr.body || jobErr.message || '').slice(0, 300),
          });
        }
      }
      jobMappings.push({
        srcJobId: sj.id ?? null,
        srcJobName: sj.name ?? null,
        destJobId: match ? (match.id ?? null) : null,
        destJobName: match ? (match.name ?? null) : null,
      });
    }
    return { jobMappings, created, missing };
  }

  // Pre-seed mapping with already-migrated rows so Snippet 3 can use them,
  // and resume any jobs that were missing from a prior partial run.
  for (const r of skippedBecauseAlreadyMigrated) {
    const hit = alreadyMigrated.get(String(r.sourceRoNumber));
    const recon = await reconcileJobsOnReusedRo(r.repairOrder, hit.destRoId, r.sourceRoNumber);
    if (recon.created > 0) {
      console.log(`[LOAD-CORE] resumed ${recon.created} missing job(s) on already-migrated RO #${r.sourceRoNumber} → dest #${hit.destRoNumber}`);
    }
    mapping.push({
      sourceRoId: r.sourceRoId,
      sourceRoNumber: r.sourceRoNumber,
      destRoId: hit.destRoId,
      destRoNumber: hit.destRoNumber,
      reused: true,
      resumedJobs: recon.created,
      jobMappings: recon.jobMappings,
    });
  }

  // Per-RO defensive marker recheck. We narrow the candidate dest RO set
  // first by the source vehicle's VIN; if the source vehicle has no VIN
  // (rare but possible — old fleet vehicles, motorcycles, equipment), we
  // fall back to narrowing by the source customer's phone or email. We
  // then fetch each candidate RO's detail (when needed) and look for our
  // migration marker. This catches the case where the Job Board pre-scan
  // was incomplete (failed pagination, RO advanced past Job Board, etc.).
  async function findExistingMigratedRo(srcRepairOrder, sourceRoNumber) {
    const vin = (srcRepairOrder.vehicle && srcRepairOrder.vehicle.vin) || null;
    const cust = srcRepairOrder.customer || {};
    const phone = (cust.phone || (cust.phones && cust.phones[0] && cust.phones[0].number) || '').replace(/\D/g, '');
    const email = cust.email || '';
    let candidates = [];
    let scopedBy = null;

    if (vin) {
      scopedBy = 'vin';
      try {
        const r = await jsonFetch(ENDPOINTS.vehicleSearch(destShopId, vin), token);
        const vehicles = Array.isArray(r) ? r : (r.content || []);
        const matched = vehicles.filter((v) => (v.vin || '').toUpperCase() === vin.toUpperCase());
        for (const v of matched) {
          try {
            const ros = await jsonFetch(`/api/shop/${destShopId}/repair-order?vehicleId=${v.id}&page=0&size=50`, token);
            const list = Array.isArray(ros) ? ros : (ros.content || ros.repairOrders || []);
            candidates.push(...list);
          } catch (_) {}
        }
      } catch (_) { /* fall through */ }
    }

    // VIN-less fallback: search dest by customer phone or email, then
    // walk each matched customer's open ROs.
    if (!vin && (phone || email)) {
      scopedBy = phone ? 'phone' : 'email';
      try {
        const q = phone || email;
        const r = await jsonFetch(ENDPOINTS.customerSearch(destShopId, q), token);
        const customers = Array.isArray(r) ? r : (r.content || []);
        for (const c of customers) {
          try {
            const ros = await jsonFetch(`/api/shop/${destShopId}/repair-order?customerId=${c.id}&page=0&size=50`, token);
            const list = Array.isArray(ros) ? ros : (ros.content || ros.repairOrders || []);
            candidates.push(...list);
          } catch (_) {}
        }
      } catch (_) { /* fall through */ }
    }

    if (!candidates.length) return null;

    for (const ro of candidates) {
      let concernField = ro.customerConcerns ?? ro.customerConcern;
      let foundSrcRo = extractMarkerFromConcernsField(concernField);
      if (!foundSrcRo) {
        // Try RO detail (some builds carry concerns inline there).
        try {
          const detail = await jsonFetch(ENDPOINTS.repairOrderDetail(destShopId, ro.id), token);
          foundSrcRo = extractMarkerFromConcernsField(detail.customerConcerns ?? detail.customerConcern);
        } catch (_) {}
      }
      if (!foundSrcRo) {
        // Authoritative fallback: dedicated concerns endpoint always
        // returns the concerns array, regardless of which Tekmetric build
        // is serving summary/detail.
        const concerns = await fetchConcernsArray(ro.id);
        foundSrcRo = extractMarkerFromConcernsField(concerns);
      }
      if (foundSrcRo && String(foundSrcRo) === String(sourceRoNumber)) {
        return { destRoId: ro.id, destRoNumber: ro.repairOrderNumber, scopedBy };
      }
    }
    return null;
  }

  for (let i = 0; i < willCreate.length; i++) {
    const item = willCreate[i];
    const src = item.repairOrder;
    const sourceRoNumber = item.sourceRoNumber;
    const sourceRoId = item.sourceRoId;
    let step = 'start';
    try {
      // 0. Defensive per-RO marker check — independent of pre-scan results.
      //    If pre-scan was incomplete (failed pagination, summary missing
      //    concern field, RO advanced past Job Board, etc.), this catches
      //    duplicates before we create any new entities.
      step = 'verifyNotAlreadyMigrated';
      const existing = await findExistingMigratedRo(src, sourceRoNumber);
      if (existing) {
        console.log(`[LOAD-CORE] (${i + 1}/${willCreate.length}) #${sourceRoNumber} already exists in dest as #${existing.destRoNumber} (id=${existing.destRoId}) — reconciling jobs (was missed by pre-scan).`);
        const recon = await reconcileJobsOnReusedRo(src, existing.destRoId, sourceRoNumber);
        if (recon.created > 0) {
          console.log(`[LOAD-CORE]   resumed ${recon.created} missing job(s) on dest #${existing.destRoNumber}`);
        }
        mapping.push({
          sourceRoId,
          sourceRoNumber,
          destRoId: existing.destRoId,
          destRoNumber: existing.destRoNumber,
          reused: true,
          recoveredByPerRoCheck: true,
          resumedJobs: recon.created,
          jobMappings: recon.jobMappings,
        });
        continue;
      }

      // 1. Resolve dest customer / vehicle / labor-rate IDs.
      //    Default path (USE_SOURCE_IDS_DIRECT=true): use the source IDs
      //    verbatim. Tekmetric account transfer preserves these rows, so
      //    they exist in the dest shop unchanged.
      //    Fallback (USE_SOURCE_IDS_DIRECT=false): legacy match-by-email/VIN
      //    or create new — kept here as insurance only.
      const srcCust = src.customer || {};
      const srcVeh = src.vehicle || {};
      const sourceLaborRateId = (typeof src.laborRate === 'number')
        ? src.laborRate
        : (src.laborRate && src.laborRate.id) || null;

      let destCustomerId = null;
      let destVehicleId = null;
      let destLaborRateId = sourceLaborRateId;

      if (USE_SOURCE_IDS_DIRECT) {
        step = 'resolveIds(direct)';
        destCustomerId = srcCust.id ?? null;
        destVehicleId = srcVeh.id ?? null;
        if (!destCustomerId || !destVehicleId) {
          throw new Error(`source RO is missing customer.id (${srcCust.id}) or vehicle.id (${srcVeh.id}); cannot use USE_SOURCE_IDS_DIRECT`);
        }
      } else {
        // Legacy fallback: match-by-email/VIN-or-create.
        step = 'matchCustomer';
        const cQuery = (srcCust.email && srcCust.email.trim()) ||
          ((srcCust.phone && srcCust.phone[0] && srcCust.phone[0].number) ? srcCust.phone[0].number :
            (typeof srcCust.phone === 'string' ? srcCust.phone : null));
        if (cQuery) {
          try {
            const r = await jsonFetch(ENDPOINTS.customerSearch(destShopId, cQuery), token);
            const list = Array.isArray(r) ? r : (r.content || []);
            const hit = list.find((c) =>
              (c.email && srcCust.email && c.email.toLowerCase() === srcCust.email.toLowerCase()) ||
              ((srcCust.lastName || '').toLowerCase() === (c.lastName || '').toLowerCase() &&
                (srcCust.firstName || '').toLowerCase() === (c.firstName || '').toLowerCase())
            );
            if (hit) destCustomerId = hit.id;
          } catch (_) { /* fall through to create */ }
        }
        if (!destCustomerId) {
          step = 'createCustomer';
          const created = await jsonFetch(ENDPOINTS.customerCreate(destShopId), token, {
            method: 'POST',
            body: JSON.stringify({
              firstName: srcCust.firstName || '',
              lastName: srcCust.lastName || '',
              email: srcCust.email || null,
              phone: srcCust.phone || [],
              address: srcCust.address || null,
              customerType: srcCust.customerType || null,
              notes: srcCust.notes || null,
            }),
          });
          destCustomerId = created.id;
        }
        step = 'matchVehicle';
        if (srcVeh.vin) {
          try {
            const r = await jsonFetch(ENDPOINTS.vehicleSearch(destShopId, srcVeh.vin), token);
            const list = Array.isArray(r) ? r : (r.content || []);
            const hit = list.find((v) => (v.vin || '').toUpperCase() === srcVeh.vin.toUpperCase());
            if (hit) destVehicleId = hit.id;
          } catch (_) {}
        }
        if (!destVehicleId) {
          step = 'createVehicle';
          const createdV = await jsonFetch(ENDPOINTS.vehicleCreate(destShopId), token, {
            method: 'POST',
            body: JSON.stringify({
              customerId: destCustomerId,
              year: srcVeh.year || null,
              make: srcVeh.make || null,
              model: srcVeh.model || null,
              subModel: srcVeh.subModel || null,
              engine: srcVeh.engine || null,
              transmission: srcVeh.transmission || null,
              drivetrain: srcVeh.drivetrain || null,
              vin: srcVeh.vin || null,
              licensePlate: srcVeh.licensePlate || srcVeh.plate || null,
              color: srcVeh.color || null,
              unitNumber: srcVeh.unitNumber || null,
              notes: srcVeh.notes || null,
            }),
          });
          destVehicleId = createdV.id;
        }
      }

      // 2. Create the RO using the proven /api/repair-order/create endpoint
      //    + payload shape from 04-clone-ro-same-shop.js. We do NOT pass
      //    concerns inline here — concerns get POSTed one-at-a-time on the
      //    next step, which mirrors what the Tekmetric UI itself does.
      step = 'createRo';
      const apptOption = normalizeApptOption(src.appointmentOption);
      const createPayload = {
        shop: { id: Number(destShopId) },
        appointmentOption: apptOption,
        odometerInop: src.odometerInop ?? false,
        leadSource: src.leadSource || '',
        vehicle: { id: destVehicleId },
        milesIn: src.milesIn ?? null,
        laborRate: destLaborRateId ? { id: destLaborRateId } : undefined,
        customer: { id: destCustomerId },
        appointment: null,
        initialJobs: [],
        recommendations: [],
        declinedJobRecommendations: [],
      };
      const createdRo = await jsonFetch(ENDPOINTS.repairOrderCreate(), token, {
        method: 'POST',
        body: JSON.stringify(createPayload),
      });
      const newRoId = createdRo.id;

      // 3. Set vehicle mileage (PUT) if source had any.
      if (src.milesIn != null || src.milesOut != null) {
        step = 'setMileage';
        try {
          await jsonFetch(ENDPOINTS.vehicleMileage(newRoId), token, {
            method: 'PUT',
            body: JSON.stringify({
              milesIn: src.milesIn ?? src.milesOut ?? 0,
              milesOut: src.milesOut ?? src.milesIn ?? 0,
              odometerInop: src.odometerInop ?? false,
            }),
          });
        } catch (e) {
          console.warn(`[LOAD-CORE]   #${sourceRoNumber} mileage PUT failed (non-fatal): ${e.message}`);
        }
      }

      // 4. Append concerns. The first concern carries the migration marker
      //    so the marker pre-scan can find it on a re-run.
      //    Tekmetric payloads vary by build: source concerns may come back
      //    as an array of {concern}, an array of strings, a single string,
      //    or a single object — normalize all of those shapes.
      step = 'addConcerns';
      const rawConcerns = src.customerConcerns ?? src.customerConcern ?? [];
      let srcConcerns;
      if (Array.isArray(rawConcerns)) {
        srcConcerns = rawConcerns
          .map((c) => (typeof c === 'string' ? { concern: c } : (c && typeof c === 'object' ? c : null)))
          .filter(Boolean);
      } else if (typeof rawConcerns === 'string') {
        srcConcerns = rawConcerns ? [{ concern: rawConcerns }] : [];
      } else if (rawConcerns && typeof rawConcerns === 'object') {
        srcConcerns = [rawConcerns];
      } else {
        srcConcerns = [];
      }
      const concernsToPost = srcConcerns.length
        ? [
            { concern: `${MIGRATION_MARKER(sourceRoNumber)} ${srcConcerns[0].concern || ''}`.trim() },
            ...srcConcerns.slice(1).map((c) => ({ concern: c.concern || '' })),
          ]
        : [{ concern: MIGRATION_MARKER(sourceRoNumber) }];
      for (let ci = 0; ci < concernsToPost.length; ci++) {
        step = `addConcern[${ci}]`;
        await jsonFetch(ENDPOINTS.addConcern(newRoId), token, {
          method: 'POST',
          body: JSON.stringify({ concern: concernsToPost[ci].concern }),
        });
      }

      // 5. Create each job on the new RO using the proven two-step pattern.
      //    On any per-job failure, optionally auto-rollback the partial RO
      //    so the dest Job Board doesn't fill up with broken half-ROs.
      const srcJobs = (src.jobs || src.repairOrderJobs || []).filter((j) => !j.archived);
      let labors = 0; let parts = 0;
      const jobMappings = [];
      for (let j = 0; j < srcJobs.length; j++) {
        const srcJob = srcJobs[j];
        step = `createJob[${j}](${srcJob.name || 'unnamed'})`;
        try {
          const { populated } = await createJobTwoStep(destShopId, newRoId, srcJob, token);
          const id = populated && (populated.id ?? populated.jobId);
          const name = populated && populated.name;
          labors += (srcJob.labor || srcJob.laborItems || []).length;
          parts += (srcJob.parts || []).length;
          jobMappings.push({
            srcJobId: srcJob.id ?? null,
            srcJobName: srcJob.name ?? null,
            destJobId: id ?? null,
            destJobName: name ?? null,
          });
        } catch (jobErr) {
          if (AUTO_ROLLBACK_PARTIAL_RO) {
            await rollbackPartialRo(token, newRoId);
          }
          // Re-throw so the outer catch records this as a per-RO failure.
          throw new Error(`${step}: ${jobErr.message}`);
        }
      }

      successes.push({
        sourceRo: sourceRoNumber,
        destRo: createdRo.repairOrderNumber,
        destRoId: newRoId,
        jobs: srcJobs.length,
        labor: labors,
        parts,
      });
      mapping.push({
        sourceRoId,
        sourceRoNumber,
        destRoId: newRoId,
        destRoNumber: createdRo.repairOrderNumber,
        reused: false,
        jobMappings,
      });
      console.log(`[LOAD-CORE] (${i + 1}/${willCreate.length}) #${sourceRoNumber} → #${createdRo.repairOrderNumber} (${srcJobs.length} jobs, ${parts} parts, ${labors} labor lines)`);
    } catch (err) {
      console.error(`[LOAD-CORE] FAILED RO #${sourceRoNumber} at step "${step}": ${err.message}`);
      failures.push({
        sourceRo: sourceRoNumber,
        sourceRoId,
        step,
        status: err.status || '',
        error: (err.body || err.message || '').slice(0, 300),
      });
    }
  }

  // ----- REPORT + MAPPING DOWNLOAD --------------------------------------
  console.log('%c[LOAD-CORE] Successes:', 'color:#0a0;font-weight:bold');
  console.table(successes);
  if (failures.length) {
    console.log('%c[LOAD-CORE] Failures:', 'color:#a00;font-weight:bold');
    console.table(failures);
  } else {
    console.log('[LOAD-CORE] No failures.');
  }

  const mappingPayload = {
    schema: 'tekmetric-migration-mapping',
    schemaVersion: VERSION,
    createdAt: new Date().toISOString(),
    source: dump.source,
    dest: { shopId: Number(destShopId), shopName: destShopName },
    counts: {
      successes: successes.length,
      failures: failures.length,
      reusedAlreadyMigrated: mapping.filter((m) => m.reused).length,
    },
    mapping,
    failures, // include failures so retry-by-hand has context too
  };
  const fname = `tekmetric-migration-mapping-${ts()}.json`;
  downloadJson(fname, mappingPayload);
  console.log(`[LOAD-CORE] Wrote mapping file: ${fname}`);
  console.log('[LOAD-CORE] Done. Now paste 03-load-extras-dest.js (still on the destination shop) to copy inspections + photos.');
})();
