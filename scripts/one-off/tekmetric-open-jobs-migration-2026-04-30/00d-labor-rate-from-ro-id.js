/* eslint-disable no-console */
/*
 * Tiny helper: given ONE RO id you can already see in the DEST shop, fetch
 * that RO's detail directly (same endpoint shape 06 uses successfully) and
 * print the laborRate id. Use this when 00c-find-dest-labor-rate.js can't
 * find any listing endpoint that the dest token is allowed to hit.
 *
 * USAGE
 *   1. In Tekmetric on shop 14245, click any existing RO in the Job Board.
 *      The URL becomes /admin/shop/14245/repair-orders/<RO_ID>/estimate.
 *   2. Copy that <RO_ID> number into DEST_RO_ID below.
 *   3. Paste your dest token into DEST_TOKEN (capture with 00-print-token.js
 *      on a 14245 tab if you don't have it handy).
 *   4. Open DevTools → Console on any Tekmetric tab. Paste this whole file.
 *   5. The labor rate id is printed (and copied to your clipboard, with a
 *      BEGIN/END marker fallback). Paste that number into 06's
 *      DEST_LABOR_RATE_ID line, re-paste 06.
 */
(async () => {
  const DEST_SHOP_ID  = 14245;
  const DEST_RO_ID    = 255022827;        // <-- paste the numeric RO id here
  const DEST_TOKEN    = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJicmFuZG9uQG15b2lsc3RpY2tlci5jb20iLCJ1c2VySWQiOiIxNDE1MzIiLCJzaG9wSWQiOiIxNDI0NSIsInNob3BUaW1lWm9uZUlkIjoiQW1lcmljYS9DaGljYWdvIiwicGVybWlzc2lvbnMiOlsiMTAwMCIsIjE1MDIiLCIxMDAiLCIxNTAxIiwiMjAwIiwiMTAxIiwiMTUwMCIsIjIwMSIsIjMwMCIsIjEwMiIsIjE0MDAiLCIxMDMiLCIyMDIiLCIzMDEiLCI0MDAiLCIxMTAyIiwiNTAwIiwiMjAzIiwiMzAyIiwiNDAxIiwiMTMwMCIsIjEyMDEiLCI0MDIiLCIxMTAxIiwiNjAwIiwiMjA0IiwiMTIwMCIsIjUwMSIsIjIwNSIsIjQwMyIsIjcwMCIsIjExMDAiLCI2MDEiLCI1MDIiLCIyMDYiLCI4MDAiLCI1MDMiLCI2MDMiLCIyMDciLCI4MDEiLCI5MDAiLCI1MDQiLCI4MDIiLCI1MDUiLCI1MDYiXSwiZW1wbG95ZWVJZCI6IjIyMTEwNiIsImVtcGxveWVlUm9sZSI6eyJpZCI6MSwiY29kZSI6IjEiLCJuYW1lIjoiU2hvcCBBZG1pbiJ9LCJhY2NvdW50VHlwZSI6IlVTRVIiLCJzZXJ2ZXJUaW1lIjoiMjAyNi0wNS0wMVQwMTowNDowOS42MDUwMzc0NDRaIiwiZXhwIjoxNzc3NjU1MDQ5fQ.qmuZci689_-fWGfb070XZbGfm0dcIzDj0dRxgGPGaj8';          // <-- paste dest token here

  if (!DEST_RO_ID || typeof DEST_RO_ID !== 'number') {
    console.error('[FIND-LR2] DEST_RO_ID is missing. Open any RO in shop 14245 and copy the number from the URL.');
    return;
  }
  if (!/^eyJ/.test(DEST_TOKEN)) {
    console.error('[FIND-LR2] DEST_TOKEN is missing or not a JWT. Capture it with 00-print-token.js on a 14245 tab.');
    return;
  }

  const url = `/api/shop/${DEST_SHOP_ID}/repair-order/${DEST_RO_ID}`;
  const r = await fetch(url, { headers: { Accept: 'application/json', 'X-AUTH-TOKEN': DEST_TOKEN } });
  if (!r.ok) {
    console.error(`[FIND-LR2] ${url} → status=${r.status}. Double-check DEST_RO_ID belongs to shop ${DEST_SHOP_ID}.`);
    return;
  }
  const body = await r.json().catch(() => null);
  const ro = body && body.data && body.type ? body.data : body;
  const lr = (typeof ro?.laborRate === 'number') ? ro.laborRate
           : (ro?.laborRate && typeof ro.laborRate.id === 'number' ? ro.laborRate.id : null);

  if (!lr) {
    console.error(`[FIND-LR2] RO ${DEST_RO_ID} returned 200 but no laborRate field. Try a different RO id.`);
    console.log('Full RO payload for inspection:', ro);
    return;
  }

  console.log(`%c[FIND-LR2] ✓ dest laborRate id = ${lr}  (from RO ${DEST_RO_ID} in shop ${DEST_SHOP_ID})`,
    'color:#0a0;font-weight:bold');
  console.log(`%c[FIND-LR2] paste this into 06's DEST_LABOR_RATE_ID line:  const DEST_LABOR_RATE_ID = ${lr};`,
    'color:#06c;font-weight:bold');

  try {
    await navigator.clipboard.writeText(String(lr));
    console.log('[FIND-LR2] ✓ copied to clipboard.');
  } catch (_) {
    console.log('[FIND-LR2] could not auto-copy. Manually copy the number between the markers below:');
    console.log('====== BEGIN DEST_LABOR_RATE_ID ======\n' + lr + '\n====== END DEST_LABOR_RATE_ID ======');
  }
})();
