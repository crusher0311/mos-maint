// MOS Tools - Shopmonkey Content Script
// Detects Order (RO) context on the Shopmonkey web app and relays it to the
// background worker, which resolves the MOS shop and drives the VHI Coach.
//
// Mirrors the Tekmetric / Shop-Ware / AutoFlow content adapters. Shopmonkey is a
// single-host SPA (app.shopmonkey.cloud), so the per-shop identifier
// (companyId / locationId) is discovered from the page rather than the hostname.
// The exact storage keys / DOM selectors are best-effort and pending live
// verification on a real Shopmonkey session (Task #587 / T010 deferred check).

console.log("[MOS Tools] Shopmonkey content script loaded");

function safeSendMessage(msg, callback) {
  try {
    if (!chrome.runtime?.id) return;
    const p = chrome.runtime.sendMessage(msg, callback);
    if (p && p.catch) p.catch(() => {});
  } catch (e) {}
}

// Relay user-action drops to the background worker for the
// /api/extension/telemetry endpoint. Fire-and-forget; never throws.
function reportActionDropped(action, reason, extra) {
  try {
    const payload = Object.assign({ action: action, reason: reason || null, provider: "shopmonkey" }, extra || {});
    safeSendMessage({ action: "REPORT_TELEMETRY", event: "action.dropped", payload: payload });
  } catch (_) { /* no-op */ }
}

let lastContext = null;
let contextCheckInterval = null;

// ==================== CONTEXT DETECTION ====================
// Shopmonkey hides some fields (VIN, mileage) once the user navigates between
// order sub-tabs, so we cache the last-known-good fields per order id and
// rehydrate, exactly like the Tekmetric adapter.
const orderContextCache = new Map();

function rememberOrderContext(ctx) {
  if (!ctx?.roId) return;
  const prior = orderContextCache.get(ctx.roId) || {};
  const merged = {
    vin: ctx.vin || prior.vin || null,
    mileage: ctx.mileage || prior.mileage || null,
    vehicle: ctx.vehicle || prior.vehicle || null,
    vehicleDisplay: ctx.vehicleDisplay || prior.vehicleDisplay || null,
    vehicleId: ctx.vehicleId || prior.vehicleId || null,
    roNumber: ctx.roNumber || prior.roNumber || null,
    customer: ctx.customer || prior.customer || null,
    customerName: ctx.customerName || prior.customerName || null,
    customerId: ctx.customerId || prior.customerId || null,
    customerPhone: ctx.customerPhone || prior.customerPhone || null,
    customerEmail: ctx.customerEmail || prior.customerEmail || null,
  };
  orderContextCache.set(ctx.roId, merged);
  return merged;
}

function hydrateContextFromCache(ctx) {
  if (!ctx?.roId) return ctx;
  const cached = orderContextCache.get(ctx.roId);
  if (!cached) return ctx;
  if (!ctx.vin && cached.vin) ctx.vin = cached.vin;
  if (!ctx.mileage && cached.mileage) ctx.mileage = cached.mileage;
  if (!ctx.vehicle && cached.vehicle) ctx.vehicle = cached.vehicle;
  if (!ctx.vehicleDisplay && cached.vehicleDisplay) ctx.vehicleDisplay = cached.vehicleDisplay;
  if (!ctx.vehicleId && cached.vehicleId) ctx.vehicleId = cached.vehicleId;
  if (!ctx.roNumber && cached.roNumber) ctx.roNumber = cached.roNumber;
  if (!ctx.customer && cached.customer) ctx.customer = cached.customer;
  if (!ctx.customerName && cached.customerName) ctx.customerName = cached.customerName;
  if (!ctx.customerId && cached.customerId) ctx.customerId = cached.customerId;
  if (!ctx.customerPhone && cached.customerPhone) ctx.customerPhone = cached.customerPhone;
  if (!ctx.customerEmail && cached.customerEmail) ctx.customerEmail = cached.customerEmail;
  return ctx;
}

// Discover the Shopmonkey per-shop identifier (companyId / locationId). Shopmonkey
// is a single-host SPA, so we probe the URL, then localStorage. The resolved
// value is used as context.shopId so the background worker can resolve the MOS
// shop via /api/extension/ro-context (extension-shop-lookup keys shopmonkey shops
// by shopmonkey.locationId / shopmonkey.companyId).
function detectShopIdentifiers() {
  const out = { companyId: null, locationId: null };
  try {
    const url = window.location.href;
    // URL query params (?companyId=...&locationId=...) or path segments.
    const u = new URL(url);
    out.companyId = u.searchParams.get('companyId') || out.companyId;
    out.locationId = u.searchParams.get('locationId') || out.locationId;

    const companyPath = url.match(/\/compan(?:y|ies)\/([a-zA-Z0-9-]+)/);
    if (!out.companyId && companyPath) out.companyId = companyPath[1];
    const locationPath = url.match(/\/locations?\/([a-zA-Z0-9-]+)/);
    if (!out.locationId && locationPath) out.locationId = locationPath[1];
  } catch (e) {}

  // localStorage fallbacks. Key names are best-effort and pending live
  // verification; we scan for likely candidates without assuming one shape.
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i) || '';
      const lk = key.toLowerCase();
      if (!out.companyId && lk.includes('company') && lk.includes('id')) {
        const v = localStorage.getItem(key);
        if (v && /^[a-zA-Z0-9-]+$/.test(v)) out.companyId = v;
      }
      if (!out.locationId && lk.includes('location') && lk.includes('id')) {
        const v = localStorage.getItem(key);
        if (v && /^[a-zA-Z0-9-]+$/.test(v)) out.locationId = v;
      }
    }
  } catch (e) {}

  return out;
}

