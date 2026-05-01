/* eslint-disable no-console */
/*
 * Tekmetric Migration — CROSS-SHOP CLONE WITH CUSTOMER/VEHICLE OVERRIDES
 *
 * Purpose: clone one open RO from a SOURCE shop into a brand-new RO in a
 * DEST shop, attaching it to a customer + vehicle that already exist in
 * the dest shop (i.e. NOT recreating the source customer/vehicle in dest).
 *
 * Use case: you have an RO in shop A under customer Foo, and you want a
 * test copy of it in shop B under an existing customer Bar / vehicle Baz.
 *
 * Modeled on 04-clone-ro-same-shop.js (proven against shop 14245 / RO #62).
 * Differences vs 04:
 *   - Source shop and dest shop are separate config knobs.
 *   - DEST_CUSTOMER_ID and DEST_VEHICLE_ID are required overrides
 *     (the source customer/vehicle IDs are NOT carried into the dest RO).
 *   - DEST_LABOR_RATE_ID is auto-discovered from any existing dest RO if
 *     not set, since the source labor-rate id won't exist in the dest.
 *   - Each populated job's `technician` and each labor line's
 *     `autoApplyLaborMatrixId` are forced to null, since those reference
 *     source-shop entities that don't exist in dest. Re-assign in the UI
 *     after clone.
 *   - The first concern is prepended with `[migrated from RO#N]` so
 *     re-runs of 02-load-core-dest.js (which scans for that marker) will
 *     skip the cloned RO instead of duplicating it.
 *
 * REQUIREMENTS
 *   - Your active Tekmetric session must be able to reach BOTH shops
 *     (i.e. you can switch between them via Tekmetric's shop dropdown).
 *     If your token is org-scoped to only one of them, the source GET
 *     will 403 and the script bails before writing anything.
 *
 * USAGE
 *   1. Find Jay Demore's customer ID in dest shop 14245 by opening his
 *      customer page in Tekmetric — the URL ends in
 *      `/admin/shop/14245/customers/{customerId}`.
 *   2. From his customer page, click the vehicle you want — the URL ends
 *      in `/vehicles/{vehicleId}`.
 *   3. Find the source RO ID in shop 10214 by opening it — URL ends in
 *      `/repair-orders/{roId}/estimate`.
 *   4. Fill in the CONFIG block below.
 *   5. Open DevTools console on ANY Tekmetric page (either shop's URL is
 *      fine — most endpoints are not URL-shop-scoped).
 *   6. Paste the whole file. Leave CONFIRM=false the first time — it
 *      pre-flights both shops, validates the dest customer + vehicle,
 *      auto-discovers the dest labor rate, and prints what it would do.
 *   7. Edit CONFIRM to true at the top, re-paste. The new RO will be
 *      created in the dest shop with the override customer/vehicle. A
 *      clickable link to it is printed at the end.
 */
