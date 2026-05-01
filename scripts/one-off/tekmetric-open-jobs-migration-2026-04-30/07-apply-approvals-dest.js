/* eslint-disable */
// =============================================================================
// Tekmetric Open-Jobs Migration — Snippet 7: APPLY APPROVALS / DECLINES
// =============================================================================
// Version: 2026-05-01.1
//
// WHY THIS EXISTS
// ---------------
// Snippet 02 successfully cloned 21 ROs into dest 18008 with all jobs + labor
// + parts. However the populate POST only forwarded `authorized` (true/false)
// and skipped `authorizedDate`, `authorizedTotal`, `declined`, `declinedDate`,
// `declinedTotal`, `declinedNote`. Tekmetric's UI shows the green "Approved"
// pill (and the red "Declined" pill) based on the presence of *Date — so
// without those, the dest jobs look pending even when the source jobs were
// approved.
//
// This snippet is a fix-up pass that runs AFTER 02 finishes. For every
// (sourceRo → destRo) pair in the mapping, it:
//   1. Fetches the dest RO's estimate (which returns `jobs[]` — the dest RO
//      detail endpoint returns `jobs:null` on most builds).
//   2. Matches dest jobs to source jobs by name (same matching strategy that
//      02's reconcileJobsOnReusedRo uses).
//   3. For each match where the source job has an authorization OR decline
//      stamp, re-POSTs the dest job's CURRENT body to /api/shop/{id}/job
//      with only the auth/decline fields overlaid.
//
// IDEMPOTENT — re-pasting is safe. If the dest job already has the same
// authorized/declined state we skip it.
//
// PROVEN ENDPOINT — POST /api/shop/{shopId}/job with the full job body and a
// non-null `id` performs an update. This is the same endpoint snippet 02 uses
// for its empty-create + populate two-step.
//
// LABELS — a separate snippet (07b) will handle repairOrderCustomLabel once
// we have the set endpoint captured from the Tekmetric UI.
//
// HOW TO RUN
// ----------
//   1. Confirm the URL bar shows /shop/18008/...  (dest shop).
//   2. Open DevTools → Console.
//   3. Paste this whole file. Hit Enter.
//   4. First file picker → tekmetric-open-jobs-dump-*.json (the ORIGINAL —
//      augmented version is fine too, augmentation only added inspections).
//   5. Second file picker → tekmetric-migration-mapping-*.json from snippet 2.
//   6. Watch the console. A summary table prints at the end. Spot-check 1–2
//      ROs in the dest UI.
// =============================================================================

