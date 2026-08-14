console.log("[MOS Tools] AutoFlow content script loaded");
console.log("[Autoflow] content script loaded");

// Task #511: relay user-action drops to the background worker for the
// /api/extension/telemetry endpoint. Fire-and-forget; never throws.
function reportActionDropped(action, reason, extra) {
  try {
    if (!chrome.runtime?.id) return;
    const payload = Object.assign({ action: action, reason: reason || null, provider: "autoflow" }, extra || {});
    const p = chrome.runtime.sendMessage({ action: "REPORT_TELEMETRY", event: "action.dropped", payload: payload });
    if (p && p.catch) p.catch(() => {});
  } catch (_) { /* no-op */ }
}

// Task #1112: report uncaught extension-origin JS errors (throttled).
try {
  globalThis.MosTelemetryCore?.installErrorHooks({
    surface: "content",
    provider: "autoflow",
    requireExtensionOrigin: true,
    // Shop-scope the error throttle (v4 SPA can change shop slug in-tab).
    getScope: () => { try { return (lastContext && lastContext.shopId) || null; } catch (_) { return null; } },
    send: (payload) => {
      try {
        if (!chrome.runtime?.id) return;
        const p = chrome.runtime.sendMessage({ action: "REPORT_TELEMETRY", event: "client.error", payload });
        if (p && p.catch) p.catch(() => {});
      } catch (_) {}
    },
  });
} catch (_) { /* never throw from telemetry */ }

let lastContext = null;
let contextCheckInterval = null;

// Mileage sanity ceiling. Real fleet/high-mile vehicles legitimately exceed
// 1,000,000 (seen live on AutoFlow v4: 1,234,556), so the cap is 2,000,000 —
// still low enough to reject phone numbers / ids masquerading as mileage.
const MAX_SANE_MILEAGE = 2000000;

