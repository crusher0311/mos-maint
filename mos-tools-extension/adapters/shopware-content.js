// MOS Tools - Shop-Ware Content Script
// Detects RO context and communicates with background worker

console.log("[MOS Tools] Shop-Ware content script loaded");

let lastContext = null;
let contextCheckInterval = null;

// ==================== CONTEXT DETECTION ====================
function detectContext() {
  const url = window.location.href;
  const hostname = window.location.hostname; // e.g. "aace-enterprises.shop-ware.com"

  const context = {
    provider: "shopware",
    shopId: null,      // tenant subdomain — MOS server resolves to a shop
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

  // ============ EXTRACT SHOP ID (tenant subdomain) ============
  // Live:    aace-enterprises.shop-ware.com
  // Sandbox: sandbox-shop.shop-ware-api-sandbox.com
  const tenantMatch = hostname.match(/^([^.]+)\.(shop-ware\.com|shop-ware-api-sandbox\.com)/);
  if (tenantMatch) {
    context.shopId = tenantMatch[1];
  }

  // ============ EXTRACT RO ID FROM URL ============
  // Possible patterns:
  //   /work_orders/12345
  //   /work_orders/open_jobs/12345
  //   /work_orders/my_jobs/12345
  //   /repair_orders/12345
  const roPatterns = [
    /\/work_orders\/(?:open_jobs|my_jobs|closed_jobs|all_jobs)?\/(\d+)/,
    /\/work_orders\/(\d+)/,
    /\/repair_orders\/(\d+)/
  ];
  for (const pattern of roPatterns) {
    const m = url.match(pattern);
    if (m) {
      context.roId = m[1];
      break;
    }
  }

  const pageText = document.body?.innerText || '';

  // ============ EXTRACT RO / WO NUMBER ============
  try {
    const woPatterns = [
      /W\.?O\.?\s*#?\s*(\d+)/i,
      /Work\s+Order\s*#?\s*(\d+)/i,
      /Repair\s+Order\s*#?\s*(\d+)/i,
      /RO\s*#?\s*(\d+)/i
    ];
    for (const p of woPatterns) {
      const m = pageText.match(p);
      if (m) {
        context.roNumber = m[1];
        break;
      }
    }
  } catch (e) {}

  // ============ EXTRACT VIN ============
  try {
    // Shop-Ware displays VINs with spaces, e.g. "1C4HJWEG7 GL 906678"
    // Strategy 1: Look for "VIN:" label and grab the value after it
    const vinLabelMatch = pageText.match(/VIN:\s*([A-HJ-NPR-Z0-9 ]{17,22})/i);
    if (vinLabelMatch) {
      const cleaned = vinLabelMatch[1].replace(/\s/g, '');
      if (/^[A-HJ-NPR-Z0-9]{17}$/i.test(cleaned)) {
        context.vin = cleaned.toUpperCase();
      }
    }
    // Strategy 2: Standard 17 consecutive chars
    if (!context.vin) {
      const vinMatch = pageText.match(/\b([A-HJ-NPR-Z0-9]{17})\b/i);
      if (vinMatch) {
        context.vin = vinMatch[1].toUpperCase();
      }
    }
    // Strategy 3: Look in DOM elements with VIN-related attributes
    if (!context.vin) {
      const vinEls = document.querySelectorAll('[data-testid*="vin"], [class*="vin"], [class*="VIN"], [aria-label*="VIN"], [aria-label*="vin"]');
      for (const el of vinEls) {
        const raw = (el.textContent || '').replace(/\s/g, '');
        const m = raw.match(/[A-HJ-NPR-Z0-9]{17}/i);
        if (m) { context.vin = m[0].toUpperCase(); break; }
      }
    }
  } catch (e) {}

  // ============ EXTRACT VEHICLE ============
  try {
    const vehiclePattern = /\b(19\d{2}|20\d{2})\s+([A-Z][a-zA-Z-]+)\s+([A-Z][a-zA-Z0-9\s-]+?)(?:\s+VIN|\s+In:|\s+Out:|\n|$)/i;
    const vm = pageText.match(vehiclePattern);
    if (vm) {
      const year = parseInt(vm[1]);
      const make = vm[2].trim();
      let model = vm[3].trim().replace(/\s+\d{1,3}(,\d{3})*\s*$/, '').trim();
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
        '[class*="car-info"]',
        '[class*="CarInfo"]'
      ];
      for (const sel of vehicleSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          const text = el.textContent || '';
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

  // ============ EXTRACT MILEAGE ============
  try {
    const mileageSelectors = [
      '[data-testid*="mileage"]',
      '[data-testid*="odometer"]',
      '[class*="mileage"]',
      '[class*="odometer"]',
      '[aria-label*="mileage"]',
      '[aria-label*="odometer"]'
    ];
    for (const sel of mileageSelectors) {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        const m = el.textContent.match(/[\d,]+/);
        if (m) {
          const v = parseInt(m[0].replace(/,/g, ''));
          if (v > 100 && v < 1000000) { context.mileage = v; break; }
        }
      }
      if (context.mileage) break;
    }

    if (!context.mileage) {
      // Shop-Ware shows "Odometer In: 2222  Out: 39390"
      const patterns = [
        /Odometer\s+In:\s*([\d,]+)/i,
        /Odometer[:\s]*([\d,]+)/i,
        /Mileage[:\s]*([\d,]+)/i,
        /In:\s*([\d,]+)/i
      ];
      for (const p of patterns) {
        const m = pageText.match(p);
        if (m) {
          const v = parseInt(m[1].replace(/,/g, ''));
          if (v > 0 && v < 1000000) { context.mileage = v; break; }
        }
      }
    }
  } catch (e) {}

  // ============ EXTRACT CUSTOMER ============
  try {
    const UI_BLACKLIST = new Set([
      'add concern', 'view customer', 'edit customer', 'new customer',
      'add note', 'add service', 'view vehicle', 'edit vehicle',
      'sign out', 'log out', 'save changes', 'cancel'
    ]);

    function isLikelyName(text) {
      if (!text || text.length < 4 || text.length > 50) return false;
      if (UI_BLACKLIST.has(text.toLowerCase())) return false;
      return /^[A-Z][a-zA-Z'-]+\s+[A-Z]/.test(text);
    }

    // Look for customer links
    const customerLinks = document.querySelectorAll('a[href*="/customer"]');
    for (const link of customerLinks) {
      const href = link.getAttribute('href') || '';
      const idMatch = href.match(/\/customers?\/(\d+)/);
      const text = link.textContent?.trim() || '';
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
          const text = el.textContent?.trim() || '';
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
        /Owner[:\s]+([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+){1,2})/,
        /Client[:\s]+([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+){1,2})/
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

    // Phone
    const phoneMatch = pageText.match(/(?:\(\d{3}\)\s*\d{3}[-.]?\d{4}|\d{3}[-.]?\d{3}[-.]?\d{4})/);
    if (phoneMatch) {
      const digits = phoneMatch[0].replace(/[^\d]/g, '');
      if (digits.length === 10) context.customerPhone = digits;
    }

    // Email
    const emailMatch = pageText.match(/\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/);
    if (emailMatch) context.customerEmail = emailMatch[0];
  } catch (e) {}

  console.log('[MOS Tools] Shop-Ware context:', context);
  return context;
}

function updateContext() {
  const context = detectContext();
  const contextStr = JSON.stringify(context);
  if (contextStr !== JSON.stringify(lastContext)) {
    lastContext = context;
    if (context.shopId) {
      console.log("[MOS Tools] Shop-Ware context changed:", context.roId ? `WO ${context.roId}` : 'shop-level', context);
      chrome.runtime.sendMessage({
        action: "SET_SMS_CONTEXT",
        context
      }).catch(() => {});
    }
  }
}

// ==================== HELPERS ====================
function findSectionByHeading(pattern) {
  const headings = document.querySelectorAll('h1, h2, h3, h4, h5, h6, strong, b, [class*="heading"], [class*="title"], [class*="section-header"]');
  for (const h of headings) {
    if (pattern.test(h.textContent || '')) {
      // Return the parent section container
      let section = h.parentElement;
      for (let i = 0; i < 4 && section; i++) {
        if (section.querySelector('textarea, [contenteditable="true"], input[type="text"]')) return section;
        section = section.parentElement;
      }
      return h.parentElement;
    }
  }
  // Also try scanning all elements for the text
  const allEls = document.querySelectorAll('div, section, fieldset');
  for (const el of allEls) {
    const directText = Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent).join('');
    if (pattern.test(directText)) return el;
  }
  return null;
}

function getNearbyText(el) {
  let text = '';
  const parent = el.parentElement;
  if (parent) {
    const prev = parent.previousElementSibling;
    if (prev) text += prev.textContent || '';
    text += parent.textContent || '';
  }
  text += el.getAttribute('placeholder') || '';
  text += el.getAttribute('aria-label') || '';
  text += el.getAttribute('name') || '';
  return text;
}

function setFieldValue(el, text) {
  try {
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const setter = Object.getOwnPropertyDescriptor(
        el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype, 'value'
      )?.set;
      if (setter) { setter.call(el, text); } else { el.value = text; }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      el.textContent = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    el.focus();
    console.log('[MOS Tools] Field value set successfully');
    return true;
  } catch (e) {
    console.warn('[MOS Tools] Error setting field value:', e);
    return false;
  }
}

// ==================== CONCERN TEXT INJECTION ====================

function getCsrfToken() {
  // Rails apps store CSRF token in a <meta name="csrf-token"> tag
  const meta = document.querySelector('meta[name="csrf-token"]');
  if (meta) return meta.getAttribute('content');
  // Fallback: look for it in a cookie or hidden input
  const input = document.querySelector('input[name="authenticity_token"]');
  if (input) return input.value;
  return null;
}

async function injectConcernViaApi(roId, text) {
  const csrfToken = getCsrfToken();
  if (!csrfToken) {
    console.warn('[MOS Tools] No CSRF token found, cannot use API');
    return false;
  }

  try {
    const res = await fetch(`/work_orders/${roId}`, {
      method: 'PATCH',
      headers: {
        'accept': 'application/json, text/javascript, */*; q=0.01',
        'content-type': 'application/json',
        'x-csrf-token': csrfToken,
        'x-requested-with': 'XMLHttpRequest'
      },
      credentials: 'same-origin',
      body: JSON.stringify({
        work_order: {
          customer_concern: text
        }
      })
    });

    if (res.ok) {
      console.log('[MOS Tools] Concern injected via Shop-Ware API');
      return true;
    } else {
      console.warn('[MOS Tools] Shop-Ware API concern update failed:', res.status);
      return false;
    }
  } catch (err) {
    console.warn('[MOS Tools] Shop-Ware API concern error:', err.message);
    return false;
  }
}

function injectConcernViaDom(text) {
  const reasonSection = findSectionByHeading(/Reason\s+for\s+Customer/i);
  if (reasonSection) {
    const textarea = reasonSection.querySelector('textarea, [contenteditable="true"], input[type="text"]');
    if (textarea && textarea.offsetParent !== null) {
      if (setFieldValue(textarea, text)) return true;
    }
  }

  const selectors = [
    'textarea[placeholder*="reason" i]',
    'textarea[placeholder*="concern" i]',
    'textarea[name*="concern" i]',
    'textarea[name*="reason" i]',
    '[contenteditable="true"]',
    'textarea'
  ];
  for (const sel of selectors) {
    const els = document.querySelectorAll(sel);
    for (const el of els) {
      if (el.offsetParent === null) continue;
      const isFallback = sel === 'textarea' || sel === '[contenteditable="true"]';
      if (isFallback) {
        const nearby = getNearbyText(el);
        if (!/(reason|concern|complaint|customer|visit|note|description)/i.test(nearby)) continue;
      }
      if (setFieldValue(el, text)) {
        console.log('[MOS Tools] Concern injected via DOM:', sel);
        return true;
      }
    }
  }
  return false;
}

async function injectConcernText(text) {
  const context = detectContext();

  // Primary: Use the internal Shop-Ware API (PATCH /work_orders/{id})
  if (context.roId) {
    const apiSuccess = await injectConcernViaApi(context.roId, text);
    if (apiSuccess) {
      showToast('Customer concern saved', 'success');
      setTimeout(() => window.location.reload(), 1000);
      return true;
    }
  }

  // Fallback: DOM injection (requires Edit Mode to be active)
  console.log('[MOS Tools] API injection failed, falling back to DOM injection');
  return injectConcernViaDom(text);
}

// ==================== TOAST NOTIFICATIONS ====================
function showToast(message, type = 'info') {
  const existing = document.getElementById('mos-toast');
  if (existing) existing.remove();

  const colors = { success: '#22c55e', error: '#ef4444', info: '#3b82f6', warning: '#f59e0b' };
  const toast = document.createElement('div');
  toast.id = 'mos-toast';
  Object.assign(toast.style, {
    position: 'fixed',
    bottom: '20px',
    right: '20px',
    backgroundColor: colors[type] || colors.info,
    color: 'white',
    padding: '10px 16px',
    borderRadius: '8px',
    fontSize: '14px',
    fontWeight: '500',
    zIndex: '999999',
    boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
    maxWidth: '320px',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
  });
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

// ==================== PRINT BUTTON ====================
let printButtonInjected = false;

function createPrintButton() {
  const button = document.createElement('button');
  button.id = 'mos-print-btn-sw';
  button.title = 'MOS Oil Sticker\nLeft-click: Print';
  button.type = 'button';

  const imgUrl = chrome.runtime.getURL('icons/mos-print-button.png');
  button.innerHTML = `<img src="${imgUrl}" alt="MOS Print" style="height:26px;display:block;" />`;
  Object.assign(button.style, {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '2px',
    background: 'transparent',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    marginLeft: '4px',
    verticalAlign: 'middle',
    transition: 'opacity 0.2s'
  });
  button.addEventListener('mouseenter', () => { button.style.opacity = '0.8'; });
  button.addEventListener('mouseleave', () => { button.style.opacity = '1'; });
  button.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const ctx = detectContext();
    if (!ctx.roId || !ctx.shopId) { showToast('No work order detected', 'error'); return; }
    showToast('Generating sticker...', 'info');
    chrome.runtime.sendMessage({ action: 'PRINT_STICKER_IMMEDIATE', context: ctx }, (response) => {
      if (response?.success) {
        printStickerFromContentScript(response.sticker);
      } else {
        showToast(response?.error || 'Failed to generate sticker', 'error');
      }
    });
  });
  return button;
}

function injectPrintButton() {
  if (printButtonInjected) return;
  const context = detectContext();
  if (!context.roId) return;
  if (document.getElementById('mos-print-btn-sw')) { printButtonInjected = true; return; }

  // Shop-Ware DOM structure (from DevTools inspection):
  //   div.job-detail-vehicle-container
  //     div.job-header-item-heading
  //       h4.job-header-item-heading-main
  //         span.vehicle-dropdown-container
  //           a.dropdown-toggle > i.icon-more-options   ← three-dot menu (⋮)
  //           ul.dropdown-menu.vehicle-dropdown
  //
  // We inject the MOS print button inside span.vehicle-dropdown-container,
  // right before the a.dropdown-toggle (⋮ menu).

  let injected = false;

  // Strategy 1: Exact selector — vehicle card's dropdown container
  const vehicleContainer = document.querySelector('.job-detail-vehicle-container');
  if (vehicleContainer) {
    const dropdownContainer = vehicleContainer.querySelector('span.vehicle-dropdown-container');
    if (dropdownContainer) {
      const dropdownToggle = dropdownContainer.querySelector('a.dropdown-toggle');
      const btn = createPrintButton();
      if (dropdownToggle) {
        dropdownContainer.insertBefore(btn, dropdownToggle);
      } else {
        dropdownContainer.prepend(btn);
      }
      injected = true;
    } else {
      // Fallback: insert into the heading row
      const heading = vehicleContainer.querySelector('.job-header-item-heading, .job-header-item-heading-main');
      if (heading) {
        const btn = createPrintButton();
        heading.appendChild(btn);
        injected = true;
      }
    }
  }

  // Strategy 2: Broader selector — any vehicle dropdown container on the page
  if (!injected) {
    const dropdownContainer = document.querySelector('span.vehicle-dropdown-container');
    if (dropdownContainer) {
      const dropdownToggle = dropdownContainer.querySelector('a.dropdown-toggle');
      const btn = createPrintButton();
      if (dropdownToggle) {
        dropdownContainer.insertBefore(btn, dropdownToggle);
      } else {
        dropdownContainer.prepend(btn);
      }
      injected = true;
    }
  }

  // Strategy 3: Look for the icon-more-options inside the vehicle heading area
  if (!injected) {
    const moreIcons = document.querySelectorAll('i.icon-more-options');
    for (const icon of moreIcons) {
      const anchor = icon.closest('a.dropdown-toggle');
      if (anchor) {
        const container = anchor.parentElement;
        // Verify this is the vehicle card's menu (not the customer card's)
        const vehicleCard = anchor.closest('.job-detail-vehicle-container, .job-header-vehicle');
        if (vehicleCard || moreIcons.length === 1) {
          const btn = createPrintButton();
          container.insertBefore(btn, anchor);
          injected = true;
          break;
        }
      }
    }
  }

  // Strategy 4: Fallback — append to the WO header area
  if (!injected) {
    const woHeader = Array.from(document.querySelectorAll('h1, h2, h3, [class*="header"], [class*="Header"]'))
      .find(el => /Work\s+Order/i.test(el.textContent || ''));
    if (woHeader) {
      const btn = createPrintButton();
      woHeader.appendChild(btn);
      injected = true;
    }
  }

  if (injected) {
    printButtonInjected = true;
    console.log('[MOS Tools] Shop-Ware print button injected');
  }
}

function printStickerFromContentScript(sticker) {
  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;border:none;z-index:999999;background:white;';
  iframe.srcdoc = `<!DOCTYPE html><html><head><style>body{margin:0;display:flex;justify-content:center;align-items:center;min-height:100vh;background:white;}img{max-width:100%;height:auto;}</style></head><body><img src="${sticker.imageUrl}" onload="window.print();setTimeout(()=>window.parent.postMessage('done','*'),500);" /></body></html>`;
  document.body.appendChild(iframe);
  window.addEventListener('message', (e) => {
    if (e.data === 'done') iframe.remove();
  }, { once: true });
}

function checkAndInjectButton() {
  const context = detectContext();
  if (context.roId) injectPrintButton();
}

// ==================== MESSAGE HANDLERS ====================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'GET_PAGE_CONTEXT') {
    sendResponse(detectContext());
    return false;
  }

  if (message.action === 'INJECT_CONCERN_TEXT') {
    injectConcernText(message.text).then(injected => {
      sendResponse({ success: !!injected });
    }).catch(err => {
      console.error('[MOS Tools] Concern injection error:', err);
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }

  if (message.action === 'SHOW_TOAST') {
    showToast(message.message, message.type || 'info');
    sendResponse({ success: true });
    return false;
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
});

// ==================== FLOATING ACTION BUTTON ====================
function injectFAB() {
  if (document.getElementById('mos-fab-sw')) return;

  const fab = document.createElement('button');
  fab.id = 'mos-fab-sw';
  fab.title = 'Open MOS Tools';
  fab.type = 'button';

  const imgUrl = chrome.runtime.getURL('icons/mos-fab.png');
  fab.innerHTML = `<img src="${imgUrl}" alt="MOS" style="width:40px;height:40px;" />`;
  Object.assign(fab.style, {
    position: 'fixed',
    bottom: '20px',
    right: '20px',
    zIndex: '999998',
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    padding: '0',
    borderRadius: '50%',
    boxShadow: '0 4px 12px rgba(0,0,0,0.3)'
  });
  fab.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'OPEN_SIDE_PANEL' }).catch(() => {});
  });
  document.body.appendChild(fab);
}

// ==================== INIT ====================
function init() {
  updateContext();
  checkAndInjectButton();
  injectFAB();

  let lastUrl = window.location.href;
  contextCheckInterval = setInterval(() => {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      printButtonInjected = false;
      updateContext();
      checkAndInjectButton();
    }
  }, 500);

  setInterval(checkAndInjectButton, 3000);

  window.addEventListener('popstate', () => {
    printButtonInjected = false;
    updateContext();
    checkAndInjectButton();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
