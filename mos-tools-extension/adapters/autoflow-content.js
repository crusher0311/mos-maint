console.log("[MOS Tools] AutoFlow content script loaded");
console.log("[Autoflow] content script loaded");

let lastContext = null;
let contextCheckInterval = null;

function detectContext() {
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

  const tenantMatch = hostname.match(/^([^.]+)\.(autotext\.me|autoflow\.com)/);
  if (tenantMatch) {
    context.shopId = tenantMatch[1];
  }

  const pageText = document.body?.innerText || "";

  const ticketPatterns = [
    /\/tickets?\/(\d+)/,
    /\/invoices?\/(\d+)/,
    /\/inspections?\/(\d+)/,
    /\/dvi[_v0-9]*\/.*[?&]status_id=(\d+)/,
    /\/dvi\/(\d+)/,
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
          if (v > 100 && v < 1000000) {
            context.mileage = v;
            break;
          }
        }
      }
      if (context.mileage) break;
    }

    if (!context.mileage) {
      const patterns = [
        /(?:Odometer|Mileage)[:\s]*([\d,]+)/i,
        /(?:Miles|KM)[:\s]*([\d,]+)/i
      ];
      for (const p of patterns) {
        const m = pageText.match(p);
        if (m) {
          const v = parseInt(m[1].replace(/,/g, ""));
          if (v > 0 && v < 1000000) {
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

function checkForContextChanges() {
  try {
    const context = detectContext();
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

setTimeout(() => {
  checkForContextChanges();
  checkAndInjectButton();
  contextCheckInterval = setInterval(() => {
    checkForContextChanges();
    checkAndInjectButton();
  }, 2000);
}, 1000);

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

// ==================== PRINT BUTTON ====================
let printButtonInjected = false;
let lastInjectedUrl = null;

function createPrintButton() {
  const button = document.createElement('button');
  button.id = 'mos-print-btn-af';
  button.title = 'MOS Oil Sticker — Left-click: Print';
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
        }
      }
    );
  });
  return button;
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
  // a known label.
  const KNOWN_LABELS = ['PDF', 'QC', 'Text & Email', 'Report Complete', 'Re-Push', 'Sheets'];
  const candidates = Array.from(document.querySelectorAll('a, button'));
  for (const label of KNOWN_LABELS) {
    const hit = candidates.find(el => {
      const t = (el.textContent || '').trim();
      return t === label || t.startsWith(label + ' ') || t.startsWith(label + '(');
    });
    if (hit && hit.parentElement) {
      target = hit;
      placement = 'after';
      break;
    }
  }

  // Strategy 2: AutoFlow DVI submit/print toolbar containers
  if (!target) {
    const bar = document.querySelector(
      '.btn-toolbar, .dvi-actions, .dvi_actions, .action-buttons, ' +
      '[class*="dvi-toolbar"], [class*="dvi_toolbar"]'
    );
    if (bar) { target = bar; placement = 'append'; }
  }

  // Strategy 3: standalone DVI viewer — look for a print-related anchor
  if (!target) {
    const printish = candidates.find(el => /^\s*Print\s*$/i.test(el.textContent || ''));
    if (printish && printish.parentElement) {
      target = printish;
      placement = 'after';
    }
  }

  if (!target) return; // try again on next tick

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
  injectPrintButton();
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
              try { if (opts.body) reqBody = (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)).substring(0, 10000); } catch(e) {}
              var capturedUrl = url, capturedMethod = method;
              return origFetch.apply(this, arguments).then(function(response) {
                var cloned = response.clone();
                cloned.text().then(function(text) {
                  window.postMessage({ type: 'MOS_SNIFFER_CAPTURE', data: { method: capturedMethod, url: capturedUrl, requestBody: reqBody, responseStatus: response.status, responseBody: text.substring(0, 10000), source: 'page_fetch' } }, '*');
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
