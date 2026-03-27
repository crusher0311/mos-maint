console.log("[MOS Tools] AutoFlow content script loaded");

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

  const tenantMatch = hostname.match(/^([^.]+)\.(autotest\.me|autotext\.me|autoflow\.com)/);
  if (tenantMatch) {
    context.shopId = tenantMatch[1];
  }

  const pageText = document.body?.innerText || "";

  const ticketPatterns = [
    /\/tickets?\/(\d+)/,
    /\/invoices?\/(\d+)/,
    /\/inspections?\/(\d+)/,
    /\/dvi\/(\d+)/
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
      /(?:Invoice|Ticket)\s*(?:Number|No\.?)\s*:?\s*(\d+)/i
    ];
    for (const p of roPatterns) {
      const m = pageText.match(p);
      if (m) {
        context.roNumber = m[1];
        if (!context.roId) context.roId = m[1];
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
      type: "SMS_CONTEXT_UPDATE",
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
  contextCheckInterval = setInterval(checkForContextChanges, 2000);
}, 1000);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GET_SMS_CONTEXT") {
    const context = detectContext();
    sendResponse(context);
    return true;
  }
});
