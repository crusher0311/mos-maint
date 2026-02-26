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
    const vinMatch = pageText.match(/\b([A-HJ-NPR-Z0-9]{17})\b/i);
    if (vinMatch) {
      context.vin = vinMatch[1].toUpperCase();
    }
    if (!context.vin) {
      const vinEls = document.querySelectorAll('[data-testid*="vin"], [class*="vin"], [class*="VIN"], [aria-label*="VIN"], [aria-label*="vin"]');
      for (const el of vinEls) {
        const m = el.textContent.match(/[A-HJ-NPR-Z0-9]{17}/i);
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
      const patterns = [
        /Mileage[:\s]*([\d,]+)/i,
        /Odometer[:\s]*([\d,]+)/i,
        /In[:\s]*([\d,]+)/i
      ];
      for (const p of patterns) {
        const m = pageText.match(p);
        if (m) {
          const v = parseInt(m[1].replace(/,/g, ''));
          if (v > 100 && v < 1000000) { context.mileage = v; break; }
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

// ==================== CONCERN TEXT INJECTION ====================
function injectConcernText(text) {
  // Try common concern/complaint textareas in Shop-Ware's UI
  const selectors = [
    'textarea[placeholder*="concern" i]',
    'textarea[placeholder*="complaint" i]',
    'textarea[placeholder*="customer" i]',
    'textarea[name*="concern" i]',
    'textarea[name*="complaint" i]',
    'textarea[aria-label*="concern" i]',
    'textarea[aria-label*="complaint" i]',
    'textarea[data-testid*="concern" i]',
    '[contenteditable="true"][aria-label*="concern" i]',
    '[contenteditable="true"][data-testid*="concern" i]',
    'textarea'  // fallback: first visible textarea on the page
  ];

  for (const sel of selectors) {
    const els = document.querySelectorAll(sel);
    for (const el of els) {
      if (el.offsetParent === null) continue; // skip hidden
      const isFallback = sel === 'textarea';
      // For the blanket textarea fallback, only use if it looks like a concern field
      if (isFallback) {
        const label = el.getAttribute('placeholder') || el.getAttribute('aria-label') || '';
        if (!/(concern|complaint|customer|note|description)/i.test(label)) continue;
      }

      // Set value
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
          || Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (nativeInputValueSetter) {
          nativeInputValueSetter.call(el, text);
        } else {
          el.value = text;
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        el.textContent = text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      el.focus();
      console.log('[MOS Tools] Concern injected into:', sel);
      return true;
    }
  }
  return false;
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

function injectPrintButton() {
  if (printButtonInjected) return;
  const context = detectContext();
  if (!context.roId) return;
  if (document.getElementById('mos-print-btn-sw')) { printButtonInjected = true; return; }

  // Look for a toolbar or action bar near the top of the page
  const containers = [
    document.querySelector('[class*="toolbar"]'),
    document.querySelector('[class*="Toolbar"]'),
    document.querySelector('[class*="action-bar"]'),
    document.querySelector('[class*="ActionBar"]'),
    document.querySelector('[class*="header-actions"]'),
    document.querySelector('[class*="work-order-header"]'),
    document.querySelector('header'),
    document.querySelector('nav')
  ];
  const targetContainer = containers.find(c => c !== null);
  if (!targetContainer) return;

  const button = document.createElement('button');
  button.id = 'mos-print-btn-sw';
  button.title = 'MOS Oil Sticker — Print';
  button.type = 'button';

  const imgUrl = chrome.runtime.getURL('icons/mos-print-button.png');
  button.innerHTML = `<img src="${imgUrl}" alt="MOS Print" style="height:26px;display:block;" />`;
  Object.assign(button.style, {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '2px 4px',
    background: 'transparent',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    marginLeft: '6px'
  });
  button.addEventListener('click', () => {
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

  targetContainer.appendChild(button);
  printButtonInjected = true;
  console.log('[MOS Tools] Shop-Ware print button injected');
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
    const injected = injectConcernText(message.text);
    sendResponse({ success: injected });
    return false;
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
