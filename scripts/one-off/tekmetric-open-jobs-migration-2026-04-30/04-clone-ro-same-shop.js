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
 * Endpoints exercised (all confirmed against HAR capture 2026-04-30):
 *   GET  /api/shop/{shopId}/repair-order/{roId}            -> RO + jobs[]
 *   GET  /api/repair-orders/{roId}/customer-concerns       -> concerns[]
 *   POST /api/repair-order/create                          -> new RO
 *   PUT  /api/repair-order/{newRoId}/vehicle-mileage       -> set mileage
 *   POST /api/repair-orders/{newRoId}/customer-concerns    -> per concern
 *   POST /api/shop/{shopId}/job                            -> per job (with
 *                                                            parts+labor inline)
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
  const SOURCE_RO_ID = 324433830; // the RO to clone (RO# 058 / Jay Demore / 2021 Silverado)
  const CONFIRM = false;          // false = dry-run; true = actually create the new RO
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

  // strip identifiers so Tekmetric mints fresh ones for the new RO
  function cleanJobForCreate(job, newRoId) {
    const cleaned = { ...job };
    cleaned.id = null;
    cleaned.repairOrderId = newRoId;
    if (Array.isArray(cleaned.parts)) {
      cleaned.parts = cleaned.parts.map((p) => ({
        ...p,
        id: null,
        jobId: null,
        repairOrderId: newRoId,
        orderId: null,
        partsTechOrderItemId: null,
        invoiceNumber: null,
        orderDate: null,
        orderNumber: null,
        orderStatus: null,
      }));
    }
    if (Array.isArray(cleaned.labor)) {
      cleaned.labor = cleaned.labor.map((l) => ({
        ...l,
        id: null,
        jobId: null,
        repairOrderId: newRoId,
      }));
    }
    if (Array.isArray(cleaned.discounts)) {
      cleaned.discounts = cleaned.discounts.map((d) => ({ ...d, id: null, jobId: null, repairOrderId: newRoId }));
    }
    if (Array.isArray(cleaned.fees)) {
      cleaned.fees = cleaned.fees.map((f) => ({ ...f, id: null, jobId: null, repairOrderId: newRoId }));
    }
    if (Array.isArray(cleaned.laborTechnicians)) {
      cleaned.laborTechnicians = cleaned.laborTechnicians.map((lt) => ({ ...lt, id: null }));
    }
    return cleaned;
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

  // ----- 1. fetch source RO + concerns
  const roResp = await jsonFetch(`/api/shop/${SHOP_ID}/repair-order/${SOURCE_RO_ID}`, { token });
  if (!roResp.ok) {
    console.error(`[CLONE] failed to fetch source RO: status=${roResp.status}`, roResp.body);
    return;
  }
  const sourceRo = unwrap(roResp);
  const sourceJobs = (sourceRo.jobs || []).filter((j) => !j.archived);
  console.log(`[CLONE] source RO #${sourceRo.repairOrderNumber} has ${sourceJobs.length} non-archived job(s).`);
  console.log(`        customer: ${sourceRo.customer?.firstName} ${sourceRo.customer?.lastName} (id ${sourceRo.customer?.id})`);
  console.log(`        vehicle: ${sourceRo.vehicle?.year} ${sourceRo.vehicle?.make} ${sourceRo.vehicle?.model} (id ${sourceRo.vehicle?.id})`);
  console.log(`        miles in/out: ${sourceRo.milesIn}/${sourceRo.milesOut}, odometerInop=${sourceRo.odometerInop}`);
  console.log(`        labor rate id: ${sourceRo.laborRate?.id}`);

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
    appointmentOption: sourceRo.appointmentOption ?? 2,
    odometerInop: sourceRo.odometerInop ?? false,
    leadSource: sourceRo.leadSource || '',
    vehicle: { id: sourceRo.vehicle.id },
    milesIn: sourceRo.milesIn ?? null,
    laborRate: { id: sourceRo.laborRate.id },
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

  // ----- 5. jobs (one POST per job, parts+labor inline)
  for (let i = 0; i < sourceJobs.length; i++) {
    const job = sourceJobs[i];
    const payload = cleanJobForCreate(job, newRoId);
    const r = await jsonFetch(`/api/shop/${SHOP_ID}/job`, { token, method: 'POST', body: payload });
    if (!r.ok) {
      console.error(`[CLONE] ✗ job ${i + 1}/${sourceJobs.length} "${job.name}" failed status=${r.status}`);
      console.error('         response:', r.body);
      console.error('         payload:', payload);
      console.warn(`[CLONE] stopping after first job failure. New RO ${newRoId} is partially populated; delete it and re-run after fixing.`);
      return;
    }
    console.log(`[CLONE] ✓ job ${i + 1}/${sourceJobs.length} "${job.name}" created`);
  }

  console.log(`%c[CLONE] DONE — open the new RO: ${newRoUrl}`, 'color:#0a0;font-weight:bold');
})();
