// MOS Tools - Tekmetric Content Script
// Detects RO context and communicates with background worker

console.log("[MOS Tools] Tekmetric content script loaded");

function safeSendMessage(msg, callback) {
  try {
    if (!chrome.runtime?.id) return;
    const p = chrome.runtime.sendMessage(msg, callback);
    if (p && p.catch) p.catch(() => {});
  } catch (e) {}
}

// Task #511: relay user-action drops to the background worker for the
// /api/extension/telemetry endpoint. Fire-and-forget; never throws.
function reportActionDropped(action, reason, extra) {
  try {
    const payload = Object.assign({ action: action, reason: reason || null, provider: "tekmetric" }, extra || {});
    safeSendMessage({ action: "REPORT_TELEMETRY", event: "action.dropped", payload: payload });
  } catch (_) { /* no-op */ }
}

let lastContext = null;
let contextCheckInterval = null;

// ==================== CONTEXT DETECTION ====================
// Cache of last-known good context fields per RO ID. Tekmetric hides the VIN
// (and sometimes mileage) in the DOM when the user switches to the Inspections
// tab, so once we've ever seen these fields for an RO, we reuse them.
const roContextCache = new Map();

// Identity fields tracked per RO. Once the interceptor captures any of these
// from the Tekmetric API, that value is AUTHORITATIVE and a later DOM scrape
// must never overwrite it — the SPA briefly renders literal label text
// ("Name", "Vehicle") before React hydrates, so scrape is bootstrap / fallback
// only. We record which fields came from the API in `_apiKeys`.
const RO_IDENTITY_FIELDS = [
  'vin', 'mileage', 'vehicle', 'vehicleDisplay', 'vehicleId', 'roNumber',
  'customer', 'customerName', 'customerId', 'customerPhone', 'customerEmail',
];

function getApiKeys(entry) {
  return (entry && Array.isArray(entry._apiKeys)) ? entry._apiKeys : [];
}

// Cache key is shop-scoped so a Tekmetric RO id can never collide across shops
// (which would otherwise risk showing one shop's customer on another's keytag).
function roCacheKey(shopId, roId) {
  if (!roId) return null;
  return `${shopId != null ? shopId : '?'}:${roId}`;
}

function rememberRoContext(ctx) {
  if (!ctx?.roId) return;
  const key = roCacheKey(ctx.shopId, ctx.roId);
  const prior = roContextCache.get(key) || {};
  const apiKeys = getApiKeys(prior);
  // API-sourced fields keep their cached value; everything else takes the
  // fresh scrape, falling back to whatever was cached.
  const merged = {};
  for (const field of RO_IDENTITY_FIELDS) {
    merged[field] = apiKeys.includes(field)
      ? (prior[field] ?? null)
      : (ctx[field] || prior[field] || null);
  }
  merged._apiKeys = apiKeys;
  roContextCache.set(ctx.roId, merged);
  return merged;
}

function hydrateContextFromCache(ctx) {
  if (!ctx?.roId) return ctx;
  const cached = roContextCache.get(roCacheKey(ctx.shopId, ctx.roId));
  if (!cached) return ctx;
  const apiKeys = getApiKeys(cached);
  for (const field of RO_IDENTITY_FIELDS) {
    if (cached[field] == null) continue;
    // API-sourced fields OVERWRITE the scraped ctx (API wins); non-API fields
    // only fill gaps the scrape left behind.
    if (apiKeys.includes(field) || ctx[field] == null) {
      ctx[field] = cached[field];
    }
  }
  return ctx;
}

// Merge fields parsed from the Tekmetric SPA's own /repair-order/{id} response
// into the per-RO cache, so the next detectContext() picks them up without any
// DOM scraping. Fed by the MOS_RO_LOADED message from interceptor.js. Anything
// the API supplies here becomes authoritative for that RO (tracked in
// `_apiKeys`) and is protected from being clobbered by a later DOM scrape.
function mergeApiRoData(shopId, roId, data) {
  if (!roId || !data) return;
  const key = roCacheKey(shopId, roId);
  const prior = roContextCache.get(key) || {};
  const v = data.vehicle || {};
  const c = data.customer || {};
  const yearMakeModel = (v.year || v.make || v.model)
    ? [v.year, v.make, v.model].filter(Boolean).join(' ').trim()
    : null;
  const customerName = (c.firstName || c.lastName)
    ? [c.firstName, c.lastName].filter(Boolean).join(' ').trim()
    : null;
  const mileageIn = data.milesIn ?? data.mileageIn ?? v.mileageIn ?? null;

  // Values the API actually provided this time (null = not present, so we
  // don't mark it authoritative and the scrape can still fill it).
  const apiValues = {
    vin: v.vin || null,
    mileage: typeof mileageIn === 'number' ? mileageIn : null,
    vehicle: yearMakeModel ? { year: v.year, make: v.make, model: v.model } : null,
    vehicleDisplay: yearMakeModel || null,
    vehicleId: v.id ? String(v.id) : null,
    roNumber: data.repairOrderNumber != null ? String(data.repairOrderNumber) : null,
    customer: customerName ? { id: c.id, firstName: c.firstName, lastName: c.lastName } : null,
    customerName: customerName,
    customerId: c.id ? String(c.id) : null,
    customerPhone: null,
    customerEmail: null,
  };

  const apiKeys = new Set(getApiKeys(prior));
  const merged = {};
  for (const field of RO_IDENTITY_FIELDS) {
    if (apiValues[field] != null) {
      merged[field] = apiValues[field]; // API is authoritative
      apiKeys.add(field);
    } else {
      merged[field] = prior[field] ?? null;
    }
  }
  merged._apiKeys = Array.from(apiKeys);
  roContextCache.set(key, merged);
}

function detectContext() {
  const ctx = _detectContextRaw();
  rememberRoContext(ctx);
  hydrateContextFromCache(ctx);
  // Task #645: preserve the on-screen odometer (the "In:" reading the advisor
  // typed / the authoritative API milesIn) under a dedicated field. The side
  // panel overwrites `mileage` with the server-resolved value after a plan
  // response (which may be a CARFAX estimate), so `scrapedOdometer` keeps the
  // real on-screen reading available to anchor the VHI on later refreshes.
  if (typeof ctx.mileage === 'number' && ctx.mileage > 0) {
    ctx.scrapedOdometer = ctx.mileage;
  }
  return ctx;
}