(async () => {
  const VERSION = '2026-05-01.1';
  const CONFIRM = true;

  const ENDPOINTS = {
    base: location.origin,
    estimate: (roId) => `/api/repair-order/${roId}/estimate`,
    jobUpsert: (shopId) => `/api/shop/${shopId}/job`,
  };

  // ---------- token capture (same proven scan as 00/01/02) ----------
  async function captureXAuthToken() {
    const JWT_RE = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
    for (const k of Object.keys(localStorage)) {
      const raw = localStorage.getItem(k);
      if (!raw) continue;
      if (JWT_RE.test(raw)) return raw;
      try {
        const parsed = JSON.parse(raw);
        for (const f of ['token', 'accessToken', 'access_token', 'jwt', 'idToken']) {
          if (parsed && typeof parsed[f] === 'string' && JWT_RE.test(parsed[f])) {
            return parsed[f];
          }
        }
      } catch (_) { /* not JSON */ }
    }
    throw new Error(
      'Could not find a JWT in localStorage. Make sure you are logged in to ' +
      'Tekmetric in this tab and refresh once before re-pasting.'
    );
  }

  function readShopIdFromUrl() {
    const m = location.pathname.match(/\/(?:admin\/)?shop\/(\d+)/);
    return m ? m[1] : null;
  }

  async function jsonFetch(path, token, opts = {}) {
    const url = path.startsWith('http') ? path : `${ENDPOINTS.base}${path}`;
    const headers = {
      'accept': 'application/json',
      'x-auth-token': token,
      ...(opts.body ? { 'content-type': 'application/json' } : {}),
      ...(opts.headers || {}),
    };
    const resp = await fetch(url, { ...opts, headers, credentials: 'include' });
    const text = await resp.text();
    let body;
    try { body = text ? JSON.parse(text) : null; } catch (_) { body = text; }
    if (!resp.ok) {
      const e = new Error(`${resp.status} ${resp.statusText} on ${path} :: ${typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300)}`);
      e.status = resp.status;
      e.body = body;
      throw e;
    }
    return body;
  }

  function pickJsonFile(promptText) {
    return new Promise((resolve, reject) => {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = 'application/json,.json';
      inp.style.display = 'none';
      document.body.appendChild(inp);
      console.log(`[APPROVE] ${promptText}`);
      inp.addEventListener('change', async () => {
        const f = inp.files && inp.files[0];
        if (!f) { document.body.removeChild(inp); return reject(new Error('no file picked')); }
        try {
          const text = await f.text();
          const json = JSON.parse(text);
          document.body.removeChild(inp);
          resolve({ name: f.name, json });
        } catch (e) {
          document.body.removeChild(inp);
          reject(e);
        }
      }, { once: true });
      inp.click();
    });
  }

  // ---------- preflight ----------
  const destShopId = readShopIdFromUrl();
  if (!destShopId) {
    console.error('[APPROVE] could not read shop id from URL — open /admin/shop/<id>/... first.');
    return;
  }
  console.log(`[APPROVE] version ${VERSION} — destShopId=${destShopId}`);

  if (!CONFIRM) {
    console.warn('[APPROVE] CONFIRM=false — set CONFIRM=true at the top of this file and re-paste to actually run.');
    return;
  }

  let token;
  try {
    token = await captureXAuthToken();
  } catch (e) {
    console.error(`[APPROVE] ${e.message}`);
    return;
  }

  const { name: dumpName, json: dump } = await pickJsonFile('Pick the tekmetric-open-jobs-dump-*.json file');
  if (dump.schema !== 'tekmetric-open-jobs-dump') {
    console.error(`[APPROVE] file ${dumpName} is not a snippet-1 dump (schema=${dump.schema}).`);
    return;
  }
  const { name: mapName, json: mapping } = await pickJsonFile('Pick the tekmetric-migration-mapping-*.json file');
  if (!Array.isArray(mapping) && !Array.isArray(mapping.results) && !Array.isArray(mapping.mapping)) {
    console.error(`[APPROVE] file ${mapName} doesn't look like the snippet-2 mapping (no array found).`);
    return;
  }
  const mappingRows = Array.isArray(mapping) ? mapping
    : Array.isArray(mapping.results) ? mapping.results
    : mapping.mapping;
  console.log(`[APPROVE] dump=${dumpName} (${dump.rows.length} ROs); mapping=${mapName} (${mappingRows.length} rows)`);

  // Build sourceRoId -> sourceRo lookup.
  const srcById = new Map();
  for (const r of dump.rows) {
    const ro = r.repairOrder || r;
    if (ro && ro.id != null) srcById.set(String(ro.id), ro);
  }

  // ---------- the work ----------
  const successes = [];
  const skipped = [];
  const failures = [];

  function pickAuthFields(srcJob) {
    const out = {};
    if (srcJob.authorized !== undefined) out.authorized = srcJob.authorized;
    if (srcJob.authorizedDate !== undefined) out.authorizedDate = srcJob.authorizedDate;
    if (srcJob.authorizedTotal !== undefined) out.authorizedTotal = srcJob.authorizedTotal;
    if (srcJob.declined !== undefined) out.declined = srcJob.declined;
    if (srcJob.declinedDate !== undefined) out.declinedDate = srcJob.declinedDate;
    if (srcJob.declinedTotal !== undefined) out.declinedTotal = srcJob.declinedTotal;
    if (srcJob.declinedNote !== undefined) out.declinedNote = srcJob.declinedNote;
    return out;
  }

  function hasAuthOrDecline(authFields) {
    return !!(authFields.authorizedDate || authFields.declinedDate ||
              authFields.authorized === true || authFields.declined === true);
  }

  function destAlreadyMatches(destJob, authFields) {
    // Treat as "already correct" if the same authorized boolean AND the same
    // authorizedDate (or both missing). Same for declined.
    const destAuth = !!destJob.authorized;
    const srcAuth = !!authFields.authorized;
    const destAuthDate = destJob.authorizedDate || null;
    const srcAuthDate = authFields.authorizedDate || null;
    const destDecl = !!destJob.declined;
    const srcDecl = !!authFields.declined;
    const destDeclDate = destJob.declinedDate || null;
    const srcDeclDate = authFields.declinedDate || null;
    return destAuth === srcAuth && destAuthDate === srcAuthDate &&
           destDecl === srcDecl && destDeclDate === srcDeclDate;
  }

  for (let i = 0; i < mappingRows.length; i++) {
    const row = mappingRows[i];
    const srcRoId = String(row.sourceRoId ?? row.srcRoId ?? '');
    const destRoId = row.destRoId ?? row.newRoId;
    const sourceRoNumber = row.sourceRoNumber ?? row.srcRoNumber ?? '?';
    const destRoNumber = row.destRoNumber ?? row.newRoNumber ?? '?';
    if (!srcRoId || !destRoId) {
      skipped.push({ sourceRo: sourceRoNumber, reason: 'mapping row missing srcRoId or destRoId' });
      continue;
    }
    const srcRo = srcById.get(srcRoId);
    if (!srcRo) {
      skipped.push({ sourceRo: sourceRoNumber, reason: `source RO id=${srcRoId} not found in dump` });
      continue;
    }
    const srcJobs = (srcRo.jobs || srcRo.repairOrderJobs || []).filter((j) => !j.archived);

    // Skip cheap if no source job has any auth/decline stamp.
    const anyToApply = srcJobs.some((sj) => hasAuthOrDecline(pickAuthFields(sj)));
    if (!anyToApply) {
      skipped.push({ sourceRo: sourceRoNumber, destRo: destRoNumber, reason: 'no source jobs are authorized or declined' });
      continue;
    }

    let destJobs;
    try {
      const est = await jsonFetch(ENDPOINTS.estimate(destRoId), token);
      destJobs = (est && (est.jobs || est.repairOrderJobs)) || [];
    } catch (e) {
      failures.push({ sourceRo: sourceRoNumber, destRo: destRoNumber, step: 'fetchEstimate', error: e.message });
      continue;
    }
    const destByName = new Map();
    for (const dj of destJobs) {
      const arr = destByName.get(dj.name) || [];
      arr.push(dj);
      destByName.set(dj.name, arr);
    }

    let appliedThisRo = 0;
    let skippedThisRo = 0;
    for (let j = 0; j < srcJobs.length; j++) {
      const sj = srcJobs[j];
      const authFields = pickAuthFields(sj);
      if (!hasAuthOrDecline(authFields)) { skippedThisRo++; continue; }
      const candidates = destByName.get(sj.name) || [];
      const dj = candidates.shift() || null;
      if (!dj) {
        failures.push({
          sourceRo: sourceRoNumber, destRo: destRoNumber,
          step: `matchJob[${j}]`, srcJobName: sj.name,
          error: 'no dest job with matching name',
        });
        continue;
      }
      if (destAlreadyMatches(dj, authFields)) {
        skippedThisRo++;
        continue;
      }
      // Build the update body — start from the dest job's CURRENT state and
      // only overlay the auth/decline fields. This minimizes the chance of
      // accidentally clobbering parts/labor edits.
      const body = { ...dj, ...authFields };
      try {
        await jsonFetch(ENDPOINTS.jobUpsert(destShopId), token, {
          method: 'POST',
          body: JSON.stringify(body),
        });
        appliedThisRo++;
      } catch (e) {
        failures.push({
          sourceRo: sourceRoNumber, destRo: destRoNumber,
          step: `updateJob[${j}](${sj.name || 'unnamed'})`,
          srcJobId: sj.id, destJobId: dj.id,
          error: e.message,
        });
      }
    }
    successes.push({ sourceRo: sourceRoNumber, destRo: destRoNumber, applied: appliedThisRo, skipped: skippedThisRo });
    console.log(`[APPROVE] (${i + 1}/${mappingRows.length}) #${sourceRoNumber} → #${destRoNumber}: applied ${appliedThisRo}, skipped ${skippedThisRo}`);
  }

  console.log('[APPROVE] Successes:');
  console.table(successes);
  if (skipped.length) {
    console.log('[APPROVE] Skipped (no work needed):');
    console.table(skipped);
  }
  if (failures.length) {
    console.warn('[APPROVE] Failures:');
    console.table(failures);
  }
  console.log(`[APPROVE] Done. ROs touched: ${successes.length}, jobs updated: ${successes.reduce((a,s)=>a+s.applied,0)}, failures: ${failures.length}.`);
})();
