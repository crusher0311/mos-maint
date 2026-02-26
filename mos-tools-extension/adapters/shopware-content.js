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
    const extractVin17 = (text) => {
      const stripped = (text || '').replace(/[^A-HJ-NPR-Z0-9]/gi, '');
      const m = stripped.match(/[A-HJ-NPR-Z0-9]{17}/i);
      return m ? m[0].toUpperCase() : null;
    };

    // Strategy 1: Find any element whose text starts with "VIN" and extract 17 VIN chars
    const allEls = document.querySelectorAll('span, td, div, p, label, dt, dd, li, a');
    for (const el of allEls) {
      if (context.vin) break;
      const txt = (el.textContent || '').trim();
      if (!/VIN/i.test(txt)) continue;
      // Element contains VIN label + value together (e.g. "VIN: 1C4HJWEG7 GL 906678")
      const afterVin = txt.replace(/^.*?VIN:?\s*/i, '');
      const v = extractVin17(afterVin);
      if (v) { context.vin = v; break; }
      // VIN label only — check next sibling
      if (/^VIN:?\s*$/i.test(txt)) {
        const sib = el.nextElementSibling || el.parentElement?.nextElementSibling;
        if (sib) {
          const sv = extractVin17(sib.textContent);
          if (sv) { context.vin = sv; break; }
        }
      }
    }
    // Strategy 2: Look for "VIN" in pageText and grab chars after it
    if (!context.vin) {
      const vinLabelMatch = pageText.match(/VIN:?\s*(.{17,30})/i);
      if (vinLabelMatch) {
        const v = extractVin17(vinLabelMatch[1]);
        if (v) context.vin = v;
      }
    }
    // Strategy 3: Standard 17 consecutive VIN chars anywhere in pageText
    if (!context.vin) {
      const vinMatch = pageText.match(/\b([A-HJ-NPR-Z0-9]{17})\b/i);
      if (vinMatch) context.vin = vinMatch[1].toUpperCase();
    }
    // Strategy 4: Look in DOM elements with VIN-related attributes
    if (!context.vin) {
      const vinEls = document.querySelectorAll('[data-testid*="vin"], [class*="vin"], [class*="VIN"], [aria-label*="VIN"], [aria-label*="vin"]');
      for (const el of vinEls) {
        const v = extractVin17(el.textContent);
        if (v) { context.vin = v; break; }
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
  button.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showIntervalDropdown(e, button);
  });
  return button;
}

async function showIntervalDropdown(event, buttonElement) {
  const existingDropdown = document.getElementById('mos-interval-dropdown');
  if (existingDropdown) { existingDropdown.remove(); return; }

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

  let intervals = [];
  try {
    const result = await new Promise((resolve) => {
      chrome.runtime.sendMessage({
        action: 'MOS_API_REQUEST',
        endpoint: `/api/extension/sticker?shopId=${context.shopId}&provider=${context.provider || 'shopware'}`
      }, resolve);
    });

    if (result && result.config && result.config.intervals) {
      const cfg = result.config.intervals;
      if (cfg.conventional) {
        intervals.push({ label: `Conventional: ${cfg.conventional.mileage.toLocaleString()} mi / ${cfg.conventional.months} mo`, miles: cfg.conventional.mileage, months: cfg.conventional.months });
      }
      if (cfg.synthetic) {
        intervals.push({ label: `Synthetic: ${cfg.synthetic.mileage.toLocaleString()} mi / ${cfg.synthetic.months} mo`, miles: cfg.synthetic.mileage, months: cfg.synthetic.months });
      }
      if (cfg.euro) {
        intervals.push({ label: `Euro: ${cfg.euro.mileage.toLocaleString()} mi / ${cfg.euro.months} mo`, miles: cfg.euro.mileage, months: cfg.euro.months });
      }
      if (cfg.diesel) {
        intervals.push({ label: `Diesel: ${cfg.diesel.mileage.toLocaleString()} mi / ${cfg.diesel.months} mo`, miles: cfg.diesel.mileage, months: cfg.diesel.months });
      }
    }
  } catch (err) {
    console.error('[MOS] Failed to fetch sticker config:', err);
  }

  if (intervals.length === 0) {
    intervals = [
      { label: 'Conventional: 3,000 mi / 3 mo', miles: 3000, months: 3 },
      { label: 'Synthetic: 5,000 mi / 6 mo', miles: 5000, months: 6 },
      { label: 'Euro: 10,000 mi / 12 mo', miles: 10000, months: 12 },
      { label: 'Diesel: 7,500 mi / 6 mo', miles: 7500, months: 6 }
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
    item.addEventListener('mouseenter', () => { item.style.backgroundColor = '#f5f5f5'; });
    item.addEventListener('mouseleave', () => { item.style.backgroundColor = 'transparent'; });
    item.addEventListener('click', () => {
      dropdown.remove();
      if (interval.action === 'customize') {
        chrome.runtime.sendMessage({ action: 'OPEN_STICKER_PANEL', context });
      } else {
        const ctx = detectContext();
        if (!ctx.roId || !ctx.shopId) { showToast('No work order detected', 'error'); return; }
        showToast(`Generating sticker (${interval.miles.toLocaleString()} mi)...`, 'info');
        chrome.runtime.sendMessage({
          action: 'PRINT_STICKER_IMMEDIATE',
          context: ctx,
          overrideInterval: { miles: interval.miles, months: interval.months }
        }, (response) => {
          if (response?.success) {
            printStickerFromContentScript(response.sticker);
          } else {
            showToast(response?.error || 'Failed to generate sticker', 'error');
          }
        });
      }
    });
    dropdown.appendChild(item);
  });

  const closeDropdown = (e) => {
    if (!dropdown.contains(e.target) && e.target !== buttonElement) {
      dropdown.remove();
      document.removeEventListener('click', closeDropdown);
    }
  };
  setTimeout(() => document.addEventListener('click', closeDropdown), 0);
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
          width: ${sticker.widthInches || '2in'};
          height: ${sticker.heightInches || '2.5in'};
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
    img.onerror = () => {
      showToast('Failed to load sticker image', 'error');
      iframe.remove();
    };
  }
}