function _detectContextRaw() {
  const url = window.location.href;
  const context = {
    provider: "tekmetric",
    shopId: null,
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

  // Extract shop ID from URL (always available on any shop page)
  const shopMatch = url.match(/\/(?:admin\/)?shop\/(\d+)/);
  if (shopMatch) {
    context.shopId = shopMatch[1];
  }
  
  // Extract RO ID from URL (only on repair order pages)
  const roMatch = url.match(/\/(?:admin\/)?shop\/\d+\/repair-orders\/(\d+)/);
  if (roMatch) {
    context.roId = roMatch[1];
  }
  
  // ============ EXTRACT RO NUMBER ============
  try {
    const pageText = document.body?.innerText || '';
    
    // Strategy 1: Look for Tekmetric-specific RO header elements first
    // Tekmetric shows RO number in a header like "RO #12345:"
    const roHeaderSelectors = [
      '[data-testid*="ro-number"]',
      '[data-testid*="repair-order-number"]',
      '[class*="RepairOrderHeader"]',
      '[class*="repair-order-header"]',
      '[class*="ro-header"]',
      '[class*="RoHeader"]',
      'h1', 'h2'
    ];
    
    for (const sel of roHeaderSelectors) {
      const elements = document.querySelectorAll(sel);
      for (const el of elements) {
        const text = el.textContent || '';
        // Look for "RO #1234:" pattern - the colon helps distinguish from other numbers
        const match = text.match(/RO\s*#\s*(\d+)\s*:/i);
        if (match && match[1]) {
          context.roNumber = match[1];
          console.log('[MOS Tools] RO# extracted via selector:', sel, context.roNumber);
          break;
        }
      }
      if (context.roNumber) break;
    }
    
    // Strategy 2: Search all text for RO # pattern with colon (most specific)
    if (!context.roNumber) {
      const match = pageText.match(/RO\s*#\s*(\d+)\s*:/i);
      if (match && match[1]) {
        context.roNumber = match[1];
        console.log('[MOS Tools] RO# extracted via page text (with colon):', context.roNumber);
      }
    }
    
    // Strategy 3: Search for RO # without colon but limit to reasonable size
    // Note: Tekmetric internal IDs are often 9+ digits, user-facing RO numbers are shorter
    if (!context.roNumber) {
      const allMatches = pageText.match(/RO\s*#\s*(\d+)/gi) || [];
      for (const m of allMatches) {
        const numMatch = m.match(/(\d+)/);
        if (numMatch) {
          const num = parseInt(numMatch[1]);
          // User-facing RO numbers are typically < 100000, internal IDs are 9+ digits
          if (num > 0 && num < 100000) {
            context.roNumber = numMatch[1];
            console.log('[MOS Tools] RO# extracted via pattern (reasonable size):', context.roNumber);
            break;
          }
        }
      }
    }
    
    // Strategy 4: Look for "Repair Order" followed by number
    if (!context.roNumber) {
      const match = pageText.match(/Repair Order[:\s#]*(\d{1,6})/i);
      if (match && match[1]) {
        context.roNumber = match[1];
        console.log('[MOS Tools] RO# extracted via "Repair Order" pattern:', context.roNumber);
      }
    }
    
  } catch (e) {
    console.warn('[MOS Tools] Error extracting RO number:', e);
  }

  // ============ EXTRACT VEHICLE INFO ============
  try {
    const pageText = document.body?.innerText || '';
    
    // Strategy 1: Look for Year Make Model pattern anywhere on page
    // Common patterns: "2019 Honda Accord", "2020 Toyota Camry LE"
    const vehiclePattern = /\b(19\d{2}|20\d{2})\s+([A-Z][a-zA-Z-]+)\s+([A-Z][a-zA-Z0-9\s-]+?)(?:\s+VIN|\s+In:|\s+Out:|\n|$)/i;
    const vehicleMatch = pageText.match(vehiclePattern);
    
    if (vehicleMatch) {
      const year = parseInt(vehicleMatch[1]);
      const make = vehicleMatch[2].trim();
      let model = vehicleMatch[3].trim();
      
      // Clean up model - remove trailing numbers that might be mileage
      model = model.replace(/\s+\d{1,3}(,\d{3})*\s*$/, '').trim();
      
      if (year >= 1900 && year <= 2030 && make && model) {
        context.vehicle = { year, make, model };
        context.vehicleDisplay = `${year} ${make} ${model}`;
      }
    }
    
    // Strategy 2: Try common Tekmetric selectors
    if (!context.vehicle) {
      const vehicleSelectors = [
        '[data-testid="vehicle-info"]',
        '[class*="VehicleInfo"]',
        '[class*="vehicle-info"]',
        '[class*="vehicleHeader"]'
      ];
      
      for (const sel of vehicleSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          const text = el.textContent || '';
          const match = text.match(/\b(19\d{2}|20\d{2})\s+(\w+)\s+([^\n]+)/);
          if (match) {
            const year = parseInt(match[1]);
            const make = match[2].trim();
            const model = match[3].trim().split(/\s{2,}/)[0]; // Take first part before multiple spaces
            if (year >= 1900 && year <= 2030) {
              context.vehicle = { year, make, model };
              context.vehicleDisplay = `${year} ${make} ${model}`;
              break;
            }
          }
        }
      }
    }

    // ============ EXTRACT VIN ============
    // Look for 17-character VIN pattern
    const vinMatch = pageText.match(/\b([A-HJ-NPR-Z0-9]{17})\b/i);
    if (vinMatch) {
      context.vin = vinMatch[1].toUpperCase();
    }
    
    // Also try specific VIN elements
    if (!context.vin) {
      const vinElements = document.querySelectorAll('[data-testid*="vin"], [class*="vin"], [class*="VIN"]');
      for (const el of vinElements) {
        const match = el.textContent.match(/[A-HJ-NPR-Z0-9]{17}/i);
        if (match) {
          context.vin = match[0].toUpperCase();
          break;
        }
      }
    }

    // ============ EXTRACT MILEAGE ============
    // Strategy 1: Look for specific DOM elements first
    const mileageSelectors = [
      '[data-testid*="mileage"]',
      '[data-testid*="miles"]',
      '[data-testid*="odometer"]',
      '[class*="mileage"]',
      '[class*="Mileage"]',
      '[class*="odometer"]'
    ];
    
    for (const sel of mileageSelectors) {
      const elements = document.querySelectorAll(sel);
      for (const el of elements) {
        const text = el.textContent || '';
        const match = text.match(/[\d,]+/);
        if (match) {
          const value = parseInt(match[0].replace(/,/g, ''));
          if (value > 100 && value < 1000000) {
            context.mileage = value;
            console.log('[MOS Tools] Mileage extracted via selector:', sel);
            break;
          }
        }
      }
      if (context.mileage) break;
    }
    
    // Strategy 2: Look for "In: 40,238" or "Out: 40,238" patterns in page text
    if (!context.mileage) {
      const mileagePatterns = [
        /In:\s*([\d,]+)/i,
        /Out:\s*([\d,]+)/i,
        /Mileage[:\s]*([\d,]+)/i,
        /Odometer[:\s]*([\d,]+)/i
      ];
      
      for (const pattern of mileagePatterns) {
        const match = pageText.match(pattern);
        if (match) {
          const value = parseInt(match[1].replace(/,/g, ''));
          if (value > 100 && value < 1000000) {
            context.mileage = value;
            console.log('[MOS Tools] Mileage extracted via regex pattern');
            break;
          }
        }
      }
    }
    
    // Strategy 3: Look for elements containing "In" or "Out" text with numbers
    if (!context.mileage) {
      const allElements = document.querySelectorAll('span, div, p');
      for (const el of allElements) {
        const text = el.textContent?.trim() || '';
        if (/^(In|Out):?\s*[\d,]+$/i.test(text)) {
          const match = text.match(/[\d,]+/);
          if (match) {
            const value = parseInt(match[0].replace(/,/g, ''));
            if (value > 100 && value < 1000000) {
              context.mileage = value;
              console.log('[MOS Tools] Mileage extracted via In/Out element');
              break;
            }
          }
        }
      }
    }

    // ============ EXTRACT CUSTOMER NAME & ID ============
    const UI_TEXT_BLACKLIST = new Set([
      'add concern', 'view customer', 'edit customer', 'new customer',
      'add note', 'add service', 'view vehicle', 'edit vehicle',
      'create ro', 'new ro', 'add job', 'add part', 'save changes',
      'mark arrived', 'drop off', 'pick up', 'view details',
      'service history', 'repair order', 'view all', 'see more',
      'learn more', 'get started', 'sign out', 'log out',
      'close modal', 'cancel changes', 'delete customer',
    ]);
    
    function isLikelyName(text) {
      if (!text || text.length < 4 || text.length > 50) return false;
      if (UI_TEXT_BLACKLIST.has(text.toLowerCase())) return false;
      if (/^(add|view|edit|new|create|delete|remove|save|cancel|close|mark|drop|pick|sign|log)\s/i.test(text)) return false;
      return /^[A-Z][a-zA-Z'-]+\s+[A-Z]/.test(text);
    }
    
    // Strategy 1: Look for customer links with ID in href
    const customerLinks = document.querySelectorAll('a[href*="/customers/"]');
    for (const link of customerLinks) {
      const href = link.getAttribute('href') || '';
      const idMatch = href.match(/\/customers\/(\d+)/);
      const text = link.textContent?.trim() || '';
      if (idMatch && idMatch[1]) {
        context.customerId = idMatch[1];
        if (isLikelyName(text)) {
          context.customerName = text;
          context.customer = { name: context.customerName };
          console.log('[MOS Tools] Customer extracted via link:', context.customerName, 'ID:', context.customerId);
        }
      }
      if (context.customerName && context.customerId) break;
    }

    // Strategy 2: Look for Tekmetric-specific customer elements
    if (!context.customerName) {
      const customerSelectors = [
        '[data-testid*="customer-name"]',
        '[data-testid*="customerName"]',
        '[data-testid*="customer"]',
        '[class*="CustomerName"]',
        '[class*="customer-name"]',
        '[class*="customerInfo"]',
        '[class*="customer-info"]'
      ];
      
      for (const sel of customerSelectors) {
        const elements = document.querySelectorAll(sel);
        for (const el of elements) {
          const text = el.textContent?.trim() || '';
          const nameMatch = text.match(/^([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+){1,2})$/);
          if (nameMatch && isLikelyName(nameMatch[1])) {
            context.customerName = nameMatch[1];
            context.customer = { name: context.customerName };
            console.log('[MOS Tools] Customer name extracted via selector:', sel, context.customerName);
            break;
          }
        }
        if (context.customerName) break;
      }
    }
    
    // Strategy 3: Look for customer link in breadcrumb or header (name only)
    if (!context.customerName) {
      const allCustomerLinks = document.querySelectorAll('a[href*="/customer"]');
      for (const link of allCustomerLinks) {
        const text = link.textContent?.trim() || '';
        if (isLikelyName(text)) {
          context.customerName = text;
          context.customer = { name: context.customerName };
          console.log('[MOS Tools] Customer name extracted via customer link:', context.customerName);
          break;
        }
      }
    }
    
    // Strategy 4: Search page text for "Customer:" or "Owner:" label
    if (!context.customerName) {
      const customerPatterns = [
        /Customer[:\s]+([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+){1,2})/,
        /Owner[:\s]+([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+){1,2})/
      ];
      
      for (const pattern of customerPatterns) {
        const match = pageText.match(pattern);
        if (match && match[1] && isLikelyName(match[1].trim())) {
          context.customerName = match[1].trim();
          context.customer = { name: context.customerName };
          console.log('[MOS Tools] Customer name extracted via label pattern:', context.customerName);
          break;
        }
      }
    }

    // ============ EXTRACT VEHICLE ID ============
    // Look for vehicle links with ID in href
    const vehicleLinks = document.querySelectorAll('a[href*="/vehicles/"]');
    for (const link of vehicleLinks) {
      const href = link.getAttribute('href') || '';
      const vIdMatch = href.match(/\/vehicles\/(\d+)/);
      if (vIdMatch && vIdMatch[1]) {
        context.vehicleId = vIdMatch[1];
        console.log('[MOS Tools] Vehicle ID extracted via link:', context.vehicleId);
        break;
      }
    }

    // ============ EXTRACT CUSTOMER PHONE & EMAIL ============
    // Look for phone number patterns on the page
    const phoneMatch = pageText.match(/(?:\(\d{3}\)\s*\d{3}[-.]?\d{4}|\d{3}[-.]?\d{3}[-.]?\d{4})/);
    if (phoneMatch) {
      context.customerPhone = phoneMatch[0].replace(/[^\d]/g, '');
      if (context.customerPhone.length === 10) {
        console.log('[MOS Tools] Customer phone extracted');
      } else {
        context.customerPhone = null;
      }
    }

    // Look for email patterns
    const emailMatch = pageText.match(/\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/);
    if (emailMatch) {
      context.customerEmail = emailMatch[0];
      console.log('[MOS Tools] Customer email extracted');
    }

  } catch (err) {
    console.log("[MOS Tools] Error parsing page context:", err);
  }

  console.log('[MOS Tools] Detected context:', context);
  return context;
}

function updateContext() {
  const context = detectContext();
  
  const contextStr = JSON.stringify(context);
  if (contextStr !== JSON.stringify(lastContext)) {
    lastContext = context;
    
    if (context.shopId) {
      console.log("[MOS Tools] Context detected:", context.roId ? `RO ${context.roId}` : 'shop-level', context);
      safeSendMessage({ 
        action: "SET_SMS_CONTEXT", 
        context 
      });
    }
  }
}

// ==================== MESSAGE HANDLERS ====================
let jobCreatedReloadTimer = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "GET_PAGE_CONTEXT") {
    const context = detectContext();
    sendResponse(context);
    return false;
  }

  if (message.action === "JOB_CREATED") {
    console.log("[MOS Tools] Job created:", message.jobName);
    
    // Show success toast
    showToast(`Job added: ${message.jobName}`, 'success');
    
    // Debounced refresh: the server has already confirmed the job, so a
    // long fixed delay just makes the add feel slow. Reload quickly, and
    // if several jobs are added back-to-back, collapse them into ONE
    // reload after the last add instead of reloading per job.
    if (jobCreatedReloadTimer) clearTimeout(jobCreatedReloadTimer);
    jobCreatedReloadTimer = setTimeout(() => {
      jobCreatedReloadTimer = null;
      window.location.reload();
    }, 400);
    
    sendResponse({ success: true });
    return false;
  }

  // Task #1107: analyze finished — show the review modal BEFORE any write.
  if (message.action === "PREFILL_DVI_REVIEW") {
    console.log("[MOS Tools] Showing DVI pre-fill review modal:", message.updates?.length, "items");
    showPrefillReviewModal(message);
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "PREFILL_DVI_COMPLETE") {
    console.log("[MOS Tools] DVI pre-fill complete:", message.result);
    document.getElementById('mos-prefill-review-modal')?.remove();
    resetPrefillButton();
    // Task #744: show techs WHY each item was auto-filled (history vs. prior
    // inspection vs. VHI interval projection) via a basis-badged summary before
    // reloading. Falls back to the old silent reload if we got no per-task data.
    const updates = message.result?.updates;
    if (Array.isArray(updates) && updates.length > 0) {
      showPrefillSummaryModal(message.result);
    } else {
      setTimeout(() => {
        window.location.reload();
      }, 2000);
    }
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "PREFILL_DVI_FAILED") {
    document.getElementById('mos-prefill-review-modal')?.remove();
    resetPrefillButton();
    reportActionDropped("prefill_dvi", "background_failed");
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "PREFILL_DVI_CHOOSE_INSPECTION") {
    console.log("[MOS Tools] Multiple inspections on RO — showing chooser:", message.inspections?.length);
    showPrefillInspectionChooser(message.inspections || []);
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "ENHANCE_FINDINGS_PREVIEW") {
    console.log("[MOS Tools] Showing enhance review modal:", message.enhanced?.length, "items");
    showEnhanceReviewModal(message.enhanced, message.inspectionId, message.context);
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "ENHANCE_FINDINGS_COMPLETE") {
    console.log("[MOS Tools] Findings enhancement complete:", message.result);
    resetEnhanceButton();
    const modal = document.getElementById('mos-enhance-review-modal');
    if (modal) modal.remove();
    // Task #1086: originals are snapshotted background-side; the ↩ Undo chip
    // reappears after the reload.
    showToast('Notes enhanced — use the ↩ Undo chip to revert if needed', 'success');
    setTimeout(() => {
      window.location.reload();
    }, 2000);
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "ENHANCE_FINDINGS_FAILED") {
    resetEnhanceButton();
    reportActionDropped("enhance_findings", "background_failed");
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "BUILD_RO_FROM_VHI_PREVIEW") {
    console.log("[MOS Tools] Showing build-RO-from-VHI modal:", message.preview?.proposed?.length, "items");
    showBuildRoFromVhiModal(message.preview, message.context);
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "BUILD_RO_FROM_VHI_PROGRESS") {
    const modal = document.getElementById('mos-build-ro-vhi-modal');
    if (modal) {
      const applyBtn = modal.querySelector('button[data-mos-apply-build-ro="1"]');
      if (applyBtn) {
        const total = message.total || 0;
        const cur = (message.index || 0) + 1;
        applyBtn.textContent = `Adding ${cur}/${total}…`;
      }
    }
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "BUILD_RO_FROM_VHI_COMPLETE") {
    console.log("[MOS Tools] Build RO from VHI complete:", message.result);
    resetBuildRoFromVhiButton();
    const modal = document.getElementById('mos-build-ro-vhi-modal');
    if (modal) modal.remove();
    const r = message.result || {};
    const added = r.added || 0;
    const skipped = r.skipped || 0;
    const failed = r.failed || 0;
    const failedItems = Array.isArray(r.failedItems) ? r.failedItems : [];

    if (added > 0) {
      let msg = `Added ${added} technician concern${added === 1 ? '' : 's'} to RO`;
      if (skipped > 0) msg += ` · ${skipped} already present`;
      if (failed > 0) {
        const names = failedItems.slice(0, 2).map(f => f.title).filter(Boolean);
        msg += ` · ${failed} failed`;
        if (names.length) msg += ` (${names.join(', ')}${failed > names.length ? '…' : ''})`;
      }
      msg += ' — undo available via the ↩ Undo chip';
      showToast(msg, failed > 0 ? 'warning' : 'success');
    } else if (skipped > 0 && failed === 0) {
      showToast(`All ${skipped} concern${skipped === 1 ? '' : 's'} already on this RO — nothing added`, 'info');
    } else if (failed > 0) {
      const names = failedItems.slice(0, 2).map(f => f.title).filter(Boolean);
      const detail = names.length ? `: ${names.join(', ')}${failed > names.length ? '…' : ''}` : '';
      showToast(`Failed to add ${failed} concern${failed === 1 ? '' : 's'}${detail}`, 'error');
      reportActionDropped("build_ro_from_vhi", "concerns_failed", { attempt: failed });
    } else {
      showToast('No concerns added', 'info');
    }

    setTimeout(() => {
      window.location.reload();
    }, 1800);
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "BUILD_RO_FROM_VHI_FAILED") {
    reportActionDropped("build_ro_from_vhi", "background_failed", { reason: message.error || null });
    resetBuildRoFromVhiButton();
    const modal = document.getElementById('mos-build-ro-vhi-modal');
    if (modal) modal.remove();
    // Only show a toast here when caller passed explicit error text;
    // no-op / informational paths emit their own SHOW_TOAST.
    if (message.error) {
      showToast(message.error, 'error');
    }
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "INJECT_CONCERN_TEXT") {
    console.log("[MOS Tools] Injecting concern text into RO");
    const injected = injectConcernText(message.text);
    sendResponse({ success: injected });
    return false;
  }

  if (message.action === "SHOW_TOAST") {
    showToast(message.message, message.type || 'info');
    sendResponse({ success: true });
    return false;
  }

  if (message.type === "REFRESH_LABOR_RATE_UI") {
    const softRefresh = message.soft || false;
    console.log("[MOS Tools] Labor rate updated", softRefresh ? "(soft refresh)" : "(full refresh)");

    const overlay = document.createElement("div");
    overlay.id = "mos-labor-rate-overlay";
    Object.assign(overlay.style, {
      position: "fixed",
      top: "0",
      left: "0",
      width: "100vw",
      height: "100vh",
      background: "rgba(0,0,0,0.7)",
      color: "white",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      zIndex: "999999",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    });
    overlay.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;">
        <svg width="32" height="32" viewBox="0 0 48 48" fill="none">
          <circle cx="24" cy="24" r="22" stroke="#3B82F6" stroke-width="3"/>
          <path d="M14 24L22 32L34 16" stroke="#3B82F6" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <span style="font-size:1.5em;font-weight:600;">Labor Rate Updated</span>
      </div>
      <span style="font-size:1.1em;opacity:0.8;">Refreshing page...</span>
    `;
    document.body.appendChild(overlay);
    setTimeout(() => {
      window.location.reload();
    }, 1500);
    sendResponse({ success: true });
    return false;
  }

  // Handle print request from side panel
  if (message.action === "PRINT_STICKER_FROM_PANEL") {
    console.log("[MOS Tools] Printing sticker from side panel");
    if (message.sticker) {
      printStickerFromContentScript(message.sticker);
      sendResponse({ success: true });
    } else {
      sendResponse({ success: false, error: 'No sticker data' });
    }
    return false;
  }
});

// ==================== MOS PRINT BUTTON ====================
let printButtonInjected = false;

function injectPrintButton() {
  if (printButtonInjected) return;
  
  const context = detectContext();
  if (!context.roId) return;
  
  // Check if button already exists
  if (document.getElementById('mos-print-button')) {
    printButtonInjected = true;
    return;
  }
  
  // Find the print icon button in Tekmetric's header action bar
  // The print button is typically an icon button with a print SVG
  let printButton = null;
  let targetContainer = null;
  
  // Look for buttons with print-related attributes or SVGs
  const allButtons = document.querySelectorAll('button');
  for (const btn of allButtons) {
    // Check if button contains a print icon (SVG with polyline for printer shape)
    const svg = btn.querySelector('svg');
    if (svg) {
      const svgContent = svg.innerHTML.toLowerCase();
      // Print icons typically have printer-related paths
      if (svgContent.includes('polyline') && svgContent.includes('rect') && 
          (btn.title?.toLowerCase().includes('print') || 
           btn.getAttribute('aria-label')?.toLowerCase().includes('print') ||
           svgContent.includes('6 9 6 2 18 2 18 9'))) {
        printButton = btn;
        targetContainer = btn.parentElement;
        break;
      }
    }
    
    // Also check for data-testid or class containing print
    if (btn.dataset.testid?.includes('print') || 
        btn.className?.includes('print') ||
        btn.title?.toLowerCase() === 'print') {
      printButton = btn;
      targetContainer = btn.parentElement;
      break;
    }
  }
  
  // If no print button found, try looking in the header icon row area
  if (!targetContainer) {
    // Tekmetric uses an icon row in the RO header - look for grouped icon buttons
    const iconRows = document.querySelectorAll('[class*="IconButton"], [class*="icon-button"], [class*="action-bar"]');
    for (const row of iconRows) {
      const buttons = row.querySelectorAll('button');
      if (buttons.length >= 2) {
        targetContainer = row;
        printButton = buttons[buttons.length - 1]; // Insert after last button
        break;
      }
    }
  }
  
  if (!targetContainer) {
    console.log('[MOS Tools] Could not find target container for print button');
    return;
  }
  
  // Create the MOS Print button using the custom image
  const button = document.createElement('button');
  button.id = 'mos-print-button';
  button.title = 'MOS Oil Sticker\nLeft-click: Print | Right-click: Intervals';
  button.type = 'button';
  
  const imgUrl = chrome.runtime.getURL('icons/mos-print-button.png');
  button.innerHTML = `<img src="${imgUrl}" alt="MOS Print" style="height: 28px; display: block;" />`;
  
  Object.assign(button.style, {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '2px',
    backgroundColor: 'transparent',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    marginLeft: '4px',
    transition: 'opacity 0.2s'
  });
  
  button.addEventListener('mouseenter', () => {
    button.style.opacity = '0.8';
  });
  
  button.addEventListener('mouseleave', () => {
    button.style.opacity = '1';
  });
  
  // Left-click: Immediate print
  button.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    handleImmediatePrint();
  });
  
  // Right-click: Show interval selection dropdown
  button.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showIntervalDropdown(e, button);
  });
  
  // Insert after the print button if found, otherwise append to container
  if (printButton && printButton.nextSibling) {
    targetContainer.insertBefore(button, printButton.nextSibling);
  } else {
    targetContainer.appendChild(button);
  }
  
  printButtonInjected = true;
  console.log('[MOS Tools] Print button injected');

  // Task #1076: warm the sticker-config cache as soon as the button exists,
  // so the first right-click renders the interval dropdown from warm data.
  try {
    if (context.shopId) {
      safeSendMessage({
        action: 'PREFETCH_STICKER_CONFIG',
        shopId: context.shopId,
        provider: context.provider || 'tekmetric'
      });
    }
  } catch (e) {
    // Prefetch is best-effort; the dropdown path has its own bounded fetch.
  }
}

function handleImmediatePrint() {
  const context = detectContext();
  if (!context.roId || !context.shopId) {
    showToast('No repair order detected', 'error');
    return;
  }
  
  showToast('Generating sticker...', 'info');
  
  // Send message to background to generate and print sticker
  safeSendMessage({
    action: 'PRINT_STICKER_IMMEDIATE',
    context: {
      ...context,
      vehicle: getVehicleDetails()
    }
  }, (response) => {
    if (response && response.success) {
      printStickerFromContentScript(response.sticker);
    } else {
      showToast(response?.error || 'Failed to generate sticker', 'error');
      reportActionDropped("print_sticker", "generation_failed", { reason: response?.error || null });
    }
  });
}

async function showIntervalDropdown(event, buttonElement) {
  // Remove existing dropdown if any
  const existingDropdown = document.getElementById('mos-interval-dropdown');
  if (existingDropdown) {
    existingDropdown.remove();
    return;
  }
  
  const context = detectContext();
  
  // Create dropdown container
  const dropdown = document.createElement('div');
  dropdown.id = 'mos-interval-dropdown';
  Object.assign(dropdown.style, {
    position: 'fixed',
    backgroundColor: '#fff',
    border: '1px solid #e0e0e0',
    borderRadius: '8px',
    boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
    zIndex: '999999',
    minWidth: '180px',
    padding: '4px 0',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
  });
  
  // Position dropdown below the button
  const rect = buttonElement.getBoundingClientRect();
  dropdown.style.top = `${rect.bottom + 4}px`;
  dropdown.style.left = `${rect.left}px`;
  
  // Show loading state
  dropdown.innerHTML = '<div style="padding: 12px 16px; color: #666; font-size: 13px;">Loading intervals...</div>';
  document.body.appendChild(dropdown);
  
  // Fetch shop's configured intervals via the background's SWR cache (task
  // #1076): a warm entry renders near-instantly; a cold miss is bounded by
  // the background's short fetch timeout, so we never sit on
  // "Loading intervals..." for many seconds — defaults render instead.
  let intervals = [];
  let useKilometers = false;
  try {
    const result = await new Promise((resolve) => {
      // Belt-and-braces: the background enforces an 8s end-to-end deadline,
      // but if the message channel itself dies (worker restart mid-flight)
      // the callback may never fire — resolve to defaults shortly after the
      // background's own bound instead of hanging the dropdown.
      const guard = setTimeout(() => resolve(null), 10000);
      safeSendMessage({
        action: 'GET_STICKER_CONFIG',
        shopId: context.shopId,
        provider: context.provider || 'tekmetric'
      }, (res) => {
        clearTimeout(guard);
        resolve(res);
      });
    });
    
    if (result && result.config) {
      useKilometers = result.config.useKilometers === true;
      const unitLabel = useKilometers ? 'km' : 'mi';
      
      if (result.config.intervals) {
        const cfg = result.config.intervals;
        // Task #439: each bucket may carry an optional per-shop `label`
        // override and a `hidden` flag. Skip hidden buckets and prefer the
        // custom label when present, otherwise fall back to the built-in
        // default.
        const BUILTIN_LABELS = {
          conventional: 'Conventional',
          synthetic: 'Synthetic',
          euro: 'Euro',
          diesel: 'Diesel'
        };
        ['conventional', 'synthetic', 'euro', 'diesel'].forEach((type) => {
          const entry = cfg[type];
          if (!entry || entry.hidden === true) return;
          const name = (entry.label && entry.label.trim()) || BUILTIN_LABELS[type];
          intervals.push({
            label: `${name}: ${entry.mileage.toLocaleString()} ${unitLabel} / ${entry.months} mo`,
            miles: entry.mileage,
            months: entry.months,
            type
          });
        });
      }
    }
  } catch (err) {
    console.error('[MOS] Failed to fetch sticker config:', err);
  }
  
  // Fallback to defaults if no intervals fetched
  if (intervals.length === 0) {
    const unitLabel = useKilometers ? 'km' : 'mi';
    intervals = [
      { label: `Conventional: 3,000 ${unitLabel} / 3 mo`, miles: 3000, months: 3, type: 'conventional' },
      { label: `Synthetic: 5,000 ${unitLabel} / 6 mo`, miles: 5000, months: 6, type: 'synthetic' },
      { label: `Euro: 10,000 ${unitLabel} / 12 mo`, miles: 10000, months: 12, type: 'euro' },
      { label: `Diesel: 7,500 ${unitLabel} / 6 mo`, miles: 7500, months: 6, type: 'diesel' }
    ];
  }
  
  // Add customize option
  intervals.push({ label: 'Customize...', action: 'customize' });
  
  // Clear loading and render intervals
  dropdown.innerHTML = '';
  
  intervals.forEach(interval => {
    const item = document.createElement('div');
    item.textContent = interval.label;
    Object.assign(item.style, {
      padding: '8px 16px',
      cursor: 'pointer',
      fontSize: '13px',
      color: '#333',
      transition: 'background-color 0.15s'
    });
    
    item.addEventListener('mouseenter', () => {
      item.style.backgroundColor = '#f5f5f5';
    });
    item.addEventListener('mouseleave', () => {
      item.style.backgroundColor = 'transparent';
    });
    
    item.addEventListener('click', () => {
      dropdown.remove();
      if (interval.action === 'customize') {
        openStickerPanel();
      } else {
        handleImmediatePrintWithInterval(interval.miles, interval.months, useKilometers);
      }
    });
    
    dropdown.appendChild(item);
  });
  
  // Close dropdown when clicking outside
  const closeDropdown = (e) => {
    if (!dropdown.contains(e.target) && e.target !== buttonElement) {
      dropdown.remove();
      document.removeEventListener('click', closeDropdown);
    }
  };
  setTimeout(() => document.addEventListener('click', closeDropdown), 0);
}

function handleImmediatePrintWithInterval(miles, months, useKm) {
  const context = detectContext();
  if (!context.roId || !context.shopId) {
    showToast('No repair order detected', 'error');
    return;
  }
  
  const unitLabel = useKm ? 'km' : 'mi';
  showToast(`Generating sticker (${miles.toLocaleString()} ${unitLabel})...`, 'info');
  
  safeSendMessage({
    action: 'PRINT_STICKER_IMMEDIATE',
    context: {
      ...context,
      vehicle: getVehicleDetails(),
      useKilometers: !!useKm
    },
    overrideInterval: { miles, months }
  }, (response) => {
    if (response && response.success) {
      printStickerFromContentScript(response.sticker);
    } else {
      showToast(response?.error || 'Failed to generate sticker', 'error');
      reportActionDropped("print_sticker", "generation_failed", { reason: response?.error || null });
    }
  });
}

function getVehicleDetails() {
  const details = {
    make: null,
    model: null,
    year: null,
    engine: null,
    fuelType: null
  };
  
  try {
    // Try to get vehicle info from the page
    const vehicleSection = document.querySelector('[class*="Vehicle"]') || 
                          document.querySelector('[data-testid*="vehicle"]');
    
    if (vehicleSection) {
      const text = vehicleSection.textContent;
      
      // Parse year make model
      const vehicleMatch = text.match(/(\d{4})\s+(\w+)\s+([^\n]+)/);
      if (vehicleMatch) {
        details.year = parseInt(vehicleMatch[1]);
        details.make = vehicleMatch[2];
        details.model = vehicleMatch[3].trim();
      }
      
      // Look for engine info
      const engineMatch = text.match(/(\d\.\d)L|(\d\.\d)\s*[LV]\d|Turbo|Diesel|Hybrid/i);
      if (engineMatch) {
        details.engine = engineMatch[0];
      }
      
      // Check for diesel
      if (/diesel/i.test(text)) {
        details.fuelType = 'diesel';
      }
    }
    
    // Also check the right sidebar for more details
    const sidebar = document.querySelector('[class*="sidebar"]') || 
                   document.querySelector('[class*="Sidebar"]');
    if (sidebar) {
      const sidebarText = sidebar.textContent;
      if (/diesel/i.test(sidebarText)) {
        details.fuelType = 'diesel';
      }
      
      // Look for transmission type (often indicates Euro spec)
      if (/euro|european/i.test(sidebarText)) {
        details.fuelType = 'euro';
      }
    }
  } catch (err) {
    console.log('[MOS Tools] Error getting vehicle details:', err);
  }
  
  return details;
}

function openStickerPanel() {
  const context = detectContext();
  // Task #1076: the user is heading into the Customize flow — expire the
  // cached sticker config so any edits they make show up on the next
  // right-click (the cache keeps last-known-good as a fallback).
  if (context && context.shopId) {
    safeSendMessage({
      action: 'INVALIDATE_STICKER_CONFIG',
      shopId: context.shopId,
      provider: context.provider || 'tekmetric'
    });
  }
  // Message background to open side panel to sticker tab
  safeSendMessage({
    action: 'OPEN_STICKER_PANEL',
    context
  });
}

function printStickerFromContentScript(sticker) {
  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:none;';
  document.body.appendChild(iframe);
  
  const doc = iframe.contentDocument || iframe.contentWindow.document;
  doc.open();
  doc.write(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Print Sticker</title>
      <style>
        @page { margin: 0; size: auto; }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        html, body { width: 100%; height: 100%; }
        img { 
          width: ${sticker.widthInches};
          height: ${sticker.heightInches};
          display: block;
        }
      </style>
    </head>
    <body>
      <img id="sticker" src="${sticker.dataUrl}" />
    </body>
    </html>
  `);
  doc.close();
  
  const img = doc.getElementById('sticker');
  const doPrint = () => {
    setTimeout(() => {
      iframe.contentWindow.print();
      setTimeout(() => iframe.remove(), 1000);
    }, 100);
  };
  
  if (img.complete) {
    doPrint();
  } else {
    img.onload = doPrint;
  }
}

// Task #1086: per-user injected-button visibility (resolved server-side
// against shop entitlements). null = unknown → fail open (visible).
let cachedButtonVis = null;

function isButtonVisible(key) {
  return !cachedButtonVis || cachedButtonVis[key] !== false;
}

function removeInjectedButton(id) {
  const el = document.getElementById(id);
  if (el) el.remove();
}

function checkAndInjectButton() {
  const context = detectContext();
  if (context.roId) {
    fetchShopFeatures(context.shopId, (features) => {
      // Oil sticker print button has no feature gate today; visibility
      // preference alone decides.
      if (isButtonVisible('oil_sticker')) {
        if (!printButtonInjected) setTimeout(injectPrintButton, 1000);
      } else {
        removeInjectedButton('mos-print-button');
        printButtonInjected = false;
      }
      if (features.dvi_prefill && isButtonVisible('dvi_prefill')) {
        setTimeout(injectPrefillButton, 200);
      } else {
        removeInjectedButton('mos-prefill-dvi-btn');
        prefillButtonInjected = false;
      }
      if (features.enhance_notes && isButtonVisible('enhance_notes')) {
        setTimeout(injectEnhanceButton, 400);
      } else {
        removeInjectedButton('mos-enhance-notes-btn');
        enhanceButtonInjected = false;
      }
      if (features.dvi_prefill && isButtonVisible('add_vhi_recommendations')) {
        setTimeout(injectBuildRoFromVhiButton, 600);
      } else {
        removeInjectedButton('mos-build-ro-vhi-btn');
        buildRoFromVhiButtonInjected = false;
      }
      checkAndInjectUndoChip(context);
    });
  } else {
    const existingButton = document.getElementById('mos-print-button');
    if (existingButton) {
      existingButton.remove();
      printButtonInjected = false;
    }
    removeInjectedButton('mos-undo-chip');
    undoChipCheckedRoId = null;
    const existingPrefill = document.getElementById('mos-prefill-dvi-btn');
    if (existingPrefill) existingPrefill.remove();
    prefillButtonInjected = false;
    prefillInFlight = false;
    const existingEnhance = document.getElementById('mos-enhance-notes-btn');
    if (existingEnhance) existingEnhance.remove();
    enhanceButtonInjected = false;
    enhanceInFlight = false;
    stopEnhanceSlowNotice();
    const existingBuild = document.getElementById('mos-build-ro-vhi-btn');
    if (existingBuild) existingBuild.remove();
    buildRoFromVhiButtonInjected = false;
    buildRoFromVhiInFlight = false;
    cachedFeatures = null;
    cachedButtonVis = null;
  }
}

// ==================== UNDO CHIP (Task #1086) ====================
// After an AI write (Pre-fill DVI, Enhance Notes, Add VHI recommendations)
// the background stores a pre-write snapshot. This chip surfaces it on the
// RO page — including after the post-apply reload — and reverts through the
// same Tekmetric write paths.
let undoChipCheckedRoId = null;

function checkAndInjectUndoChip(context) {
  if (!context.roId) return;
  if (document.getElementById('mos-undo-chip')) return;
  if (undoChipCheckedRoId === context.roId) return;
  undoChipCheckedRoId = context.roId;
  safeSendMessage(
    { action: 'UNDO_SNAPSHOT_LIST', provider: 'tekmetric', shopId: context.shopId, roId: context.roId },
    (resp) => {
      if (!resp || !resp.success || !Array.isArray(resp.snapshots) || resp.snapshots.length === 0) return;
      injectUndoChip(resp.snapshots);
    }
  );
}

function injectUndoChip(snapshots) {
  if (document.getElementById('mos-undo-chip')) return;
  const target = document.getElementById('mos-prefill-dvi-btn')?.parentElement || findTekmetricActionContainer();
  if (!target) {
    // Anchor not rendered yet — allow the next poll tick to retry.
    undoChipCheckedRoId = null;
    return;
  }
  const summaries = snapshots.map((s) => s.summary || s.kind);
  const chip = document.createElement('button');
  chip.id = 'mos-undo-chip';
  chip.type = 'button';
  chip.title = 'Undo recent Detect Dog changes:\n' + summaries.map((s) => '• ' + s).join('\n');
  chip.innerHTML = '<span style="font-size:14px;line-height:1;">↩</span><span>Undo</span>';
  Object.assign(chip.style, {
    display: 'inline-flex', alignItems: 'center', gap: '4px',
    padding: '4px 10px', marginLeft: '6px', verticalAlign: 'middle',
    backgroundColor: '#fef3c7', color: '#92400e',
    border: '1px solid #f59e0b', borderRadius: '999px',
    fontSize: '12px', fontWeight: '600', cursor: 'pointer',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  });
  chip.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const ok = window.confirm('Undo recent Detect Dog changes?\n\n' + summaries.map((s) => '• ' + s).join('\n'));
    if (!ok) return;
    chip.disabled = true;
    chip.style.opacity = '0.6';
    showToast('Reverting Detect Dog changes...', 'info');
    let reverted = 0;
    let failed = 0;
    for (const snap of snapshots) {
      const resp = await new Promise((resolve) =>
        safeSendMessage({ action: 'UNDO_APPLY_TEKMETRIC', key: snap.key }, resolve)
      );
      if (resp && resp.success) reverted += resp.reverted || 0;
      else failed++;
      if (resp && resp.failed) failed += resp.failed;
    }
    if (failed === 0) {
      showToast(`Reverted ${reverted} change${reverted === 1 ? '' : 's'}. Reloading...`, 'success');
    } else {
      showToast(`Undo finished with issues: ${reverted} reverted, ${failed} failed. Reloading...`, 'warning');
    }
    chip.remove();
    setTimeout(() => window.location.reload(), 1800);
  });
  target.appendChild(chip);
  console.log('[MOS Tools] Undo chip injected (' + snapshots.length + ' snapshot(s))');
}

let prefillButtonInjected = false;
let cachedFeatures = null;
let cachedFloatingEnabled = null; // null = unknown (show), true = show, false = hide FAB launcher
let floatingFabFetchInFlight = false;
let featuresFetchInFlight = false;

function fetchShopFeatures(shopId, callback) {
  if (cachedFeatures) { callback(cachedFeatures); return; }
  if (featuresFetchInFlight) return;
  featuresFetchInFlight = true;
  safeSendMessage({ action: 'GET_SHOP_FEATURES', shopId, provider: 'tekmetric' }, (resp) => {
    featuresFetchInFlight = false;
    if (resp && resp.success) {
      cachedFeatures = resp.features;
      // Task #1086: per-user button visibility rides along with features.
      cachedButtonVis = (resp.buttonVisibility && resp.buttonVisibility.tekmetric) || null;
    } else {
      cachedFeatures = {};
    }
    callback(cachedFeatures);
  });
}

// Locate the RO page's print/action-bar container. Extracted from
// injectPrefillButton (Task #1086) so Enhance Notes / Build-RO / the undo
// chip can anchor themselves even when the Pre-fill button is hidden by the
// user's visibility preferences.
function findTekmetricActionContainer() {
  const allButtons = document.querySelectorAll('button');
  for (const btn of allButtons) {
    if (btn.id && btn.id.startsWith('mos-')) continue;
    const svg = btn.querySelector('svg');
    if (svg) {
      const svgContent = svg.innerHTML.toLowerCase();
      if (svgContent.includes('polyline') && svgContent.includes('rect') &&
          (btn.title?.toLowerCase().includes('print') ||
           btn.getAttribute('aria-label')?.toLowerCase().includes('print') ||
           svgContent.includes('6 9 6 2 18 2 18 9'))) {
        return btn.parentElement;
      }
    }
    if (btn.dataset.testid?.includes('print') ||
        btn.className?.includes('print') ||
        btn.title?.toLowerCase() === 'print') {
      return btn.parentElement;
    }
  }
  const iconRows = document.querySelectorAll('[class*="IconButton"], [class*="icon-button"], [class*="action-bar"]');
  for (const row of iconRows) {
    if (row.querySelectorAll('button').length >= 2) return row;
  }
  return null;
}

function injectPrefillButton() {
  if (prefillButtonInjected) return;
  if (document.getElementById('mos-prefill-dvi-btn')) {
    prefillButtonInjected = true;
    return;
  }

  const context = detectContext();
  if (!context.roId) return;

  const targetContainer = findTekmetricActionContainer();
  if (!targetContainer) return;

  const btn = document.createElement('button');
  btn.id = 'mos-prefill-dvi-btn';
  btn.title = 'Pre-fill DVI with VHI data';
  btn.type = 'button';
  const iconUrl = chrome.runtime.getURL('icons/VHI_icon.png');
  btn.innerHTML = `<img src="${iconUrl}" width="32" height="32" style="object-fit:contain;" />`;

  Object.assign(btn.style, {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '36px',
    height: '36px',
    padding: '2px',
    backgroundColor: 'transparent',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    marginLeft: '8px',
    transition: 'all 0.2s',
  });

  btn.addEventListener('mouseenter', () => {
    btn.style.opacity = '0.7';
  });

  btn.addEventListener('mouseleave', () => {
    btn.style.opacity = '1';
  });

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    handlePrefillDvi(btn);
  });

  targetContainer.appendChild(btn);
  prefillButtonInjected = true;
  console.log('[MOS Tools] Pre-fill DVI button injected');
}

