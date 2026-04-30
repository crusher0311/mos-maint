/* eslint-disable no-console */
/*
 * Tekmetric Migration — SMOKE TEST: clone one RO into a new RO IN THE SAME SHOP
 *
 * Purpose: end-to-end smoke test of every write endpoint we'll need for the
 * real cross-shop migration, without any cross-shop ID remapping. Reads one
 * source RO, then creates a brand-new RO in the SAME shop with the same
 * customer / vehicle / labor rate / mileage / customer-concerns / jobs
 * (each job's parts + labor lines preserved verbatim).
 *
 * Endpoints exercised (all confirmed against HAR captures 2026-04-30):
 *   GET  /api/shop/{shopId}/repair-order/{roId}            -> RO metadata
 *                                                            (customer/vehicle/laborRate/mileage)
 *   GET  /api/repair-order/{roId}/estimate                 -> jobs[] with parts+labor inline
 *   GET  /api/repair-orders/{roId}/customer-concerns       -> concerns[]
 *   POST /api/repair-order/create                          -> new RO
 *   PUT  /api/repair-order/{newRoId}/vehicle-mileage       -> set mileage
 *   POST /api/repair-orders/{newRoId}/customer-concerns    -> per concern
 *   POST /api/shop/{shopId}/job                            -> empty-job CREATE
 *                                                            ({name, repairOrderId,
 *                                                              syncPartsAttachedToNonQuotedOrders})
 *   POST /api/shop/{shopId}/job                            -> populate (id set,
 *                                                            parts/labor have tempId)
 *   PUT  /api/repair-order/{newRoId}/status                -> auto-rollback DELETED
 *                                                            on failure
 *
 * NOTE on laborRate shape: the RO metadata endpoint returns laborRate as a
 * bare numeric id (e.g. `laborRate: 9991`), NOT an object. The create payload
 * wraps it back into `{ id: <number> }`.
 *
 * NOTE on appointmentOption shape: the RO metadata endpoint returns it as a
 * string enum (e.g. `"DROP"`), but the create endpoint expects a numeric Long.
 * Confirmed mapping from HAR: `"DROP"` -> 2. Other values are best-guess and
 * default to 2 (drop-off) so the create doesn't 400 on an unknown enum.
 *
 * NOTE on job creation: a single fat POST with id=null does NOT work — Tekmetric
 * 500s. The real flow is two-step:
 *   1. POST {name, repairOrderId, syncPartsAttachedToNonQuotedOrders:false}
 *      -> returns the freshly minted empty job (with id, defaults).
 *   2. POST that returned object back, mutated to set source's name/status/
 *      technician/etc and with parts/labor REPLACED by lean items each carrying
 *      a `tempId: <random float>` and `jobId: <new id>`. Most of the bloat
 *      Tekmetric returns on the GET is server-managed and ignored on input —
 *      sending the GET shape verbatim is what triggers the 500.
 *
 * USAGE
 *   1. In Tekmetric, navigate to ANY page on the shop you want to clone within
 *      (e.g. https://shop.tekmetric.com/admin/shop/14245/...). The active
 *      shop in the URL must match SHOP_ID below.
 *   2. Open DevTools console.
 *   3. Set SOURCE_RO_ID below to the RO you want to clone.
 *   4. Leave CONFIRM=false for a dry-run first — it prints what it would do,
 *      writes nothing.
 *   5. Paste the whole file, hit Enter. Read the dry-run output.
 *   6. Edit CONFIRM to true at the top, re-paste, hit Enter. The new RO will
 *      be created and you'll get a clickable link to open it.
 *
 * NOTE: photos and inspections are NOT cloned by this snippet. Smoke test for
 * those is intentionally out of scope — the migration runs them separately
 * via 03-load-extras-dest.js.
 */
