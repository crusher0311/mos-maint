/* eslint-disable no-console */
/**
 * 05-clone-ro-cross-shop.js
 *
 * CROSS-SHOP smoke test for the open-RO migration. Pulls a source RO from
 * one Tekmetric shop (live, e.g. Service Solutions Garage 10214) and creates
 * an equivalent RO in a DIFFERENT destination shop (the test shop 14245)
 * against an existing dest-shop customer/vehicle/labor-rate.
 *
 * What this validates beyond 04-clone-ro-same-shop.js:
 *   - The token can fetch source-RO state from a shop you're not currently
 *     sitting on (works because the token is account-scoped).
 *   - Job/parts/labor payloads built from a source-shop RO are accepted by a
 *     different dest shop (i.e. nothing is implicitly tied to the source shop).
 *   - The dest shop's customer / vehicle / labor-rate IDs are correctly
 *     substituted into the create payload.
 *
 * What this script DOES NOT do (see 02-load-core-dest.js for the real run):
 *   - It does not try to find/create the customer or vehicle in the dest
 *     shop — you point it at a known-good dest customer + vehicle. For the
 *     real cross-shop migration tonight, IDs carry over verbatim because
 *     Tekmetric's account transfer preserves customers/vehicles/labor-rates,
 *     so this remapping is only a TEST-shop problem.
 *
 * Endpoints exercised (same as 04, with source-shop scoping for the GETs):
 *   GET  /api/shop/{SOURCE_SHOP_ID}/repair-order/{SOURCE_RO_ID}   -> source meta
 *   GET  /api/repair-order/{SOURCE_RO_ID}/estimate                -> source jobs
 *   GET  /api/repair-orders/{SOURCE_RO_ID}/customer-concerns      -> source concerns
 *   GET  /api/shop/{DEST_SHOP_ID}/repair-order/{DEST_REFERENCE_RO_ID}
 *                                                                 -> pull dest
 *                                                                    customer/
 *                                                                    vehicle/
 *                                                                    laborRate
 *   POST /api/repair-order/create
 *   PUT  /api/repair-order/{newRoId}/vehicle-mileage
 *   POST /api/repair-orders/{newRoId}/customer-concerns
 *   POST /api/shop/{DEST_SHOP_ID}/job          (empty-create)
 *   POST /api/shop/{DEST_SHOP_ID}/job          (populate)
 *   PUT  /api/repair-order/{newRoId}/status    (auto-rollback on failure)
 *
 * USAGE
 *   1. In Tekmetric, navigate to ANY page on the DEST shop (the test shop
 *      you want the new RO to land in, e.g.
 *      https://shop.tekmetric.com/admin/shop/14245/...). Sitting on the
 *      dest shop is required for the active-shop sanity check.
 *   2. Open the browser DevTools console.
 *   3. Edit CONFIG below: SOURCE/DEST shop ids, SOURCE_RO_ID, and
 *      DEST_REFERENCE_RO_ID (any RO in the dest shop that already uses the
 *      customer/vehicle/labor-rate you want the new RO to use).
 *   4. Set CONFIRM=true; paste; hit Enter.
 *   5. Watch console; on failure the partial RO auto-deletes.
 *
 * IMPORTANT — what gets STRIPPED in cross-shop mode (vs same-shop):
 *   - Each labor line's `technician` is forced to null (techs are shop-scoped).
 *   - Each labor line's `autoApplyLaborMatrixId` is forced to null (labor
 *     matrices are shop-scoped). The labor `rate` (dollar amount) is preserved.
 *   - Day-1, the dest-shop advisor reassigns techs in the UI.
 */