let prefillInFlight = false;
let enhanceButtonInjected = false;
let enhanceInFlight = false;

// ---- Enhance Findings slow-write notice (task #789) ----
// The analyze and apply steps can legitimately take 45s+ on big shops. Toasts
// auto-dismiss, so repeat a reassuring "still working…" toast every
// ENHANCE_SLOW_NOTICE_INTERVAL_MS (first one after ENHANCE_SLOW_NOTICE_DELAY_MS)
// until the background reports preview/complete/failed — otherwise users click
// again or navigate away mid-write.
const ENHANCE_SLOW_NOTICE_DELAY_MS = 18000;
const ENHANCE_SLOW_NOTICE_INTERVAL_MS = 25000;
let enhanceSlowNoticeTimer = null;
let enhanceSlowNoticeInterval = null;

function startEnhanceSlowNotice(message) {
  stopEnhanceSlowNotice();
  const text = message || 'Still working — big shops can take a minute…';
  enhanceSlowNoticeTimer = setTimeout(() => {
    enhanceSlowNoticeTimer = null;
    showToast(text, 'info');
    enhanceSlowNoticeInterval = setInterval(() => showToast(text, 'info'), ENHANCE_SLOW_NOTICE_INTERVAL_MS);
  }, ENHANCE_SLOW_NOTICE_DELAY_MS);
}