function checkAndInjectButton() {
  const context = detectContext();
  if (context.roId) injectPrintButton();
}

// ==================== ADD SERVICE TO RO ====================

async function searchShopWareCannedJobs(query, vehicle, workOrderId) {
  const csrfToken = getCsrfToken();
  if (!csrfToken) {
    console.warn('[MOS Tools] No CSRF token found for canned job search');
    return { success: false, error: 'No CSRF token', results: [] };
  }

  const params = new URLSearchParams();
  if (query) params.set('search', query);
  if (vehicle?.year) params.set('vehicle_year', String(vehicle.year));
  if (vehicle?.make) params.set('vehicle_make', vehicle.make);
  if (vehicle?.model) params.set('vehicle_model', vehicle.model);
  if (vehicle?.engine) params.set('vehicle_engine', vehicle.engine);
  if (workOrderId) params.set('work_order_id', workOrderId);

  try {
    const res = await fetch(`/canned_jobs/search?${params.toString()}`, {
      method: 'GET',
      headers: {
        'accept': 'application/json, text/javascript, */*; q=0.01',
        'x-csrf-token': csrfToken,
        'x-requested-with': 'XMLHttpRequest'
      },
      credentials: 'same-origin'
    });

    if (!res.ok) {
      console.warn('[MOS Tools] Canned job search failed:', res.status);
      return { success: false, error: `Search failed (${res.status})`, results: [] };
    }

    const data = await res.json();
    const results = Array.isArray(data) ? data : (data.canned_jobs || data.results || []);
    console.log(`[MOS Tools] Canned job search for "${query}": ${results.length} results`);
    return { success: true, results };
  } catch (err) {
    console.error('[MOS Tools] Canned job search error:', err);
    return { success: false, error: err.message, results: [] };
  }
}

async function importServiceToRO(workOrderId, serviceId) {
  const csrfToken = getCsrfToken();
  if (!csrfToken) {
    return { success: false, error: 'No CSRF token found' };
  }

  try {
    const res = await fetch(`/work_orders/${workOrderId}/import_service?service_id=${serviceId}`, {
      method: 'GET',
      headers: {
        'accept': 'application/json, text/javascript, */*; q=0.01',
        'x-csrf-token': csrfToken,
        'x-requested-with': 'XMLHttpRequest'
      },
      credentials: 'same-origin'
    });

    if (!res.ok) {
      console.warn('[MOS Tools] Import service failed:', res.status);
      return { success: false, error: `Import failed (${res.status})` };
    }

    let serviceTemplateId = null;
    try {
      const data = await res.json();
      serviceTemplateId = data?.id || data?.work_order_service?.id || null;
    } catch (e) {
      console.warn('[MOS Tools] Could not parse import response as JSON');
    }

    console.log(`[MOS Tools] Service ${serviceId} imported to WO ${workOrderId}, templateId: ${serviceTemplateId}`);
    return { success: true, serviceTemplateId };
  } catch (err) {
    console.error('[MOS Tools] Import service error:', err);
    return { success: false, error: err.message };
  }
}

