/* eslint-disable */
/**
 * Tekmetric Open Jobs Migration - Snippet 09b: APPLY INVENTORY MIN/MAX
 *
 * Companion to 09a-dump-and-plan-inventory.ts. Loads the per-shop plan JSON
 * the Node script wrote, then for each row whose action === 'update':
 *   - GETs the full dest part body via the internal API + user JWT
 *   - mutates `min` and `max` to the planned values
 *   - PUTs /api/shop/{dest}/inventory/{partId}
 *
 * Endpoint shape proven from HAR capture 2026-05-01:
 *   PUT https://shop.tekmetric.com/api/shop/{shopId}/inventory/{partId}
 *   Body: the full part object as returned by GET (we read-modify-write so we
 *   don't accidentally clobber any other fields).
 *
 * USAGE
 *   1. Run 09a first (Node) to produce inventory-plan-{src}-to-{dest}-*.json.
 *   2. Open shop.tekmetric.com in Chrome with a user logged in who can
 *      access the destination shop. Navigate to the destination shop so the
 *      session is in that shop's context (URL contains /admin/shop/{dest}/...).
 *   3. Edit DEST_SHOP_ID below and CONFIRM (false for dry-run).
 *   4. Paste the whole snippet into the Console. A file picker opens -
 *      choose the matching plan JSON from output/.
 *   5. The snippet prints a summary and downloads a results JSON.
 *      Re-run with CONFIRM=true to actually write.
 */