function stopEnhanceSlowNotice() {
  if (enhanceSlowNoticeTimer) { clearTimeout(enhanceSlowNoticeTimer); enhanceSlowNoticeTimer = null; }
  if (enhanceSlowNoticeInterval) { clearInterval(enhanceSlowNoticeInterval); enhanceSlowNoticeInterval = null; }
}

function injectEnhanceButton() {
  if (enhanceButtonInjected) return;
  if (document.getElementById('mos-enhance-notes-btn')) {
    enhanceButtonInjected = true;
    return;
  }

  const context = detectContext();
  if (!context.roId) return;

  const prefillBtn = document.getElementById('mos-prefill-dvi-btn');
  const targetContainer = prefillBtn?.parentElement || findTekmetricActionContainer();
  if (!targetContainer) return;

  const btn = document.createElement('button');
  btn.id = 'mos-enhance-notes-btn';
  btn.title = 'Enhance technician notes with AI';
  btn.type = 'button';
  const enhanceIconUrl = chrome.runtime.getURL('icons/enhance_notes_icon.png');
  btn.innerHTML = `<img src="${enhanceIconUrl}" width="32" height="32" style="object-fit:contain;" />`;

  Object.assign(btn.style, {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '36px',
    height: '36px',
    padding: '2px',
    backgroundColor: 'transparent',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    marginLeft: '6px',
    transition: 'all 0.2s',
  });

  btn.addEventListener('mouseenter', () => {
    btn.style.opacity = '0.7';
  });

  btn.addEventListener('mouseleave', () => {
    btn.style.opacity = '1';
  });

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    handleEnhanceNotes(btn);
  });

  targetContainer.appendChild(btn);
  enhanceButtonInjected = true;
  console.log('[MOS Tools] Enhance Notes button injected');
}

