/* eslint-disable */
/**
 * Tekmetric Open Jobs Migration — Snippet 8d: CREATE APPOINTMENTS (browser)
 *
 * Companion to 08c-dump-source-appts.ts. Loads the appt-dump JSON the Node
 * script wrote, then for each enriched appointment:
 *   - looks up the dest customer (email -> phone -> exact-name match)
 *   - looks up the dest vehicle by VIN, scoped to that customer
 *   - POSTs the appointment on the destination shop using the user JWT
 *
 * USAGE
 *   1. Run 08c first to dump source appointments to JSON.
 *   2. Open shop.tekmetric.com in Chrome with a user logged in who can
 *      access the destination shop.
 *   3. Edit DEST_SHOP_ID below and CONFIRM (false for dry-run).
 *   4. Paste the whole snippet into the Console. A file picker opens —
 *      choose the appt-dump JSON from output/.
 *   5. The snippet prints a summary and downloads a mapping JSON.
 *      Re-run with CONFIRM=true to actually create.
 */
(async () => {
  // ============== EDIT THESE PER SHOP ==============
  const DEST_SHOP_ID = 18007;
  const CONFIRM = false; // set true on the second paste to actually create
  // =================================================

  const VERSION = '2026-05-01.1';

  const ENDPOINTS = {
    base: location.origin,
    apptCreate: (shopId) => `/api/shop/${shopId}/appointments`,
    customerSearch: (shopId, q) =>
      `/api/shop/${shopId}/customers?search=${encodeURIComponent(q)}&size=20&sort=firstName,lastName`,
    vehicleSearch: (shopId, customerId, q) =>
      `/api/shop/${shopId}/customer/${customerId}/vehicles-search?search=${encodeURIComponent(q)}&size=20`,
  };

  function captureToken() {
    const JWT_RE = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
    for (const k of Object.keys(localStorage)) {
      const v = localStorage.getItem(k) || '';
      if (JWT_RE.test(v)) return v;
      try {
        const p = JSON.parse(v);
        if (p && typeof p.token === 'string' && p.token.startsWith('eyJ')) return p.token;
        if (p && typeof p.accessToken === 'string' && p.accessToken.startsWith('eyJ'))
          return p.accessToken;
      } catch (_) {}
    }
    return null;
  }
  const TOKEN = captureToken();
  if (!TOKEN) {
    console.error('[APPT] No JWT in localStorage. Are you logged in?');
    return;
  }

  async function jsonFetch(path, opts = {}) {
    const url = path.startsWith('http') ? path : `${ENDPOINTS.base}${path}`;
    const res = await fetch(url, {
      method: opts.method || 'GET',
      credentials: 'include',
      headers: {
        'x-auth-token': TOKEN,
        'content-type': 'application/json',
        accept: 'application/json',
        ...(opts.headers || {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let body;
    try { body = text ? JSON.parse(text) : null; } catch (_) { body = text; }
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} ${path}`);
      err.status = res.status;
      err.body = typeof body === 'string' ? body : JSON.stringify(body);
      throw err;
    }
    return body;
  }

  function downloadJson(name, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }
  function ts() { return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, ''); }
  function pickEmail(c) {
    if (!c) return null;
    if (typeof c.email === 'string' && c.email.includes('@')) return c.email.toLowerCase().trim();
    return null;
  }
  function pickPhone(c) {
    if (!c) return null;
    const arr = Array.isArray(c.phone) ? c.phone : [];
    const p = arr.find((x) => x && x.primary) || arr[0];
    if (!p || !p.number) return null;
    return String(p.number).replace(/\D+/g, '');
  }
  function fullName(c) {
    if (!c) return '';
    return `${c.firstName || ''} ${c.lastName || ''}`.trim();
  }

  // ----- 1. PICK DUMP FILE -------------------------------------------
  console.log(`%c[APPT] v${VERSION}  dest=${DEST_SHOP_ID}  CONFIRM=${CONFIRM}`,
    'color:#06f;font-weight:bold');
  console.log('[APPT] Pick the appt-dump JSON file...');
  const file = await new Promise((resolveFile) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = () => resolveFile(input.files && input.files[0]);
    input.click();
  });
  if (!file) {
    console.error('[APPT] No file chosen.');
    return;
  }
  const dump = JSON.parse(await file.text());
  if (dump.schema !== 'tekmetric-appt-dump') {
    console.error('[APPT] File schema is not tekmetric-appt-dump:', dump.schema);
    return;
  }
  const items = dump.appointments || [];
  console.log(`[APPT] loaded ${items.length} appts from ${file.name} (src=${dump.srcShopId})`);

  // ----- 2. RESOLVE + CREATE ----------------------------------------
  const destCustCache = new Map();
  const destVehCache = new Map();
  const results = [];

  for (let i = 0; i < items.length; i += 1) {
    const { appt: a, srcCustomer, srcVehicle } = items[i];
    const tag = `(${i + 1}/${items.length})`;
    const row = {
      sourceApptId: a.id,
      sourceCustomerId: a.customerId,
      sourceVehicleId: a.vehicleId,
      startTime: a.startTime,
      endTime: a.endTime,
      title: a.title || '',
      customerName: fullName(srcCustomer),
      customerEmail: pickEmail(srcCustomer) || '',
      customerPhone: pickPhone(srcCustomer) || '',
      vehicleVin: (srcVehicle && srcVehicle.vin) || '',
      vehicleYMM: srcVehicle ? `${srcVehicle.year || ''} ${srcVehicle.make || ''} ${srcVehicle.model || ''}`.trim() : '',
      status: 'error',
    };

    try {
      if (!srcCustomer) {
        row.status = 'gap-customer';
        row.error = 'src customer missing in dump';
        results.push(row);
        console.log(`[APPT] ${tag} appt ${a.id}: GAP (no src customer in dump)`);
        continue;
      }

      // dest customer match
      if (!destCustCache.has(a.customerId)) {
        const email = pickEmail(srcCustomer);
        const phone = pickPhone(srcCustomer);
        const name = fullName(srcCustomer);
        let hit = null;
        if (email) {
          const r = await jsonFetch(ENDPOINTS.customerSearch(DEST_SHOP_ID, email));
          const list = Array.isArray(r) ? r : r.content || [];
          hit = list.find((c) => pickEmail(c) === email);
          if (hit) hit._matchedBy = 'email';
        }
        if (!hit && phone) {
          const r = await jsonFetch(ENDPOINTS.customerSearch(DEST_SHOP_ID, phone));
          const list = Array.isArray(r) ? r : r.content || [];
          hit = list.find((c) => pickPhone(c) === phone);
          if (hit) hit._matchedBy = 'phone';
        }
        if (!hit && name) {
          const r = await jsonFetch(ENDPOINTS.customerSearch(DEST_SHOP_ID, name));
          const list = Array.isArray(r) ? r : r.content || [];
          const matches = list.filter((c) => fullName(c).toLowerCase() === name.toLowerCase());
          if (matches.length === 1) {
            hit = matches[0];
            hit._matchedBy = 'name';
          }
        }
        destCustCache.set(a.customerId, hit || null);
      }
      const destCust = destCustCache.get(a.customerId);
      if (!destCust) {
        row.status = 'gap-customer';
        row.error = 'no matching customer on dest';
        results.push(row);
        console.log(`[APPT] ${tag} appt ${a.id}: GAP customer "${row.customerName}" (${row.customerEmail || row.customerPhone || 'no contact'})`);
        continue;
      }
      row.destCustomerId = destCust.id;
      row.customerMatchedBy = destCust._matchedBy;

      // dest vehicle by VIN
      const vin = (srcVehicle && srcVehicle.vin && String(srcVehicle.vin).trim()) || '';
      if (!vin) {
        row.status = 'gap-vehicle';
        row.error = 'src vehicle has no VIN';
        results.push(row);
        console.log(`[APPT] ${tag} appt ${a.id}: GAP vehicle (no VIN)`);
        continue;
      }
      const vKey = `${destCust.id}-${vin.toUpperCase()}`;
      if (!destVehCache.has(vKey)) {
        const r = await jsonFetch(ENDPOINTS.vehicleSearch(DEST_SHOP_ID, destCust.id, vin));
        const list = Array.isArray(r) ? r : r.content || [];
        const hit = list.find((v) => (v.vin || '').toUpperCase() === vin.toUpperCase());
        destVehCache.set(vKey, hit ? hit.id : null);
      }
      const destVehId = destVehCache.get(vKey);
      if (!destVehId) {
        row.status = 'gap-vehicle';
        row.error = `no vehicle on dest with VIN ${vin}`;
        results.push(row);
        console.log(`[APPT] ${tag} appt ${a.id}: GAP vehicle VIN=${vin}`);
        continue;
      }
      row.destVehicleId = destVehId;
      row.vehicleMatchedBy = 'vin';

      if (!CONFIRM) {
        row.status = 'dry-run';
        results.push(row);
        console.log(`[APPT] ${tag} appt ${a.id}: DRY-RUN -> cust ${destCust.id} veh ${destVehId} @ ${a.startTime}`);
        continue;
      }

      const body = {
        shopId: DEST_SHOP_ID,
        customerId: destCust.id,
        vehicleId: destVehId,
        startTime: a.startTime,
        endTime: a.endTime,
        title: a.title || null,
        description: a.description || a.note || null,
        color: a.color || null,
        dropoffTime: a.dropoffTime || null,
        pickupTime: a.pickupTime || null,
        rideOption: a.rideOption || null,
        appointmentOption: a.appointmentOption || null,
        appointmentStatus: a.appointmentStatus || 'NONE',
        leadSource: a.leadSource || null,
      };

      let created;
      try {
        created = await jsonFetch(ENDPOINTS.apptCreate(DEST_SHOP_ID), { method: 'POST', body });
      } catch (err) {
        row.status = 'error';
        row.error = `create failed: ${err.status} ${(err.body || err.message || '').slice(0, 300)}`;
        results.push(row);
        console.error(`[APPT] ${tag} appt ${a.id}: CREATE FAILED ${row.error}`);
        continue;
      }
      row.destApptId = created && (created.id || (created.data && created.data.id));
      row.status = 'created';
      results.push(row);
      console.log(`[APPT] ${tag} appt ${a.id}: CREATED dest appt ${row.destApptId}`);
    } catch (err) {
      row.status = 'error';
      row.error = (err.body || err.message || String(err)).slice(0, 500);
      results.push(row);
      console.error(`[APPT] ${tag} appt ${a.id}: ERROR ${row.error}`);
    }
  }

  // ----- 3. REPORT + DOWNLOAD ---------------------------------------
  const counts = {
    total: results.length,
    created: results.filter((r) => r.status === 'created').length,
    dryRun: results.filter((r) => r.status === 'dry-run').length,
    gapCustomer: results.filter((r) => r.status === 'gap-customer').length,
    gapVehicle: results.filter((r) => r.status === 'gap-vehicle').length,
    error: results.filter((r) => r.status === 'error').length,
  };
  console.log('%c[APPT] ===== SUMMARY =====', 'color:#0a0;font-weight:bold');
  console.table(counts);
  const errs = results.filter((r) => r.status === 'error');
  if (errs.length) {
    console.log('%c[APPT] Errors:', 'color:#a00;font-weight:bold');
    console.table(errs.map((r) => ({ srcAppt: r.sourceApptId, error: r.error })));
  }
  const gaps = results.filter((r) => r.status === 'gap-customer' || r.status === 'gap-vehicle');
  if (gaps.length) {
    console.log('%c[APPT] Gaps (recreate manually):', 'color:#a60;font-weight:bold');
    console.table(gaps.map((r) => ({
      srcAppt: r.sourceApptId,
      when: r.startTime,
      customer: r.customerName,
      contact: r.customerEmail || r.customerPhone,
      vin: r.vehicleVin,
      ymm: r.vehicleYMM,
      title: r.title,
      reason: r.error,
    })));
  }
  const fname = `tekmetric-appt-migration-${dump.srcShopId}-to-${DEST_SHOP_ID}-${ts()}.json`;
  downloadJson(fname, {
    schema: 'tekmetric-appt-migration-mapping',
    schemaVersion: VERSION,
    createdAt: new Date().toISOString(),
    src: dump.srcShopId,
    dest: DEST_SHOP_ID,
    confirm: CONFIRM,
    counts,
    results,
  });
  console.log(`[APPT] Wrote ${fname} to Downloads.`);
  if (!CONFIRM) {
    console.log('%c[APPT] DRY RUN. Re-paste with CONFIRM = true to create.', 'color:#06f');
  }
})();