(async () => {
  // ============== EDIT THESE PER SHOP ==============
  const DEST_SHOP_ID = 18007;
  const CONFIRM = false; // set true on the second paste to actually write
  // =================================================

  const VERSION = '2026-05-01.1';

  const ENDPOINTS = {
    base: location.origin,
    invGet: (shopId, partId) => `/api/shop/${shopId}/inventory/${partId}`,
    invPut: (shopId, partId) => `/api/shop/${shopId}/inventory/${partId}`,
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
    console.error('[INV] No JWT in localStorage. Are you logged in?');
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

  // ----- 1. PICK PLAN FILE -------------------------------------------
  console.log(`%c[INV] v${VERSION}  dest=${DEST_SHOP_ID}  CONFIRM=${CONFIRM}`,
    'color:#06f;font-weight:bold');
  console.log('[INV] Pick the inventory-plan JSON file...');
  const file = await new Promise((resolveFile) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = () => resolveFile(input.files && input.files[0]);
    input.click();
  });
  if (!file) {
    console.error('[INV] No file chosen.');
    return;
  }
  const plan = JSON.parse(await file.text());
  if (plan.schema !== 'tekmetric-inventory-min-max-plan') {
    console.error('[INV] File schema is not tekmetric-inventory-min-max-plan:', plan.schema);
    return;
  }
  if (plan.destShopId !== DEST_SHOP_ID) {
    console.error(
      `[INV] DEST_SHOP_ID mismatch! Plan is for dest=${plan.destShopId}, snippet is set to ${DEST_SHOP_ID}. Aborting.`
    );
    return;
  }
  const updates = (plan.rows || []).filter((r) => r.action === 'update');
  console.log(
    `[INV] loaded plan src=${plan.srcShopId} dest=${plan.destShopId} (${plan.pairName}) -- ${updates.length} updates queued (${plan.rows.length} total rows)`
  );

  // ----- 2. APPLY ---------------------------------------------------
  const results = [];
  for (let i = 0; i < updates.length; i += 1) {
    const r = updates[i];
    const tag = `(${i + 1}/${updates.length})`;
    const out = {
      destPartId: r.destPartId,
      partNumber: r.partNumber,
      brand: r.brand,
      partTypeId: r.partTypeId,
      partName: r.partName,
      plannedMin: r.newMin,
      plannedMax: r.newMax,
      previousMin: null,
      previousMax: null,
      appliedMin: null,
      appliedMax: null,
      status: 'pending',
    };
    try {
      const cur = await jsonFetch(ENDPOINTS.invGet(DEST_SHOP_ID, r.destPartId));
      out.previousMin = cur.min ?? null;
      out.previousMax = cur.max ?? null;

      // Apply the same fill-only-where-null-or-zero rule on live read so we
      // never clobber a value that someone set between dump and apply.
      const isFillable = (v) => v == null || v === 0;
      const willCopyMin = isFillable(cur.min) && r.srcMin != null && r.srcMin > 0;
      const willCopyMax = isFillable(cur.max) && r.srcMax != null && r.srcMax > 0;
      if (!willCopyMin && !willCopyMax) {
        out.status = 'skip-dest-now-set';
        out.appliedMin = cur.min ?? null;
        out.appliedMax = cur.max ?? null;
        results.push(out);
        console.log(`[INV] ${tag} part ${r.destPartId} ${r.partNumber}: SKIP (dest now has values: min=${cur.min} max=${cur.max})`);
        continue;
      }
      const nextMin = willCopyMin ? r.srcMin : cur.min;
      const nextMax = willCopyMax ? r.srcMax : cur.max;

      if (!CONFIRM) {
        out.status = 'dry-run';
        out.appliedMin = nextMin;
        out.appliedMax = nextMax;
        results.push(out);
        console.log(`[INV] ${tag} part ${r.destPartId} ${r.partNumber}: DRY-RUN min ${cur.min}->${nextMin} max ${cur.max}->${nextMax}`);
        continue;
      }

      // Read-modify-write: keep the entire fetched body, only mutate min/max.
      const updated = { ...cur, min: nextMin, max: nextMax };
      const resp = await jsonFetch(ENDPOINTS.invPut(DEST_SHOP_ID, r.destPartId), {
        method: 'PUT',
        body: updated,
      });
      out.status = 'updated';
      out.appliedMin = (resp && resp.min != null) ? resp.min : nextMin;
      out.appliedMax = (resp && resp.max != null) ? resp.max : nextMax;
      results.push(out);
      console.log(`[INV] ${tag} part ${r.destPartId} ${r.partNumber}: UPDATED min ${cur.min}->${out.appliedMin} max ${cur.max}->${out.appliedMax}`);
    } catch (err) {
      out.status = 'error';
      out.error = `${err.status || ''} ${(err.body || err.message || String(err)).slice(0, 300)}`.trim();
      results.push(out);
      console.error(`[INV] ${tag} part ${r.destPartId} ${r.partNumber}: ERROR ${out.error}`);
    }
  }

  // ----- 3. REPORT + DOWNLOAD ---------------------------------------
  const counts = {
    total: results.length,
    updated: results.filter((r) => r.status === 'updated').length,
    dryRun: results.filter((r) => r.status === 'dry-run').length,
    skipDestNowSet: results.filter((r) => r.status === 'skip-dest-now-set').length,
    error: results.filter((r) => r.status === 'error').length,
  };
  console.log('%c[INV] ===== SUMMARY =====', 'color:#0a0;font-weight:bold');
  console.table(counts);
  const errs = results.filter((r) => r.status === 'error');
  if (errs.length) {
    console.log('%c[INV] Errors:', 'color:#a00;font-weight:bold');
    console.table(errs.map((r) => ({ partId: r.destPartId, partNumber: r.partNumber, error: r.error })));
  }
  const fname = `tekmetric-inventory-apply-${plan.srcShopId}-to-${DEST_SHOP_ID}-${ts()}.json`;
  downloadJson(fname, {
    schema: 'tekmetric-inventory-min-max-apply',
    schemaVersion: VERSION,
    createdAt: new Date().toISOString(),
    src: plan.srcShopId,
    dest: DEST_SHOP_ID,
    confirm: CONFIRM,
    counts,
    results,
  });
  console.log(`[INV] Wrote ${fname} to Downloads.`);
  if (!CONFIRM) {
    console.log('%c[INV] DRY RUN. Re-paste with CONFIRM = true to write.', 'color:#06f');
  }
})();