function handleEnhanceNotes(buttonEl) {
  if (enhanceInFlight) {
    showToast('Enhancement already in progress', 'info');
    return;
  }

  const context = detectContext();
  if (!context.roId || !context.shopId) {
    showToast('No repair order detected', 'error');
    return;
  }

  enhanceInFlight = true;
  buttonEl.disabled = true;
  buttonEl.style.opacity = '0.5';
  buttonEl.style.cursor = 'wait';
  startEnhanceSlowNotice('Still enhancing notes — big shops can take a minute…');

  safeSendMessage({
    action: 'ENHANCE_FINDINGS',
    context: {
      shopId: context.shopId,
      roId: context.roId,
      vin: context.vin,
      mileage: context.mileage,
      provider: 'tekmetric',
      vehicleInfo: context.vehicle || null,
    }
  }, (response) => {});
}

function resetEnhanceButton() {
  enhanceInFlight = false;
  stopEnhanceSlowNotice();
  const btn = document.getElementById('mos-enhance-notes-btn');
  if (btn) {
    btn.disabled = false;
    btn.style.opacity = '1';
    btn.style.cursor = 'pointer';
  }
}

function showEnhanceReviewModal(enhanced, inspectionId, context) {
  // The analyze step finished — stop the "still working…" notice.
  stopEnhanceSlowNotice();
  if (!Array.isArray(enhanced) || enhanced.length === 0) {
    showToast('No changes to review', 'info');
    resetEnhanceButton();
    return;
  }

  const existing = document.getElementById('mos-enhance-review-modal');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'mos-enhance-review-modal';
  Object.assign(overlay.style, {
    position: 'fixed', top: '0', left: '0', width: '100vw', height: '100vh',
    backgroundColor: 'rgba(0,0,0,0.5)', zIndex: '999999',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  });

  const modal = document.createElement('div');
  Object.assign(modal.style, {
    backgroundColor: '#fff', borderRadius: '12px', width: '680px', maxWidth: '90vw',
    maxHeight: '80vh', display: 'flex', flexDirection: 'column',
    boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
  });

  const header = document.createElement('div');
  Object.assign(header.style, {
    padding: '16px 20px', borderBottom: '1px solid #e5e7eb',
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  });
  header.innerHTML = `<div style="font-size:16px;font-weight:600;color:#111">Review Enhanced Notes <span style="color:#6b7280;font-weight:400;font-size:13px">(${enhanced.length} items)</span></div>`;

  const selectAllWrap = document.createElement('label');
  Object.assign(selectAllWrap.style, { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', color: '#6b7280', cursor: 'pointer' });
  const selectAllCb = document.createElement('input');
  selectAllCb.type = 'checkbox';
  selectAllCb.checked = true;
  selectAllWrap.appendChild(selectAllCb);
  selectAllWrap.appendChild(document.createTextNode('Select all'));
  header.appendChild(selectAllWrap);
  modal.appendChild(header);

  const body = document.createElement('div');
  Object.assign(body.style, { overflowY: 'auto', padding: '12px 20px', flex: '1' });

  const checkboxes = [];

  enhanced.forEach((item, idx) => {
    const card = document.createElement('div');
    Object.assign(card.style, {
      border: '1px solid #e5e7eb', borderRadius: '8px', padding: '12px',
      marginBottom: '10px', backgroundColor: '#fafafa',
    });

    const topRow = document.createElement('div');
    Object.assign(topRow.style, { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' });

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    cb.dataset.idx = idx;
    checkboxes.push(cb);

    const taskLabel = document.createElement('span');
    Object.assign(taskLabel.style, { fontWeight: '600', fontSize: '13px', color: '#111' });
    taskLabel.textContent = item.taskName || `Task ${item.taskId}`;

    topRow.appendChild(cb);
    topRow.appendChild(taskLabel);
    card.appendChild(topRow);

    const origRow = document.createElement('div');
    Object.assign(origRow.style, { fontSize: '12px', color: '#6b7280', marginBottom: '6px' });
    origRow.innerHTML = `<span style="font-weight:500;color:#9ca3af">ORIGINAL:</span> ${escapeHtml(item.original)}`;
    card.appendChild(origRow);

    const enhancedInput = document.createElement('textarea');
    enhancedInput.value = item.enhanced;
    enhancedInput.dataset.idx = idx;
    Object.assign(enhancedInput.style, {
      width: '100%', minHeight: '48px', padding: '8px', border: '1px solid #d1d5db',
      borderRadius: '6px', fontSize: '13px', color: '#111', resize: 'vertical',
      lineHeight: '1.4', boxSizing: 'border-box',
    });
    card.appendChild(enhancedInput);

    body.appendChild(card);
  });

  selectAllCb.addEventListener('change', () => {
    checkboxes.forEach(cb => { cb.checked = selectAllCb.checked; });
  });

  modal.appendChild(body);

  const footer = document.createElement('div');
  Object.assign(footer.style, {
    padding: '12px 20px', borderTop: '1px solid #e5e7eb',
    display: 'flex', justifyContent: 'flex-end', gap: '10px',
  });

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  Object.assign(cancelBtn.style, {
    padding: '8px 16px', borderRadius: '6px', border: '1px solid #d1d5db',
    backgroundColor: '#fff', cursor: 'pointer', fontSize: '13px', fontWeight: '500',
  });
  const dismissEnhanceModal = () => {
    document.removeEventListener('keydown', onEnhanceModalKeydown, true);
    overlay.remove();
    resetEnhanceButton();
  };
  const onEnhanceModalKeydown = (e) => {
    if (!overlay.isConnected) {
      // Modal was closed by another path (apply complete/failed); self-clean.
      document.removeEventListener('keydown', onEnhanceModalKeydown, true);
      return;
    }
    if (e.key !== 'Escape') return;
    if (cancelBtn.disabled) return; // apply in flight — don't dismiss
    e.preventDefault();
    e.stopPropagation();
    dismissEnhanceModal();
  };
  cancelBtn.addEventListener('click', dismissEnhanceModal);
  document.addEventListener('keydown', onEnhanceModalKeydown, true);

  const applyBtn = document.createElement('button');
  applyBtn.textContent = 'Apply Selected';
  Object.assign(applyBtn.style, {
    padding: '8px 16px', borderRadius: '6px', border: 'none',
    backgroundColor: '#8B5CF6', color: '#fff', cursor: 'pointer',
    fontSize: '13px', fontWeight: '600',
  });
  applyBtn.addEventListener('click', () => {
    const approved = [];
    checkboxes.forEach((cb, idx) => {
      if (cb.checked) {
        const textarea = body.querySelector(`textarea[data-idx="${idx}"]`);
        approved.push({
          taskId: enhanced[idx].taskId,
          taskName: enhanced[idx].taskName,
          original: enhanced[idx].original,
          aiOriginal: enhanced[idx].enhanced,
          enhanced: textarea ? textarea.value : enhanced[idx].enhanced,
          _inspectionId: enhanced[idx]._inspectionId || null,
        });
      }
    });

    if (approved.length === 0) {
      showToast('No items selected', 'info');
      return;
    }

    applyBtn.disabled = true;
    applyBtn.textContent = 'Applying...';
    applyBtn.style.opacity = '0.6';
    cancelBtn.disabled = true;
    // Applying writes each finding server-side, which can also run long on
    // big shops; keep the user reassured until COMPLETE/FAILED arrives
    // (both call resetEnhanceButton, which stops this notice).
    startEnhanceSlowNotice('Still applying enhanced notes — big shops can take a minute…');

    safeSendMessage({
      action: 'APPLY_ENHANCED_FINDINGS',
      context: context,
      inspectionId: inspectionId,
      approved: approved,
    }, () => {});
  });

  footer.appendChild(cancelBtn);
  footer.appendChild(applyBtn);
  modal.appendChild(footer);
  overlay.appendChild(modal);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay && !cancelBtn.disabled) {
      dismissEnhanceModal();
    }
  });

  document.body.appendChild(overlay);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function handlePrefillDvi(buttonEl) {
  if (prefillInFlight) {
    showToast('Pre-fill already in progress', 'info');
    return;
  }

  const context = detectContext();
  if (!context.roId || !context.shopId) {
    showToast('No repair order detected', 'error');
    return;
  }
  if (!context.vin) {
    showToast('No VIN detected — cannot pre-fill DVI', 'error');
    return;
  }
  if (!context.mileage) {
    showToast('No mileage detected — cannot pre-fill DVI', 'error');
    return;
  }

  prefillInFlight = true;
  buttonEl.disabled = true;
  buttonEl.style.opacity = '0.5';
  buttonEl.style.cursor = 'wait';

  safeSendMessage({
    action: 'PREFILL_DVI',
    context: {
      shopId: context.shopId,
      roId: context.roId,
      vin: context.vin,
      mileage: context.mileage,
      provider: 'tekmetric',
    }
  }, (response) => {});
}

function resetPrefillButton() {
  prefillInFlight = false;
  const btn = document.getElementById('mos-prefill-dvi-btn');
  if (btn) {
    btn.disabled = false;
    btn.style.opacity = '1';
    btn.style.cursor = 'pointer';
  }
}

// When an RO carries more than one candidate inspection (e.g. MPI + an
// internal inspection), the background asks the tech which one to fill
// instead of silently targeting whichever renders last on the page.
function showPrefillInspectionChooser(inspections) {
  const existing = document.getElementById('mos-prefill-choose-modal');
  if (existing) existing.remove();

  if (!Array.isArray(inspections) || inspections.length === 0) {
    resetPrefillButton();
    showToast('No inspections available to pre-fill', 'error');
    return;
  }

  const overlay = document.createElement('div');
  overlay.id = 'mos-prefill-choose-modal';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:2147483646;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;';

  const card = document.createElement('div');
  card.style.cssText = 'background:#fff;border-radius:12px;max-width:420px;width:92%;padding:20px;box-shadow:0 10px 40px rgba(0,0,0,0.25);';

  const title = document.createElement('div');
  title.textContent = 'Which inspection should be pre-filled?';
  title.style.cssText = 'font-size:16px;font-weight:600;color:#111827;margin-bottom:4px;';
  card.appendChild(title);

  const sub = document.createElement('div');
  sub.textContent = 'This repair order has more than one inspection.';
  sub.style.cssText = 'font-size:12px;color:#6b7280;margin-bottom:14px;';
  card.appendChild(sub);

  const finishChoice = (inspId) => {
    overlay.remove();
    const context = detectContext();
    if (!context.roId || !context.shopId || !context.vin || !context.mileage) {
      resetPrefillButton();
      showToast('Lost repair order context — please try again', 'error');
      return;
    }
    safeSendMessage({
      action: 'PREFILL_DVI',
      inspectionId: inspId,
      context: {
        shopId: context.shopId,
        roId: context.roId,
        vin: context.vin,
        mileage: context.mileage,
        provider: 'tekmetric',
      }
    }, (response) => {});
  };

  for (const insp of inspections) {
    const btn = document.createElement('button');
    btn.type = 'button';
    const statusLabel = insp.status ? String(insp.status).replace(/_/g, ' ').toLowerCase() : '';
    const metaBits = [];
    if (insp.taskCount) metaBits.push(`${insp.taskCount} task${insp.taskCount === 1 ? '' : 's'}`);
    if (statusLabel) metaBits.push(statusLabel);
    btn.innerHTML = '';
    const nameEl = document.createElement('div');
    nameEl.textContent = insp.name || `Inspection #${insp.id}`;
    nameEl.style.cssText = 'font-size:14px;font-weight:600;color:#111827;';
    const metaEl = document.createElement('div');
    metaEl.textContent = metaBits.join(' · ');
    metaEl.style.cssText = 'font-size:12px;color:#6b7280;margin-top:2px;';
    btn.appendChild(nameEl);
    if (metaBits.length) btn.appendChild(metaEl);
    btn.style.cssText = 'display:block;width:100%;text-align:left;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:10px 12px;margin-bottom:8px;cursor:pointer;';
    btn.addEventListener('mouseenter', () => { btn.style.background = '#eef2ff'; btn.style.borderColor = '#6366f1'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = '#f9fafb'; btn.style.borderColor = '#e5e7eb'; });
    btn.addEventListener('click', () => finishChoice(insp.id));
    card.appendChild(btn);
  }

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  cancel.style.cssText = 'display:block;width:100%;background:none;border:none;color:#6b7280;font-size:13px;padding:8px 0 0;cursor:pointer;';
  cancel.addEventListener('click', () => {
    overlay.remove();
    resetPrefillButton();
  });
  card.appendChild(cancel);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      overlay.remove();
      resetPrefillButton();
    }
  });

  card.addEventListener('click', (e) => e.stopPropagation());
  overlay.appendChild(card);
  document.body.appendChild(overlay);
}