function detectContext() {
  const ctx = _detectContextRaw();
  rememberOrderContext(ctx);
  hydrateContextFromCache(ctx);
  return ctx;
}

function _detectContextRaw() {
  const url = window.location.href;
  const ids = detectShopIdentifiers();
  const context = {
    provider: "shopmonkey",
    shopId: ids.locationId || ids.companyId || null,
    companyId: ids.companyId,
    locationId: ids.locationId,
    roId: null,
    roNumber: null,
    vin: null,
    vehicle: null,
    vehicleDisplay: null,
    vehicleId: null,
    customer: null,
    customerName: null,
    customerId: null,
    customerPhone: null,
    customerEmail: null,
    mileage: null
  };

  // ============ EXTRACT ORDER (RO) ID ============
  // Shopmonkey order routes look like /orders/{id} or /#/orders/{id}. Ids are
  // typically long alphanumeric, so accept both numeric and uuid-like forms.
  const orderMatch = url.match(/\/(?:#\/)?orders?\/([a-zA-Z0-9-]+)/);
  if (orderMatch) {
    context.roId = orderMatch[1];
  }

  // ============ EXTRACT ORDER NUMBER ============
  try {
    const pageText = document.body?.innerText || '';
    // Shopmonkey shows the human order number as "Order #1234" / "RO #1234".
    let m = pageText.match(/(?:Order|RO)\s*#\s*(\d{1,7})/i);
    if (m && m[1]) {
      context.roNumber = m[1];
    } else {
      // Header selectors fallback.
      const headers = document.querySelectorAll('h1, h2, [class*="order-number"], [data-testid*="order-number"]');
      for (const el of headers) {
        const t = el.textContent || '';
        const hm = t.match(/#\s*(\d{1,7})/);
        if (hm && hm[1]) { context.roNumber = hm[1]; break; }
      }
    }
  } catch (e) {}

  // ============ EXTRACT VEHICLE INFO ============
  try {
    const pageText = document.body?.innerText || '';
    const vehiclePattern = /\b(19\d{2}|20\d{2})\s+([A-Z][a-zA-Z-]+)\s+([A-Z][a-zA-Z0-9\s-]+?)(?:\s+VIN|\s+In:|\s+Out:|\n|$)/i;
    const vehicleMatch = pageText.match(vehiclePattern);
    if (vehicleMatch) {
      const year = parseInt(vehicleMatch[1]);
      const make = (vehicleMatch[2] || '').trim();
      const model = (vehicleMatch[3] || '').trim();
      context.vehicle = { year, make, model };
      context.vehicleDisplay = `${year} ${make} ${model}`.trim();
    }

    // VIN — standard 17-char pattern (excludes I, O, Q).
    const vinMatch = pageText.match(/\b([A-HJ-NPR-Z0-9]{17})\b/);
    if (vinMatch) context.vin = vinMatch[1].toUpperCase();

    // Mileage — "Odometer", "Miles", "In:" labels followed by a number.
    const mileMatch = pageText.match(/(?:Odometer|Mileage|Miles|In)\s*:?\s*([\d,]{1,8})/i);
    if (mileMatch) {
      const miles = parseInt(mileMatch[1].replace(/,/g, ''));
      if (!isNaN(miles) && miles > 0 && miles < 2000000) context.mileage = miles;
    }
  } catch (e) {}

  // ============ EXTRACT CUSTOMER INFO ============
  try {
    const pageText = document.body?.innerText || '';
    const phoneMatch = pageText.match(/\(?\b(\d{3})\)?[-.\s]?(\d{3})[-.\s]?(\d{4})\b/);
    if (phoneMatch) {
      const digits = (phoneMatch[1] + phoneMatch[2] + phoneMatch[3]);
      if (digits.length === 10) context.customerPhone = digits;
    }
    const emailMatch = pageText.match(/\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/);
    if (emailMatch) context.customerEmail = emailMatch[0];
  } catch (e) {}

  console.log('[MOS Tools] Shopmonkey context:', context);
  return context;
}

function updateContext() {
  const context = detectContext();
  const contextStr = JSON.stringify(context);
  if (contextStr !== JSON.stringify(lastContext)) {
    lastContext = context;
    if (context.shopId) {
      console.log("[MOS Tools] Shopmonkey context changed:", context.roId ? `Order ${context.roId}` : 'shop-level', context);
      safeSendMessage({ action: "SET_SMS_CONTEXT", context });
    } else {
      // No resolvable shop identifier yet — surface as a drop so telemetry can
      // flag shops where the companyId/locationId probe needs live tuning.
      reportActionDropped("set_sms_context", "no_shop_identifier", { hasOrder: !!context.roId });
    }
  }
}

// ==================== INIT ====================
function init() {
  updateContext();

  let lastUrl = window.location.href;
  contextCheckInterval = setInterval(() => {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      updateContext();
    }
  }, 500);

  // Periodic re-scan: Shopmonkey hydrates order fields asynchronously after the
  // route settles, so poll for late-arriving VIN / mileage / customer data.
  setInterval(updateContext, 3000);

  window.addEventListener('popstate', () => {
    updateContext();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