// AutoFlow shop id detection across v3 (per-shop subdomain) and v4 (shared
// host with the shop slug in the path). Generic infrastructure subdomains
// (app/www/admin/...) are NOT shop ids, so on v4 we read the path instead.
// The returned id must match what the backend resolves against
// (autoflow.subdomain / autoflow.domain / autoflow.shopId / autoflowDomain).
function detectAutoflowShopId(hostname, pathname) {
  const GENERIC = new Set(["app", "www", "admin", "secure", "api", "portal"]);
  const sub = (hostname || "").match(/^([^.]+)\.(autotext\.me|autoflow\.com)/i);
  if (sub && !GENERIC.has(sub[1].toLowerCase())) return sub[1];
  const pathSlug = (pathname || "").match(/\/shop\/([^/?#]+)/i);
  if (pathSlug) {
    try { return decodeURIComponent(pathSlug[1]); } catch (_) { return pathSlug[1]; }
  }
  return null;
}

// Collect form-field values paired with a lowercase "hint" (name/id/
// placeholder/aria-label/data-testid + associated <label> text). DVI pages
// hold VIN + mileage in editable inputs whose values never appear in
// document.body.innerText, so the text-based scrapes can't see them.
//
// AutoFlow v4 (July 2026) renders DVI vehicle fields as bare inputs inside
// table cells with the human label in the ADJACENT cell ("Vin | [input]",
// "Mileage | [input]") — no <label for>, no name/placeholder/aria hints. So
// when the attribute-based hints come up empty we also read the previous
// sibling table cell (and, as a last resort, the input's previous element
// sibling) as the label. Labels are short by nature; anything long is a
// content cell, not a label, and is ignored.
const MAX_ADJACENT_LABEL_LEN = 40;

function readAdjacentCellLabel(el) {
  try {
    if (!el || !el.closest) return "";
    const clean = (t) => {
      const s = (t || "").replace(/\s+/g, " ").trim();
      return s && s.length <= MAX_ADJACENT_LABEL_LEN ? s : "";
    };
    const cell = el.closest("td, th");
    if (cell && cell.previousElementSibling) {
      const t = clean(cell.previousElementSibling.textContent);
      if (t) return t;
    }
    // Non-table v4 layouts: a label-ish element directly before the input.
    if (el.previousElementSibling) {
      const t = clean(el.previousElementSibling.textContent);
      if (t) return t;
    }
    // Or directly before the input's wrapper div/span.
    const parent = el.parentElement;
    if (parent && parent.previousElementSibling && !cell) {
      const t = clean(parent.previousElementSibling.textContent);
      if (t) return t;
    }
  } catch (_) {}
  return "";
}

function collectFormFieldHints() {
  const out = [];
  let els;
  try { els = document.querySelectorAll("input, textarea, select"); }
  catch (_) { return out; }
  for (const el of els) {
    const value = (el && el.value != null ? String(el.value) : "").trim();
    if (!value) continue;
    let label = "";
    try {
      if (el.id) {
        const sel = window.CSS && CSS.escape ? CSS.escape(el.id) : el.id;
        const l = document.querySelector('label[for="' + sel + '"]');
        if (l) label = l.textContent || "";
      }
      if (!label && el.closest) {
        const wrap = el.closest("label");
        if (wrap) label = wrap.textContent || "";
      }
    } catch (_) {}
    let hint = [
      el.name, el.id,
      el.getAttribute && el.getAttribute("placeholder"),
      el.getAttribute && el.getAttribute("aria-label"),
      el.getAttribute && el.getAttribute("data-testid"),
      label
    ].filter(Boolean).join(" ").toLowerCase();
    // v4: attribute hints are often useless — inputs carry randomized ids
    // (e.g. "jawzvixagj") with no name/placeholder/aria-label and no <label>
    // association, so the attribute-derived hint is non-empty gibberish.
    // ALWAYS append the adjacent-cell label ("Mileage", "VIN", …) rather than
    // only when the hint is empty, or the mileage field is never recognized
    // on v4 DVI pages (telemetry: hasMileage=false with random hintKeys).
    const adjacent = readAdjacentCellLabel(el).toLowerCase();
    if (adjacent) {
      hint = hint ? hint + " " + adjacent : adjacent;
    }
    out.push({ hint, value });
  }
  return out;
}

// ==================== LAST-KNOWN-GOOD IDENTITY GUARD ====================
// AutoFlow is scrape-only (no API interceptor like Tekmetric), so the SPA can
// momentarily re-render with an identity field missing when the user switches
// browser tabs or React re-hydrates. Once we've seen a good value for a
// vehicle/RO identity field, a later empty/null scrape for the SAME RO/vehicle
// must NOT clobber it. A genuinely different RO/VIN is a legitimate switch and
// replaces the cached values.
const AF_IDENTITY_FIELDS = [
  "roId", "roNumber", "vin", "mileage", "vehicle", "vehicleDisplay",
  "vehicleId", "customer", "customerName", "customerId", "customerPhone",
  "customerEmail"
];

// Per RO/VIN cache of last-known-good identity fields, plus the key of the most
// recent good context so a scrape that drops the identity entirely (roId AND vin
// both missing) can still be re-anchored to the current vehicle.
const afContextCache = new Map();
let afLastGoodKey = null;

function afCacheKey(ctx) {
  const shop = ctx && ctx.shopId != null ? ctx.shopId : "?";
  if (ctx && ctx.roId) return `${shop}:ro:${ctx.roId}`;
  if (ctx && ctx.vin) return `${shop}:vin:${ctx.vin}`;
  return null;
}

function isEmptyValue(v) {
  return v == null || v === "";
}

// Merge a freshly-scraped context with the last-known-good values for the same
// RO/vehicle. Non-empty scraped values always win (real updates, including a
// legitimate switch to a different RO/VIN); empty scrapes fall back to cache.
function applyLastKnownGoodGuard(ctx) {
  let key = afCacheKey(ctx);
  // Identity fully dropped by a transient re-render — re-anchor to the last
  // good RO/VIN so the sidepanel keeps the current vehicle context.
  if (!key && afLastGoodKey) key = afLastGoodKey;
  if (!key) return ctx; // nothing captured yet; nothing to protect

  const prior = afContextCache.get(key) || {};
  const merged = {};
  for (const field of AF_IDENTITY_FIELDS) {
    const fresh = ctx[field];
    merged[field] = isEmptyValue(fresh) ? (prior[field] ?? null) : fresh;
    ctx[field] = merged[field];
  }
  afContextCache.set(key, merged);
  afLastGoodKey = key;
  return ctx;
}

function detectContext() {
  const ctx = _detectContextRaw();
  const guarded = applyLastKnownGoodGuard(ctx);
  // Mirror the Tekmetric adapter: preserve the on-screen odometer under a
  // dedicated field. The side panel forwards `scrapedOdometer` to the plan
  // API's `odometer` param so the VHI anchors on the mileage the advisor
  // actually entered on the DVI/ticket page, instead of a CARFAX estimate.
  // Without this, AutoFlow pages never send an odometer and the extension
  // header can disagree with the page (e.g. estimate 21,489 vs entered
  // 21,860). `mileage` itself gets overwritten by the server-resolved value
  // after a plan response, so a separate field is required.
  if (typeof guarded.mileage === 'number' && guarded.mileage > 0) {
    guarded.scrapedOdometer = guarded.mileage;
  }
  return guarded;
}

function _detectContextRaw() {
  const url = window.location.href;
  const hostname = window.location.hostname;

  const context = {
    provider: "autoflow",
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

  // Shop identifier — AutoFlow is mid-transition from v3 to v4:
  //   v3: per-shop subdomain  (harrells-nc87.autotext.me)
  //   v4: shared host + shop in the path (app.autoflow.com/shop/<slug>/...)
  context.shopId = detectAutoflowShopId(hostname, window.location.pathname);

  const pageText = document.body?.innerText || "";

  // VIN + mileage live in editable form fields on DVI pages, whose values are
  // not in innerText. Collect them once for the VIN/mileage fallbacks below.
  const fieldHints = collectFormFieldHints();

  const ticketPatterns = [
    /\/tickets?\/(\d+)/,
    /\/invoices?\/(\d+)/,
    /\/inspections?\/(\d+)/,
    /\/dvi[_v0-9]*\/.*[?&]status_id=(\d+)/,
    // v4 DVI detail page: app.autoflow.com/shop/<number>/dvi/<dviId>
    // (matched explicitly BEFORE the generic /dvi/<id> pattern so a future
    // change to the generic pattern can't silently drop v4 support).
    /\/shop\/[^/]+\/dvi\/(\d+)/i,
    /\/dvi\/(\d+)/,
    // v4 path-based RO/ticket locations under app.autoflow.com/shop/<slug>/...
    /\/shop\/[^/]+\/(?:repair[-_]?orders?|work[-_]?orders?|ro|tickets?|invoices?|inspections?)\/(\d+)/i,
    /\/(?:repair[-_]?orders?|work[-_]?orders?|ro)\/(\d+)/i,
    /[?&](?:status_id|ticket_id|invoice_id|ro_id)=(\d+)/
  ];
  for (const pattern of ticketPatterns) {
    const m = url.match(pattern);
    if (m) {
      context.roId = m[1];
      break;
    }
  }

  try {
    const roPatterns = [
      /(?:Invoice|Ticket|RO|Work\s*Order)\s*#?\s*:?\s*(\d+)/i,
      /(?:Invoice|Ticket)\s*(?:Number|No\.?)\s*:?\s*(\d+)/i,
      /Est\/Invoice#\s*(\d+)/i
    ];
    for (const p of roPatterns) {
      const m = pageText.match(p);
      if (m) {
        context.roNumber = m[1];
        context.roId = m[1];
        break;
      }
    }
  } catch (e) {}

  try {
    const vinLabelMatch = pageText.match(/VIN[:\s]+([A-HJ-NPR-Z0-9 ]{17,22})/i);
    if (vinLabelMatch) {
      const cleaned = vinLabelMatch[1].replace(/\s/g, "");
      if (/^[A-HJ-NPR-Z0-9]{17}$/i.test(cleaned)) {
        context.vin = cleaned.toUpperCase();
      }
    }
    if (!context.vin) {
      const vinEls = document.querySelectorAll(
        '[data-testid*="vin"], [class*="vin"], [class*="VIN"], [aria-label*="VIN"]'
      );
      for (const el of vinEls) {
        const raw = (el.textContent || "").replace(/\s/g, "");
        const m = raw.match(/[A-HJ-NPR-Z0-9]{17}/i);
        if (m) {
          context.vin = m[0].toUpperCase();
          break;
        }
      }
    }
    if (!context.vin) {
      const vinMatch = pageText.match(/\b([A-HJ-NPR-Z0-9]{17})\b/i);
      if (vinMatch) {
        context.vin = vinMatch[1].toUpperCase();
      }
    }
    // Form-field fallback: the VIN usually sits in an editable input on DVI
    // pages, so it never reaches innerText. Prefer a VIN-hinted field, then
    // fall back to any field holding a valid 17-char VIN.
    if (!context.vin) {
      for (const f of fieldHints) {
        if (!/vin/.test(f.hint)) continue;
        const m = f.value.replace(/\s/g, "").match(/[A-HJ-NPR-Z0-9]{17}/i);
        if (m) { context.vin = m[0].toUpperCase(); break; }
      }
    }
    if (!context.vin) {
      for (const f of fieldHints) {
        const cleaned = f.value.replace(/\s/g, "");
        if (/^[A-HJ-NPR-Z0-9]{17}$/i.test(cleaned)) { context.vin = cleaned.toUpperCase(); break; }
      }
    }
  } catch (e) {}

  try {
    const vehiclePattern =
      /\b(19\d{2}|20\d{2})\s+([A-Z][a-zA-Z-]+)\s+([A-Z][a-zA-Z0-9\s-]+?)(?:\s+VIN|\s+In:|\s+Out:|\n|$)/i;
    const vm = pageText.match(vehiclePattern);
    if (vm) {
      const year = parseInt(vm[1]);
      const make = vm[2].trim();
      let model = vm[3].trim().replace(/\s+\d{1,3}(,\d{3})*\s*$/, "").trim();
      if (year >= 1900 && year <= 2035 && make && model) {
        context.vehicle = { year, make, model };
        context.vehicleDisplay = `${year} ${make} ${model}`;
      }
    }

    if (!context.vehicle) {
      const vehicleSelectors = [
        '[data-testid*="vehicle"]',
        '[class*="vehicle"]',
        '[class*="Vehicle"]',
        '[class*="car-info"]'
      ];
      for (const sel of vehicleSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          const text = el.textContent || "";
          const m = text.match(/\b(19\d{2}|20\d{2})\s+(\w+)\s+([^\n]+)/);
          if (m) {
            const year = parseInt(m[1]);
            const make = m[2].trim();
            const model = m[3].trim().split(/\s{2,}/)[0];
            if (year >= 1900 && year <= 2035) {
              context.vehicle = { year, make, model };
              context.vehicleDisplay = `${year} ${make} ${model}`;
              break;
            }
          }
        }
      }
    }
  } catch (e) {}

  try {
    const mileageSelectors = [
      '[data-testid*="mileage"]',
      '[data-testid*="odometer"]',
      '[class*="mileage"]',
      '[class*="odometer"]'
    ];
    for (const sel of mileageSelectors) {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        const m = el.textContent.match(/[\d,]+/);
        if (m) {
          const v = parseInt(m[0].replace(/,/g, ""));
          if (v > 100 && v < MAX_SANE_MILEAGE) {
            context.mileage = v;
            break;
          }
        }
      }
      if (context.mileage) break;
    }

    // Form-field fallback: DVI pages keep mileage in an editable input whose
    // label renders "Mileage *", so its value is not in innerText.
    if (!context.mileage) {
      // Two passes: an explicit "mileage"/"odometer" label always beats a
      // looser "miles" match. Now that adjacent-cell labels are appended to
      // EVERY field's hint (v4 randomized ids), a stray "miles"-labeled
      // numeric field earlier in DOM order must not shadow the real
      // Mileage input.
      const passes = [/mileage|odometer|odom/, /miles/];
      outer: for (const rx of passes) {
        for (const f of fieldHints) {
          if (!rx.test(f.hint)) continue;
          const m = f.value.replace(/,/g, "").match(/\d+/);
          if (m) {
            const v = parseInt(m[0]);
            if (v > 100 && v < MAX_SANE_MILEAGE) { context.mileage = v; break outer; }
          }
        }
      }
    }

    if (!context.mileage) {
      // Tolerate a required-asterisk and assorted separators between the label
      // ("Mileage"/"Odometer") and the number ("Mileage *: 191,485").
      const patterns = [
        /(?:Odometer|Mileage)\s*\*?\s*[:\-]?\s*([\d,]+)/i,
        /(?:Miles|KM)\s*\*?\s*[:\-]?\s*([\d,]+)/i
      ];
      for (const p of patterns) {
        const m = pageText.match(p);
        if (m) {
          const v = parseInt(m[1].replace(/,/g, ""));
          if (v > 0 && v < MAX_SANE_MILEAGE) {
            context.mileage = v;
            break;
          }
        }
      }
    }
  } catch (e) {}

  try {
    const UI_BLACKLIST = new Set([
      "add concern",
      "view customer",
      "edit customer",
      "new customer",
      "add note",
      "sign out",
      "log out",
      "save changes",
      "cancel"
    ]);

    function isLikelyName(text) {
      if (!text || text.length < 4 || text.length > 50) return false;
      if (UI_BLACKLIST.has(text.toLowerCase())) return false;
      return /^[A-Z][a-zA-Z'-]+\s+[A-Z]/.test(text);
    }

    const customerLinks = document.querySelectorAll('a[href*="/customer"]');
    for (const link of customerLinks) {
      const href = link.getAttribute("href") || "";
      const idMatch = href.match(/\/customers?\/(\d+)/);
      const text = link.textContent?.trim() || "";
      if (idMatch) context.customerId = idMatch[1];
      if (isLikelyName(text)) {
        context.customerName = text;
        context.customer = { name: text };
      }
      if (context.customerName && context.customerId) break;
    }

    if (!context.customerName) {
      const customerSelectors = [
        '[data-testid*="customer"]',
        '[class*="customer-name"]',
        '[class*="CustomerName"]',
        '[class*="client-name"]',
        '[class*="owner"]'
      ];
      for (const sel of customerSelectors) {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          const text = el.textContent?.trim() || "";
          if (isLikelyName(text)) {
            context.customerName = text;
            context.customer = { name: text };
            break;
          }
        }
        if (context.customerName) break;
      }
    }

    if (!context.customerName) {
      const labelPatterns = [
        /Customer[:\s]+([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+){1,2})/,
        /Owner[:\s]+([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+){1,2})/
      ];
      for (const p of labelPatterns) {
        const m = pageText.match(p);
        if (m && isLikelyName(m[1].trim())) {
          context.customerName = m[1].trim();
          context.customer = { name: context.customerName };
          break;
        }
      }
    }
  } catch (e) {}

  try {
    const emailMatch = pageText.match(
      /\b([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b/
    );
    if (emailMatch) context.customerEmail = emailMatch[1];

    const phoneMatch = pageText.match(
      /\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/
    );
    if (phoneMatch) context.customerPhone = phoneMatch[0];
  } catch (e) {}

  return context;
}

function hasContextChanged(a, b) {
  if (!a && !b) return false;
  if (!a || !b) return true;
  return (
    a.roId !== b.roId ||
    a.shopId !== b.shopId ||
    a.vin !== b.vin ||
    a.mileage !== b.mileage ||
    a.customerName !== b.customerName
  );
}

function sendContextUpdate(context) {
  if (!context.shopId) return;
  if (!context.roId && !context.vin) return;

  chrome.runtime.sendMessage(
    {
      action: "SET_SMS_CONTEXT",
      context: context
    },
    (response) => {
      if (chrome.runtime.lastError) {
        console.log(
          "[MOS Tools] Context send error:",
          chrome.runtime.lastError.message
        );
      }
    }
  );
}

// ==================== INCOMPLETE-CONTEXT TELEMETRY (Task #884) ====================
// When a DVI-like page (v3 or v4) still yields an incomplete context after
// the page has had time to render, report it once per URL so unresolved v4
// layouts / shop numbers surface in /api/extension/telemetry instead of
// failing silently. Payload carries ONLY the URL shape, resolved-field
// booleans, and anonymized hint keys — never field values.
const DVI_INCOMPLETE_SETTLE_MS = 8000;
const reportedIncompleteUrls = new Set();
let dviIncompleteTimer = null;
let dviIncompleteTimerUrl = null;

function classifyDviUrlShape() {
  const path = window.location.pathname || "";
  const host = window.location.hostname || "";
  if (/\/shop\/[^/]+\/dvi\//i.test(path)) return "v4_dvi";
  if (/\/dvi[_v0-9]*\//i.test(path) && /autotext\.me$/i.test(host)) return "v3_dvi";
  if (/\/dvi[_v0-9]*\//i.test(path)) return "other_dvi";
  return null;
}

// Anonymize hints: keep only short alphabetic tokens (label words like
// "vin"/"mileage"), never digits or values. Capped so payloads stay tiny.
function anonymizedHintKeys() {
  const keys = [];
  try {
    const hints = collectFormFieldHints();
    for (const f of hints) {
      const tokens = (f.hint || "")
        .split(/[^a-z]+/i)
        .filter((t) => t.length >= 2 && t.length <= 24)
        .slice(0, 3);
      const key = tokens.join("_");
      if (key && !keys.includes(key)) keys.push(key);
      if (keys.length >= 12) break;
    }
  } catch (_) {}
  return keys;
}

function maybeReportIncompleteDviContext(context) {
  const urlShape = classifyDviUrlShape();
  if (!urlShape) return;
  const url = window.location.href.split("#")[0];
  const complete = !!(context.shopId && context.vin && context.mileage && context.roId);
  if (complete) {
    if (dviIncompleteTimerUrl === url && dviIncompleteTimer) {
      clearTimeout(dviIncompleteTimer);
      dviIncompleteTimer = null;
      dviIncompleteTimerUrl = null;
    }
    return;
  }
  if (reportedIncompleteUrls.has(url)) return;
  if (dviIncompleteTimerUrl === url && dviIncompleteTimer) return; // already pending
  if (dviIncompleteTimer) clearTimeout(dviIncompleteTimer);
  dviIncompleteTimerUrl = url;
  // Let the SPA finish rendering before declaring the context incomplete.
  dviIncompleteTimer = setTimeout(() => {
    dviIncompleteTimer = null;
    dviIncompleteTimerUrl = null;
    try {
      if (window.location.href.split("#")[0] !== url) return; // navigated away
      const ctx = detectContext();
      if (ctx.shopId && ctx.vin && ctx.mileage && ctx.roId) return; // resolved itself
      reportedIncompleteUrls.add(url);
      const payload = {
        provider: "autoflow",
        urlShape,
        hasShopId: !!ctx.shopId,
        hasRoId: !!ctx.roId,
        hasVin: !!ctx.vin,
        hasMileage: !!ctx.mileage,
        hintKeys: anonymizedHintKeys(),
      };
      if (ctx.shopId) payload.smsShopId = String(ctx.shopId);
      if (!chrome.runtime?.id) return;
      const p = chrome.runtime.sendMessage({
        action: "REPORT_TELEMETRY",
        event: "context.incomplete",
        payload,
      });
      if (p && p.catch) p.catch(() => {});
      console.log("[MOS Tools] AutoFlow incomplete DVI context reported:", payload);
    } catch (_) { /* no-op */ }
  }, DVI_INCOMPLETE_SETTLE_MS);
}

function checkForContextChanges() {
  try {
    const context = detectContext();
    maybeReportIncompleteDviContext(context);
    if (hasContextChanged(context, lastContext)) {
      lastContext = context;
      console.log("[MOS Tools] AutoFlow context updated:", {
        shopId: context.shopId,
        roId: context.roId,
        vin: context.vin,
        vehicle: context.vehicleDisplay,
        mileage: context.mileage,
        customer: context.customerName
      });
      sendContextUpdate(context);
    }
  } catch (e) {
    console.error("[MOS Tools] Context check error:", e);
  }
}

// ==================== WRITE-PROVIDER GATE ====================
// AutoFlow shops can be paired with Tekmetric/Protractor/Shopware as the
// write-side SMS. We only show the "Create RO" button when the resolved
// write provider is Protractor — that's the only path we currently
// support for create-from-extension. Cached for the lifetime of the page
// (refreshed lazily after sign-in / shop change).
let cachedWriteProvider = null; // null = unknown, "" = none, otherwise provider name
let cachedCanWrite = null; // null = unknown, true/false once resolved
let writeProviderFetchInFlight = false;

function refreshWriteProvider() {
  if (writeProviderFetchInFlight) return;
  const ctx = lastContext || detectContext();
  if (!ctx.shopId) return;
  writeProviderFetchInFlight = true;
  chrome.runtime.sendMessage(
    { action: "GET_SHOP_FEATURES", shopId: ctx.shopId, provider: "autoflow" },
    (response) => {
      writeProviderFetchInFlight = false;
      if (chrome.runtime.lastError) return;
      if (response && response.success) {
        cachedWriteProvider = response.writeProvider || "";
        cachedCanWrite = response.canWrite !== false;
        console.log(
          "[MOS Tools] AutoFlow write provider resolved:",
          cachedWriteProvider || "(none)",
          "canWrite=" + cachedCanWrite
        );
        // Re-evaluate Create RO button now that we know the provider.
        checkAndInjectCreateRoButton();
      }
    }
  );
}

// ==================== FLOATING LAUNCHER (FAB) ====================
// AutoFlow had no floating Detect Dog launcher (only Tekmetric / Shop-Ware did),
// so there was no way to re-open the side panel from the AutoFlow dashboard.
// This mirrors the Tekmetric FAB so advisors can open the panel from any
// AutoFlow page. Fail-open: only an explicit floatingButtonEnabled === false
// hides it; unknown / errors leave it shown.
let fabInjected = false;
let fabDragging = false;
let fabDragStartY = 0;
let fabStartTop = 0;
let cachedFloatingEnabled = null; // null = unknown (show), true = show, false = hide
let floatingFabFetchInFlight = false;

function applyFloatingToFab() {
  if (cachedFloatingEnabled === false) {
    const ex = document.getElementById("mos-fab");
    if (ex) ex.remove();
    fabInjected = false;
  } else {
    injectAutoflowFloatingButton();
  }
}

function refreshFloatingSetting() {
  if (cachedFloatingEnabled !== null) { applyFloatingToFab(); return; }
  if (floatingFabFetchInFlight) return;
  const ctx = lastContext || detectContext();
  if (!ctx || !ctx.shopId) return;
  floatingFabFetchInFlight = true;
  chrome.runtime.sendMessage(
    { action: "GET_SHOP_FEATURES", shopId: ctx.shopId, provider: "autoflow" },
    (resp) => {
      floatingFabFetchInFlight = false;
      if (chrome.runtime.lastError) return;
      if (resp && resp.success) {
        cachedFloatingEnabled = resp.floatingButtonEnabled !== false;
        applyFloatingToFab();
      }
    }
  );
}

function injectAutoflowFloatingButton() {
  if (cachedFloatingEnabled === false) {
    const ex = document.getElementById("mos-fab");
    if (ex) ex.remove();
    fabInjected = false;
    return;
  }
  if (fabInjected) return;
  if (document.getElementById("mos-fab")) { fabInjected = true; return; }

  const fab = document.createElement("button");
  fab.id = "mos-fab";
  fab.title = "Open Detect Dog";
  fab.type = "button";
  const imgUrl = chrome.runtime.getURL("icons/mos-fab.png");
  fab.innerHTML = `<img src="${imgUrl}" alt="Detect Dog" style="width:100%;height:100%;object-fit:contain;border-radius:4px;display:block;" />`;

  const savedTop = localStorage.getItem("mos-fab-top");
  const topPosition = savedTop ? parseInt(savedTop) : 200;
  Object.assign(fab.style, {
    position: "fixed", right: "12px", top: `${topPosition}px`,
    width: "48px", height: "48px", borderRadius: "8px",
    backgroundColor: "#ffffff", border: "1px solid #e0e0e0",
    boxShadow: "0 4px 12px rgba(0,0,0,0.2)", cursor: "grab",
    zIndex: "2147483647", display: "flex", alignItems: "center",
    justifyContent: "center", padding: "0", overflow: "hidden",
    transition: "transform 0.15s, box-shadow 0.15s", userSelect: "none",
  });

  fab.addEventListener("mouseenter", () => {
    if (!fabDragging) { fab.style.transform = "scale(1.08)"; fab.style.boxShadow = "0 6px 16px rgba(0,0,0,0.25)"; }
  });
  fab.addEventListener("mouseleave", () => {
    if (!fabDragging) { fab.style.transform = "scale(1)"; fab.style.boxShadow = "0 4px 12px rgba(0,0,0,0.2)"; }
  });
  fab.addEventListener("mousedown", (e) => {
    fabDragging = true; fabDragStartY = e.clientY; fabStartTop = parseInt(fab.style.top);
    fab.style.cursor = "grabbing"; fab.style.transition = "none"; e.preventDefault();
  });
  document.addEventListener("mousemove", (e) => {
    if (!fabDragging) return;
    const deltaY = e.clientY - fabDragStartY;
    let newTop = fabStartTop + deltaY;
    newTop = Math.max(10, Math.min(window.innerHeight - 58, newTop));
    fab.style.top = `${newTop}px`;
  });
  document.addEventListener("mouseup", (e) => {
    if (!fabDragging) return;
    const movedDistance = Math.abs(e.clientY - fabDragStartY);
    fabDragging = false; fab.style.cursor = "grab";
    fab.style.transition = "transform 0.15s, box-shadow 0.15s";
    localStorage.setItem("mos-fab-top", fab.style.top.replace("px", ""));
    if (movedDistance < 5) openAutoflowSidePanel();
  });

  document.body.appendChild(fab);
  fabInjected = true;
  console.log("[MOS Tools] AutoFlow floating button injected");
}

function openAutoflowSidePanel() {
  // When the extension is reloaded/updated, this already-injected content
  // script's context dies. `chrome.runtime.id` goes undefined and any
  // `chrome.runtime.*` call throws "Extension context invalidated"
  // SYNCHRONOUSLY (the lastError callback never runs), so it must be guarded
  // here, not just in the callback. A page refresh re-injects a fresh script.
  if (!chrome.runtime?.id) return;
  try {
    chrome.runtime.sendMessage({ action: "PING" }, () => {
      void chrome.runtime.lastError;
      setTimeout(() => {
        if (!chrome.runtime?.id) return;
        try {
          chrome.runtime.sendMessage({ action: "OPEN_SIDE_PANEL" }, () => {
            if (chrome.runtime.lastError) {
              setTimeout(() => {
                if (!chrome.runtime?.id) return;
                try {
                  chrome.runtime.sendMessage({ action: "OPEN_SIDE_PANEL" }, () => { void chrome.runtime.lastError; });
                } catch (_) { /* context invalidated mid-call */ }
              }, 500);
            }
          });
        } catch (_) { /* context invalidated mid-call */ }
      }, 100);
    });
  } catch (_) {
    // Extension context invalidated (reload/update). Safe to ignore.
  }
}

setTimeout(() => {
  checkForContextChanges();
  checkAndInjectButton();
  checkAndInjectCreateRoButton();
  checkAndInjectVhiButtons();
  refreshWriteProvider();
  refreshFloatingSetting();
  contextCheckInterval = setInterval(() => {
    checkForContextChanges();
    checkAndInjectButton();
    checkAndInjectCreateRoButton();
    checkAndInjectVhiButtons();
    refreshFloatingSetting();
  }, 2000);
}, 1000);

// MutationObserver: AutoFlow swaps page content inline (SPA-ish). Polling
// every 2 s leaves a visible "missing button" gap when navigating between
// dashboards. Listening for DOM mutations lets us re-inject within ~1 frame
// of the new view rendering.
(function installAutoflowMutationObserver() {
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      try {
        checkForContextChanges();
        checkAndInjectButton();
        checkAndInjectCreateRoButton();
        checkAndInjectVhiButtons();
        refreshFloatingSetting();
      } catch (e) {
        console.warn("[MOS Tools] AutoFlow re-inject error:", e.message);
      }
    });
  };
  const observer = new MutationObserver(schedule);
  const start = () => {
    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
    } else {
      setTimeout(start, 100);
    }
  };
  start();
})();

// ==================== TOAST NOTIFICATIONS ====================
function showToast(message, type = 'info') {
  const existing = document.getElementById('mos-toast');
  if (existing) existing.remove();
  const colors = { success: '#22c55e', error: '#ef4444', info: '#3b82f6', warning: '#f59e0b' };
  const toast = document.createElement('div');
  toast.id = 'mos-toast';
  Object.assign(toast.style, {
    position: 'fixed', bottom: '20px', right: '20px',
    backgroundColor: colors[type] || colors.info, color: 'white',
    padding: '10px 16px', borderRadius: '8px', fontSize: '14px',
    fontWeight: '500', zIndex: '999999',
    boxShadow: '0 4px 12px rgba(0,0,0,0.3)', maxWidth: '320px',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
  });
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

// After a successful DVI write-back (Apply to DVI / Enhance Notes / Add to
// Concerns), AutoFlow's page doesn't re-render the applied statuses/notes/
// recommendations until a manual refresh. Reload the page so the technician
// immediately sees the changes — but only when at least one item was written,
// so an all-failed apply leaves the error toast visible. The short delay keeps
// the success toast readable before the reload happens.
function reloadAfterApply() {
  setTimeout(() => {
    try { window.location.reload(); } catch (e) {}
  }, 1200);
}

// ==================== PRINT BUTTON ====================
let printButtonInjected = false;
let lastInjectedUrl = null;

function createPrintButton() {
  const button = document.createElement('button');
  button.id = 'mos-print-btn-af';
  button.title = 'MOS Oil Sticker\nLeft-click: Print | Right-click: Intervals';
  button.type = 'button';
  const imgUrl = chrome.runtime.getURL('icons/mos-print-button.png');
  button.innerHTML = `<img src="${imgUrl}" alt="MOS Print" style="height:26px;display:block;" />`;
  Object.assign(button.style, {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    padding: '2px', background: 'transparent', border: 'none',
    borderRadius: '4px', cursor: 'pointer', marginLeft: '6px',
    verticalAlign: 'middle', transition: 'opacity 0.2s'
  });
  button.addEventListener('mouseenter', () => { button.style.opacity = '0.8'; });
  button.addEventListener('mouseleave', () => { button.style.opacity = '1'; });
  button.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const ctx = detectContext();
    if (!ctx.roId || !ctx.shopId) {
      showToast('No work order detected on this page', 'error');
      return;
    }
    showToast('Generating sticker...', 'info');
    chrome.runtime.sendMessage(
      { action: 'PRINT_STICKER_IMMEDIATE', context: ctx },
      (response) => {
        if (response?.success) {
          printStickerFromContentScript(response.sticker);
        } else {
          showToast(response?.error || 'Failed to generate sticker', 'error');
          reportActionDropped("print_sticker", "generation_failed", { reason: response?.error || null });
        }
      }
    );
  });
  // Right-click: show interval-selection dropdown (Tekmetric parity).
  button.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showIntervalDropdown(e, button);
  });
  return button;
}