// Task #744: how each pre-filled DVI item was decided. Mirrors the `basis`
// values returned by app/api/extension/prefill-dvi/route.ts so techs can tell a
// concrete history/inspection signal apart from a generic interval projection.
const PREFILL_BASIS_META = {
  recently_performed: {
    label: 'History',
    color: '#16a34a',
    bg: '#dcfce7',
    title: 'Marked OK because shop/CARFAX history shows this was recently performed.',
  },
  inspection_history: {
    label: 'Inspection',
    color: '#b45309',
    bg: '#fef3c7',
    title: 'Based on a real, unresolved finding from a prior inspection.',
  },
  vhi: {
    label: 'VHI',
    color: '#2563eb',
    bg: '#dbeafe',
    title: 'Projected from the maintenance interval (VHI) — not a confirmed history signal.',
  },
};

const PREFILL_STATUS_META = {
  overdue: { label: 'Overdue', color: '#ef4444' },
  due_soon: { label: 'Due Soon', color: '#f59e0b' },
  upcoming: { label: 'OK', color: '#22c55e' },
  ok: { label: 'OK', color: '#22c55e' },
};

// Task #1107: review modal shown BEFORE any Tekmetric write. Mirrors the
// enhance-notes modal (checkboxes + select-all + editable text + Cancel/Apply)
// and AutoFlow's showAfReviewModal. Cancel / Esc / overlay click dismiss with
// zero writes; dismissal is blocked while the apply is in flight. Only the
// checked items are sent back via PREFILL_DVI_APPLY.
function showPrefillReviewModal(msg) {
  const updates = Array.isArray(msg?.updates) ? msg.updates : [];
  if (updates.length === 0) {
    showToast('No matching DVI items to pre-fill', 'info');
    resetPrefillButton();
    return;
  }

  const existing = document.getElementById('mos-prefill-review-modal');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'mos-prefill-review-modal';
  Object.assign(overlay.style, {
    position: 'fixed', top: '0', left: '0', width: '100vw', height: '100vh',
    backgroundColor: 'rgba(0,0,0,0.5)', zIndex: '999999',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  });

  const modal = document.createElement('div');
  Object.assign(modal.style, {
    backgroundColor: '#fff', borderRadius: '12px', width: '680px', maxWidth: '90vw',
    maxHeight: '80vh', display: 'flex', flexDirection: 'column',
    boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
  });

  const header = document.createElement('div');
  Object.assign(header.style, {
    padding: '16px 20px', borderBottom: '1px solid #e5e7eb',
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  });
  const veh = msg?.vehicle
    ? [msg.vehicle.year, msg.vehicle.make, msg.vehicle.model].filter(Boolean).join(' ')
    : '';
  header.innerHTML = `<div style="font-size:16px;font-weight:600;color:#111">Review DVI Pre-fill <span style="color:#6b7280;font-weight:400;font-size:13px">(${updates.length} item${updates.length === 1 ? '' : 's'}${veh ? ' · ' + escapeHtml(veh) : ''})</span></div>`;

  const selectAllWrap = document.createElement('label');
  Object.assign(selectAllWrap.style, { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', color: '#6b7280', cursor: 'pointer' });
  const selectAllCb = document.createElement('input');
  selectAllCb.type = 'checkbox';
  selectAllCb.checked = true;
  selectAllWrap.appendChild(selectAllCb);
  selectAllWrap.appendChild(document.createTextNode('Select all'));
  header.appendChild(selectAllWrap);
  modal.appendChild(header);

  // Legend so techs learn what each basis badge means (matches summary modal).
  const legend = document.createElement('div');
  Object.assign(legend.style, {
    padding: '10px 20px', borderBottom: '1px solid #f3f4f6',
    display: 'flex', flexWrap: 'wrap', gap: '10px', fontSize: '11px', color: '#6b7280',
  });
  ['recently_performed', 'inspection_history', 'vhi'].forEach((key) => {
    const meta = PREFILL_BASIS_META[key];
    const chip = document.createElement('span');
    chip.title = meta.title;
    Object.assign(chip.style, { display: 'inline-flex', alignItems: 'center', gap: '5px' });
    chip.innerHTML = `<span style="display:inline-block;font-size:10px;font-weight:600;padding:1px 6px;border-radius:4px;background:${meta.bg};color:${meta.color}">${meta.label}</span>`;
    const desc = document.createElement('span');
    desc.textContent = key === 'recently_performed'
      ? 'recently done'
      : key === 'inspection_history'
        ? 'prior finding'
        : 'interval guess';
    chip.appendChild(desc);
    legend.appendChild(chip);
  });
  modal.appendChild(legend);

  const body = document.createElement('div');
  Object.assign(body.style, { overflowY: 'auto', padding: '12px 20px', flex: '1' });

  const checkboxes = [];

  updates.forEach((u, idx) => {
    const meta = PREFILL_BASIS_META[u.basis] || PREFILL_BASIS_META.vhi;
    const statusMeta = PREFILL_STATUS_META[u.status];

    const card = document.createElement('div');
    Object.assign(card.style, {
      border: '1px solid #e5e7eb', borderLeft: `3px solid ${meta.color}`,
      borderRadius: '8px', padding: '10px 12px', marginBottom: '8px',
      backgroundColor: '#fafafa',
    });

    const topRow = document.createElement('div');
    Object.assign(topRow.style, { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' });

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    cb.dataset.idx = idx;
    checkboxes.push(cb);
    topRow.appendChild(cb);

    const taskLabel = document.createElement('span');
    Object.assign(taskLabel.style, { fontWeight: '600', fontSize: '13px', color: '#111', flex: '1', minWidth: '0' });
    taskLabel.textContent = u.taskName || 'Inspection item';
    topRow.appendChild(taskLabel);

    if (statusMeta) {
      const statusBadge = document.createElement('span');
      Object.assign(statusBadge.style, {
        fontSize: '10px', fontWeight: '600', padding: '2px 6px', borderRadius: '4px',
        backgroundColor: statusMeta.color + '22', color: statusMeta.color, whiteSpace: 'nowrap',
      });
      statusBadge.textContent = statusMeta.label;
      topRow.appendChild(statusBadge);
    }

    const basisBadge = document.createElement('span');
    basisBadge.title = meta.title;
    Object.assign(basisBadge.style, {
      fontSize: '10px', fontWeight: '600', padding: '2px 6px', borderRadius: '4px',
      backgroundColor: meta.bg, color: meta.color, whiteSpace: 'nowrap', cursor: 'help',
    });
    basisBadge.textContent = meta.label;
    topRow.appendChild(basisBadge);

    card.appendChild(topRow);

    const findingInput = document.createElement('textarea');
    findingInput.value = u.finding || '';
    findingInput.placeholder = 'Finding (optional)';
    findingInput.dataset.idx = idx;
    Object.assign(findingInput.style, {
      width: '100%', minHeight: '44px', padding: '8px', border: '1px solid #d1d5db',
      borderRadius: '6px', fontSize: '13px', color: '#111', resize: 'vertical',
      lineHeight: '1.4', boxSizing: 'border-box',
    });
    card.appendChild(findingInput);

    body.appendChild(card);
  });

  selectAllCb.addEventListener('change', () => {
    checkboxes.forEach(cb => { cb.checked = selectAllCb.checked; });
  });

  modal.appendChild(body);

  const footer = document.createElement('div');
  Object.assign(footer.style, {
    padding: '12px 20px', borderTop: '1px solid #e5e7eb',
    display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '10px',
  });

  const statusEl = document.createElement('div');
  Object.assign(statusEl.style, { marginRight: 'auto', fontSize: '12px', color: '#6b7280' });
  statusEl.textContent = 'Nothing is written until you apply.';
  footer.appendChild(statusEl);

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  Object.assign(cancelBtn.style, {
    padding: '8px 16px', borderRadius: '6px', border: '1px solid #d1d5db',
    backgroundColor: '#fff', cursor: 'pointer', fontSize: '13px', fontWeight: '500',
  });
  const dismissReviewModal = () => {
    document.removeEventListener('keydown', onReviewModalKeydown, true);
    overlay.remove();
    resetPrefillButton();
  };
  const onReviewModalKeydown = (e) => {
    if (!overlay.isConnected) {
      // Modal was closed by another path (apply complete/failed); self-clean.
      document.removeEventListener('keydown', onReviewModalKeydown, true);
      return;
    }
    if (e.key !== 'Escape') return;
    if (cancelBtn.disabled) return; // apply in flight — don't dismiss
    e.preventDefault();
    e.stopPropagation();
    dismissReviewModal();
  };
  cancelBtn.addEventListener('click', () => { if (!cancelBtn.disabled) dismissReviewModal(); });
  document.addEventListener('keydown', onReviewModalKeydown, true);

  const applyBtn = document.createElement('button');
  applyBtn.textContent = 'Apply to DVI';
  Object.assign(applyBtn.style, {
    padding: '8px 16px', borderRadius: '6px', border: 'none',
    backgroundColor: '#8B5CF6', color: '#fff', cursor: 'pointer',
    fontSize: '13px', fontWeight: '600',
  });
  applyBtn.addEventListener('click', () => {
    const approved = [];
    checkboxes.forEach((cb, idx) => {
      if (cb.checked) {
        const textarea = body.querySelector(`textarea[data-idx="${idx}"]`);
        approved.push(Object.assign({}, updates[idx], {
          finding: textarea ? textarea.value : updates[idx].finding,
        }));
      }
    });

    if (approved.length === 0) {
      showToast('No items selected', 'info');
      return;
    }

    applyBtn.disabled = true;
    applyBtn.textContent = 'Applying...';
    applyBtn.style.opacity = '0.6';
    applyBtn.style.cursor = 'wait';
    cancelBtn.disabled = true;
    statusEl.textContent = `Applying ${approved.length} item${approved.length === 1 ? '' : 's'}…`;

    safeSendMessage({
      action: 'PREFILL_DVI_APPLY',
      inspectionId: msg.inspectionId,
      context: msg.context,
      vehicle: msg.vehicle || null,
      approved: approved,
    }, () => {});
  });

  footer.appendChild(cancelBtn);
  footer.appendChild(applyBtn);
  modal.appendChild(footer);
  overlay.appendChild(modal);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay && !cancelBtn.disabled) {
      dismissReviewModal();
    }
  });

  document.body.appendChild(overlay);
}

// Task #744: after a DVI pre-fill runs, show a read-only summary that explains
// WHY each item was auto-filled (basis badge) before reloading the RO. The
// ratings/findings themselves are already written to Tekmetric at this point —
// this panel is purely explanatory.
function showPrefillSummaryModal(result) {
  const updates = Array.isArray(result?.updates) ? result.updates : [];
  if (updates.length === 0) {
    setTimeout(() => window.location.reload(), 1500);
    return;
  }

  const existing = document.getElementById('mos-prefill-summary-modal');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'mos-prefill-summary-modal';
  Object.assign(overlay.style, {
    position: 'fixed', top: '0', left: '0', width: '100vw', height: '100vh',
    backgroundColor: 'rgba(0,0,0,0.5)', zIndex: '999999',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  });

  const modal = document.createElement('div');
  Object.assign(modal.style, {
    backgroundColor: '#fff', borderRadius: '12px', width: '640px', maxWidth: '90vw',
    maxHeight: '80vh', display: 'flex', flexDirection: 'column',
    boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
  });

  const header = document.createElement('div');
  Object.assign(header.style, {
    padding: '16px 20px', borderBottom: '1px solid #e5e7eb',
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  });
  const veh = result?.vehicle
    ? [result.vehicle.year, result.vehicle.make, result.vehicle.model].filter(Boolean).join(' ')
    : '';
  header.innerHTML = `<div style="font-size:16px;font-weight:600;color:#111">DVI Pre-fill Applied <span style="color:#6b7280;font-weight:400;font-size:13px">(${updates.length} item${updates.length === 1 ? '' : 's'}${veh ? ' · ' + escapeHtml(veh) : ''})</span></div>`;
  modal.appendChild(header);

  // Legend so techs learn what each badge means.
  const legend = document.createElement('div');
  Object.assign(legend.style, {
    padding: '10px 20px', borderBottom: '1px solid #f3f4f6',
    display: 'flex', flexWrap: 'wrap', gap: '10px', fontSize: '11px', color: '#6b7280',
  });
  ['recently_performed', 'inspection_history', 'vhi'].forEach((key) => {
    const meta = PREFILL_BASIS_META[key];
    const chip = document.createElement('span');
    chip.title = meta.title;
    Object.assign(chip.style, { display: 'inline-flex', alignItems: 'center', gap: '5px' });
    chip.innerHTML = `<span style="display:inline-block;font-size:10px;font-weight:600;padding:1px 6px;border-radius:4px;background:${meta.bg};color:${meta.color}">${meta.label}</span>`;
    const desc = document.createElement('span');
    desc.textContent = key === 'recently_performed'
      ? 'recently done'
      : key === 'inspection_history'
        ? 'prior finding'
        : 'interval guess';
    chip.appendChild(desc);
    legend.appendChild(chip);
  });
  modal.appendChild(legend);

  const body = document.createElement('div');
  Object.assign(body.style, { overflowY: 'auto', padding: '12px 20px', flex: '1' });

  updates.forEach((u) => {
    const meta = PREFILL_BASIS_META[u.basis] || PREFILL_BASIS_META.vhi;
    const statusMeta = PREFILL_STATUS_META[u.status];

    const card = document.createElement('div');
    Object.assign(card.style, {
      border: '1px solid #e5e7eb', borderLeft: `3px solid ${meta.color}`,
      borderRadius: '8px', padding: '10px 12px', marginBottom: '8px',
      backgroundColor: '#fafafa',
    });

    const topRow = document.createElement('div');
    Object.assign(topRow.style, { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: u.finding ? '6px' : '0' });

    const taskLabel = document.createElement('span');
    Object.assign(taskLabel.style, { fontWeight: '600', fontSize: '13px', color: '#111', flex: '1', minWidth: '0' });
    taskLabel.textContent = u.taskName || 'Inspection item';
    topRow.appendChild(taskLabel);

    if (statusMeta) {
      const statusBadge = document.createElement('span');
      Object.assign(statusBadge.style, {
        fontSize: '10px', fontWeight: '600', padding: '2px 6px', borderRadius: '4px',
        backgroundColor: statusMeta.color + '22', color: statusMeta.color, whiteSpace: 'nowrap',
      });
      statusBadge.textContent = statusMeta.label;
      topRow.appendChild(statusBadge);
    }

    const basisBadge = document.createElement('span');
    basisBadge.title = meta.title;
    Object.assign(basisBadge.style, {
      fontSize: '10px', fontWeight: '600', padding: '2px 6px', borderRadius: '4px',
      backgroundColor: meta.bg, color: meta.color, whiteSpace: 'nowrap', cursor: 'help',
    });
    basisBadge.textContent = meta.label;
    topRow.appendChild(basisBadge);

    card.appendChild(topRow);

    if (u.finding) {
      const finding = document.createElement('div');
      Object.assign(finding.style, { fontSize: '12px', color: '#4b5563', lineHeight: '1.4' });
      finding.textContent = u.finding;
      card.appendChild(finding);
    }

    body.appendChild(card);
  });

  modal.appendChild(body);

  const footer = document.createElement('div');
  Object.assign(footer.style, {
    padding: '12px 20px', borderTop: '1px solid #e5e7eb',
    display: 'flex', justifyContent: 'flex-end',
  });
  const doneBtn = document.createElement('button');
  doneBtn.textContent = 'Done';
  Object.assign(doneBtn.style, {
    padding: '8px 16px', borderRadius: '6px', border: 'none',
    backgroundColor: '#8B5CF6', color: '#fff', cursor: 'pointer',
    fontSize: '13px', fontWeight: '600',
  });
  const dismissSummaryModal = () => {
    document.removeEventListener('keydown', onSummaryModalKeydown, true);
    overlay.remove();
    window.location.reload();
  };
  const onSummaryModalKeydown = (e) => {
    if (!overlay.isConnected) {
      document.removeEventListener('keydown', onSummaryModalKeydown, true);
      return;
    }
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    dismissSummaryModal();
  };
  doneBtn.addEventListener('click', dismissSummaryModal);
  document.addEventListener('keydown', onSummaryModalKeydown, true);
  footer.appendChild(doneBtn);
  modal.appendChild(footer);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      dismissSummaryModal();
    }
  });

  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}