async function addServiceToRO(serviceName, workOrderId, vehicle) {
  if (!workOrderId) {
    showToast('No work order detected. Navigate to a work order first.', 'error');
    return { success: false, error: 'No work order ID' };
  }
  if (!serviceName) {
    return { success: false, error: 'No service name provided' };
  }
  showToast(`Searching for "${serviceName}"...`, 'info');

  const searchResult = await searchShopWareCannedJobs(serviceName, vehicle, workOrderId);
  if (!searchResult.success || searchResult.results.length === 0) {
    showToast(`No canned job found for "${serviceName}". Add it manually in Shop-Ware.`, 'warning');
    return { success: false, error: 'No matching canned job found' };
  }

  const nameLower = serviceName.toLowerCase();
  let bestMatch = searchResult.results[0];
  for (const job of searchResult.results) {
    const title = (job.title || job.name || '').toLowerCase();
    if (title === nameLower) {
      bestMatch = job;
      break;
    }
    if (title.includes(nameLower) || nameLower.includes(title)) {
      bestMatch = job;
    }
  }

  const jobId = bestMatch.id;
  const jobTitle = bestMatch.title || bestMatch.name || serviceName;
  showToast(`Adding "${jobTitle}" to WO...`, 'info');

  const importResult = await importServiceToRO(workOrderId, jobId);
  if (importResult.success) {
    showToast(`Added "${jobTitle}" to work order`, 'success');
    setTimeout(() => window.location.reload(), 1500);
    return { success: true, jobName: jobTitle };
  } else {
    showToast(`Failed to add "${jobTitle}": ${importResult.error}`, 'error');
    return { success: false, error: importResult.error };
  }
}

// ==================== ADD FINDING TO RO ====================