async function showIntervalDropdown(event, buttonElement) {
  // Toggle: clicking again closes an open dropdown.
  const existingDropdown = document.getElementById('mos-interval-dropdown');
  if (existingDropdown) {
    existingDropdown.remove();
    return;
  }

  const context = detectContext();

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

  const rect = buttonElement.getBoundingClientRect();
  dropdown.style.top = `${rect.bottom + 4}px`;
  dropdown.style.left = `${rect.left}px`;

  dropdown.innerHTML = '<div style="padding: 12px 16px; color: #666; font-size: 13px;">Loading intervals...</div>';
  document.body.appendChild(dropdown);

  // Fetch shop's configured intervals (same contract as Tekmetric).
  let intervals = [];
  let useKilometers = false;
  try {
    const result = await new Promise((resolve) => {
      chrome.runtime.sendMessage({
        action: 'MOS_API_REQUEST',
        endpoint: `/api/extension/sticker?shopId=${context.shopId}&provider=${context.provider || 'autoflow'}`
      }, resolve);
    });

    if (result && result.config) {
      useKilometers = result.config.useKilometers === true;
      const unitLabel = useKilometers ? 'km' : 'mi';

      if (result.config.intervals) {
        const cfg = result.config.intervals;
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

  // Fallback to defaults if no intervals fetched.
  if (intervals.length === 0) {
    const unitLabel = useKilometers ? 'km' : 'mi';
    intervals = [
      { label: `Conventional: 3,000 ${unitLabel} / 3 mo`, miles: 3000, months: 3, type: 'conventional' },
      { label: `Synthetic: 5,000 ${unitLabel} / 6 mo`, miles: 5000, months: 6, type: 'synthetic' },
      { label: `Euro: 10,000 ${unitLabel} / 12 mo`, miles: 10000, months: 12, type: 'euro' },
      { label: `Diesel: 7,500 ${unitLabel} / 6 mo`, miles: 7500, months: 6, type: 'diesel' }
    ];
  }

  intervals.push({ label: 'Customize...', action: 'customize' });

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

  // Close dropdown when clicking outside.
  const closeDropdown = (e) => {
    if (!dropdown.contains(e.target) && e.target !== buttonElement) {
      dropdown.remove();
      document.removeEventListener('click', closeDropdown);
    }
  };
  setTimeout(() => document.addEventListener('click', closeDropdown), 0);
}

function handleImmediatePrintWithInterval(miles, months, useKm) {
  const ctx = detectContext();
  if (!ctx.roId || !ctx.shopId) {
    showToast('No work order detected on this page', 'error');
    return;
  }

  const unitLabel = useKm ? 'km' : 'mi';
  showToast(`Generating sticker (${miles.toLocaleString()} ${unitLabel})...`, 'info');

  chrome.runtime.sendMessage({
    action: 'PRINT_STICKER_IMMEDIATE',
    context: {
      ...ctx,
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

function openStickerPanel() {
  chrome.runtime.sendMessage({
    action: 'OPEN_STICKER_PANEL',
    context: detectContext()
  });
}

function injectPrintButton() {
  if (printButtonInjected && document.getElementById('mos-print-btn-af')) return;
  if (document.getElementById('mos-print-btn-af')) {
    printButtonInjected = true;
    return;
  }
  const ctx = detectContext();
  if (!ctx.roId) return;

  let target = null;
  let placement = 'after'; // 'after' | 'append'

  // Strategy 1: AutoFlow DVI action bar — find the existing PDF / QC /
  // "Text & Email" / "Report Complete" buttons and drop in alongside
  // them. These are typically anchors or buttons whose visible text is
  // a known label. List has grown as we've onboarded tenants whose DVI
  // layouts use slightly different button labels.
  const KNOWN_LABELS = [
    'PDF', 'QC', 'Text & Email', 'Text and Email', 'Report Complete',
    'Re-Push', 'Re Push', 'RePush', 'Sheets', 'Print PDF', 'Print Report',
    'Email Report', 'Email PDF', 'Send Report', 'Send PDF',
    'Customer Report', 'Tech Report', 'Inspection Report',
    'Print Inspection', 'Print DVI', 'Print Ticket', 'Print Invoice',
    'Print Estimate', 'Print Work Order', 'Print', 'Print Sticker',
  ];
  const candidates = Array.from(document.querySelectorAll('a, button'));
  for (const label of KNOWN_LABELS) {
    const hit = candidates.find(el => {
      if (el.id === 'mos-print-btn-af') return false;
      const t = (el.textContent || '').trim();
      return t === label || t.startsWith(label + ' ') || t.startsWith(label + '(');
    });
    if (hit && hit.parentElement) {
      target = hit;
      placement = 'after';
      break;
    }
  }

  // Strategy 2: AutoFlow DVI / ticket submit/print toolbar containers.
  // Broadened to cover customized layouts reported by users — kept narrow
  // to known toolbar / action-bar class shapes so we don't latch onto
  // random divs.
  if (!target) {
    const toolbarSelectors = [
      '.btn-toolbar',
      '.dvi-actions', '.dvi_actions',
      '.dvi-action-bar', '.dvi_action_bar',
      '.dvi-toolbar', '.dvi_toolbar',
      '.dvi-header .actions', '.dvi-header .pull-right',
      '.dvi-footer .actions', '.dvi-footer .pull-right',
      '.inspection-actions', '.inspection_actions',
      '.inspection-toolbar', '.inspection_toolbar',
      '.inspection-header .actions', '.inspection-header .pull-right',
      '.ticket-actions', '.ticket_actions',
      '.ticket-toolbar', '.ticket_toolbar',
      '.ticket-header .actions', '.ticket-header .pull-right',
      '.invoice-actions', '.invoice_actions',
      '.invoice-toolbar', '.invoice_toolbar',
      '.action-buttons', '.action-bar', '.action-bar .actions',
      '.report-actions', '.report-toolbar',
      '.print-actions', '.print-toolbar',
      '.page-header .actions', '.page-header .pull-right',
      '.page-header .btn-group', '.page-header__actions',
      '.content-header .actions', '.content-header .pull-right',
      '.toolbar .actions', '.toolbar',
      "[class*='dvi-toolbar']", "[class*='dvi_toolbar']",
      "[class*='dviToolbar']",
      "[class*='inspection-toolbar']", "[class*='inspectionToolbar']",
      "[class*='ticket-toolbar']", "[class*='ticketToolbar']",
      "[class*='ActionBar']", "[class*='actionBar']",
      "[class*='HeaderActions']", "[class*='headerActions']",
      "[data-testid='dvi-actions']",
      "[data-testid='inspection-actions']",
      "[data-testid='ticket-actions']",
    ];
    for (const sel of toolbarSelectors) {
      const el = document.querySelector(sel);
      if (el) { target = el; placement = 'append'; break; }
    }
  }

  // Strategy 3: standalone DVI viewer — look for a print-related anchor
  // whose text contains "Print" (covers "Print", "Print PDF", etc).
  if (!target) {
    const printish = candidates.find(el => {
      if (el.id === 'mos-print-btn-af') return false;
      const t = (el.textContent || '').trim();
      return /^\s*Print\b/i.test(t) && t.length < 40;
    });
    if (printish && printish.parentElement) {
      target = printish;
      placement = 'after';
    }
  }

  // Strategy 4: floating fallback. If no in-page anchor matched, pin the
  // button to the bottom-right of the viewport so the print action is
  // always reachable on customized DVI / ticket layouts. We log once per
  // path so we can grow the anchor list from real telemetry later.
  if (!target) {
    const nowKey = window.location.pathname;
    if (window.__mosPrintNoAnchorLogged !== nowKey) {
      window.__mosPrintNoAnchorLogged = nowKey;
      console.log(
        '[MOS Telemetry]',
        'print_button_no_anchor',
        { path: nowKey, host: window.location.host, fallback: 'floating' }
      );
    }
    const btn = createPrintButton();
    btn.dataset.mosFloating = '1';
    Object.assign(btn.style, {
      position: 'fixed',
      right: '20px',
      bottom: '80px',
      marginLeft: '0',
      zIndex: '999998',
      padding: '6px',
      background: '#ffffff',
      border: '1px solid rgba(0,0,0,0.12)',
      boxShadow: '0 4px 12px rgba(0,0,0,0.18)',
    });
    document.body.appendChild(btn);
    printButtonInjected = true;
    lastInjectedUrl = window.location.href;
    console.log(
      '[MOS Telemetry]',
      'print_button_injected',
      { strategy: 'floating', path: window.location.pathname }
    );
    return;
  }

  const btn = createPrintButton();
  if (placement === 'after') {
    target.parentElement.insertBefore(btn, target.nextSibling);
  } else {
    target.appendChild(btn);
  }
  printButtonInjected = true;
  lastInjectedUrl = window.location.href;
  console.log('[MOS Tools] AutoFlow print button injected (strategy target=' +
    (target.tagName || '?') + ', text="' + ((target.textContent || '').trim().slice(0, 40)) + '")');
}

function checkAndInjectButton() {
  // Re-inject on URL change (AutoFlow uses traditional navigation but
  // also some inline page swaps).
  if (lastInjectedUrl && lastInjectedUrl !== window.location.href) {
    printButtonInjected = false;
    lastInjectedUrl = null;
  }
  // Drop the cached flag if the button got nuked from the DOM by a
  // page re-render.
  if (printButtonInjected && !document.getElementById('mos-print-btn-af')) {
    printButtonInjected = false;
  }
  // Task #1086: per-user visibility. Unknown → fail open (inject) while a
  // lazy features fetch resolves it; explicit false → remove/skip.
  if (cachedAfButtonVis === null && !cachedAfFeatures) fetchAutoflowFeatures(() => {});
  if (!isAfButtonVisible('oil_sticker')) {
    const ex = document.getElementById('mos-print-btn-af');
    if (ex) ex.remove();
    printButtonInjected = false;
    return;
  }
  injectPrintButton();
}

// ==================== CREATE RO BUTTON (AutoFlow + Protractor) ====================
let createRoButtonInjected = false;

function isAutoflowDashboardView() {
  // Heuristics for "we're looking at a list/dashboard, not a single ticket
  // detail/inspection". We only want to surface Create RO when the user is
  // browsing dashboards — the per-ticket view has its own RO already.
  const url = window.location.href;
  if (/\/tickets?\/\d+/.test(url)) return false;
  if (/\/invoices?\/\d+/.test(url)) return false;
  if (/\/inspections?\/\d+/.test(url)) return false;
  // Legacy PHP AutoFlow DVI/inspection pages (e.g. /Admin/dvi_v3/index.php)
  // are per-ticket views — never inject Create RO there.
  if (/\/dvi[_v0-9]*\//.test(url)) return false;
  // Legacy PHP AutoFlow workflow board (e.g. /Admin/v5.php). These shops run
  // the old AutoFlow front-end and browse versioned .php board pages instead
  // of the modern /workflow|/board routes. The DVI exclusion above already
  // keeps dvi_v3 etc. out, so this only matches the board itself.
  if (/\/Admin\/v\d+\.php/i.test(url)) return true;
  // Common AutoFlow dashboard / list paths.
  return /\/(dashboard|tickets?|workflow|board|home|inspections?)\/?(\?|$|#)/i.test(url) ||
    url.endsWith(window.location.host + "/") ||
    /\/dashboard$/i.test(window.location.pathname) ||
    window.location.pathname === "/" ||
    window.location.pathname === "";
}

function createCreateRoButton() {
  const button = document.createElement("button");
  button.id = "mos-create-ro-btn-af";
  button.title = "Create RO in Protractor (via MOS Tools)";
  button.type = "button";
  button.innerHTML =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:6px;vertical-align:middle;"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>' +
    '<span>Create RO</span>';
  Object.assign(button.style, {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "6px 12px",
    background: "#2563eb",
    color: "#fff",
    border: "none",
    borderRadius: "6px",
    fontSize: "13px",
    fontWeight: "600",
    cursor: "pointer",
    marginLeft: "8px",
    verticalAlign: "middle",
    boxShadow: "0 1px 2px rgba(0,0,0,0.08)",
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  });
  button.addEventListener("mouseenter", () => {
    button.style.background = "#1d4ed8";
  });
  button.addEventListener("mouseleave", () => {
    button.style.background = "#2563eb";
  });
  button.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const ctx = detectContext();
    console.log(
      "[MOS Telemetry]",
      "create_ro_panel_opened_autoflow",
      { shopId: ctx.shopId, writeProvider: cachedWriteProvider, path: window.location.pathname }
    );
    chrome.runtime.sendMessage(
      { action: "OPEN_CREATE_RO_PANEL", context: ctx },
      () => {
        if (chrome.runtime.lastError) {
          showToast(
            "Could not open Create RO: " + chrome.runtime.lastError.message,
            "error"
          );
        }
      }
    );
  });
  return button;
}

// ---------- Floating Create RO: dismiss + drag-to-corner persistence ----------
// Per-host preferences live in localStorage so they're scoped to the
// AutoFlow tenant. Two keys:
//   mos.createRoFloating.dismissed = "1" when user closed the bubble
//   mos.createRoFloating.corner    = "br" | "bl" | "tr" | "tl"
const FLOATING_CORNERS = ["br", "bl", "tr", "tl"];
const FLOATING_DISMISS_KEY = "mos.createRoFloating.dismissed";
const FLOATING_CORNER_KEY = "mos.createRoFloating.corner";

function isFloatingDismissed() {
  try { return localStorage.getItem(FLOATING_DISMISS_KEY) === "1"; }
  catch (e) { return false; }
}
function setFloatingDismissed(v) {
  try {
    if (v) localStorage.setItem(FLOATING_DISMISS_KEY, "1");
    else localStorage.removeItem(FLOATING_DISMISS_KEY);
  } catch (e) {}
}
function getFloatingCorner() {
  try {
    const v = localStorage.getItem(FLOATING_CORNER_KEY);
    return FLOATING_CORNERS.includes(v) ? v : "br";
  } catch (e) { return "br"; }
}
function setFloatingCorner(c) {
  if (!FLOATING_CORNERS.includes(c)) return;
  try { localStorage.setItem(FLOATING_CORNER_KEY, c); } catch (e) {}
}
function applyCornerStyles(wrap, corner) {
  // Reset
  wrap.style.top = "auto";
  wrap.style.bottom = "auto";
  wrap.style.left = "auto";
  wrap.style.right = "auto";
  const offset = "20px";
  if (corner === "br") { wrap.style.bottom = offset; wrap.style.right = offset; }
  else if (corner === "bl") { wrap.style.bottom = offset; wrap.style.left = offset; }
  else if (corner === "tr") { wrap.style.top = offset; wrap.style.right = offset; }
  else if (corner === "tl") { wrap.style.top = offset; wrap.style.left = offset; }
}
function nearestCorner(x, y) {
  const w = window.innerWidth, h = window.innerHeight;
  const left = x < w / 2;
  const top = y < h / 2;
  return (top ? "t" : "b") + (left ? "l" : "r");
}

function createFloatingCreateRoWrap() {
  const wrap = document.createElement("div");
  wrap.id = "mos-create-ro-wrap-af";
  wrap.dataset.mosFloating = "1";
  Object.assign(wrap.style, {
    position: "fixed",
    zIndex: "999998",
    display: "inline-flex",
    alignItems: "center",
    boxShadow: "0 4px 12px rgba(0,0,0,0.18)",
    borderRadius: "6px",
    background: "#2563eb",
    userSelect: "none",
  });
  applyCornerStyles(wrap, getFloatingCorner());

  // Drag handle (also acts as visual grip)
  const handle = document.createElement("div");
  handle.title = "Drag to move";
  handle.setAttribute("aria-label", "Drag handle");
  Object.assign(handle.style, {
    cursor: "grab",
    padding: "0 6px 0 8px",
    color: "rgba(255,255,255,0.85)",
    fontSize: "14px",
    lineHeight: "1",
    display: "inline-flex",
    alignItems: "center",
    height: "100%",
  });
  handle.innerHTML =
    '<svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor" aria-hidden="true">' +
    '<circle cx="2" cy="3" r="1.3"/><circle cx="2" cy="8" r="1.3"/><circle cx="2" cy="13" r="1.3"/>' +
    '<circle cx="8" cy="3" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="8" cy="13" r="1.3"/>' +
    "</svg>";

  const btn = createCreateRoButton();
  // Strip the inline button styling we don't want when wrapped.
  btn.style.marginLeft = "0";
  btn.style.boxShadow = "none";
  btn.style.borderRadius = "0";
  btn.style.padding = "10px 12px";
  btn.style.fontSize = "14px";

  // Dismiss (X) button
  const close = document.createElement("button");
  close.type = "button";
  close.id = "mos-create-ro-dismiss-af";
  close.title = "Hide Create RO button on this site";
  close.setAttribute("aria-label", "Dismiss Create RO button");
  Object.assign(close.style, {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "24px",
    height: "24px",
    margin: "0 6px 0 2px",
    padding: "0",
    background: "transparent",
    color: "#fff",
    border: "none",
    borderRadius: "4px",
    cursor: "pointer",
    fontSize: "16px",
    lineHeight: "1",
    opacity: "0.85",
  });
  close.textContent = "\u2715";
  close.addEventListener("mouseenter", () => { close.style.opacity = "1"; close.style.background = "rgba(0,0,0,0.15)"; });
  close.addEventListener("mouseleave", () => { close.style.opacity = "0.85"; close.style.background = "transparent"; });
  close.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    setFloatingDismissed(true);
    wrap.remove();
    createRoButtonInjected = false;
    console.log(
      "[MOS Telemetry]",
      "create_ro_button_dismissed",
      { host: window.location.host, path: window.location.pathname }
    );
  });

  wrap.appendChild(handle);
  wrap.appendChild(btn);
  wrap.appendChild(close);

  // ----- Drag-to-snap behavior on the handle -----
  let dragState = null;
  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    dragState = {
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      pointerId: e.pointerId,
    };
    handle.setPointerCapture(e.pointerId);
    handle.style.cursor = "grabbing";
    e.preventDefault();
  };
  const onPointerMove = (e) => {
    if (!dragState) return;
    const dx = e.clientX - dragState.startX;
    const dy = e.clientY - dragState.startY;
    if (!dragState.moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
      dragState.moved = true;
      // Switch to free-floating coords for live preview.
      const rect = wrap.getBoundingClientRect();
      wrap.style.top = rect.top + "px";
      wrap.style.left = rect.left + "px";
      wrap.style.right = "auto";
      wrap.style.bottom = "auto";
      wrap.style.transition = "none";
      wrap.style.opacity = "0.85";
    }
    if (dragState.moved) {
      const rect = wrap.getBoundingClientRect();
      const newLeft = Math.max(0, Math.min(window.innerWidth - rect.width, e.clientX - rect.width / 2));
      const newTop = Math.max(0, Math.min(window.innerHeight - rect.height, e.clientY - rect.height / 2));
      wrap.style.left = newLeft + "px";
      wrap.style.top = newTop + "px";
    }
  };
  const onPointerUp = (e) => {
    if (!dragState) return;
    const moved = dragState.moved;
    try { handle.releasePointerCapture(dragState.pointerId); } catch (_) {}
    handle.style.cursor = "grab";
    if (moved) {
      const rect = wrap.getBoundingClientRect();
      const corner = nearestCorner(rect.left + rect.width / 2, rect.top + rect.height / 2);
      setFloatingCorner(corner);
      wrap.style.opacity = "1";
      applyCornerStyles(wrap, corner);
      console.log(
        "[MOS Telemetry]",
        "create_ro_button_moved",
        { corner, host: window.location.host }
      );
    }
    dragState = null;
  };
  handle.addEventListener("pointerdown", onPointerDown);
  handle.addEventListener("pointermove", onPointerMove);
  handle.addEventListener("pointerup", onPointerUp);
  handle.addEventListener("pointercancel", onPointerUp);

  return wrap;
}

function injectCreateRoButton() {
  if (cachedWriteProvider !== "protractor") return; // gate
  if (cachedCanWrite === false) return; // read-only user
  if (!isAutoflowDashboardView()) return;
  if (document.getElementById("mos-create-ro-btn-af")) {
    createRoButtonInjected = true;
    return;
  }

  // Strategy 1: a top-level page header / nav action area. This list has
  // grown organically as we've onboarded tenants whose dashboards don't
  // match the original two heuristics; keep additions narrowly-scoped to
  // headers/toolbars so we don't latch onto random divs.
  const headerCandidates = [
    "header .actions",
    "header .header-actions",
    ".page-header .actions",
    ".page-header .btn-group",
    ".page-header .pull-right",
    ".page-header__actions",
    ".navbar .navbar-right",
    ".navbar .navbar-nav.ml-auto",
    ".navbar-nav.ml-auto",
    ".navbar .nav.navbar-nav.navbar-right",
    ".dashboard-header .actions",
    ".dashboard-header .pull-right",
    ".dashboard-toolbar",
    ".dashboard-toolbar .actions",
    ".main-header .actions",
    ".main-header .pull-right",
    ".content-header .pull-right",
    ".content-header .actions",
    ".toolbar .actions",
    ".btn-toolbar",
    ".workflow-header .actions",
    ".workflow-toolbar",
    ".board-header .actions",
    ".board-toolbar",
    ".tickets-header .actions",
    ".tickets-toolbar",
    ".action-bar",
    ".action-bar .actions",
    "[class*='HeaderActions']",
    "[class*='headerActions']",
    "[class*='PageHeader'] [class*='actions']",
    "[data-testid='page-header-actions']",
    "[data-testid='dashboard-actions']",
  ];
  let target = null;
  let placement = "append";
  for (const sel of headerCandidates) {
    const el = document.querySelector(sel);
    if (el) {
      target = el;
      placement = "append";
      break;
    }
  }

  // Strategy 2: drop in next to a recognizable dashboard action button.
  if (!target) {
    const KNOWN_LABELS = [
      "New Ticket",
      "Create Ticket",
      "Add Ticket",
      "New Inspection",
      "New Invoice",
      "New RO",
      "Create RO",
      "Add RO",
      "New Estimate",
      "Create Estimate",
      "New Work Order",
      "Add",
      "+ Ticket",
      "+ Invoice",
      "+ Inspection",
    ];
    const candidates = Array.from(document.querySelectorAll("a, button"));
    for (const label of KNOWN_LABELS) {
      const hit = candidates.find((el) => {
        const t = (el.textContent || "").trim();
        if (el.id === "mos-create-ro-btn-af") return false;
        return t === label || t.startsWith(label + " ");
      });
      if (hit && hit.parentElement) {
        target = hit;
        placement = "after";
        break;
      }
    }
  }

  // Strategy 3: floating fallback. If no in-page anchor matched, pin the
  // button to a viewport corner so it's always reachable on customized
  // dashboards. Users can dismiss (X) or drag it to a different corner;
  // both choices persist per host. We log once per path so we still get
  // the telemetry signal to add a proper anchor later.
  if (!target) {
    if (isFloatingDismissed()) return;
    const nowKey = window.location.pathname;
    if (window.__mosCreateRoNoAnchorLogged !== nowKey) {
      window.__mosCreateRoNoAnchorLogged = nowKey;
      console.log(
        "[MOS Telemetry]",
        "create_ro_button_no_anchor",
        { path: nowKey, host: window.location.host, fallback: "floating" }
      );
    }
    const wrap = createFloatingCreateRoWrap();
    document.body.appendChild(wrap);
    createRoButtonInjected = true;
    console.log(
      "[MOS Telemetry]",
      "create_ro_button_injected",
      { strategy: "floating", corner: getFloatingCorner(), path: window.location.pathname }
    );
    return;
  }

  const btn = createCreateRoButton();
  if (placement === "after") {
    target.parentElement.insertBefore(btn, target.nextSibling);
  } else {
    target.appendChild(btn);
  }
  createRoButtonInjected = true;
  console.log(
    "[MOS Telemetry]",
    "create_ro_button_injected",
    { strategy: placement, tag: target.tagName || "?", path: window.location.pathname }
  );
}

function removeStaleCreateRoButton() {
  const wrap = document.getElementById("mos-create-ro-wrap-af");
  if (wrap) wrap.remove();
  const stale = document.getElementById("mos-create-ro-btn-af");
  if (stale) stale.remove();
}

function checkAndInjectCreateRoButton() {
  // If the button was nuked by a re-render, drop the cached flag.
  if (createRoButtonInjected && !document.getElementById("mos-create-ro-btn-af")) {
    createRoButtonInjected = false;
  }
  // If we don't yet know the write provider, kick off a (debounced) lookup.
  if (cachedWriteProvider === null) {
    refreshWriteProvider();
    return;
  }
  // Task #1086: user hid the Create RO button for AutoFlow pages.
  if (!isAfButtonVisible("create_ro")) {
    removeStaleCreateRoButton();
    createRoButtonInjected = false;
    return;
  }
  if (cachedWriteProvider !== "protractor" || cachedCanWrite === false) {
    // Not a Protractor-paired shop, or user lacks write permission —
    // clean up any stale button.
    removeStaleCreateRoButton();
    createRoButtonInjected = false;
    return;
  }
  // If we're not on a dashboard view, don't inject (and tear down any stale).
  if (!isAutoflowDashboardView()) {
    removeStaleCreateRoButton();
    createRoButtonInjected = false;
    return;
  }
  injectCreateRoButton();
}

function printStickerFromContentScript(sticker) {
  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:none;';
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument || iframe.contentWindow.document;
  doc.open();
  doc.write(`
    <!DOCTYPE html>
    <html><head><title>Print Sticker</title><style>
      @page { margin: 0; size: auto; }
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: 100%; height: 100%; }
      img {
        width: ${sticker.widthInches || '2in'};
        height: ${sticker.heightInches || '2.5in'};
        display: block;
      }
    </style></head>
    <body><img id="sticker" src="${sticker.dataUrl}" /></body></html>
  `);
  doc.close();
  const img = doc.getElementById('sticker');
  const doPrint = () => {
    setTimeout(() => {
      iframe.contentWindow.print();
      setTimeout(() => iframe.remove(), 1000);
    }, 100);
  };
  if (img.complete) doPrint();
  else {
    img.onload = doPrint;
    img.onerror = () => {
      showToast('Failed to load sticker image', 'error');
      iframe.remove();
    };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GET_SMS_CONTEXT") {
    const context = detectContext();
    sendResponse(context);
    return true;
  }
  if (message.action === 'PRINT_STICKER_FROM_PANEL') {
    if (message.sticker) {
      printStickerFromContentScript(message.sticker);
      sendResponse({ success: true });
    } else {
      sendResponse({ success: false, error: 'No sticker data' });
    }
    return false;
  }
  if (message.action === 'SHOW_TOAST') {
    showToast(message.message, message.type || 'info');
    sendResponse({ success: true });
    return false;
  }
  if (message.action === 'JOB_CREATED') {
    // A Protractor canned job was added from the side panel. AutoFlow (the
    // front-end for these Protractor shops) doesn't re-render the new job until
    // a manual refresh, so show a toast and reload — mirrors the Tekmetric
    // content script's JOB_CREATED handler and the DVI write-back reload.
    console.log('[MOS Tools] Job created (Protractor):', message.jobName);
    showToast(`Job added: ${message.jobName}`, 'success');
    reloadAfterApply();
    sendResponse({ success: true });
    return false;
  }
  if (message.action === 'MOS_SNIFFER_STATE_UPDATE') {
    if (message.active) {
      if (!document.getElementById('mos-page-sniffer')) {
      const script = document.createElement('script');
      script.id = 'mos-page-sniffer';
      script.textContent = `(${function() {
        var snifferActive = true;
        window.addEventListener('message', function(e) {
          if (e.data && e.data.type === 'MOS_SNIFFER_STATE') snifferActive = !!e.data.active;
        });
        var origFetch = window.fetch;
        window.fetch = function() {
          var url = typeof arguments[0] === 'string' ? arguments[0] : (arguments[0] && arguments[0].url) || '';
          var opts = arguments[1] || {};
          var method = opts.method || 'GET';
          if (snifferActive) {
            var reqBody = null;
            try { if (opts.body) reqBody = (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)).substring(0, 50000); } catch(e) {}
            var capturedUrl = url, capturedMethod = method;
            return origFetch.apply(this, arguments).then(function(response) {
              var cloned = response.clone();
              cloned.text().then(function(text) {
                window.postMessage({ type: 'MOS_SNIFFER_CAPTURE', data: { method: capturedMethod, url: capturedUrl, requestBody: reqBody, responseStatus: response.status, responseBody: text.substring(0, 50000), source: 'page_fetch' } }, '*');
              }).catch(function(){});
              return response;
            });
          }
          return origFetch.apply(this, arguments);
        };
        var origOpen = XMLHttpRequest.prototype.open;
        var origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function(m, u) { this._mosUrl = u; this._mosMethod = m; return origOpen.apply(this, arguments); };
        XMLHttpRequest.prototype.send = function(body) {
          if (snifferActive && this._mosMethod) {
            var xhrRef = this, reqBody = null, xhrMethod = this._mosMethod, xhrUrl = this._mosUrl;
              try { if (body) reqBody = (typeof body === 'string' ? body : JSON.stringify(body)).substring(0, 10000); } catch(e) {}
              this.addEventListener('load', function() {
                try { window.postMessage({ type: 'MOS_SNIFFER_CAPTURE', data: { method: xhrMethod, url: xhrUrl, requestBody: reqBody, responseStatus: xhrRef.status, responseBody: (xhrRef.responseText || '').substring(0, 10000), source: 'page_xhr' } }, '*'); } catch(e) {}
              });
            }
            return origSend.apply(this, arguments);
          };
        }})();`;
        (document.head || document.documentElement).appendChild(script);
      }
    }
    window.postMessage({ type: 'MOS_SNIFFER_STATE', active: message.active }, '*');
  }
});

(function initSnifferRelay() {
  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'MOS_SNIFFER_CAPTURE') {
      chrome.runtime.sendMessage({
        action: 'SNIFFER_CAPTURE_FROM_PAGE',
        data: e.data.data
      }).catch(() => {});
    }
  });

  chrome.runtime.sendMessage({ action: 'SNIFFER_STATUS' }, (res) => {
    if (res?.active) {
      if (document.getElementById('mos-page-sniffer')) return;
      const script = document.createElement('script');
      script.id = 'mos-page-sniffer';
      script.textContent = `(${function() {
        var snifferActive = true;
        window.addEventListener('message', function(e) {
          if (e.data && e.data.type === 'MOS_SNIFFER_STATE') snifferActive = !!e.data.active;
        });
        var origFetch = window.fetch;
        window.fetch = function() {
          var url = typeof arguments[0] === 'string' ? arguments[0] : (arguments[0] && arguments[0].url) || '';
          var opts = arguments[1] || {};
          var method = opts.method || 'GET';
          if (snifferActive) {
            var reqBody = null;
            try { if (opts.body) reqBody = (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)).substring(0, 50000); } catch(e) {}
            var capturedUrl = url, capturedMethod = method;
            return origFetch.apply(this, arguments).then(function(response) {
              var cloned = response.clone();
              cloned.text().then(function(text) {
                window.postMessage({ type: 'MOS_SNIFFER_CAPTURE', data: { method: capturedMethod, url: capturedUrl, requestBody: reqBody, responseStatus: response.status, responseBody: text.substring(0, 50000), source: 'page_fetch' } }, '*');
              }).catch(function(){});
              return response;
            });
          }
          return origFetch.apply(this, arguments);
        };
        var origOpen = XMLHttpRequest.prototype.open;
        var origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function(m, u) { this._mosUrl = u; this._mosMethod = m; return origOpen.apply(this, arguments); };
        XMLHttpRequest.prototype.send = function(body) {
          if (snifferActive && this._mosMethod) {
            var xhrRef = this, reqBody = null, xhrMethod = this._mosMethod, xhrUrl = this._mosUrl;
            try { if (body) reqBody = (typeof body === 'string' ? body : JSON.stringify(body)).substring(0, 50000); } catch(e) {}
            this.addEventListener('load', function() {
              try { window.postMessage({ type: 'MOS_SNIFFER_CAPTURE', data: { method: xhrMethod, url: xhrUrl, requestBody: reqBody, responseStatus: xhrRef.status, responseBody: (xhrRef.responseText || '').substring(0, 50000), source: 'page_xhr' } }, '*'); } catch(e) {}
            });
          }
          return origSend.apply(this, arguments);
        };
      }})();`;
      (document.head || document.documentElement).appendChild(script);
    }
  });
})();