// ==================== BUILD RO FROM VHI ====================
let buildRoFromVhiButtonInjected = false;
let buildRoFromVhiInFlight = false;

function injectBuildRoFromVhiButton() {
  if (buildRoFromVhiButtonInjected) return;
  if (document.getElementById('mos-build-ro-vhi-btn')) {
    buildRoFromVhiButtonInjected = true;
    return;
  }

  const context = detectContext();
  if (!context.roId) return;

  const prefillBtn = document.getElementById('mos-prefill-dvi-btn');
  const targetContainer = prefillBtn?.parentElement || findTekmetricActionContainer();
  if (!targetContainer) return;

  const btn = document.createElement('button');
  btn.id = 'mos-build-ro-vhi-btn';
  btn.title = 'Add all to concerns';
  btn.type = 'button';
  // Match sibling extension buttons (Pre-fill DVI, Enhance Notes) which all
  // use 32x32 PNG icons via chrome.runtime.getURL. The aiVHI_icon.png asset
  // is the AI-flavored sibling of VHI_icon.png and is registered in
  // manifest.json's web_accessible_resources.
  const buildVhiIconUrl = chrome.runtime.getURL('icons/aiVHI_icon.png');
  btn.innerHTML = `<img src="${buildVhiIconUrl}" width="32" height="32" style="object-fit:contain;" />`;

  Object.assign(btn.style, {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '36px',
    height: '36px',
    padding: '2px',
    backgroundColor: 'transparent',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    marginLeft: '6px',
    transition: 'all 0.2s',
  });

  btn.addEventListener('mouseenter', () => { btn.style.opacity = '0.7'; });
  btn.addEventListener('mouseleave', () => { btn.style.opacity = '1'; });

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    handleBuildRoFromVhi(btn);
  });

  targetContainer.appendChild(btn);
  buildRoFromVhiButtonInjected = true;
  console.log('[MOS Tools] Build RO from VHI button injected');
}

function handleBuildRoFromVhi(buttonEl) {
  if (buildRoFromVhiInFlight) {
    showToast('Build already in progress', 'info');
    return;
  }

  const context = detectContext();
  if (!context.roId || !context.shopId) {
    showToast('No repair order detected', 'error');
    return;
  }
  if (!context.vin) {
    showToast('No VIN detected — cannot build from VHI', 'error');
    return;
  }
  if (!context.mileage) {
    showToast('No mileage detected — cannot build from VHI', 'error');
    return;
  }

  buildRoFromVhiInFlight = true;
  buttonEl.disabled = true;
  buttonEl.style.opacity = '0.5';
  buttonEl.style.cursor = 'wait';

  showToast('Loading VHI suggestions...', 'info');

  safeSendMessage({
    action: 'BUILD_RO_FROM_VHI',
    context: {
      shopId: context.shopId,
      roId: context.roId,
      roNumber: context.roNumber || null,
      vin: context.vin,
      mileage: context.mileage,
      provider: 'tekmetric',
    }
  }, () => {});
}

function resetBuildRoFromVhiButton() {
  buildRoFromVhiInFlight = false;
  const btn = document.getElementById('mos-build-ro-vhi-btn');
  if (btn) {
    btn.disabled = false;
    btn.style.opacity = '1';
    btn.style.cursor = 'pointer';
  }
}