(async () => {
  // ===== CONFIG =====
  const SOURCE_SHOP_ID    = 10214;        // shop the RO is being cloned FROM
  const SOURCE_RO_ID      = null;         // numeric RO id in source shop  (REQUIRED)
  const DEST_SHOP_ID      = 14245;        // shop the new RO will be created IN
  const DEST_CUSTOMER_ID  = null;         // existing customer in DEST shop  (REQUIRED — Jay Demore)
  const DEST_VEHICLE_ID   = null;         // existing vehicle in DEST shop   (REQUIRED — Jay's vehicle)
  const DEST_LABOR_RATE_ID = null;        // null = auto-discover from a recent dest RO
  const CONFIRM           = false;        // false = dry-run; true = actually create
  const JOBS_LIMIT        = null;         // null = clone all jobs; e.g. 1 to test the first only
  const AUTO_ROLLBACK     = true;         // on per-job failure, set partial RO to DELETED
  // ==================

  const BASE = location.origin;

  // hard-fail fast on missing required config
  for (const [k, v] of Object.entries({
    SOURCE_RO_ID, DEST_CUSTOMER_ID, DEST_VEHICLE_ID,
  })) {
    if (v == null) {
      console.error(`[CLONE-X] Missing required config: ${k}. Fill it in at the top of the snippet and re-paste.`);
      return;
    }
  }

  // ----- token discovery (works from any tab; same pattern as 04) ---------
  async function getToken() {
    for (const k of Object.keys(localStorage)) {
      const v = localStorage.getItem(k) || '';
      if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(v)) return v;
      try {
        const parsed = JSON.parse(v);
        if (parsed && typeof parsed.token === 'string' && parsed.token.startsWith('eyJ')) return parsed.token;
        if (parsed && typeof parsed.accessToken === 'string' && parsed.accessToken.startsWith('eyJ')) return parsed.accessToken;
      } catch (_) {}
    }
    return await new Promise((resolve, reject) => {
      const origFetch = window.fetch.bind(window);
      const timeout = setTimeout(() => {
        window.fetch = origFetch;
        reject(new Error('Timed out waiting for an outgoing API call to snipe the auth token from. Click anywhere in Tekmetric and re-run.'));
      }, 8000);
      window.fetch = function patched(input, init) {
        try {
          const headers = (init && init.headers) || {};
          let token = null;
          if (headers instanceof Headers) token = headers.get('X-AUTH-TOKEN');
          else if (Array.isArray(headers)) {
            const h = headers.find(([k]) => /^x-auth-token$/i.test(k));
            if (h) token = h[1];
          } else for (const k of Object.keys(headers)) if (k.toLowerCase() === 'x-auth-token') token = headers[k];
          if (token) {
            clearTimeout(timeout);
            window.fetch = origFetch;
            resolve(token);
          }
        } catch (_) {}
        return origFetch(input, init);
      };
      try {
        const m = location.pathname.match(/\/admin\/shop\/(\d+)\b/);
        const probeShop = m ? Number(m[1]) : DEST_SHOP_ID;
        origFetch(`${BASE}/api/shop/${probeShop}`, { credentials: 'include' }).catch(() => {});
      } catch (_) {}
    });
  }

  async function jsonFetch(path, opts = {}) {
    const token = opts.token;
    const init = {
      method: opts.method || 'GET',
      credentials: 'include',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'X-AUTH-TOKEN': token,
      },
    };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
    const res = await fetch(`${BASE}${path}`, init);
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch (_) {}
    return { status: res.status, ok: res.ok, body: parsed, raw: text };
  }

  function unwrap(resp) {
    if (resp.body && typeof resp.body === 'object' && 'data' in resp.body && 'type' in resp.body) return resp.body.data;
    return resp.body;
  }

  // Lean part / labor / populate helpers — verbatim from 04, except the
  // populate helper here forces technician = null and labor lines'
  // autoApplyLaborMatrixId = null because those reference source-shop
  // entities that don't exist in dest.
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
      'width', 'ratio', 'diameter', 'constructionType', 'loadIndex', 'speedRating',
      'tireType', 'mileageWarranty', 'loadRange', 'tireCategory', 'runFlat',
      'sideWallStyle', 'treadwear', 'traction', 'temperature']) {
      if (p[k] !== undefined && p[k] !== null) out[k] = p[k];
    }
    return out;
  }

  function leanLabor(l, newJobId) {
    const out = {
      tempId: Math.random(),
      jobId: newJobId,
      name: l.name ?? '',
      hours: l.hours ?? 0,
      rate: l.rate ?? 0,
      // null these — they reference source-shop entities
      autoApplyLaborMatrixId: null,
      technician: null,
    };
    for (const k of ['complete', 'position', 'warrantyLabel', 'sortOrder', 'sectionApplication']) {
      if (l[k] !== undefined && l[k] !== null) out[k] = l[k];
    }
    return out;
  }

  function buildPopulatePayload(emptyJobResp, sourceJob) {
    const newJobId = emptyJobResp.id;
    const populated = { ...emptyJobResp };
    populated.name = sourceJob.name ?? populated.name;
    populated.status = sourceJob.status ?? populated.status;
    populated.selected = sourceJob.selected ?? populated.selected;
    populated.authorized = sourceJob.authorized ?? populated.authorized;
    populated.technician = null; // source-shop tech id won't exist in dest
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
    populated.labor = (sourceJob.labor || []).map((l) => leanLabor(l, newJobId));
    populated.discounts = [];
    populated.fees = [];
    populated.smartJobIds = [];
    populated.smartJobs = [];
    populated.laborTechnicians = [];
    return populated;
  }

  async function rollbackPartialRo(token, partialRoId) {
    try {
      const r = await jsonFetch(`/api/repair-order/${partialRoId}/status`, {
        token, method: 'PUT',
        body: { repairOrderStatus: { code: 'DELETED', name: 'Deleted', id: 7 } },
      });
      if (r.ok) console.warn(`[CLONE-X] auto-rolled-back partial RO ${partialRoId} (set to DELETED).`);
      else console.warn(`[CLONE-X] auto-rollback FAILED for RO ${partialRoId} status=${r.status}; delete it manually:`, r.raw);
    } catch (e) {
      console.warn(`[CLONE-X] auto-rollback threw for RO ${partialRoId}: ${e.message}`);
    }
  }

  console.log(`%c[CLONE-X] starting — source shop ${SOURCE_SHOP_ID} RO ${SOURCE_RO_ID} → dest shop ${DEST_SHOP_ID} customer ${DEST_CUSTOMER_ID} vehicle ${DEST_VEHICLE_ID}, CONFIRM=${CONFIRM}`,
    'color:#06c;font-weight:bold');

  let token;
  try {
    token = await getToken();
    console.log(`[CLONE-X] got auth token (len=${token.length}).`);
  } catch (e) {
    console.error('[CLONE-X] could not get auth token:', e.message);
    return;
  }

  // ----- 0. PRE-FLIGHT: token must reach both shops; dest customer + vehicle must exist
  const probeSrc = await jsonFetch(`/api/shop/${SOURCE_SHOP_ID}`, { token });
  if (!probeSrc.ok) {
    console.error(`[CLONE-X] cannot reach source shop ${SOURCE_SHOP_ID} (status=${probeSrc.status}). Your active session can't read this shop. Switch to it via the Tekmetric shop dropdown, or log in to the org that owns it, then re-run.`);
    return;
  }
  const probeDst = await jsonFetch(`/api/shop/${DEST_SHOP_ID}`, { token });
  if (!probeDst.ok) {
    console.error(`[CLONE-X] cannot reach dest shop ${DEST_SHOP_ID} (status=${probeDst.status}). Same fix as above for the dest shop.`);
    return;
  }
  console.log(`[CLONE-X] ✓ token reaches both source (${SOURCE_SHOP_ID}) and dest (${DEST_SHOP_ID}).`);

  const destCustResp = await jsonFetch(`/api/shop/${DEST_SHOP_ID}/customer/${DEST_CUSTOMER_ID}`, { token });
  if (!destCustResp.ok) {
    console.error(`[CLONE-X] dest customer ${DEST_CUSTOMER_ID} not found in shop ${DEST_SHOP_ID} (status=${destCustResp.status}). Double-check the ID from the customer-page URL in Tekmetric.`);
    return;
  }
  const destCust = unwrap(destCustResp);
  console.log(`[CLONE-X] ✓ dest customer: ${destCust.firstName} ${destCust.lastName} (id ${destCust.id})`);

  const destVehResp = await jsonFetch(`/api/shop/${DEST_SHOP_ID}/vehicle/${DEST_VEHICLE_ID}`, { token });
  if (!destVehResp.ok) {
    console.error(`[CLONE-X] dest vehicle ${DEST_VEHICLE_ID} not found in shop ${DEST_SHOP_ID} (status=${destVehResp.status}). Double-check the ID from the vehicle-page URL.`);
    return;
  }
  const destVeh = unwrap(destVehResp);
  console.log(`[CLONE-X] ✓ dest vehicle: ${destVeh.year || ''} ${destVeh.make || ''} ${destVeh.model || ''} VIN=${destVeh.vin || ''} (id ${destVeh.id})`);

  // ----- 0b. resolve dest labor rate (auto-discover if not set)
  let destLaborRateId = DEST_LABOR_RATE_ID;
  if (!destLaborRateId) {
    const recent = await jsonFetch(`/api/shop/${DEST_SHOP_ID}/repair-order?page=0&size=10`, { token });
    if (recent.ok) {
      const list = (recent.body && (recent.body.content || recent.body.repairOrders || recent.body.data || recent.body)) || [];
      for (const ro of list) {
        const lr = typeof ro.laborRate === 'number' ? ro.laborRate : ro.laborRate?.id;
        if (lr) { destLaborRateId = lr; break; }
      }
    }
    if (!destLaborRateId) {
      console.error(`[CLONE-X] could not auto-discover a labor rate id from any recent RO in dest shop ${DEST_SHOP_ID}. Set DEST_LABOR_RATE_ID at the top of the snippet and re-run.`);
      return;
    }
    console.log(`[CLONE-X] ✓ auto-discovered dest labor rate id = ${destLaborRateId}`);
  } else {
    console.log(`[CLONE-X] ✓ using configured dest labor rate id = ${destLaborRateId}`);
  }

  // ----- 1. fetch source RO metadata, jobs (from estimate endpoint), and concerns
  const roResp = await jsonFetch(`/api/shop/${SOURCE_SHOP_ID}/repair-order/${SOURCE_RO_ID}`, { token });
  if (!roResp.ok) {
    console.error(`[CLONE-X] failed to fetch source RO: status=${roResp.status}`, roResp.body);
    return;
  }
  const sourceRo = unwrap(roResp);

  const estResp = await jsonFetch(`/api/repair-order/${SOURCE_RO_ID}/estimate`, { token });
  if (!estResp.ok) {
    console.error(`[CLONE-X] failed to fetch source estimate: status=${estResp.status}`, estResp.body);
    return;
  }
  const sourceEstimate = unwrap(estResp);
  const sourceJobs = (sourceEstimate.jobs || []).filter((j) => !j.archived);

  const APPT_OPTION_MAP = { DROP: 2, WAIT: 1, PICKUP: 3 };
  const sourceApptOption = typeof sourceRo.appointmentOption === 'number'
    ? sourceRo.appointmentOption
    : (APPT_OPTION_MAP[sourceRo.appointmentOption] ?? 2);

  console.log(`[CLONE-X] source RO #${sourceRo.repairOrderNumber} has ${sourceJobs.length} non-archived job(s).`);
  console.log(`          source customer: ${sourceRo.customer?.firstName} ${sourceRo.customer?.lastName} (id ${sourceRo.customer?.id}) — IGNORED, using dest override`);
  console.log(`          source vehicle:  ${sourceRo.vehicle?.year} ${sourceRo.vehicle?.make} ${sourceRo.vehicle?.model} (id ${sourceRo.vehicle?.id}) — IGNORED, using dest override`);
  console.log(`          source miles in/out: ${sourceRo.milesIn}/${sourceRo.milesOut}, odometerInop=${sourceRo.odometerInop}`);

  const concernsResp = await jsonFetch(`/api/repair-orders/${SOURCE_RO_ID}/customer-concerns`, { token });
  if (!concernsResp.ok) {
    console.error(`[CLONE-X] failed to fetch source concerns: status=${concernsResp.status}`, concernsResp.body);
    return;
  }
  const sourceConcerns = Array.isArray(concernsResp.body) ? concernsResp.body : (concernsResp.body?.data || []);
  console.log(`[CLONE-X] source RO has ${sourceConcerns.length} customer concern(s).`);

  // Build the concerns we'll POST: prepend migration marker to first concern
  // (matches the marker format used by 02-load-core-dest.js so re-runs of
  // the full migration won't duplicate this RO).
  const MIGRATION_MARKER = `[migrated from RO#${sourceRo.repairOrderNumber}]`;
  const concernsToPost = sourceConcerns.length
    ? [
        { concern: `${MIGRATION_MARKER} ${sourceConcerns[0].concern || ''}`.trim() },
        ...sourceConcerns.slice(1).map((c) => ({ concern: c.concern || '' })),
      ]
    : [{ concern: MIGRATION_MARKER }];

  if (!CONFIRM) {
    console.warn('[CLONE-X] DRY RUN — set CONFIRM=true at the top to actually create the new RO.');
    console.log(`[CLONE-X] would create new RO in shop ${DEST_SHOP_ID}:`);
    console.log(`            customer: ${destCust.firstName} ${destCust.lastName} (id ${destCust.id})`);
    console.log(`            vehicle:  ${destVeh.year || ''} ${destVeh.make || ''} ${destVeh.model || ''} (id ${destVeh.id})`);
    console.log(`            labor rate: ${destLaborRateId}`);
    console.log(`            mileage in/out: ${sourceRo.milesIn ?? '-'}/${sourceRo.milesOut ?? '-'}`);
    concernsToPost.forEach((c, i) => console.log(`            concern ${i + 1}: ${c.concern.slice(0, 100)}${c.concern.length > 100 ? '…' : ''}`));
    sourceJobs.forEach((j, i) => console.log(`            job ${i + 1}: "${j.name}" — ${j.parts?.length || 0} part(s), ${j.labor?.length || 0} labor line(s), status=${j.status}`));
    return;
  }

  // ----- 2. create the new RO in DEST shop with override customer/vehicle
  const createPayload = {
    shop: { id: DEST_SHOP_ID },
    appointmentOption: sourceApptOption,
    odometerInop: sourceRo.odometerInop ?? false,
    leadSource: sourceRo.leadSource || '',
    vehicle: { id: DEST_VEHICLE_ID },
    milesIn: sourceRo.milesIn ?? null,
    laborRate: { id: destLaborRateId },
    customer: { id: DEST_CUSTOMER_ID },
    appointment: null,
    initialJobs: [],
    recommendations: [],
    declinedJobRecommendations: [],
  };
  const createResp = await jsonFetch(`/api/repair-order/create`, { token, method: 'POST', body: createPayload });
  if (!createResp.ok) {
    console.error(`[CLONE-X] RO create failed: status=${createResp.status}`, createResp.body);
    console.error('           payload:', JSON.stringify(createPayload, null, 2));
    return;
  }
  const newRo = unwrap(createResp);
  const newRoId = newRo.id;
  console.log(`%c[CLONE-X] ✓ created new RO id=${newRoId} #${newRo.repairOrderNumber} in shop ${DEST_SHOP_ID}`, 'color:#0a0;font-weight:bold');
  const newRoUrl = `${BASE}/admin/shop/${DEST_SHOP_ID}/repair-orders/${newRoId}/estimate`;
  console.log(`           open it: ${newRoUrl}`);

  // ----- 3. set mileage (if source had any)
  if (sourceRo.milesIn != null || sourceRo.milesOut != null) {
    const milesResp = await jsonFetch(`/api/repair-order/${newRoId}/vehicle-mileage`, {
      token, method: 'PUT',
      body: {
        milesIn: sourceRo.milesIn ?? sourceRo.milesOut ?? 0,
        milesOut: sourceRo.milesOut ?? sourceRo.milesIn ?? 0,
        odometerInop: sourceRo.odometerInop ?? false,
      },
    });
    if (!milesResp.ok) console.warn(`[CLONE-X] mileage PUT failed status=${milesResp.status}`, milesResp.body);
    else console.log(`[CLONE-X] ✓ mileage set`);
  }

  // ----- 4. concerns (first one carries the migration marker)
  for (let i = 0; i < concernsToPost.length; i++) {
    const c = concernsToPost[i];
    const r = await jsonFetch(`/api/repair-orders/${newRoId}/customer-concerns`, {
      token, method: 'POST', body: { concern: c.concern },
    });
    if (!r.ok) console.error(`[CLONE-X] ✗ concern ${i + 1} failed status=${r.status}`, r.body);
    else console.log(`[CLONE-X] ✓ concern ${i + 1}/${concernsToPost.length} created`);
  }

  // ----- 5. jobs (TWO-STEP per job: empty create -> populate), POST against DEST shop
  const jobsToClone = JOBS_LIMIT ? sourceJobs.slice(0, JOBS_LIMIT) : sourceJobs;
  if (JOBS_LIMIT) console.log(`[CLONE-X] JOBS_LIMIT=${JOBS_LIMIT} → cloning only the first ${jobsToClone.length} of ${sourceJobs.length} job(s).`);

  for (let i = 0; i < jobsToClone.length; i++) {
    const job = jobsToClone[i];
    const label = `job ${i + 1}/${jobsToClone.length} "${job.name}"`;

    const emptyPayload = {
      name: job.name || 'New Job',
      repairOrderId: newRoId,
      syncPartsAttachedToNonQuotedOrders: false,
    };
    const emptyResp = await jsonFetch(`/api/shop/${DEST_SHOP_ID}/job`, { token, method: 'POST', body: emptyPayload });
    if (!emptyResp.ok) {
      console.error(`[CLONE-X] ✗ ${label}: empty-create failed status=${emptyResp.status}`);
      console.error('           response (raw):', emptyResp.raw);
      console.error('           payload (json):', JSON.stringify(emptyPayload, null, 2));
      if (AUTO_ROLLBACK) await rollbackPartialRo(token, newRoId);
      else console.warn(`[CLONE-X] stopping. New RO ${newRoId} is partially populated; delete it and re-run.`);
      return;
    }
    const emptyJob = unwrap(emptyResp);

    const populatePayload = buildPopulatePayload(emptyJob, job);
    const popResp = await jsonFetch(`/api/shop/${DEST_SHOP_ID}/job`, { token, method: 'POST', body: populatePayload });
    if (!popResp.ok) {
      console.error(`[CLONE-X] ✗ ${label}: populate failed status=${popResp.status}`);
      console.error('           response (raw):', popResp.raw);
      try { console.error('           response (json):', JSON.stringify(popResp.body, null, 2)); } catch (_) {}
      console.error('           payload (json):', JSON.stringify(populatePayload, null, 2));
      if (AUTO_ROLLBACK) await rollbackPartialRo(token, newRoId);
      else console.warn(`[CLONE-X] stopping. New RO ${newRoId} is partially populated; delete it and re-run.`);
      return;
    }
    console.log(`[CLONE-X] ✓ ${label} — empty-create id=${emptyJob.id}, populate ok (${job.parts?.length || 0}p / ${job.labor?.length || 0}l)`);
  }

  console.log(`%c[CLONE-X] DONE — open the new RO: ${newRoUrl}`, 'color:#0a0;font-weight:bold');
})();