// ==================== VHI WRITE-BACK ACTIONS (Task #586) ====================
// Three actions mirrored from the Tekmetric adapter, adapted for AutoFlow's
// jQuery/PHP DVI:
//   1. Pre-fill DVI      — set item statuses + notes from VHI maintenance data
//   2. Enhance Notes     — AI-rewrite technician notes (review modal)
//   3. Add Recommendations ("add all to concerns") — create RVH entries
// All three are gated behind per-shop feature flags (default OFF):
//   dvi_prefill  -> pre-fill + recommendations
//   enhance_notes -> enhance
// MOS analysis is fetched by the background worker; the actual writes are
// performed in the page via the MAIN-world bridge (adapters/autoflow-dvi-bridge.js)
// so they carry the AutoFlow session cookie and the page's own payload format.

// ---------- MAIN-world bridge plumbing ----------
let afBridgeReqId = 0;
const afBridgePending = new Map();

window.addEventListener('message', (e) => {
  if (e.source !== window) return;
  const m = e.data;
  if (!m || typeof m !== 'object') return;
  if (m.type === 'MOS_AF_DVI_DATA' || m.type === 'MOS_AF_WRITE_RESULT') {
    const resolver = afBridgePending.get(m.requestId);
    if (resolver) { afBridgePending.delete(m.requestId); resolver(m.payload); }
  }
});

