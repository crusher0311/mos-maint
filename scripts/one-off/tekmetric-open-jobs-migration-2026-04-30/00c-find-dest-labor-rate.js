/* eslint-disable no-console */
/*
 * Tiny helper: finds a usable laborRate id for the DEST shop, so you can
 * paste it into 06's DEST_LABOR_RATE_ID config field and skip 06's
 * auto-discovery (which depends on a particular Tekmetric URL shape that
 * isn't always available).
 *
 * USAGE
 *   1. Open the DEST-shop tab in Tekmetric (e.g. /admin/shop/14245/...).
 *   2. Open DevTools → Console.
 *   3. Edit the DEST_TOKEN line below, pasting the dest token you captured
 *      with 00-print-token.js between the quotes.
 *   4. Optionally edit DEST_VEHICLE_ID / DEST_CUSTOMER_ID if your dest
 *      customer is different (defaults match the HCAC Jay Demore record).
 *   5. Paste this whole file into the console. Hit Enter.
 *   6. The script prints the labor rate id (and copies it to clipboard,
 *      with a BEGIN/END fallback if clipboard is blocked). Paste that
 *      number into 06's DEST_LABOR_RATE_ID line, re-paste 06, done.
 */
(async () => {
  const DEST_SHOP_ID     = 14245;
  const DEST_TOKEN       = '';        // <-- paste dest token here
  const DEST_VEHICLE_ID  = 118337025; // Jay Demore's truck (used as a strong probe filter)
  const DEST_CUSTOMER_ID = 82581111;  // Jay Demore (fallback probe filter)

  if (!/^eyJ/.test(DEST_TOKEN)) {
    console.error('[FIND-LR] DEST_TOKEN is missing or not a JWT. Capture it with 00-print-token.js on a 14245 tab, paste into DEST_TOKEN above, re-paste this snippet.');
    return;
  }

  async function get(url) {
    const r = await fetch(url, { headers: { Accept: 'application/json', 'X-AUTH-TOKEN': DEST_TOKEN } });
    let body = null;
    try { body = await r.json(); } catch (_) {}
    return { ok: r.ok, status: r.status, body };
  }

  function extractLaborRateId(maybeRo) {
    if (!maybeRo) return null;
    const lr = maybeRo.laborRate;
    if (typeof lr === 'number') return lr;
    if (lr && typeof lr.id === 'number') return lr.id;
    return null;
  }

  // Try several listing/detail probes in priority order.
  const probes = [
    `/api/shop/${DEST_SHOP_ID}/repair-order?vehicleId=${DEST_VEHICLE_ID}&page=0&size=10&sort=updatedDate,desc`,
    `/api/shop/${DEST_SHOP_ID}/repair-order?customerId=${DEST_CUSTOMER_ID}&page=0&size=10&sort=updatedDate,desc`,
    `/api/shop/${DEST_SHOP_ID}/repair-order?status=ESTIMATE,WORK_IN_PROGRESS,POSTED&page=0&size=25&sort=updatedDate,desc`,
    `/api/shop/${DEST_SHOP_ID}/repair-order?status=POSTED&page=0&size=25&sort=updatedDate,desc`,
  ];

  let foundId = null;
  let foundFrom = null;
  let foundRoNumber = null;

  for (const url of probes) {
    const r = await get(url);
    if (!r.ok) {
      console.warn(`[FIND-LR] ${url} → status=${r.status}; trying next.`);
      continue;
    }
    const list = (r.body && (r.body.content || r.body.repairOrders || r.body.data || r.body)) || [];
    if (!Array.isArray(list) || list.length === 0) {
      console.warn(`[FIND-LR] ${url} → 0 results; trying next.`);
      continue;
    }
    // First, try to extract directly from the listing payload (fast path).
    for (const ro of list) {
      const lr = extractLaborRateId(ro);
      if (lr) { foundId = lr; foundFrom = url; foundRoNumber = ro.repairOrderNumber || ro.id; break; }
    }
    if (foundId) break;

    // Slow path: listings sometimes omit laborRate; fetch the first 3 ROs in detail.
    for (const ro of list.slice(0, 3)) {
      const detailUrl = `/api/shop/${DEST_SHOP_ID}/repair-order/${ro.id}`;
      const d = await get(detailUrl);
      if (!d.ok) continue;
      const lr = extractLaborRateId(d.body);
      if (lr) { foundId = lr; foundFrom = detailUrl; foundRoNumber = ro.repairOrderNumber || ro.id; break; }
    }
    if (foundId) break;
  }

  if (!foundId) {
    console.error(`%c[FIND-LR] could not find a laborRate id in any recent RO for shop ${DEST_SHOP_ID}.`,
      'color:#c00;font-weight:bold');
    console.error('Manual fallback: in Tekmetric, open any RO for shop 14245. In DevTools → Network, find the request to /api/repair-order/<roId> and look at the response JSON for "laborRate": <number>. Paste that number into 06\'s DEST_LABOR_RATE_ID line.');
    return;
  }

  console.log(`%c[FIND-LR] ✓ dest laborRate id = ${foundId}  (from RO #${foundRoNumber} via ${foundFrom})`,
    'color:#0a0;font-weight:bold');
  console.log(`%c[FIND-LR] paste this into 06's DEST_LABOR_RATE_ID line:  const DEST_LABOR_RATE_ID = ${foundId};`,
    'color:#06c;font-weight:bold');

  try {
    await navigator.clipboard.writeText(String(foundId));
    console.log('[FIND-LR] ✓ copied to clipboard.');
  } catch (_) {
    console.log('[FIND-LR] could not auto-copy. Manually copy the number between the markers below:');
    console.log('====== BEGIN DEST_LABOR_RATE_ID ======\n' + foundId + '\n====== END DEST_LABOR_RATE_ID ======');
  }
})();