(async () => {
  // ===== CONFIG =====
  const SOURCE_SHOP_ID = 10214;            // Service Solutions Garage (live)
  const SOURCE_RO_ID   = 324031687;        // RO to clone from source
  const DEST_SHOP_ID   = 14245;            // your test shop (sitting on it)
  const DEST_REFERENCE_RO_ID = 255022827;  // any RO in DEST shop with the
                                           // customer/vehicle/laborRate you
                                           // want the new RO to land on
                                           // (Jay Demore in shop 14245)
  const CONFIRM = false;                   // false = dry-run; true = actually create
  const JOBS_LIMIT = 1;                    // null = clone all jobs;
                                           // start with 1 to validate
  const AUTO_ROLLBACK = true;              // delete partial RO on failure
  // ==================

  const BASE = location.origin;

  // sanity: must be sitting on the DEST shop
  const m = location.pathname.match(/\/admin\/shop\/(\d+)\b/);
  const activeShop = m ? Number(m[1]) : null;
  if (activeShop !== DEST_SHOP_ID) {
    console.error(`[XCLONE] Expected to be on DEST shop ${DEST_SHOP_ID}, but URL says shop ${activeShop}. Switch shops in Tekmetric, then re-run.`);
    return;
  }

  // ----- token discovery (same as 04)
  async function getToken() {
    for (const k of Object.keys(localStorage)) {
      const v = localStorage.getItem(k) || '';
      if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(v)) return v;
      try {
        const p = JSON.parse(v);
        if (p && typeof p.token === 'string' && p.token.startsWith('eyJ')) return p.token;
        if (p && typeof p.accessToken === 'string' && p.accessToken.startsWith('eyJ')) return p.accessToken;
      } catch (_) {}
    }
    return await new Promise((resolve, reject) => {
      const orig = window.fetch.bind(window);
      const t = setTimeout(() => { window.fetch = orig; reject(new Error('Timed out sniping token. Click Tekmetric and re-run.')); }, 8000);
      window.fetch = function p(input, init) {
        try {
          const h = (init && init.headers) || {}; let tok = null;
          if (h instanceof Headers) tok = h.get('X-AUTH-TOKEN');
          else if (Array.isArray(h)) { const x = h.find(([k]) => /^x-auth-token$/i.test(k)); if (x) tok = x[1]; }
          else for (const k of Object.keys(h)) if (k.toLowerCase() === 'x-auth-token') tok = h[k];
          if (tok) { clearTimeout(t); window.fetch = orig; resolve(tok); }
        } catch (_) {}
        return orig(input, init);
      };
      try { orig(`${BASE}/api/shop/${DEST_SHOP_ID}`, { credentials: 'include' }).catch(() => {}); } catch (_) {}
    });
  }

  async function jsonFetch(path, opts = {}) {
    const init = {
      method: opts.method || 'GET', credentials: 'include',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'X-AUTH-TOKEN': opts.token },
    };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
    const res = await fetch(`${BASE}${path}`, init);
    const text = await res.text();
    let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch (_) {}
    return { status: res.status, ok: res.ok, body: parsed, raw: text };
  }
  function unwrap(r) { if (r.body && typeof r.body === 'object' && 'data' in r.body && 'type' in r.body) return r.body.data; return r.body; }

  function leanPart(p, newJobId) {
    const out = {
      tempId: Math.random(), jobId: newJobId,
      partType: p.partType ? { id: p.partType.id, code: p.partType.code } : { id: 1, code: 'PART' },
      name: p.name ?? '', partNumber: p.partNumber ?? '', position: p.position ?? '',
      quantity: p.quantity ?? 1, cost: p.cost ?? 0, retail: p.retail ?? 0, oemPartNumber: p.oemPartNumber ?? '',
    };
    for (const k of ['brand','description','model','fet','msrp','quote','notes',
      'pcdbPartTypeId','pcdbPartTypeName','partsTechPartId','unitOfMeasure','maxCapacity','specStandard',
      'warrantyLabel','sortOrder','width','ratio','diameter','constructionType','loadIndex','speedRating',
      'tireType','mileageWarranty','loadRange','tireCategory','runFlat','sideWallStyle','treadwear','traction','temperature']) {
      if (p[k] !== undefined && p[k] !== null) out[k] = p[k];
    }
    return out;
  }

  // CROSS-SHOP: technician + autoApplyLaborMatrixId are shop-scoped → strip.
  // The labor rate (dollar amount) is preserved as a literal $ value.
  function leanLaborCrossShop(l, newJobId) {
    const out = {
      tempId: Math.random(), jobId: newJobId,
      name: l.name ?? '', hours: l.hours ?? 0, rate: l.rate ?? 0,
      autoApplyLaborMatrixId: null,  // forced null cross-shop
      technician: null,              // forced null cross-shop
    };
    for (const k of ['complete','position','warrantyLabel','sortOrder','sectionApplication']) {
      if (l[k] !== undefined && l[k] !== null) out[k] = l[k];
    }
    return out;
  }

  function buildPopulatePayload(emptyJobResp, sourceJob) {
    const newJobId = emptyJobResp.id;
    const p = { ...emptyJobResp };
    p.name = sourceJob.name ?? p.name;
    p.status = sourceJob.status ?? p.status;
    p.selected = sourceJob.selected ?? p.selected;
    p.authorized = sourceJob.authorized ?? p.authorized;
    p.technician = null;  // cross-shop: drop
    p.note = sourceJob.note ?? null;
    p.declinedNote = sourceJob.declinedNote ?? null;
    p.jobCategoryCode = sourceJob.jobCategoryCode ?? null;
    p.jobCategoryName = sourceJob.jobCategoryName ?? null;
    for (const k of ['taxParts','taxLabor','taxFees','taxTires','taxTiresFet',
      'packagePrice','packagePriceMethod','packagePriceSurplusOilMethod','packagePriceModsHidden','feeable']) {
      if (sourceJob[k] !== undefined && sourceJob[k] !== null) p[k] = sourceJob[k];
    }
    p.parts = (sourceJob.parts || []).map(x => leanPart(x, newJobId));
    p.labor = (sourceJob.labor || []).map(x => leanLaborCrossShop(x, newJobId));
    p.discounts = []; p.fees = []; p.smartJobIds = []; p.smartJobs = []; p.laborTechnicians = [];
    return p;
  }

  async function rollback(token, partialRoId) {
    try {
      const r = await jsonFetch(`/api/repair-order/${partialRoId}/status`, {
        token, method: 'PUT',
        body: { repairOrderStatus: { code: 'DELETED', name: 'Deleted', id: 7 } },
      });
      if (r.ok) console.warn(`[XCLONE] auto-rolled-back partial RO ${partialRoId} (DELETED).`);
      else console.warn(`[XCLONE] auto-rollback FAILED for RO ${partialRoId} status=${r.status}; delete manually:`, r.raw);
    } catch (e) { console.warn(`[XCLONE] auto-rollback threw: ${e.message}`); }
  }

  console.log(`%c[XCLONE] starting — source shop ${SOURCE_SHOP_ID} RO ${SOURCE_RO_ID} → dest shop ${DEST_SHOP_ID}, CONFIRM=${CONFIRM}, JOBS_LIMIT=${JOBS_LIMIT}`,
    'color:#06c;font-weight:bold');

  let token;
  try { token = await getToken(); console.log('[XCLONE] got auth token.'); }
  catch (e) { console.error('[XCLONE] auth token error:', e.message); return; }

  // ----- 1. fetch source RO meta + estimate + concerns
  const srcRoResp = await jsonFetch(`/api/shop/${SOURCE_SHOP_ID}/repair-order/${SOURCE_RO_ID}`, { token });
  if (!srcRoResp.ok) {
    console.error(`[XCLONE] failed to fetch SOURCE RO from shop ${SOURCE_SHOP_ID}: status=${srcRoResp.status}`, srcRoResp.raw);
    console.error('         (if 403, your token may not have access to that shop)');
    return;
  }
  const srcRo = unwrap(srcRoResp);

  const srcEstResp = await jsonFetch(`/api/repair-order/${SOURCE_RO_ID}/estimate`, { token });
  if (!srcEstResp.ok) { console.error(`[XCLONE] failed source estimate status=${srcEstResp.status}`, srcEstResp.raw); return; }
  const srcJobs = (unwrap(srcEstResp).jobs || []).filter(j => !j.archived);

  const srcConcernsResp = await jsonFetch(`/api/repair-orders/${SOURCE_RO_ID}/customer-concerns`, { token });
  if (!srcConcernsResp.ok) { console.error(`[XCLONE] failed source concerns status=${srcConcernsResp.status}`, srcConcernsResp.raw); return; }
  const srcConcerns = Array.isArray(srcConcernsResp.body) ? srcConcernsResp.body : (srcConcernsResp.body?.data || []);

  console.log(`[XCLONE] source RO #${srcRo.repairOrderNumber}: ${srcJobs.length} jobs, ${srcConcerns.length} concerns`);
  console.log(`         source customer: ${srcRo.customer?.firstName} ${srcRo.customer?.lastName} (id ${srcRo.customer?.id}) — IGNORED for cross-shop`);
  console.log(`         source vehicle:  ${srcRo.vehicle?.year} ${srcRo.vehicle?.make} ${srcRo.vehicle?.model} (id ${srcRo.vehicle?.id}) — IGNORED for cross-shop`);

  // ----- 2. fetch DEST reference RO to pull customer/vehicle/laborRate IDs
  const destRefResp = await jsonFetch(`/api/shop/${DEST_SHOP_ID}/repair-order/${DEST_REFERENCE_RO_ID}`, { token });
  if (!destRefResp.ok) {
    console.error(`[XCLONE] failed to fetch DEST reference RO ${DEST_REFERENCE_RO_ID} from shop ${DEST_SHOP_ID}: status=${destRefResp.status}`, destRefResp.raw);
    return;
  }
  const destRef = unwrap(destRefResp);
  const destCustomerId = destRef.customer?.id;
  const destVehicleId = destRef.vehicle?.id;
  const destLaborRateId = typeof destRef.laborRate === 'number' ? destRef.laborRate : destRef.laborRate?.id;
  if (!destCustomerId || !destVehicleId || !destLaborRateId) {
    console.error(`[XCLONE] dest reference RO missing customer/vehicle/laborRate. Got customer=${destCustomerId}, vehicle=${destVehicleId}, laborRate=${destLaborRateId}`);
    return;
  }
  console.log(`[XCLONE] dest reference RO #${destRef.repairOrderNumber} → using customer=${destCustomerId}, vehicle=${destVehicleId}, laborRate=${destLaborRateId}`);

  // appointmentOption: source returns string enum; create endpoint wants Long
  const APPT = { DROP: 2, WAIT: 1, PICKUP: 3 };
  const apptOption = typeof srcRo.appointmentOption === 'number'
    ? srcRo.appointmentOption : (APPT[srcRo.appointmentOption] ?? 2);

  if (!CONFIRM) {
    console.warn('[XCLONE] DRY RUN — set CONFIRM=true to actually create.');
    srcConcerns.forEach((c, i) => console.log(`         concern ${i+1}: ${c.concern.slice(0,80)}${c.concern.length>80?'…':''}`));
    srcJobs.forEach((j, i) => console.log(`         job ${i+1}: "${j.name}" — ${j.parts?.length||0}p / ${j.labor?.length||0}l, status=${j.status}`));
    return;
  }

  // ----- 3. create the new RO in the DEST shop
  const createPayload = {
    shop: { id: DEST_SHOP_ID },
    appointmentOption: apptOption,
    odometerInop: srcRo.odometerInop ?? false,
    leadSource: srcRo.leadSource || '',
    vehicle:  { id: destVehicleId },
    milesIn:  srcRo.milesIn ?? null,
    laborRate:{ id: destLaborRateId },
    customer: { id: destCustomerId },
    appointment: null, initialJobs: [], recommendations: [], declinedJobRecommendations: [],
  };
  const createResp = await jsonFetch(`/api/repair-order/create`, { token, method: 'POST', body: createPayload });
  if (!createResp.ok) { console.error(`[XCLONE] RO create failed status=${createResp.status}`, createResp.raw); return; }
  const newRo = unwrap(createResp);
  const newRoId = newRo.id;
  const newRoUrl = `${BASE}/admin/shop/${DEST_SHOP_ID}/repair-orders/${newRoId}/estimate`;
  console.log(`%c[XCLONE] ✓ created new RO id=${newRoId} #${newRo.repairOrderNumber} in shop ${DEST_SHOP_ID}`, 'color:#0a0;font-weight:bold');
  console.log(`         ${newRoUrl}`);

  // ----- 4. set mileage
  if (srcRo.milesIn != null || srcRo.milesOut != null) {
    const r = await jsonFetch(`/api/repair-order/${newRoId}/vehicle-mileage`, {
      token, method: 'PUT',
      body: { milesIn: srcRo.milesIn ?? srcRo.milesOut ?? 0, milesOut: srcRo.milesOut ?? srcRo.milesIn ?? 0, odometerInop: srcRo.odometerInop ?? false },
    });
    if (!r.ok) console.warn(`[XCLONE] mileage failed:`, r.raw); else console.log(`[XCLONE] ✓ mileage`);
  }

  // ----- 5. concerns
  for (let i = 0; i < srcConcerns.length; i++) {
    const r = await jsonFetch(`/api/repair-orders/${newRoId}/customer-concerns`, {
      token, method: 'POST', body: { concern: srcConcerns[i].concern },
    });
    if (!r.ok) console.error(`[XCLONE] ✗ concern ${i+1}:`, r.raw);
    else console.log(`[XCLONE] ✓ concern ${i+1}/${srcConcerns.length}`);
  }

  // ----- 6. jobs (TWO-STEP per job, against DEST shop)
  const jobs = JOBS_LIMIT ? srcJobs.slice(0, JOBS_LIMIT) : srcJobs;
  if (JOBS_LIMIT) console.log(`[XCLONE] JOBS_LIMIT=${JOBS_LIMIT} → ${jobs.length} of ${srcJobs.length} job(s).`);

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    const label = `job ${i+1}/${jobs.length} "${job.name}"`;

    const empty = await jsonFetch(`/api/shop/${DEST_SHOP_ID}/job`, {
      token, method: 'POST',
      body: { name: job.name || 'New Job', repairOrderId: newRoId, syncPartsAttachedToNonQuotedOrders: false },
    });
    if (!empty.ok) {
      console.error(`[XCLONE] ✗ ${label} empty-create status=${empty.status}`, empty.raw);
      if (AUTO_ROLLBACK) await rollback(token, newRoId);
      return;
    }
    const emptyJob = unwrap(empty);

    const popPayload = buildPopulatePayload(emptyJob, job);
    const pop = await jsonFetch(`/api/shop/${DEST_SHOP_ID}/job`, { token, method: 'POST', body: popPayload });
    if (!pop.ok) {
      console.error(`[XCLONE] ✗ ${label} populate status=${pop.status}`);
      console.error('         response (raw):', pop.raw);
      try { console.error('         response (json):', JSON.stringify(pop.body, null, 2)); } catch (_) {}
      console.error('         payload (json):', JSON.stringify(popPayload, null, 2));
      if (AUTO_ROLLBACK) await rollback(token, newRoId);
      return;
    }
    console.log(`[XCLONE] ✓ ${label} — empty-id=${emptyJob.id}, ${job.parts?.length||0}p / ${job.labor?.length||0}l`);
  }

  console.log(`%c[XCLONE] DONE — open: ${newRoUrl}`, 'color:#0a0;font-weight:bold');
})();