function afBridgeSend(type, extra, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const requestId = 'af_' + (++afBridgeReqId) + '_' + Date.now();
    let done = false;
    const finish = (p) => { if (done) return; done = true; resolve(p); };
    afBridgePending.set(requestId, finish);
    setTimeout(() => {
      if (!done) { afBridgePending.delete(requestId); finish({ ok: false, error: 'bridge_timeout' }); }
    }, timeoutMs);
    window.postMessage(Object.assign({ type, requestId }, extra || {}), '*');
  });
}

const readAutoflowDvi = () => afBridgeSend('MOS_AF_READ_DVI');
const writeAutoflowSheet = (params) => afBridgeSend('MOS_AF_WRITE_SHEET', { params });
const writeAutoflowRvh = (params) => afBridgeSend('MOS_AF_WRITE_RVH', { params });

// MOS status string -> AutoFlow inspec_status (0=red/overdue, 1=yellow/due-soon, 2=green/ok).
function mosStatusToAf(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'overdue') return '0';
  if (s === 'due-soon' || s === 'duesoon' || s === 'due_soon') return '1';
  if (s === 'ok' || s === 'good' || s === 'pass') return '2';
  return '1';
}

function escapeAfHtml(str) {
  const d = document.createElement('div');
  d.textContent = (str == null ? '' : String(str));
  return d.innerHTML;
}