function showBuildRoFromVhiModal(preview, context) {
  const proposed = preview?.proposed || [];
  if (proposed.length === 0) {
    showToast('No overdue or due-soon services to add', 'info');
    resetBuildRoFromVhiButton();
    return;
  }

  const existing = document.getElementById('mos-build-ro-vhi-modal');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'mos-build-ro-vhi-modal';
  Object.assign(overlay.style, {
    position: 'fixed', top: '0', left: '0', width: '100vw', height: '100vh',
    backgroundColor: 'rgba(0,0,0,0.5)', zIndex: '999999',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  });

  const modal = document.createElement('div');
  Object.assign(modal.style, {
    backgroundColor: '#fff', borderRadius: '12px', width: '720px', maxWidth: '92vw',
    maxHeight: '82vh', display: 'flex', flexDirection: 'column',
    boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
  });

  const header = document.createElement('div');
  Object.assign(header.style, {
    padding: '16px 20px', borderBottom: '1px solid #e5e7eb',
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  });
  const summary = preview.summary || {};
  header.innerHTML = `<div style="font-size:16px;font-weight:600;color:#111">Add technician concerns from VHI <span style="color:#6b7280;font-weight:400;font-size:13px">(${summary.overdue || 0} overdue, ${summary.dueSoon || 0} due soon)</span></div>`;

  const selectAllWrap = document.createElement('label');
  Object.assign(selectAllWrap.style, { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', color: '#6b7280', cursor: 'pointer' });
  const selectAllCb = document.createElement('input');
  selectAllCb.type = 'checkbox';
  selectAllCb.checked = true;
  selectAllWrap.appendChild(selectAllCb);
  selectAllWrap.appendChild(document.createTextNode('Select all'));
  header.appendChild(selectAllWrap);
  modal.appendChild(header);

  const subhead = document.createElement('div');
  Object.assign(subhead.style, { padding: '8px 20px 0 20px', fontSize: '12px', color: '#6b7280' });
  subhead.textContent = `Each selected item adds a technician concern to this RO. The advisor builds the matching jobs themselves. Items already added in a prior run will be skipped automatically.`;
  modal.appendChild(subhead);

  const body = document.createElement('div');
  Object.assign(body.style, { overflowY: 'auto', padding: '12px 20px', flex: '1' });

  const checkboxes = [];

  proposed.forEach((item, idx) => {
    const card = document.createElement('div');
    Object.assign(card.style, {
      border: '1px solid #e5e7eb', borderRadius: '8px', padding: '12px',
      marginBottom: '10px', backgroundColor: '#fafafa',
    });

    const topRow = document.createElement('div');
    Object.assign(topRow.style, { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' });

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    cb.dataset.idx = idx;
    checkboxes.push(cb);

    const titleSpan = document.createElement('span');
    Object.assign(titleSpan.style, { fontWeight: '600', fontSize: '13px', color: '#111' });
    titleSpan.textContent = item.title;

    const statusBadge = document.createElement('span');
    const isOverdue = item.status === 'overdue';
    Object.assign(statusBadge.style, {
      fontSize: '11px',
      fontWeight: '600',
      padding: '2px 8px',
      borderRadius: '10px',
      backgroundColor: isOverdue ? '#FEE2E2' : '#FEF3C7',
      color: isOverdue ? '#991B1B' : '#92400E',
      marginLeft: 'auto',
    });
    statusBadge.textContent = isOverdue ? 'OVERDUE' : 'DUE SOON';

    topRow.appendChild(cb);
    topRow.appendChild(titleSpan);
    topRow.appendChild(statusBadge);
    card.appendChild(topRow);

    const concernRow = document.createElement('div');
    Object.assign(concernRow.style, { fontSize: '12px', color: '#374151', marginBottom: '6px', lineHeight: '1.4' });
    concernRow.innerHTML = `<span style="font-weight:500;color:#6b7280">CONCERN:</span> ${escapeHtml(item.concern)}`;
    card.appendChild(concernRow);

    // Job row removed in v1.27.2 — feature now creates concerns only;
    // the advisor adds the matching jobs themselves.

    body.appendChild(card);
  });

  selectAllCb.addEventListener('change', () => {
    checkboxes.forEach(cb => { cb.checked = selectAllCb.checked; });
  });

  modal.appendChild(body);

  const footer = document.createElement('div');
  Object.assign(footer.style, {
    padding: '12px 20px', borderTop: '1px solid #e5e7eb',
    display: 'flex', justifyContent: 'flex-end', gap: '10px',
  });

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  Object.assign(cancelBtn.style, {
    padding: '8px 16px', borderRadius: '6px', border: '1px solid #d1d5db',
    backgroundColor: '#fff', cursor: 'pointer', fontSize: '13px', fontWeight: '500',
  });
  const dismissBuildRoModal = () => {
    document.removeEventListener('keydown', onBuildRoModalKeydown, true);
    overlay.remove();
    resetBuildRoFromVhiButton();
  };
  const onBuildRoModalKeydown = (e) => {
    if (!overlay.isConnected) {
      // Modal was closed by another path (apply complete/failed); self-clean.
      document.removeEventListener('keydown', onBuildRoModalKeydown, true);
      return;
    }
    if (e.key !== 'Escape') return;
    if (cancelBtn.disabled) return; // apply in flight — don't dismiss
    e.preventDefault();
    e.stopPropagation();
    dismissBuildRoModal();
  };
  cancelBtn.addEventListener('click', dismissBuildRoModal);
  document.addEventListener('keydown', onBuildRoModalKeydown, true);

  const applyBtn = document.createElement('button');
  applyBtn.textContent = 'Add to RO';
  applyBtn.setAttribute('data-mos-apply-build-ro', '1');
  Object.assign(applyBtn.style, {
    padding: '8px 16px', borderRadius: '6px', border: 'none',
    backgroundColor: '#8B5CF6', color: '#fff', cursor: 'pointer',
    fontSize: '13px', fontWeight: '600',
  });
  applyBtn.addEventListener('click', () => {
    const selected = [];
    checkboxes.forEach((cb, idx) => {
      if (cb.checked) selected.push(proposed[idx]);
    });
    if (selected.length === 0) {
      showToast('No items selected', 'info');
      return;
    }
    applyBtn.disabled = true;
    applyBtn.textContent = `Adding 0/${selected.length}…`;
    applyBtn.style.opacity = '0.6';
    cancelBtn.disabled = true;

    safeSendMessage({
      action: 'APPLY_BUILD_RO_FROM_VHI',
      context: context,
      selected: selected,
      markerPrefix: preview.markerPrefix || '[VHI]',
    }, () => {});
  });

  footer.appendChild(cancelBtn);
  footer.appendChild(applyBtn);
  modal.appendChild(footer);
  overlay.appendChild(modal);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay && !cancelBtn.disabled) {
      dismissBuildRoModal();
    }
  });

  document.body.appendChild(overlay);
}

// ==================== UI HELPERS ====================
function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = 'mos-tools-toast';
  toast.textContent = message;
  
  const bgColor = type === 'success' ? '#10B981' : 
                  type === 'error' ? '#EF4444' : '#3B82F6';
  
  Object.assign(toast.style, {
    position: 'fixed',
    top: '20px',
    right: '20px',
    padding: '12px 24px',
    backgroundColor: bgColor,
    color: 'white',
    borderRadius: '8px',
    fontFamily: 'system-ui, sans-serif',
    fontSize: '14px',
    fontWeight: '500',
    boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
    zIndex: '999999',
    animation: 'mos-toast-slide-in 0.3s ease'
  });

  // Add animation keyframes if not already added
  if (!document.getElementById('mos-tools-styles')) {
    const style = document.createElement('style');
    style.id = 'mos-tools-styles';
    style.textContent = `
      @keyframes mos-toast-slide-in {
        from { transform: translateX(100%); opacity: 0; }
        to { transform: translateX(0); opacity: 1; }
      }
      @keyframes mos-toast-slide-out {
        from { transform: translateX(0); opacity: 1; }
        to { transform: translateX(100%); opacity: 0; }
      }
    `;
    document.head.appendChild(style);
  }

  document.body.appendChild(toast);

  // Remove after 3 seconds
  setTimeout(() => {
    toast.style.animation = 'mos-toast-slide-out 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// ==================== FLOATING ACTION BUTTON ====================
let fabInjected = false;
let fabDragging = false;
let fabDragStartY = 0;
let fabStartTop = 0;

function applyFloatingToFab() {
  if (cachedFloatingEnabled === false) {
    const ex = document.getElementById('mos-fab');
    if (ex) ex.remove();
    fabInjected = false;
  } else if (cachedFloatingEnabled === true) {
    injectFloatingButton();
  }
}

// Resolve the owner + user floating-launcher decision and show/hide the FAB.
// Fail-open: only an explicit `false` hides it; unknown / errors leave it shown.
function refreshFloatingSetting() {
  if (cachedFloatingEnabled !== null) { applyFloatingToFab(); return; }
  if (floatingFabFetchInFlight) return;
  const ctx = detectContext();
  if (!ctx.shopId) return;
  floatingFabFetchInFlight = true;
  safeSendMessage({ action: 'GET_SHOP_FEATURES', shopId: ctx.shopId, provider: 'tekmetric' }, (resp) => {
    floatingFabFetchInFlight = false;
    if (resp && resp.success) {
      cachedFloatingEnabled = resp.floatingButtonEnabled !== false;
      applyFloatingToFab();
    }
  });
}

function injectFloatingButton() {
  // Owner/user gate: the launcher (FAB) is disabled for this shop+user.
  if (cachedFloatingEnabled === false) {
    const ex = document.getElementById('mos-fab');
    if (ex) ex.remove();
    fabInjected = false;
    return;
  }
  if (fabInjected) return;
  if (document.getElementById('mos-fab')) {
    fabInjected = true;
    return;
  }
  
  // Create the floating action button
  const fab = document.createElement('button');
  fab.id = 'mos-fab';
  fab.title = 'Open Detect Dog';
  fab.type = 'button';
  
  const imgUrl = chrome.runtime.getURL('icons/mos-fab.png');
  // Fill the FAB with the mascot — earlier sizing (40×40 inside 48×48 with
  // 2px padding) left the detective bear visibly dwarfed by the white
  // container, which made the brand mark hard to read against bold pages
  // like Tekmetric's refer-and-earn promo. We now stretch the img to the
  // full container with `object-fit: contain` so any aspect-ratio source
  // still renders without distortion but uses every available pixel.
  fab.innerHTML = `<img src="${imgUrl}" alt="Detect Dog" style="width: 100%; height: 100%; object-fit: contain; border-radius: 4px; display: block;" />`;
  
  // Get saved position or default
  const savedTop = localStorage.getItem('mos-fab-top');
  const topPosition = savedTop ? parseInt(savedTop) : 200;
  
  Object.assign(fab.style, {
    position: 'fixed',
    right: '12px',
    top: `${topPosition}px`,
    width: '48px',
    height: '48px',
    borderRadius: '8px',
    backgroundColor: '#ffffff',
    border: '1px solid #e0e0e0',
    boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
    cursor: 'grab',
    zIndex: '2147483647',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '0',
    overflow: 'hidden',
    transition: 'transform 0.15s, box-shadow 0.15s',
    userSelect: 'none'
  });
  
  // Hover effects
  fab.addEventListener('mouseenter', () => {
    if (!fabDragging) {
      fab.style.transform = 'scale(1.08)';
      fab.style.boxShadow = '0 6px 16px rgba(0,0,0,0.25)';
    }
  });
  
  fab.addEventListener('mouseleave', () => {
    if (!fabDragging) {
      fab.style.transform = 'scale(1)';
      fab.style.boxShadow = '0 4px 12px rgba(0,0,0,0.2)';
    }
  });
  
  // Drag functionality
  fab.addEventListener('mousedown', (e) => {
    fabDragging = true;
    fabDragStartY = e.clientY;
    fabStartTop = parseInt(fab.style.top);
    fab.style.cursor = 'grabbing';
    fab.style.transition = 'none';
    e.preventDefault();
  });
  
  document.addEventListener('mousemove', (e) => {
    if (!fabDragging) return;
    const deltaY = e.clientY - fabDragStartY;
    let newTop = fabStartTop + deltaY;
    
    // Constrain to viewport
    newTop = Math.max(10, Math.min(window.innerHeight - 58, newTop));
    fab.style.top = `${newTop}px`;
  });
  
  document.addEventListener('mouseup', (e) => {
    if (!fabDragging) return;
    
    const movedDistance = Math.abs(e.clientY - fabDragStartY);
    fabDragging = false;
    fab.style.cursor = 'grab';
    fab.style.transition = 'transform 0.15s, box-shadow 0.15s';
    
    // Save position
    localStorage.setItem('mos-fab-top', fab.style.top.replace('px', ''));
    
    // If minimal movement, treat as click
    if (movedDistance < 5) {
      openSidePanel();
    }
  });
  
  document.body.appendChild(fab);
  fabInjected = true;
  console.log('[MOS Tools] Floating button injected');
}

function openSidePanel() {
  safeSendMessage({ action: 'PING' }, () => {
    if (chrome.runtime?.lastError) {
      console.log('[MOS Tools] Waking service worker...');
    }
    setTimeout(() => {
      safeSendMessage({ action: 'OPEN_SIDE_PANEL' }, (response) => {
        if (chrome.runtime?.lastError) {
          console.log('[MOS Tools] Could not open side panel:', chrome.runtime.lastError.message);
          setTimeout(() => {
            safeSendMessage({ action: 'OPEN_SIDE_PANEL' }, () => {
              if (chrome.runtime?.lastError) {
                console.log('[MOS Tools] Side panel open failed after retry');
              }
            });
          }, 500);
        }
      });
    }, 100);
  });
}

// ==================== INITIALIZATION ====================
// ==================== CATEGORY CHANGE DETECTION ====================
let categoryChangeDebounce = null;

let authorizationDebounce = null;

function startCategoryChangeObserver() {
  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'MOS_CATEGORY_CHANGED') {
      const { jobId, categoryCode, categoryName } = e.data;
      console.log(`[MOS Tools] Category change detected via network: job ${jobId} → ${categoryName} (${categoryCode})`);

      if (categoryChangeDebounce) clearTimeout(categoryChangeDebounce);
      categoryChangeDebounce = setTimeout(() => {
        safeSendMessage({
          action: "CATEGORY_CHANGED",
          jobId: jobId,
          jobName: jobId,
          newCategory: categoryName || categoryCode
        });
      }, 500);
    }

    if (e.data && e.data.type === 'MOS_JOBS_AUTHORIZED') {
      console.log('[MOS Tools] Job authorization detected via network');
      if (authorizationDebounce) clearTimeout(authorizationDebounce);
      authorizationDebounce = setTimeout(() => {
        safeSendMessage({
          action: "JOBS_AUTHORIZED"
        });
      }, 1500);
    }

    if (e.data && e.data.type === 'MOS_SNIFFER_CAPTURE') {
      safeSendMessage({
        action: 'SNIFFER_CAPTURE_FROM_PAGE',
        data: e.data.data
      });
    }

    // Tekmetric SPA loaded an RO — interceptor parsed its API response and
    // handed us friendly RO #, vehicle, customer, mileage. Merge into cache
    // and re-emit context so the side panel updates on first paint.
    if (e.data && e.data.type === 'MOS_RO_LOADED' && e.data.roId && e.data.data) {
      try {
        mergeApiRoData(e.data.shopId, e.data.roId, e.data.data);
        console.log('[MOS Tools] RO data captured from SPA network response for', e.data.roId);
        updateContext();
      } catch (err) {
        console.warn('[MOS Tools] MOS_RO_LOADED handler error:', err);
      }
    }
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'MOS_SNIFFER_STATE_UPDATE') {
      window.postMessage({ type: 'MOS_SNIFFER_STATE', active: message.active }, '*');
    }
  });

  console.log('[MOS Tools] Category change listener registered (network-based)');
}

function init() {
  // Initial context check
  updateContext();
  
  // Inject floating action button (launcher) — gated by owner/user setting.
  injectFloatingButton();
  refreshFloatingSetting();
  
  // Try to inject print button
  checkAndInjectButton();

  // Check for context changes on URL changes (SPA navigation)
  let lastUrl = window.location.href;
  contextCheckInterval = setInterval(() => {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      printButtonInjected = false; // Reset on navigation
      updateContext();
      checkAndInjectButton();
    }
  }, 500);
  
  // Also periodically try to inject button (for dynamic page loads)
  setInterval(checkAndInjectButton, 2000);

  // Also listen for popstate (browser back/forward)
  window.addEventListener('popstate', () => {
    printButtonInjected = false;
    updateContext();
    checkAndInjectButton();
  });

  // Watch for job category changes on RO pages
  startCategoryChangeObserver();
}

// NOTE: Main world interceptor (interceptor.js) is now injected via manifest.json
// at document_start in MAIN world for reliable fetch/XHR interception.

// ==================== CONCERN INJECTION ====================
function injectConcernText(text) {
  showToast('Concern text copied to clipboard. Use interceptor logs to find API.', 'info');
  navigator.clipboard.writeText(text).catch(() => {});
  return true;
}

// Wait for page to be ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