(async () => {
  // ===== CONFIG =====
  const SHOP_ID = 14245;          // active shop you're sitting on
  const SOURCE_RO_ID = 255022827; // the RO to clone (RO# 001 / Jay Demore / 2021 Silverado)
  const CONFIRM = false;          // false = dry-run; true = actually create the new RO
  const JOBS_LIMIT = null;        // null = clone all jobs; set to 1 to test just the
                                  // first job before doing all 11
  const AUTO_ROLLBACK = true;     // on any job failure, set the partial RO to DELETED
                                  // so you don't have to clean it up manually
  // ==================

  const BASE = location.origin;

  // sanity: are we on the right shop?
  const m = location.pathname.match(/\/admin\/shop\/(\d+)\b/);
  const activeShop = m ? Number(m[1]) : null;
  if (activeShop !== SHOP_ID) {
    console.error(`[CLONE] Expected to be on shop ${SHOP_ID}, but URL says shop ${activeShop}. Switch shops in Tekmetric, then re-run.`);
    return;
  }

  // ----- token discovery: snipe X-AUTH-TOKEN off any next request, or read from
  // localStorage if it's there. Most reliable: piggyback on a known-safe GET.
  async function getToken() {
    // try localStorage first
    for (const k of Object.keys(localStorage)) {
      const v = localStorage.getItem(k) || '';
      if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(v)) return v;
      try {
        const parsed = JSON.parse(v);
        if (parsed && typeof parsed.token === 'string' && parsed.token.startsWith('eyJ')) return parsed.token;
        if (parsed && typeof parsed.accessToken === 'string' && parsed.accessToken.startsWith('eyJ')) return parsed.accessToken;
      } catch (_) {}
    }
    // fall back: snipe from the next outgoing request by patching fetch briefly
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
      // nudge a request to fire
      try { origFetch(`${BASE}/api/shop/${SHOP_ID}`, { credentials: 'include' }).catch(() => {}); } catch (_) {}
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
    // Tekmetric responses are sometimes {type, message, data, details} and
    // sometimes the bare object. Normalize.
    if (resp.body && typeof resp.body === 'object' && 'data' in resp.body && 'type' in resp.body) return resp.body.data;
    return resp.body;
  }

  // Lean part shape — matches the populate POST captured in HAR. Most of the
  // 80+ fields Tekmetric returns on GET are server-managed; sending them back
  // as-is on a new job triggers a 500. We carry over commonly-meaningful fields
  // (descriptors + tire dimensions + cross-system bridges) but drop everything
  // tied to source-RO state (orders, inventory, invoices, etc.).
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
    // optional descriptors — copy if non-null
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
    // human-set fields we want to carry over from source
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
    // tax flags (preserve if source had non-defaults)
    for (const k of ['taxParts', 'taxLabor', 'taxFees', 'taxTires', 'taxTiresFet']) {
      if (sourceJob[k] !== undefined && sourceJob[k] !== null) populated[k] = sourceJob[k];
    }
    // package-pricing carry-over (some shops use this)
    for (const k of ['packagePrice', 'packagePriceMethod', 'packagePriceSurplusOilMethod',
      'packagePriceModsHidden', 'feeable']) {
      if (sourceJob[k] !== undefined && sourceJob[k] !== null) populated[k] = sourceJob[k];
    }
    // parts + labor: replace with lean shapes
    populated.parts = (sourceJob.parts || []).map((p) => leanPart(p, newJobId));
    populated.labor = (sourceJob.labor || []).map((l) => leanLabor(l, newJobId));
    // discounts/fees/smartJobs/laborTechnicians: smoke test source has none
    // for the test RO; for safety, keep empty arrays (the server seems to
    // recompute totals anyway). Add lean mappers later if a real RO has them.
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
      if (r.ok) console.warn(`[CLONE] auto-rolled-back partial RO ${partialRoId} (set to DELETED).`);
      else console.warn(`[CLONE] auto-rollback FAILED for RO ${partialRoId} status=${r.status}; delete it manually:`, r.raw);
    } catch (e) {
      console.warn(`[CLONE] auto-rollback threw for RO ${partialRoId}: ${e.message}`);
    }
  }

  console.log(`%c[CLONE] starting — shop ${SHOP_ID}, source RO ${SOURCE_RO_ID}, CONFIRM=${CONFIRM}`,
    'color:#06c;font-weight:bold');

  let token;
  try {
    token = await getToken();
    console.log('[CLONE] got auth token (len=' + token.length + ').');
  } catch (e) {
    console.error('[CLONE] could not get auth token:', e.message);
    return;
  }

  // ----- 1. fetch source RO metadata, jobs (from estimate endpoint), and concerns
  const roResp = await jsonFetch(`/api/shop/${SHOP_ID}/repair-order/${SOURCE_RO_ID}`, { token });
  if (!roResp.ok) {
    console.error(`[CLONE] failed to fetch source RO: status=${roResp.status}`, roResp.body);
    return;
  }
  const sourceRo = unwrap(roResp);

  // Jobs come from the estimate endpoint (the RO metadata endpoint returns jobs:null)
  const estResp = await jsonFetch(`/api/repair-order/${SOURCE_RO_ID}/estimate`, { token });
  if (!estResp.ok) {
    console.error(`[CLONE] failed to fetch source estimate: status=${estResp.status}`, estResp.body);
    return;
  }
  const sourceEstimate = unwrap(estResp);
  const sourceJobs = (sourceEstimate.jobs || []).filter((j) => !j.archived);

  // laborRate on the metadata endpoint is a bare number id, not an object
  const sourceLaborRateId = typeof sourceRo.laborRate === 'number'
    ? sourceRo.laborRate
    : sourceRo.laborRate?.id;

  // appointmentOption: GET returns string enum, POST expects numeric Long.
  // Confirmed mapping from HAR: "DROP" -> 2. Default to 2 (drop-off) for any
  // string we don't recognize so the create doesn't 400.
  const APPT_OPTION_MAP = { DROP: 2, WAIT: 1, PICKUP: 3 };
  const sourceApptOption = typeof sourceRo.appointmentOption === 'number'
    ? sourceRo.appointmentOption
    : (APPT_OPTION_MAP[sourceRo.appointmentOption] ?? 2);

  console.log(`[CLONE] source RO #${sourceRo.repairOrderNumber} has ${sourceJobs.length} non-archived job(s).`);
  console.log(`        customer: ${sourceRo.customer?.firstName} ${sourceRo.customer?.lastName} (id ${sourceRo.customer?.id})`);
  console.log(`        vehicle: ${sourceRo.vehicle?.year} ${sourceRo.vehicle?.make} ${sourceRo.vehicle?.model} (id ${sourceRo.vehicle?.id})`);
  console.log(`        miles in/out: ${sourceRo.milesIn}/${sourceRo.milesOut}, odometerInop=${sourceRo.odometerInop}`);
  console.log(`        labor rate id: ${sourceLaborRateId}`);

  const concernsResp = await jsonFetch(`/api/repair-orders/${SOURCE_RO_ID}/customer-concerns`, { token });
  if (!concernsResp.ok) {
    console.error(`[CLONE] failed to fetch source concerns: status=${concernsResp.status}`, concernsResp.body);
    return;
  }
  const sourceConcerns = Array.isArray(concernsResp.body) ? concernsResp.body : (concernsResp.body?.data || []);
  console.log(`[CLONE] source RO has ${sourceConcerns.length} customer concern(s).`);

  if (!CONFIRM) {
    console.warn('[CLONE] DRY RUN — set CONFIRM=true at the top to actually create the new RO.');
    console.log('[CLONE] would create new RO with customer/vehicle/labor-rate above, plus:');
    sourceConcerns.forEach((c, i) => console.log(`        concern ${i + 1}: ${c.concern.slice(0, 80)}${c.concern.length > 80 ? '…' : ''}`));
    sourceJobs.forEach((j, i) => console.log(`        job ${i + 1}: "${j.name}" — ${j.parts?.length || 0} part(s), ${j.labor?.length || 0} labor line(s), status=${j.status}`));
    return;
  }

  // ----- 2. create the new RO
  const createPayload = {
    shop: { id: SHOP_ID },
    appointmentOption: sourceApptOption,
    odometerInop: sourceRo.odometerInop ?? false,
    leadSource: sourceRo.leadSource || '',
    vehicle: { id: sourceRo.vehicle.id },
    milesIn: sourceRo.milesIn ?? null,
    laborRate: { id: sourceLaborRateId },
    customer: { id: sourceRo.customer.id },
    appointment: null,
    initialJobs: [],
    recommendations: [],
    declinedJobRecommendations: [],
  };
  const createResp = await jsonFetch(`/api/repair-order/create`, { token, method: 'POST', body: createPayload });
  if (!createResp.ok) {
    console.error(`[CLONE] RO create failed: status=${createResp.status}`, createResp.body);
    return;
  }
  const newRo = unwrap(createResp);
  const newRoId = newRo.id;
  console.log(`%c[CLONE] ✓ created new RO id=${newRoId} #${newRo.repairOrderNumber}`, 'color:#0a0;font-weight:bold');
  const newRoUrl = `${BASE}/admin/shop/${SHOP_ID}/repair-orders/${newRoId}/estimate`;
  console.log(`        open it: ${newRoUrl}`);

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
    if (!milesResp.ok) console.warn(`[CLONE] mileage PUT failed status=${milesResp.status}`, milesResp.body);
    else console.log(`[CLONE] ✓ mileage set`);
  }

  // ----- 4. concerns
  for (let i = 0; i < sourceConcerns.length; i++) {
    const c = sourceConcerns[i];
    const r = await jsonFetch(`/api/repair-orders/${newRoId}/customer-concerns`, {
      token, method: 'POST', body: { concern: c.concern },
    });
    if (!r.ok) {
      console.error(`[CLONE] ✗ concern ${i + 1} failed status=${r.status}`, r.body);
    } else {
      console.log(`[CLONE] ✓ concern ${i + 1}/${sourceConcerns.length} created`);
    }
  }

  // ----- 5. jobs (TWO-STEP per job: empty create -> populate)
  const jobsToClone = JOBS_LIMIT ? sourceJobs.slice(0, JOBS_LIMIT) : sourceJobs;
  if (JOBS_LIMIT) console.log(`[CLONE] JOBS_LIMIT=${JOBS_LIMIT} → cloning only the first ${jobsToClone.length} of ${sourceJobs.length} job(s).`);

  for (let i = 0; i < jobsToClone.length; i++) {
    const job = jobsToClone[i];
    const label = `job ${i + 1}/${jobsToClone.length} "${job.name}"`;

    // 5a. empty-job create
    const emptyPayload = {
      name: job.name || 'New Job',
      repairOrderId: newRoId,
      syncPartsAttachedToNonQuotedOrders: false,
    };
    const emptyResp = await jsonFetch(`/api/shop/${SHOP_ID}/job`, { token, method: 'POST', body: emptyPayload });
    if (!emptyResp.ok) {
      console.error(`[CLONE] ✗ ${label}: empty-create failed status=${emptyResp.status}`);
      console.error('         response (raw):', emptyResp.raw);
      console.error('         payload (json):', JSON.stringify(emptyPayload, null, 2));
      if (AUTO_ROLLBACK) await rollbackPartialRo(token, newRoId);
      else console.warn(`[CLONE] stopping. New RO ${newRoId} is partially populated; delete it and re-run.`);
      return;
    }
    const emptyJob = unwrap(emptyResp);

    // 5b. populate (with parts + labor + status etc.)
    const populatePayload = buildPopulatePayload(emptyJob, job);
    const popResp = await jsonFetch(`/api/shop/${SHOP_ID}/job`, { token, method: 'POST', body: populatePayload });
    if (!popResp.ok) {
      console.error(`[CLONE] ✗ ${label}: populate failed status=${popResp.status}`);
      console.error('         response (raw):', popResp.raw);
      try { console.error('         response (json):', JSON.stringify(popResp.body, null, 2)); } catch (_) {}
      console.error('         payload (json):', JSON.stringify(populatePayload, null, 2));
      if (AUTO_ROLLBACK) await rollbackPartialRo(token, newRoId);
      else console.warn(`[CLONE] stopping. New RO ${newRoId} is partially populated; delete it and re-run.`);
      return;
    }
    console.log(`[CLONE] ✓ ${label} — empty-create id=${emptyJob.id}, populate ok (${job.parts?.length || 0}p / ${job.labor?.length || 0}l)`);
  }

  console.log(`%c[CLONE] DONE — open the new RO: ${newRoUrl}`, 'color:#0a0;font-weight:bold');
})();