// ---------- Feature flags ----------
let cachedAfFeatures = null;
let afFeaturesFetchInFlight = false;
// Task #1086: per-user injected-button visibility (resolved server-side
// against shop entitlements). null = unknown → fail open (visible).
let cachedAfButtonVis = null;

function isAfButtonVisible(key) {
  return !cachedAfButtonVis || cachedAfButtonVis[key] !== false;
}

function fetchAutoflowFeatures(cb) {
  if (cachedAfFeatures) { cb(cachedAfFeatures); return; }
  if (afFeaturesFetchInFlight) return;
  const ctx = lastContext || detectContext();
  if (!ctx.shopId) { cb({}); return; }
  afFeaturesFetchInFlight = true;
  chrome.runtime.sendMessage(
    { action: 'GET_SHOP_FEATURES', shopId: ctx.shopId, provider: 'autoflow' },
    (resp) => {
      afFeaturesFetchInFlight = false;
      if (chrome.runtime.lastError) { cb({}); return; }
      cachedAfFeatures = (resp && resp.success) ? (resp.features || {}) : {};
      if (resp && resp.success) {
        cachedAfButtonVis = (resp.buttonVisibility && resp.buttonVisibility.autoflow) || null;
      }
      cb(cachedAfFeatures);
    }
  );
}

// ---------- Button injection ----------
let vhiButtonsInjected = false;
let lastVhiInjectedUrl = null;

function isAutoflowDviView() {
  const url = window.location.href;
  return /\/dvi[_v0-9]*\//i.test(url) || /[?&]status_id=\d+/.test(url);
}

function makeVhiIconButton(id, iconPath, title, handler) {
  const btn = document.createElement('button');
  btn.id = id;
  btn.type = 'button';
  btn.title = title;
  const url = chrome.runtime.getURL(iconPath);
  btn.innerHTML = `<img src="${url}" width="28" height="28" style="object-fit:contain;display:block;" alt="" />`;
  Object.assign(btn.style, {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: '34px', height: '34px', padding: '2px', background: 'transparent',
    border: 'none', borderRadius: '6px', cursor: 'pointer', marginLeft: '6px',
    verticalAlign: 'middle', transition: 'opacity 0.2s',
  });
  btn.addEventListener('mouseenter', () => { if (!btn.disabled) btn.style.opacity = '0.7'; });
  btn.addEventListener('mouseleave', () => { btn.style.opacity = '1'; });
  btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); handler(btn); });
  return btn;
}

function setVhiBtnBusy(btn, busy) {
  if (!btn) return;
  btn.disabled = busy;
  btn.style.opacity = busy ? '0.5' : '1';
  btn.style.cursor = busy ? 'wait' : 'pointer';
}

// ---- Enhance Notes slow-write notice (task #789) ----
// The AI analyze step can legitimately take 45s+ on big shops. Toasts
// auto-dismiss after ~4s, so repeat a reassuring "still working…" toast
// (first after 18s, then every 25s) until the background responds — otherwise
// users click again or navigate away mid-request.
let afEnhanceSlowNoticeTimer = null;
let afEnhanceSlowNoticeInterval = null;

function startAfEnhanceSlowNotice(message) {
  stopAfEnhanceSlowNotice();
  const text = message || 'Still working — big shops can take a minute…';
  afEnhanceSlowNoticeTimer = setTimeout(() => {
    afEnhanceSlowNoticeTimer = null;
    showToast(text, 'info');
    afEnhanceSlowNoticeInterval = setInterval(() => showToast(text, 'info'), 25000);
  }, 18000);
}

function stopAfEnhanceSlowNotice() {
  if (afEnhanceSlowNoticeTimer) { clearTimeout(afEnhanceSlowNoticeTimer); afEnhanceSlowNoticeTimer = null; }
  if (afEnhanceSlowNoticeInterval) { clearInterval(afEnhanceSlowNoticeInterval); afEnhanceSlowNoticeInterval = null; }
}

// Anchor next to the AutoFlow DVI action bar (Push DVI / PDF / etc).
// Extracted (Task #1086) so the undo chip can anchor even when every VHI
// button is hidden by the user's visibility preferences.
function findAfDviAnchor() {
  const KNOWN = [
    'Push DVI', 'Re-Push', 'Re Push', 'RePush', 'PDF',
    'Report Complete', 'Text & Email', 'Text and Email', 'Sheets', 'QC',
  ];
  const candidates = Array.from(document.querySelectorAll('a, button'));
  for (const label of KNOWN) {
    const hit = candidates.find((el) => {
      if (el.closest('#mos-vhi-actions-af') || el.closest('#mos-af-undo-chip')) return false;
      const t = (el.textContent || '').trim();
      return t === label || t.startsWith(label + ' ');
    });
    if (hit && hit.parentElement) return hit;
  }
  return null;
}

function injectVhiButtons() {
  if (!isAutoflowDviView()) return;
  const ctx = detectContext();
  if (!ctx.roId) return;
  if (document.getElementById('mos-vhi-actions-af')) { vhiButtonsInjected = true; return; }

  fetchAutoflowFeatures((features) => {
    // Task #1086: intersect entitlements with per-user visibility prefs.
    const wantPrefill = !!features.dvi_prefill && isAfButtonVisible('dvi_prefill');
    const wantEnhance = !!features.enhance_notes && isAfButtonVisible('enhance_notes');
    const wantConcerns = !!features.dvi_prefill && isAfButtonVisible('add_vhi_recommendations');
    if (!wantPrefill && !wantEnhance && !wantConcerns) return;
    if (document.getElementById('mos-vhi-actions-af')) return;

    const target = findAfDviAnchor();
    if (!target) return; // keep VHI actions tied to the DVI bar; retry next tick

    const wrap = document.createElement('span');
    wrap.id = 'mos-vhi-actions-af';
    Object.assign(wrap.style, { display: 'inline-flex', alignItems: 'center', verticalAlign: 'middle' });

    if (wantPrefill) wrap.appendChild(makeVhiIconButton('mos-af-prefill-btn', 'icons/VHI_icon.png', 'Pre-fill DVI with VHI data', handleAfPrefill));
    if (wantEnhance) wrap.appendChild(makeVhiIconButton('mos-af-enhance-btn', 'icons/enhance_notes_icon.png', 'Enhance technician notes with AI', handleAfEnhance));
    if (wantConcerns) wrap.appendChild(makeVhiIconButton('mos-af-concerns-btn', 'icons/aiVHI_icon.png', 'Add VHI recommendations to RO', handleAfConcerns));

    target.parentElement.insertBefore(wrap, target.nextSibling);
    vhiButtonsInjected = true;
    lastVhiInjectedUrl = window.location.href;
    console.log('[MOS Tools] AutoFlow VHI buttons injected (anchor="' + ((target.textContent || '').trim().slice(0, 24)) + '")');
  });
}

function checkAndInjectVhiButtons() {
  if (lastVhiInjectedUrl && lastVhiInjectedUrl !== window.location.href) {
    const ex = document.getElementById('mos-vhi-actions-af');
    if (ex) ex.remove();
    vhiButtonsInjected = false;
    lastVhiInjectedUrl = null;
    afUndoChipCheckedRoId = null;
  }
  if (!isAutoflowDviView()) {
    const ex = document.getElementById('mos-vhi-actions-af');
    if (ex) ex.remove();
    vhiButtonsInjected = false;
    const chip = document.getElementById('mos-af-undo-chip');
    if (chip) chip.remove();
    afUndoChipCheckedRoId = null;
    return;
  }
  if (vhiButtonsInjected && !document.getElementById('mos-vhi-actions-af')) {
    vhiButtonsInjected = false;
  }
  if (!vhiButtonsInjected) injectVhiButtons();
  checkAndInjectAfUndoChip();
}

