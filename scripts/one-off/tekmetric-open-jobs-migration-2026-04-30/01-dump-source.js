/* eslint-disable */
/**
 * Tekmetric Open Jobs Migration — Snippet 1: DUMP (source shop)
 *
 * Paste this whole file into Chrome DevTools Console while you are on
 * shop.tekmetric.com with the SOURCE shop active. It will:
 *   1. capture the live x-auth-token from the session
 *   2. read every non-Posted (Estimate / WIP) RO from the Job Board
 *   3. fetch each RO's full detail (customer, vehicle, header, jobs with
 *      labor & parts, notes, customer concerns, mileage, service writer,
 *      appointment) plus the list of inspection IDs/titles attached
 *   4. trigger a download of a single tekmetric-open-jobs-dump-{shop}-{ts}.json
 *
 * It does NOT write anything to Tekmetric. There is no CONFIRM gate because
 * this snippet is read-only.
 *
 * After it finishes:
 *   - switch the active Tekmetric shop to the destination shop
 *   - paste 02-load-core-dest.js
 *
 * If anything in this snippet's ENDPOINTS block disagrees with what you saw
 * during the discovery pass, edit them here before pasting.
 */
(async () => {
  const VERSION = '2026-05-01.1-tokenfix';

  // ----- ENDPOINTS (confirmed against HAR captures + same-shop smoke test) -
  const ENDPOINTS = {
    base: location.origin, // https://shop.tekmetric.com in practice
    // Job Board listing — internal endpoint. Common shape:
    //   /api/shop/{shopId}/repair-order?status=ESTIMATE,WORK_IN_PROGRESS&page=...&size=...
    jobBoardList: (shopId, page, size) =>
      `/api/shop/${shopId}/repair-order?status=ESTIMATE,WORK_IN_PROGRESS&page=${page}&size=${size}&sort=updatedDate,desc`,
    // RO header / metadata — customer, vehicle, laborRate, mileage, header
    // fields. NOTE: this endpoint returns `jobs: null` — jobs must be fetched
    // separately from the estimate endpoint below.
    repairOrderDetail: (shopId, roId) =>
      `/api/shop/${shopId}/repair-order/${roId}`,
    // Jobs (with parts + labor inline) — confirmed in HAR 2026-04-30. This is
    // the only endpoint that returns the full jobs array for an RO.
    repairOrderEstimate: (roId) =>
      `/api/repair-order/${roId}/estimate`,
    // Customer concerns — confirmed in HAR 2026-04-30. The RO detail endpoint
    // sometimes embeds concerns, sometimes doesn't; this endpoint is the
    // authoritative source.
    repairOrderConcerns: (roId) =>
      `/api/repair-orders/${roId}/customer-concerns`,
    // Inspection list per RO — known internal path from
    // lib/integrations/tekmetric/client.ts:276
    inspectionList: (shopId, roId) =>
      `/api/shop/${shopId}/repair-orders/${roId}/inspections`,
  };

  const PAGE_SIZE = 50;

  // ----- TOKEN + SHOP CAPTURE -------------------------------------------
  function readShopIdFromUrl() {
    const m = location.pathname.match(/\/(?:admin\/)?shop\/(\d+)/);
    return m ? m[1] : null;
  }

  function readShopNameFromDom() {
    // Tekmetric typically renders the active shop name in a header / picker.
    // We pick the first reasonable candidate; falls back to "shop-{id}".
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
    // Use the same proven extraction as 00-print-token.js: scan
    // localStorage for a JWT-shaped value (raw or wrapped in JSON under
    // .token / .accessToken). The fetch-monkey-patch approach we tried
    // first was tripped up by Tekmetric's auth interceptor: a probe
    // request fired from the snippet doesn't go through the page's
    // interceptor, so the patched fetch never sees x-auth-token.
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

  // ----- HELPERS ---------------------------------------------------------
  async function jsonFetch(path, token) {
    const url = path.startsWith('http') ? path : `${ENDPOINTS.base}${path}`;
    const res = await fetch(url, {
      headers: {
        'x-auth-token': token,
        'content-type': 'application/json',
        'accept': 'application/json',
      },
      credentials: 'include',
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`${res.status} ${res.statusText} on ${path} :: ${body.slice(0, 200)}`);
    }
    return res.json();
  }

  function downloadJson(filename, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 1000);
  }

  function ts() {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
  }

  function safeFilenamePart(s) {
    return (s || 'unknown').toString().replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 40);
  }

  // ----- MAIN ------------------------------------------------------------
  console.log(`%c[Tekmetric Migration DUMP v${VERSION}] starting…`, 'color:#0a0;font-weight:bold');

  const shopId = readShopIdFromUrl();
  if (!shopId) {
    console.error('[DUMP] No shop ID detected in URL. Open a Tekmetric shop page (e.g. the Job Board) and re-paste.');
    return;
  }
  const shopName = readShopNameFromDom() || `shop-${shopId}`;
  console.log(`[DUMP] Active shop: ${shopName} (id=${shopId})`);

  console.log('[DUMP] Capturing x-auth-token from live session…');
  const token = await captureXAuthToken();
  if (!token) {
    console.error('[DUMP] Could not capture x-auth-token. Click around in Tekmetric (open an RO, switch tabs) to trigger a request, then re-paste this snippet.');
    return;
  }
  console.log(`[DUMP] Token captured (length=${token.length}).`);

  // 1. List Job Board ROs (paginated)
  const allRoSummaries = [];
  let page = 0;
  while (true) {
    const path = ENDPOINTS.jobBoardList(shopId, page, PAGE_SIZE);
    let resp;
    try {
      resp = await jsonFetch(path, token);
    } catch (err) {
      console.error(`[DUMP] Job Board listing failed at page ${page}:`, err.message);
      console.error('[DUMP] If this is a 404, the jobBoardList path in ENDPOINTS does not match what this Tekmetric build uses. Update the ENDPOINTS.jobBoardList in this snippet using the captured fixtures/job-board-list.req.json and re-run.');
      return;
    }
    // Tolerate either {content: [...]} or a bare array.
    const content = Array.isArray(resp) ? resp : (resp.content || resp.repairOrders || resp.data || []);
    if (!content.length) break;
    allRoSummaries.push(...content);
    const totalPages = (resp && resp.totalPages) || (content.length < PAGE_SIZE ? page + 1 : null);
    console.log(`[DUMP] Listed page ${page + 1}${totalPages ? ` / ${totalPages}` : ''}: ${content.length} ROs (running total ${allRoSummaries.length})`);
    if (content.length < PAGE_SIZE) break;
    if (totalPages && page + 1 >= totalPages) break;
    page++;
    if (page > 200) {
      console.warn('[DUMP] Hit hard cap of 200 pages — bailing out of pagination.');
      break;
    }
  }
  console.log(`[DUMP] Job Board total: ${allRoSummaries.length} open ROs`);

  // 2. Fetch full RO detail + estimate (jobs) + concerns + inspection list for each.
  //    The RO detail endpoint returns `jobs: null`, so we MUST also hit the
  //    estimate endpoint to capture the jobs/parts/labor that Snippet 2 will
  //    re-create in the destination shop. Concerns are fetched from their own
  //    endpoint for the same reason — RO detail's `customerConcerns` field
  //    is unreliable across Tekmetric builds.
  const dumpedRos = [];
  let inspectionCount = 0;
  let jobCount = 0;
  let concernCount = 0;
  let estimateMissCount = 0;
  let concernsMissCount = 0;
  for (let i = 0; i < allRoSummaries.length; i++) {
    const summary = allRoSummaries[i];
    const roId = summary.id || summary.repairOrderId;
    const roNumber = summary.repairOrderNumber || summary.number;
    try {
      const detail = await jsonFetch(ENDPOINTS.repairOrderDetail(shopId, roId), token);

      // Fetch jobs from the estimate endpoint (RO detail returns jobs:null).
      let jobs = [];
      try {
        const est = await jsonFetch(ENDPOINTS.repairOrderEstimate(roId), token);
        jobs = (est && (est.jobs || est.repairOrderJobs)) || [];
      } catch (e) {
        estimateMissCount++;
        console.warn(`[DUMP] estimate fetch failed for RO #${roNumber} (id=${roId}): ${e.message}`);
      }

      // Fetch concerns from the dedicated concerns endpoint.
      let concerns = [];
      try {
        const c = await jsonFetch(ENDPOINTS.repairOrderConcerns(roId), token);
        concerns = Array.isArray(c) ? c : (c && (c.data || c.content)) || [];
      } catch (e) {
        concernsMissCount++;
        console.warn(`[DUMP] concerns fetch failed for RO #${roNumber} (id=${roId}): ${e.message}`);
      }

      let inspections = [];
      try {
        inspections = await jsonFetch(ENDPOINTS.inspectionList(shopId, roId), token);
      } catch (e) {
        // Inspection listing failures are non-fatal at dump time — Snippet 3
        // is the one that actually needs the inspection content.
        console.warn(`[DUMP] inspection list failed for RO #${roNumber} (id=${roId}): ${e.message}`);
      }
      const inspectionSummaries = (Array.isArray(inspections) ? inspections : (inspections.content || []))
        .map((ins) => ({ id: ins.id, title: ins.title || ins.name, jobId: ins.jobId || null }));

      // Overlay jobs + concerns onto the RO detail so Snippet 2 can read
      // everything off `repairOrder` without juggling extra fields.
      detail.jobs = jobs;
      detail.customerConcerns = concerns;

      inspectionCount += inspectionSummaries.length;
      jobCount += jobs.length;
      concernCount += concerns.length;

      dumpedRos.push({
        sourceRoId: roId,
        sourceRoNumber: roNumber,
        repairOrder: detail,
        inspections: inspectionSummaries, // full content fetched in Snippet 3
      });
      if ((i + 1) % 10 === 0 || i === allRoSummaries.length - 1) {
        console.log(`[DUMP] RO ${i + 1}/${allRoSummaries.length} (#${roNumber}) — running counts: jobs=${jobCount} concerns=${concernCount} inspections=${inspectionCount}`);
      }
    } catch (err) {
      console.error(`[DUMP] Failed to fetch RO #${roNumber} (id=${roId}):`, err.message);
      dumpedRos.push({
        sourceRoId: roId,
        sourceRoNumber: roNumber,
        repairOrder: null,
        inspections: [],
        _dumpError: err.message,
      });
    }
  }

  const dumpedOk = dumpedRos.filter((r) => r.repairOrder).length;
  const dumpedErr = dumpedRos.length - dumpedOk;

  const payload = {
    schema: 'tekmetric-open-jobs-dump',
    schemaVersion: VERSION,
    dumpedAt: new Date().toISOString(),
    source: { shopId: Number(shopId), shopName },
    counts: {
      ros: dumpedRos.length,
      rosWithDetail: dumpedOk,
      rosWithDumpError: dumpedErr,
      jobs: jobCount,
      inspections: inspectionCount,
    },
    repairOrders: dumpedRos,
  };

  const filename = `tekmetric-open-jobs-dump-${safeFilenamePart(shopName)}-${ts()}.json`;
  downloadJson(filename, payload);

  console.log('%c[DUMP] Summary:', 'color:#0a0;font-weight:bold');
  console.table([{
    sourceShop: shopName,
    sourceShopId: shopId,
    rosListed: allRoSummaries.length,
    rosWithDetail: dumpedOk,
    rosWithDumpError: dumpedErr,
    jobs: jobCount,
    inspections: inspectionCount,
    file: filename,
  }]);
  if (dumpedErr) {
    console.warn(`[DUMP] ${dumpedErr} RO(s) had dump errors — see logs above. They will be skipped by Snippet 2 because their repairOrder is null.`);
  }
  console.log('[DUMP] Done. Now switch the active Tekmetric shop to the DESTINATION shop, then paste 02-load-core-dest.js.');
})();
