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
  const VERSION = '2026-04-30.1';

  // ============================================================
  // SAFETY GATE — defaults to DRY RUN. Flip to true to actually
  // create customers / vehicles / ROs / jobs in the destination.
  // ============================================================
  const CONFIRM = false;

  // Job-payload behavior toggle.
  //   false (default) → preserve the SOURCE labor item rate / technician
  //                     when present, falling back to dest defaults. This
  //                     is the more migration-faithful behavior — it
  //                     keeps the rates the customer was quoted at the
  //                     old shop.
  //   true            → always use the DESTINATION RO's labor rate and
  //                     defaultTechnician (strict mirror of the
  //                     extension's createTekmetricJob in
  //                     mos-tools-extension/background.js). Flip this on
  //                     if Tekmetric's job-create endpoint rejects the
  //                     source-rate payload during the smoke test.
  const FORCE_DEST_LABOR_RATE_AND_TECH = false;

  // Marker prefixed onto the destination RO's customer concern so we can
  // detect already-migrated ROs on a re-run.
  const MIGRATION_MARKER = (sourceRoNumber) => `[migrated from RO#${sourceRoNumber}]`;
  const MIGRATION_MARKER_RE = /\[migrated from RO#(\d+)\]/;

  // ----- ENDPOINTS (best-effort defaults; confirm against fixtures/) ------
  const ENDPOINTS = {
    base: location.origin,
    // Job Board listing on DEST — used to scan for already-migrated markers.
    jobBoardList: (shopId, page, size) =>
      `/api/shop/${shopId}/repair-order?status=ESTIMATE,WORK_IN_PROGRESS&page=${page}&size=${size}&sort=updatedDate,desc`,
    repairOrderDetail: (shopId, roId) =>
      `/api/shop/${shopId}/repair-order/${roId}`,
    // Customer search by phone/email — used to match existing customers
    // already created by Tekmetric's own transfer (which copies customers).
    customerSearch: (shopId, q) =>
      `/api/shop/${shopId}/customer?search=${encodeURIComponent(q)}&page=0&size=20`,
    customerCreate: (shopId) => `/api/shop/${shopId}/customer`,
    // Vehicle search by VIN — same reason as customer search.
    vehicleSearch: (shopId, q) =>
      `/api/shop/${shopId}/vehicle?search=${encodeURIComponent(q)}&page=0&size=20`,
    vehicleCreate: (shopId) => `/api/shop/${shopId}/vehicle`,
    // Create RO. Per discovery may need to be `/repair-order` (singular).
    repairOrderCreate: (shopId) => `/api/shop/${shopId}/repair-order`,
    // Create job — KNOWN endpoint, mirrors background.js:1352.
    jobCreate: (shopId) => `/api/shop/${shopId}/job`,
  };

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
    return new Promise((resolve) => {
      const captured = { token: null };
      const origFetch = window.fetch;
      const origOpen = XMLHttpRequest.prototype.open;
      const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
      let timeoutId;
      function done(token) {
        if (captured.token) return;
        captured.token = token;
        window.fetch = origFetch;
        XMLHttpRequest.prototype.open = origOpen;
        XMLHttpRequest.prototype.setRequestHeader = origSetHeader;
        clearTimeout(timeoutId);
        resolve(token);
      }
      window.fetch = function patched(input, init) {
        try {
          const headers = (init && init.headers) || (input && input.headers);
          if (headers) {
            const h = headers instanceof Headers ? headers.get('x-auth-token') :
              (headers['x-auth-token'] || headers['X-Auth-Token']);
            if (h) done(h);
          }
        } catch (_) {}
        return origFetch.apply(this, arguments);
      };
      XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
        if (typeof name === 'string' && name.toLowerCase() === 'x-auth-token' && value) done(value);
        return origSetHeader.apply(this, arguments);
      };
      const shopId = readShopIdFromUrl();
      if (shopId) {
        try { fetch(`${ENDPOINTS.base}/api/shop/${shopId}`, { credentials: 'include' }).catch(() => {}); } catch (_) {}
      }
      timeoutId = setTimeout(() => done(null), 4000);
    });
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

  // Build a job payload mirroring the known shape from
  // mos-tools-extension/background.js:createTekmetricJob.
  function buildJobPayload(srcJob, destRo, destRoLaborRate) {
    // Labor rate / technician resolution. See FORCE_DEST_LABOR_RATE_AND_TECH
    // at the top of this snippet for the trade-off rationale.
    const pickRate = (item) => {
      if (FORCE_DEST_LABOR_RATE_AND_TECH) return destRoLaborRate || 15000;
      return typeof item.rate === 'number' ? item.rate : (destRoLaborRate || 15000);
    };
    const pickTech = (item) => {
      if (FORCE_DEST_LABOR_RATE_AND_TECH) return destRo.defaultTechnician || null;
      return item.technician || destRo.defaultTechnician || null;
    };
    const labor = (srcJob.labor || srcJob.laborItems || []).map((item) => ({
      tempId: Math.random(),
      jobId: null,
      name: item.name || item.description || 'Labor',
      hours: parseFloat(item.hours) || 0,
      rate: pickRate(item),
      technician: pickTech(item),
    }));
    const parts = (srcJob.parts || []).map((part) => ({
      tempId: Math.random(),
      jobId: null,
      name: part.name || part.description || 'Part',
      partNumber: part.partNumber || '',
      oemPartNumber: part.oemPartNumber || '',
      brand: part.brand || '',
      cost: typeof part.cost === 'number' ? part.cost : Math.round((parseFloat(part.cost) || 0) * 100),
      quantity: parseInt(part.quantity) || 1,
      retail: typeof part.retail === 'number' ? part.retail : Math.round((parseFloat(part.retail) || parseFloat(part.price) || 0) * 100),
      position: part.position || '',
      partType: part.partType || { id: 1, code: 'PART' },
    }));
    const veh = destRo.vehicle || {};
    const vehicleDesc = veh.year || veh.make || veh.model
      ? `${veh.year || ''} ${veh.make || ''} ${veh.model || ''}`.trim()
      : '';
    return {
      repairOrderId: parseInt(destRo.id),
      repairOrderNumber: destRo.repairOrderNumber,
      repairOrderVehicleDescription: vehicleDesc,
      name: srcJob.name || srcJob.jobName || 'Job',
      status: srcJob.status || 'Pending',
      selected: true,
      archived: false,
      authorized: srcJob.authorized ?? null,
      authorizedDate: srcJob.authorizedDate ?? null,
      milesOut: destRo.milesOut ?? destRo.vehicle?.mileageOut ?? null,
      technician: FORCE_DEST_LABOR_RATE_AND_TECH
        ? (destRo.defaultTechnician ?? null)
        : (srcJob.technician ?? destRo.defaultTechnician ?? null),
      labor,
      parts,
      discounts: srcJob.discounts || [],
      fees: srcJob.fees || [],
      feeable: srcJob.feeable ?? true,
      taxLabor: destRo.taxLabor ?? false,
      taxParts: destRo.taxParts ?? true,
      taxFees: destRo.taxFees ?? true,
      taxTires: destRo.taxTires ?? false,
      taxTiresFet: destRo.taxTiresFet ?? true,
      note: srcJob.note ?? null,
      notDeclined: true,
    };
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

  // Hard safety check: do not allow loading back into the source shop.
  if (Number(dump.source.shopId) === Number(destShopId)) {
    console.error(`[LOAD-CORE] REFUSING TO RUN: dump source shop id (${dump.source.shopId}) equals active shop id (${destShopId}). You appear to be trying to load the dump back into the source shop. Switch the active Tekmetric shop to the destination and re-paste.`);
    return;
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
      } else if (!summaryHasConcernField(ro)) {
        summariesNeedingDetail.push({ id: ro.id, repairOrderNumber: ro.repairOrderNumber });
      }
    }
    if (content.length < PAGE_SIZE) break;
    page++;
    if (page > 200) break;
  }
  if (summariesNeedingDetail.length) {
    console.log(`[LOAD-CORE] Pre-scan: summary did not expose customerConcerns; fetching detail for ${summariesNeedingDetail.length} dest RO(s) for a deterministic marker check…`);
    let detailMatches = 0;
    for (let i = 0; i < summariesNeedingDetail.length; i++) {
      const s = summariesNeedingDetail[i];
      try {
        const detail = await jsonFetch(ENDPOINTS.repairOrderDetail(destShopId, s.id), token);
        const srcRoNum = extractMarkerFromConcernsField(detail.customerConcerns ?? detail.customerConcern);
        if (srcRoNum) {
          alreadyMigrated.set(String(srcRoNum), { destRoId: detail.id, destRoNumber: detail.repairOrderNumber });
          detailMatches++;
        }
      } catch (e) {
        console.warn(`[LOAD-CORE] detail fetch for dest RO #${s.repairOrderNumber} failed: ${e.message}`);
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
    const destJobs = destDetail.jobs || destDetail.repairOrderJobs || [];
    const destByName = new Map();
    for (const dj of destJobs) {
      const arr = destByName.get(dj.name) || [];
      arr.push(dj);
      destByName.set(dj.name, arr);
    }
    const destLaborRate = destDetail.laborRate || srcRepairOrder.laborRate || 15000;
    const jobMappings = [];
    let created = 0;
    let missing = 0;
    for (let j = 0; j < srcJobs.length; j++) {
      const sj = srcJobs[j];
      const candidates = destByName.get(sj.name) || [];
      let match = candidates.shift() || null;
      if (!match) {
        // Resume: this job was missing from the previous run. Create it.
        missing++;
        try {
          const payload = buildJobPayload(sj, destDetail, destLaborRate);
          const createdJob = await jsonFetch(ENDPOINTS.jobCreate(destShopId), token, {
            method: 'POST',
            body: JSON.stringify(payload),
          });
          match = { id: createdJob && (createdJob.id ?? createdJob.jobId), name: createdJob && createdJob.name };
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
      if (!foundSrcRo && !summaryHasConcernField(ro)) {
        try {
          const detail = await jsonFetch(ENDPOINTS.repairOrderDetail(destShopId, ro.id), token);
          foundSrcRo = extractMarkerFromConcernsField(detail.customerConcerns ?? detail.customerConcern);
        } catch (_) {}
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

      // 1. Customer: try to match by email/phone first, then create.
      step = 'matchCustomer';
      let destCustomerId = null;
      const srcCust = src.customer || {};
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
        } catch (_) { /* swallow — fall through to create */ }
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

      // 2. Vehicle: try to match by VIN first, then create + attach to customer.
      step = 'matchVehicle';
      let destVehicleId = null;
      const srcVeh = src.vehicle || {};
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

      // 3. Create RO with marker prefixed to customer concern.
      //    Tekmetric payloads vary by build: concerns may be exposed as
      //    `customerConcerns` (plural array of {concern, ...}) or as
      //    `customerConcern` (singular — sometimes a string, sometimes an
      //    object {concern: "..."}). Normalize both to a plural array of
      //    objects before prepending the migration marker so we don't drop
      //    the original concern text on builds that use the singular form.
      step = 'createRo';
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
      const firstConcern = srcConcerns[0] || { concern: '' };
      const taggedConcerns = srcConcerns.length
        ? [
            { ...firstConcern, concern: `${MIGRATION_MARKER(sourceRoNumber)} ${firstConcern.concern || ''}`.trim() },
            ...srcConcerns.slice(1),
          ]
        : [{ concern: MIGRATION_MARKER(sourceRoNumber) }];
      const createdRo = await jsonFetch(ENDPOINTS.repairOrderCreate(destShopId), token, {
        method: 'POST',
        body: JSON.stringify({
          customerId: destCustomerId,
          vehicleId: destVehicleId,
          status: src.status || 'ESTIMATE',
          milesIn: src.milesIn ?? null,
          milesOut: src.milesOut ?? null,
          serviceWriter: src.serviceWriter ?? null,
          serviceWriterId: src.serviceWriter?.id ?? null,
          appointmentStartTime: src.appointmentStartTime ?? src.appointment?.startTime ?? null,
          appointmentEndTime: src.appointmentEndTime ?? src.appointment?.endTime ?? null,
          customerConcerns: taggedConcerns,
          notes: src.notes || src.note || null,
          color: src.color || null,
          tag: src.tag || null,
          dropOffDate: src.dropOffDate ?? null,
          completedDate: src.completedDate ?? null,
        }),
      });

      // 4. Create each job on the new RO. Record srcJobId→destJobId so
      //    Snippet 3 can attach photos to the equivalent job entity.
      step = 'createJob[]';
      const srcJobs = src.jobs || src.repairOrderJobs || [];
      const destLaborRate = createdRo.laborRate || src.laborRate || 15000;
      let labors = 0; let parts = 0;
      const jobMappings = [];
      for (let j = 0; j < srcJobs.length; j++) {
        const srcJob = srcJobs[j];
        step = `createJob[${j}](${srcJob.name || 'unnamed'})`;
        const payload = buildJobPayload(srcJob, createdRo, destLaborRate);
        const createdJob = await jsonFetch(ENDPOINTS.jobCreate(destShopId), token, {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        labors += payload.labor.length;
        parts += payload.parts.length;
        jobMappings.push({
          srcJobId: srcJob.id ?? null,
          srcJobName: srcJob.name ?? null,
          destJobId: createdJob && (createdJob.id ?? createdJob.jobId) || null,
          destJobName: createdJob && (createdJob.name ?? null),
        });
      }

      successes.push({
        sourceRo: sourceRoNumber,
        destRo: createdRo.repairOrderNumber,
        destRoId: createdRo.id,
        jobs: srcJobs.length,
        labor: labors,
        parts,
      });
      mapping.push({
        sourceRoId,
        sourceRoNumber,
        destRoId: createdRo.id,
        destRoNumber: createdRo.repairOrderNumber,
        reused: false,
        jobMappings,
      });
      console.log(`[LOAD-CORE] (${i + 1}/${willCreate.length}) #${sourceRoNumber} → #${createdRo.repairOrderNumber} (${srcJobs.length} jobs)`);
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