// ==================== UNDO CHIP (Task #1086) ====================
// Pre-write snapshots are saved (via the background) before AI writes are
// applied. AutoFlow reloads the page after each apply (reloadAfterApply),
// so this chip is how the revert stays reachable afterwards. Reverts run
// here in the content script through the same MAIN-world bridge write
// paths the apply used.
let afUndoChipCheckedRoId = null;

function checkAndInjectAfUndoChip() {
  if (!isAutoflowDviView()) return;
  if (document.getElementById('mos-af-undo-chip')) return;
  const ctx = lastContext || detectContext();
  if (!ctx.roId) return;
  if (afUndoChipCheckedRoId === ctx.roId) return;
  afUndoChipCheckedRoId = ctx.roId;
  chrome.runtime.sendMessage(
    { action: 'UNDO_SNAPSHOT_LIST', provider: 'autoflow', shopId: ctx.shopId, roId: ctx.roId },
    (resp) => {
      if (chrome.runtime.lastError) return;
      if (!resp || !resp.success || !Array.isArray(resp.snapshots) || resp.snapshots.length === 0) return;
      injectAfUndoChip(resp.snapshots);
    }
  );
}

function injectAfUndoChip(snapshots) {
  if (document.getElementById('mos-af-undo-chip')) return;
  const wrap = document.getElementById('mos-vhi-actions-af');
  let parent = wrap;
  if (!parent) {
    const anchor = findAfDviAnchor();
    if (!anchor) { afUndoChipCheckedRoId = null; return; } // retry next tick
    parent = anchor.parentElement;
  }
  const summaries = snapshots.map((s) => s.summary || s.kind);
  const chip = document.createElement('button');
  chip.id = 'mos-af-undo-chip';
  chip.type = 'button';
  chip.title = 'Undo recent Detect Dog changes:\n' + summaries.map((s) => '• ' + s).join('\n');
  chip.innerHTML = '<span style="font-size:13px;line-height:1;">↩</span><span>Undo</span>';
  Object.assign(chip.style, {
    display: 'inline-flex', alignItems: 'center', gap: '4px',
    padding: '3px 10px', marginLeft: '6px', verticalAlign: 'middle',
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
    showToast('Reverting Detect Dog changes…', 'info');
    let reverted = 0;
    let failed = 0;
    for (const snap of snapshots) {
      const ops = MosUndoCore.buildAutoflowRevertOps(snap);
      let snapFailed = 0;
      for (const op of ops) {
        try {
          const res = op.type === 'rvh_delete'
            ? await writeAutoflowRvh(op.params)
            : await writeAutoflowSheet(op.params);
          if (res && res.ok) reverted++; else { snapFailed++; console.warn('[MOS Tools] Undo op failed:', op.label, res); }
        } catch (err) {
          snapFailed++;
          console.warn('[MOS Tools] Undo op error:', op.label, err);
        }
      }
      failed += snapFailed;
      if (snapFailed === 0) {
        chrome.runtime.sendMessage({ action: 'UNDO_SNAPSHOT_CLEAR', key: snap.key }, () => { void chrome.runtime.lastError; });
      }
    }
    if (failed === 0) {
      showToast(`Reverted ${reverted} change${reverted === 1 ? '' : 's'}. Reloading…`, 'success');
    } else {
      // delete_rvh IS supported by AutoFlow v3 (verified 2026-08-12 against
      // the public jquery.atme.rvh.js: $.fn.deleteRVH sends exactly
      // status_id + rvh_id + request_type:'delete_rvh'). A failure here is a
      // transient/session issue, not a missing feature — leave the snapshot
      // for a retry.
      showToast(`Undo finished with issues: ${reverted} reverted, ${failed} failed. Reloading…`, 'warning');
    }
    chip.remove();
    setTimeout(() => window.location.reload(), 1600);
  });
  parent.appendChild(chip);
  console.log('[MOS Tools] AutoFlow undo chip injected (' + snapshots.length + ' snapshot(s))');
}

function saveAfUndoSnapshot(snapshot) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ action: 'UNDO_SNAPSHOT_SAVE', snapshot }, (resp) => {
        void chrome.runtime.lastError;
        resolve(resp && resp.success);
      });
    } catch (_) { resolve(false); }
  });
}

// ---------- Pending-apply marker (Task #1101) ----------
// AutoFlow applies write item-by-item from THIS content script, so a full page
// reload mid-apply kills the loop: some items were written, the rest never
// sent — and the modal (with its status line) is gone. Persist a small per-tab
// marker in sessionStorage (survives reloads, dies with the tab), updated as
// each item starts, so the next page view can tell the advisor how far the
// apply got instead of leaving them guessing. SPA navigation keeps this script
// alive, so the loop finishes and its own completion toast fires; the marker
// only matters across real reloads.
const AF_PENDING_APPLY_KEY = 'mosAfPendingApply';
const AF_PENDING_APPLY_MAX_AGE_MS = 10 * 60 * 1000;

function afSetPendingApply(label, total) {
  try {
    sessionStorage.setItem(AF_PENDING_APPLY_KEY, JSON.stringify({
      label, total: total || 0, lastStatus: '', startedAt: Date.now(),
    }));
  } catch (_) {}
}

function afNotePendingApplyProgress(statusText) {
  try {
    const raw = sessionStorage.getItem(AF_PENDING_APPLY_KEY);
    if (!raw) return;
    const rec = JSON.parse(raw);
    rec.lastStatus = String(statusText || '');
    sessionStorage.setItem(AF_PENDING_APPLY_KEY, JSON.stringify(rec));
  } catch (_) {}
}

function afClearPendingApply() {
  try { sessionStorage.removeItem(AF_PENDING_APPLY_KEY); } catch (_) {}
}

// Read-and-clear at startup; if an apply was interrupted by a reload, report
// how far it got so the advisor reviews the DVI/RO instead of blind re-applying
// (which would duplicate the already-written items).
function afCheckPendingApplyOnLoad() {
  let rec = null;
  try {
    const raw = sessionStorage.getItem(AF_PENDING_APPLY_KEY);
    if (raw) rec = JSON.parse(raw);
  } catch (_) {}
  if (!rec) return;
  afClearPendingApply();
  const age = Date.now() - (rec.startedAt || 0);
  if (!(age >= 0 && age < AF_PENDING_APPLY_MAX_AGE_MS)) return; // stale/bogus
  const label = rec.label || 'An apply';
  const progress = rec.lastStatus
    ? ` It got to "${rec.lastStatus.replace(/…$/, '')}" of ${rec.total} item${rec.total === 1 ? '' : 's'}.`
    : ` None of the ${rec.total} item${rec.total === 1 ? '' : 's'} may have been written.`;
  showToast(
    `"${label}" was interrupted by a page reload before it finished.${progress} Some items may not have been written — review before re-applying.`,
    'warning'
  );
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', afCheckPendingApplyOnLoad);
} else {
  afCheckPendingApplyOnLoad();
}