async function createNote(workOrderId, text, isDraft, csrfToken) {
  const res = await fetch(`/work_orders/${workOrderId}/notes/`, {
    method: 'POST',
    headers: {
      'accept': 'application/json, text/javascript, */*; q=0.01',
      'content-type': 'application/json',
      'x-csrf-token': csrfToken,
      'x-requested-with': 'XMLHttpRequest'
    },
    credentials: 'same-origin',
    body: JSON.stringify({
      note: { text },
      is_draft: isDraft
    })
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    console.warn('[MOS Tools] Create note failed:', res.status, errBody.substring(0, 200));
    return null;
  }

  try {
    const data = await res.json();
    return data?.id || data?.note?.id || null;
  } catch (e) {
    console.warn('[MOS Tools] Could not parse note response');
    return null;
  }
}

async function addRecommendationToNote(workOrderId, noteId, templateId, csrfToken) {
  const res = await fetch(`/work_orders/${workOrderId}/notes/${noteId}/recommendations/`, {
    method: 'POST',
    headers: {
      'accept': 'application/json, text/javascript, */*; q=0.01',
      'content-type': 'application/json',
      'x-csrf-token': csrfToken,
      'x-requested-with': 'XMLHttpRequest'
    },
    credentials: 'same-origin',
    body: JSON.stringify({
      recommendation: {
        note_id: noteId,
        template_id: templateId
      },
      template: null,
      part_summary: null,
      work_order: null,
      past_recommendation: []
    })
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    console.warn('[MOS Tools] Add recommendation failed:', res.status, errBody.substring(0, 200));
    return false;
  }
  return true;
}

async function importProposedService(workOrderId, cannedJobId, csrfToken) {
  try {
    const res = await fetch(`/work_order_services/?proposed=true&service_id=${cannedJobId}`, {
      method: 'GET',
      headers: {
        'accept': 'application/json, text/javascript, */*; q=0.01',
        'x-csrf-token': csrfToken,
        'x-requested-with': 'XMLHttpRequest'
      },
      credentials: 'same-origin'
    });

    if (!res.ok) {
      console.warn('[MOS Tools] Import proposed service failed:', res.status);
      return { success: false, error: `Import proposed failed (${res.status})` };
    }

    const data = await res.json();

    let templateId = null;
    if (data?.work_order?.services && Array.isArray(data.work_order.services)) {
      const matchByCannedJob = data.work_order.services.find(svc => svc.canned_job_id === cannedJobId);
      if (matchByCannedJob) {
        templateId = matchByCannedJob.id;
      } else {
        const newest = data.work_order.services.reduce((best, svc) => {
          if (!best || (svc.id && svc.id > best.id)) return svc;
          return best;
        }, null);
        templateId = newest?.id || null;
      }
    }
    if (!templateId) {
      templateId = data?.id || null;
    }

    console.log(`[MOS Tools] Proposed service imported, templateId: ${templateId}`);
    return { success: true, serviceTemplateId: templateId };
  } catch (err) {
    console.error('[MOS Tools] Import proposed service error:', err);
    return { success: false, error: err.message };
  }
}

async function addFindingToRO(text, workOrderId, isDraft = false, serviceName = null, vehicle = null) {
  if (!workOrderId) {
    showToast('No work order detected. Navigate to a work order first.', 'error');
    return { success: false, error: 'No work order ID' };
  }
  if (!text) {
    return { success: false, error: 'No finding text provided' };
  }

  const csrfToken = getCsrfToken();
  if (!csrfToken) {
    return { success: false, error: 'No CSRF token found' };
  }

  const statusLabel = isDraft ? 'Draft' : 'Published';
  showToast(`Adding finding as ${statusLabel}...`, 'info');

  try {
    const noteId = await createNote(workOrderId, text, isDraft, csrfToken);
    if (!noteId) {
      showToast('Failed to add finding. Try adding it manually.', 'error');
      return { success: false, error: 'Note creation failed' };
    }

    console.log(`[MOS Tools] Finding created (${statusLabel}), noteId: ${noteId}`);
    showToast(`Finding added (${statusLabel}): "${text.substring(0, 40)}${text.length > 40 ? '...' : ''}"`, 'success');

    setTimeout(() => window.location.reload(), 1500);
    return { success: true, status: statusLabel, jobName: serviceName || text };
  } catch (err) {
    console.error('[MOS Tools] Add finding error:', err);
    showToast(`Error adding finding: ${err.message}`, 'error');
    return { success: false, error: err.message };
  }
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

  if (message.action === 'SW_SEARCH_CANNED_JOBS') {
    searchShopWareCannedJobs(message.query, message.vehicle, message.workOrderId)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ success: false, error: err.message, results: [] }));
    return true;
  }

  if (message.action === 'SW_IMPORT_SERVICE') {
    importServiceToRO(message.workOrderId, message.serviceId)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === 'SW_ADD_SERVICE') {
    addServiceToRO(message.serviceName, message.workOrderId, message.vehicle)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === 'SW_ADD_FINDING') {
    addFindingToRO(message.text, message.workOrderId, message.isDraft, message.serviceName, message.vehicle)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ success: false, error: err.message }));
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
  const saved = localStorage.getItem('mos_fab_pos');
  const pos = saved ? JSON.parse(saved) : { bottom: 20, right: 20 };
  fab.setAttribute('style', `position:fixed !important; bottom:${pos.bottom}px !important; right:${pos.right}px !important; z-index:999998 !important; background:transparent !important; border:none !important; cursor:grab !important; padding:0 !important; border-radius:50% !important; box-shadow:0 4px 12px rgba(0,0,0,0.3) !important; display:block !important; width:48px !important; height:48px !important;`);

  let isDragging = false;
  let dragStartX, dragStartY, fabStartRight, fabStartBottom;

  fab.addEventListener('mousedown', (e) => {
    isDragging = false;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    const rect = fab.getBoundingClientRect();
    fabStartRight = window.innerWidth - rect.right;
    fabStartBottom = window.innerHeight - rect.bottom;
    fab.style.cursor = 'grabbing';

    const onMouseMove = (e) => {
      const dx = e.clientX - dragStartX;
      const dy = e.clientY - dragStartY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) isDragging = true;
      const newRight = Math.max(0, fabStartRight - dx);
      const newBottom = Math.max(0, fabStartBottom - dy);
      fab.style.right = newRight + 'px';
      fab.style.bottom = newBottom + 'px';
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      fab.style.cursor = 'grab';
      if (isDragging) {
        const newPos = { right: parseInt(fab.style.right), bottom: parseInt(fab.style.bottom) };
        localStorage.setItem('mos_fab_pos', JSON.stringify(newPos));
      }
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });

  fab.addEventListener('click', (e) => {
    if (isDragging) { e.preventDefault(); e.stopPropagation(); return; }
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