// ---------- Shared review modal ----------
// opts: { title, applyLabel, rows:[{label,sub,badge,badgeColor,text,...}], onApply(selected,{setStatus})->Promise, onClose }
function showAfReviewModal(opts) {
  const existing = document.getElementById('mos-af-review-modal');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'mos-af-review-modal';
  Object.assign(overlay.style, {
    position: 'fixed', top: '0', left: '0', width: '100vw', height: '100vh',
    background: 'rgba(0,0,0,0.5)', zIndex: '2147483646',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  });

  const modal = document.createElement('div');
  Object.assign(modal.style, {
    background: '#fff', borderRadius: '12px', width: '680px', maxWidth: '92vw',
    maxHeight: '82vh', display: 'flex', flexDirection: 'column',
    boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
  });

  const header = document.createElement('div');
  Object.assign(header.style, {
    padding: '16px 20px', borderBottom: '1px solid #e5e7eb',
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  });
  header.innerHTML = `<div style="font-size:16px;font-weight:600;color:#111">${escapeAfHtml(opts.title)} <span style="color:#6b7280;font-weight:400;font-size:13px">(${opts.rows.length})</span></div>`;

  const selectAllWrap = document.createElement('label');
  Object.assign(selectAllWrap.style, { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', color: '#6b7280', cursor: 'pointer' });
  const selectAll = document.createElement('input');
  selectAll.type = 'checkbox';
  selectAll.checked = true;
  selectAllWrap.appendChild(selectAll);
  selectAllWrap.appendChild(document.createTextNode('Select all'));
  header.appendChild(selectAllWrap);
  modal.appendChild(header);

  const body = document.createElement('div');
  Object.assign(body.style, { overflowY: 'auto', padding: '12px 20px', flex: '1' });

  const cbs = [];
  opts.rows.forEach((row, idx) => {
    const card = document.createElement('div');
    Object.assign(card.style, { border: '1px solid #e5e7eb', borderRadius: '8px', padding: '12px', marginBottom: '10px', background: '#fafafa' });

    const top = document.createElement('div');
    Object.assign(top.style, { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' });

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    cb.dataset.idx = idx;
    cbs.push(cb);

    const lbl = document.createElement('span');
    Object.assign(lbl.style, { fontWeight: '600', fontSize: '13px', color: '#111' });
    lbl.textContent = row.label || '';

    top.appendChild(cb);
    top.appendChild(lbl);

    if (row.badge) {
      const b = document.createElement('span');
      Object.assign(b.style, { marginLeft: 'auto', fontSize: '11px', fontWeight: '600', padding: '2px 8px', borderRadius: '10px', color: '#fff', background: row.badgeColor || '#6b7280' });
      b.textContent = row.badge;
      top.appendChild(b);
    }
    card.appendChild(top);

    if (row.sub) {
      const s = document.createElement('div');
      Object.assign(s.style, { fontSize: '12px', color: '#6b7280', marginBottom: '6px' });
      s.innerHTML = row.sub;
      card.appendChild(s);
    }

    const ta = document.createElement('textarea');
    ta.value = row.text || '';
    ta.dataset.idx = idx;
    Object.assign(ta.style, {
      width: '100%', minHeight: '46px', padding: '8px', border: '1px solid #d1d5db',
      borderRadius: '6px', fontSize: '13px', color: '#111', resize: 'vertical',
      lineHeight: '1.4', boxSizing: 'border-box',
    });
    card.appendChild(ta);

    body.appendChild(card);
  });

  selectAll.addEventListener('change', () => { cbs.forEach((cb) => { cb.checked = selectAll.checked; }); });
  modal.appendChild(body);

  const footer = document.createElement('div');
  Object.assign(footer.style, { padding: '12px 20px', borderTop: '1px solid #e5e7eb', display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '10px' });

  const statusEl = document.createElement('div');
  Object.assign(statusEl.style, { marginRight: 'auto', fontSize: '12px', color: '#6b7280' });
  footer.appendChild(statusEl);

  const cancel = document.createElement('button');
  cancel.textContent = 'Cancel';
  Object.assign(cancel.style, { padding: '8px 16px', borderRadius: '6px', border: '1px solid #d1d5db', background: '#fff', cursor: 'pointer', fontSize: '13px', fontWeight: '500' });

  const apply = document.createElement('button');
  apply.textContent = opts.applyLabel || 'Apply Selected';
  Object.assign(apply.style, { padding: '8px 16px', borderRadius: '6px', border: 'none', background: '#2563eb', color: '#fff', cursor: 'pointer', fontSize: '13px', fontWeight: '600' });

  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onModalKeydown, true);
    overlay.remove();
    if (typeof opts.onClose === 'function') opts.onClose();
  };
  const onModalKeydown = (e) => {
    if (closed || !overlay.isConnected) {
      document.removeEventListener('keydown', onModalKeydown, true);
      return;
    }
    if (e.key !== 'Escape') return;
    if (cancel.disabled) return; // apply in flight — don't dismiss
    e.preventDefault();
    e.stopPropagation();
    cleanup();
  };
  cancel.addEventListener('click', cleanup);
  document.addEventListener('keydown', onModalKeydown, true);
  overlay.addEventListener('click', (e) => { if (e.target === overlay && !cancel.disabled) cleanup(); });

  apply.addEventListener('click', async () => {
    const selected = [];
    cbs.forEach((cb, idx) => {
      if (cb.checked) {
        const ta = body.querySelector(`textarea[data-idx="${idx}"]`);
        selected.push(Object.assign({}, opts.rows[idx], { text: ta ? ta.value : opts.rows[idx].text }));
      }
    });
    if (selected.length === 0) { showToast('No items selected', 'info'); return; }
    apply.disabled = true;
    cancel.disabled = true;
    apply.style.opacity = '0.6';
    apply.style.cursor = 'wait';
    // Task #1101: survive a mid-apply page reload — every onApply flow calls
    // setStatus per item, so mirroring it into the marker records how far the
    // loop got. Cleared when the apply finishes (success or error).
    afSetPendingApply(opts.title || 'Apply', selected.length);
    try {
      await opts.onApply(selected, { setStatus: (t) => {
        statusEl.textContent = t;
        afNotePendingApplyProgress(t);
      } });
    } catch (err) {
      showToast('Apply error: ' + (err && err.message ? err.message : err), 'error');
    } finally {
      afClearPendingApply();
      cleanup();
    }
  });

  footer.appendChild(cancel);
  footer.appendChild(apply);
  modal.appendChild(footer);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}

// ---------- Action 1: Pre-fill DVI ----------
async function handleAfPrefill(btn) {
  const ctx = detectContext();
  if (!ctx.roId || !ctx.shopId) { showToast('No DVI detected on this page', 'error'); return; }
  if (!ctx.vin) { showToast('No VIN detected — cannot pre-fill DVI', 'error'); return; }

  setVhiBtnBusy(btn, true);
  showToast('Reading DVI items…', 'info');
  const dvi = await readAutoflowDvi();
  if (!dvi || !dvi.ok || !Array.isArray(dvi.items) || dvi.items.length === 0) {
    showToast('Could not read DVI items on this page', 'error');
    setVhiBtnBusy(btn, false);
    return;
  }

  const statusId = dvi.statusId || ctx.roId;
  const sheetId = dvi.sheetId || null;
  const inspectionTasks = dvi.items.map((it) => ({ id: it.inspecId, name: it.name, inspectionGroup: '' }));
  showToast('Matching VHI maintenance data…', 'info');

  chrome.runtime.sendMessage(
    { action: 'AF_ANALYZE_PREFILL', context: Object.assign({}, ctx), inspectionTasks },
    (resp) => {
      if (chrome.runtime.lastError || !resp || !resp.success) {
        showToast((resp && resp.error) || 'Pre-fill analysis failed', 'error');
        setVhiBtnBusy(btn, false);
        return;
      }
      const updates = (resp.updates || []).filter((u) => u && u.taskId != null);
      if (updates.length === 0) {
        showToast('No matching DVI items to pre-fill', 'info');
        setVhiBtnBusy(btn, false);
        return;
      }
      const itemsById = {};
      dvi.items.forEach((it) => { itemsById[String(it.inspecId)] = it; });

      const colorFor = (st) => ({ '0': '#ef4444', '1': '#f59e0b', '2': '#22c55e' }[st] || '#6b7280');
      const labelFor = (st) => ({ '0': 'RED', '1': 'YELLOW', '2': 'GREEN' }[st] || '—');
      const rows = updates.map((u) => {
        const it = itemsById[String(u.taskId)] || {};
        const af = mosStatusToAf(u.status);
        return {
          _u: u, _it: it,
          label: u.taskName || it.name || ('Item ' + u.taskId),
          badge: labelFor(af), badgeColor: colorFor(af),
          sub: `<span style="font-weight:500;color:#9ca3af">Status:</span> ${escapeAfHtml(u.status || '')}`,
          text: u.finding || '',
        };
      });

      showAfReviewModal({
        title: 'Pre-fill DVI',
        applyLabel: 'Apply to DVI',
        rows,
        onClose: () => setVhiBtnBusy(btn, false),
        onApply: async (selected, { setStatus }) => {
          let added = 0, failed = 0;
          const failedNames = [];
          const undoItems = []; // Task #1086: pre-write originals
          for (let i = 0; i < selected.length; i++) {
            const row = selected[i];
            const u = row._u, it = row._it || {};
            const af = mosStatusToAf(u.status);
            setStatus(`Writing ${i + 1}/${selected.length}…`);
            const params = {
              request_type: 'update_sheet',
              status_id: statusId,
              inspec_id: String(u.taskId),
              inspec_status: af,
              notes: row.text || '',
            };
            if (sheetId) params.sheet_id = sheetId;
            if (it.resultsId) params.results_id = it.resultsId;
            if (it.techId) params.prev_tech_id = it.techId;
            const res = await writeAutoflowSheet(params);
            if (res && res.ok) {
              added++;
              undoItems.push({
                inspecId: String(u.taskId), name: row.label,
                prevStatus: it.status, prevNotes: it.notes || '',
                resultsId: it.resultsId || null, techId: it.techId || null,
              });
            } else { failed++; failedNames.push(row.label); }
          }
          if (undoItems.length) {
            await saveAfUndoSnapshot({
              provider: 'autoflow', shopId: ctx.shopId, roId: ctx.roId,
              kind: 'dvi_prefill', statusId, sheetId, items: undoItems,
            });
          }
          if (added) showToast(`DVI pre-filled: ${added} updated${failed ? `, ${failed} failed` : ''} — undo available after reload`, failed ? 'warning' : 'success');
          else showToast(`Pre-fill failed (${failed} item${failed === 1 ? '' : 's'})`, 'error');
          if (failedNames.length) console.warn('[MOS Tools] AF prefill failed items:', failedNames);
          if (added) reloadAfterApply();
        },
      });
    }
  );
}

// ---------- Action 2: Enhance Notes ----------
async function handleAfEnhance(btn) {
  const ctx = detectContext();
  if (!ctx.roId || !ctx.shopId) { showToast('No DVI detected on this page', 'error'); return; }

  setVhiBtnBusy(btn, true);
  showToast('Reading DVI notes…', 'info');
  const dvi = await readAutoflowDvi();
  if (!dvi || !dvi.ok) {
    showToast('Could not read DVI on this page', 'error');
    setVhiBtnBusy(btn, false);
    return;
  }
  const withNotes = (dvi.items || []).filter((it) => (it.notes || '').trim().length > 0);
  if (withNotes.length === 0) {
    showToast('No technician notes to enhance', 'info');
    setVhiBtnBusy(btn, false);
    return;
  }

  const statusId = dvi.statusId || ctx.roId;
  const sheetId = dvi.sheetId || null;
  const findings = withNotes.map((it) => ({ taskId: it.inspecId, taskName: it.name, finding: it.notes }));
  showToast('Enhancing notes with AI…', 'info');
  startAfEnhanceSlowNotice('Still enhancing notes — big shops can take a minute…');

  chrome.runtime.sendMessage(
    { action: 'AF_ANALYZE_ENHANCE', context: Object.assign({}, ctx), findings },
    (resp) => {
      stopAfEnhanceSlowNotice();
      if (chrome.runtime.lastError || !resp || !resp.success) {
        showToast((resp && resp.error) || 'Enhance failed', 'error');
        setVhiBtnBusy(btn, false);
        return;
      }
      const enhanced = (resp.enhanced || []).filter((e) => e && e.enhanced && e.enhanced !== e.original);
      if (enhanced.length === 0) {
        showToast('Notes already look good — no changes needed', 'info');
        setVhiBtnBusy(btn, false);
        return;
      }
      const itemsById = {};
      withNotes.forEach((it) => { itemsById[String(it.inspecId)] = it; });

      const rows = enhanced.map((e) => ({
        _it: itemsById[String(e.taskId)] || {},
        _taskId: String(e.taskId),
        label: e.taskName || ('Item ' + e.taskId),
        sub: `<span style="font-weight:500;color:#9ca3af">ORIGINAL:</span> ${escapeAfHtml(e.original)}`,
        text: e.enhanced,
      }));

      showAfReviewModal({
        title: 'Review Enhanced Notes',
        applyLabel: 'Apply Selected',
        rows,
        onClose: () => setVhiBtnBusy(btn, false),
        onApply: async (selected, { setStatus }) => {
          let added = 0, failed = 0;
          const undoItems = []; // Task #1086: pre-write originals
          for (let i = 0; i < selected.length; i++) {
            const row = selected[i];
            const it = row._it || {};
            setStatus(`Writing ${i + 1}/${selected.length}…`);
            const params = {
              request_type: 'update_sheet',
              status_id: statusId,
              inspec_id: row._taskId,
              notes: row.text || '',
            };
            if (sheetId) params.sheet_id = sheetId;
            // Preserve the item's existing status when only rewriting notes.
            if (it.status !== '' && it.status != null) params.inspec_status = it.status;
            if (it.resultsId) params.results_id = it.resultsId;
            if (it.techId) params.prev_tech_id = it.techId;
            const res = await writeAutoflowSheet(params);
            if (res && res.ok) {
              added++;
              undoItems.push({
                inspecId: row._taskId, name: row.label,
                prevStatus: it.status, prevNotes: it.notes || '',
                resultsId: it.resultsId || null, techId: it.techId || null,
              });
            } else failed++;
          }
          if (undoItems.length) {
            await saveAfUndoSnapshot({
              provider: 'autoflow', shopId: ctx.shopId, roId: ctx.roId,
              kind: 'enhance_notes', statusId, sheetId, items: undoItems,
            });
          }
          if (added) showToast(`Updated ${added} note${added === 1 ? '' : 's'}${failed ? `, ${failed} failed` : ''} — undo available after reload`, failed ? 'warning' : 'success');
          else showToast(`Enhance apply failed (${failed})`, 'error');
          if (added) reloadAfterApply();
        },
      });
    }
  );
}

// ---------- Action 3: Add Recommendations ("add all to concerns") ----------
async function handleAfConcerns(btn) {
  const ctx = detectContext();
  if (!ctx.roId || !ctx.shopId) { showToast('No DVI detected on this page', 'error'); return; }
  if (!ctx.vin) { showToast('No VIN detected — cannot build recommendations', 'error'); return; }

  setVhiBtnBusy(btn, true);
  showToast('Building VHI recommendations…', 'info');
  const dvi = await readAutoflowDvi();
  const statusId = (dvi && dvi.statusId) || ctx.roId;

  chrome.runtime.sendMessage(
    { action: 'AF_ANALYZE_BUILD_RO', context: Object.assign({}, ctx) },
    (resp) => {
      if (chrome.runtime.lastError || !resp || !resp.success) {
        showToast((resp && resp.error) || 'Build recommendations failed', 'error');
        setVhiBtnBusy(btn, false);
        return;
      }
      const proposed = (resp.proposed || []).filter((p) => p);
      if (proposed.length === 0) {
        showToast('No recommendations to add', 'info');
        setVhiBtnBusy(btn, false);
        return;
      }
      const colorFor = (st) => ({ overdue: '#ef4444', 'due-soon': '#f59e0b', dueSoon: '#f59e0b' }[String(st)] || '#6b7280');
      // AutoFlow add-RVH "type" select (jquery.atme.rvh.js): 0=Concern, 1=Information, 2=Service.
      // Map our recommendation status onto it so added items reflect severity instead of
      // landing on AutoFlow's default ("Concern"): overdue -> Concern, due-soon -> Service.
      const afRvhTypeFor = (st) => ({ overdue: '0', 'due-soon': '2', dueSoon: '2' }[String(st)] || '1');
      const rows = proposed.map((p) => ({
        _p: p,
        label: p.title || p.serviceKey || 'Recommendation',
        badge: (p.status || '').toUpperCase(),
        badgeColor: colorFor(p.status),
        text: p.concern || p.title || '',
      }));

      showAfReviewModal({
        title: 'Add VHI Recommendations',
        applyLabel: 'Add to RO',
        rows,
        onClose: () => setVhiBtnBusy(btn, false),
        onApply: async (selected, { setStatus }) => {
          let added = 0, failed = 0;
          let lastErr = null;
          const undoItems = []; // Task #1086: ids of the entries we create
          for (let i = 0; i < selected.length; i++) {
            const row = selected[i];
            setStatus(`Adding ${i + 1}/${selected.length}…`);
            const params = {
              request_type: 'add_rvh',
              status_id: statusId,
              details: row.label || '',
              notes: row.text || '',
              type: afRvhTypeFor(row._p && row._p.status),
              skip_mapping: 1,
            };
            const res = await writeAutoflowRvh(params);
            if (res && res.ok) {
              added++;
              // add_rvh responses carry the created entry's id (rvh_id) —
              // capture it so the entry can be deleted on undo.
              const rvhId = (res.data && (res.data.rvh_id ?? res.data.id)) ?? res.rvh_id ?? null;
              if (rvhId != null) undoItems.push({ rvhId, title: row.label });
            } else { failed++; lastErr = (res && res.error) || lastErr; }
          }
          if (undoItems.length) {
            await saveAfUndoSnapshot({
              provider: 'autoflow', shopId: ctx.shopId, roId: ctx.roId,
              kind: 'add_vhi_recommendations', statusId, items: undoItems,
            });
          }
          if (added) showToast(`Added ${added} recommendation${added === 1 ? '' : 's'} to RO${failed ? `, ${failed} failed` : ''}${undoItems.length ? ' — undo available after reload' : ''}`, failed ? 'warning' : 'success');
          // v4 pages where the RVH route table can't be resolved (or a future
          // AutoFlow build removes the feature) get a clear "not available"
          // message instead of a generic failure count.
          else if (lastErr === 'rvh_unsupported_v4' || lastErr === 'rvh_route_unresolved_v4') showToast('Adding recommendations is not available on this AutoFlow v4 page', 'error');
          else showToast(`Add recommendations failed (${failed})`, 'error');
          if (added) reloadAfterApply();
        },
      });
    }
  );
}
