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

let lastContext = null;
let contextCheckInterval = null;

// ==================== CONTEXT DETECTION ====================
// Cache of last-known good context fields per RO ID. Tekmetric hides the VIN
// (and sometimes mileage) in the DOM when the user switches to the Inspections
// tab, so once we've ever seen these fields for an RO, we reuse them.
const roContextCache = new Map();

function rememberRoContext(ctx) {
  if (!ctx?.roId) return;
  const prior = roContextCache.get(ctx.roId) || {};
  const merged = {
    vin: ctx.vin || prior.vin || null,
    mileage: ctx.mileage || prior.mileage || null,
    vehicle: ctx.vehicle || prior.vehicle || null,
    vehicleDisplay: ctx.vehicleDisplay || prior.vehicleDisplay || null,
  };
  roContextCache.set(ctx.roId, merged);
  return merged;
}

function hydrateContextFromCache(ctx) {
  if (!ctx?.roId) return ctx;
  const cached = roContextCache.get(ctx.roId);
  if (!cached) return ctx;
  if (!ctx.vin && cached.vin) ctx.vin = cached.vin;
  if (!ctx.mileage && cached.mileage) ctx.mileage = cached.mileage;
  if (!ctx.vehicle && cached.vehicle) ctx.vehicle = cached.vehicle;
  if (!ctx.vehicleDisplay && cached.vehicleDisplay) ctx.vehicleDisplay = cached.vehicleDisplay;
  return ctx;
}

function detectContext() {
  const ctx = _detectContextRaw();
  rememberRoContext(ctx);
  hydrateContextFromCache(ctx);
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
    
    // Refresh page after short delay
    setTimeout(() => {
      window.location.reload();
    }, 1500);
    
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "PREFILL_DVI_COMPLETE") {
    console.log("[MOS Tools] DVI pre-fill complete:", message.result);
    resetPrefillButton();
    setTimeout(() => {
      window.location.reload();
    }, 2000);
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "PREFILL_DVI_FAILED") {
    resetPrefillButton();
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
    setTimeout(() => {
      window.location.reload();
    }, 2000);
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "ENHANCE_FINDINGS_FAILED") {
    resetEnhanceButton();
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
      let msg = `Added ${added} item${added === 1 ? '' : 's'} to RO`;
      if (skipped > 0) msg += ` · ${skipped} already present`;
      if (failed > 0) {
        const names = failedItems.slice(0, 2).map(f => f.title).filter(Boolean);
        msg += ` · ${failed} failed`;
        if (names.length) msg += ` (${names.join(', ')}${failed > names.length ? '…' : ''})`;
      }
      showToast(msg, failed > 0 ? 'warning' : 'success');
    } else if (skipped > 0 && failed === 0) {
      showToast(`All ${skipped} item${skipped === 1 ? '' : 's'} already on this RO — nothing added`, 'info');
    } else if (failed > 0) {
      const names = failedItems.slice(0, 2).map(f => f.title).filter(Boolean);
      const detail = names.length ? `: ${names.join(', ')}${failed > names.length ? '…' : ''}` : '';
      showToast(`Failed to add ${failed} item${failed === 1 ? '' : 's'}${detail}`, 'error');
    } else {
      showToast('No items added', 'info');
    }

    setTimeout(() => {
      window.location.reload();
    }, 1800);
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "BUILD_RO_FROM_VHI_FAILED") {
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
  
  // Fetch shop's configured intervals
  let intervals = [];
  let useKilometers = false;
  try {
    const result = await new Promise((resolve) => {
      safeSendMessage({
        action: 'MOS_API_REQUEST',
        endpoint: `/api/extension/sticker?shopId=${context.shopId}&provider=${context.provider || 'tekmetric'}`
      }, resolve);
    });
    
    if (result && result.config) {
      useKilometers = result.config.useKilometers === true;
      const unitLabel = useKilometers ? 'km' : 'mi';
      
      if (result.config.intervals) {
        const cfg = result.config.intervals;
        if (cfg.conventional) {
          intervals.push({ 
            label: `Conventional: ${cfg.conventional.mileage.toLocaleString()} ${unitLabel} / ${cfg.conventional.months} mo`, 
            miles: cfg.conventional.mileage, 
            months: cfg.conventional.months,
            type: 'conventional'
          });
        }
        if (cfg.synthetic) {
          intervals.push({ 
            label: `Synthetic: ${cfg.synthetic.mileage.toLocaleString()} ${unitLabel} / ${cfg.synthetic.months} mo`, 
            miles: cfg.synthetic.mileage, 
            months: cfg.synthetic.months,
            type: 'synthetic'
          });
        }
        if (cfg.euro) {
          intervals.push({ 
            label: `Euro: ${cfg.euro.mileage.toLocaleString()} ${unitLabel} / ${cfg.euro.months} mo`, 
            miles: cfg.euro.mileage, 
            months: cfg.euro.months,
            type: 'euro'
          });
        }
        if (cfg.diesel) {
          intervals.push({ 
            label: `Diesel: ${cfg.diesel.mileage.toLocaleString()} ${unitLabel} / ${cfg.diesel.months} mo`, 
            miles: cfg.diesel.mileage, 
            months: cfg.diesel.months,
            type: 'diesel'
          });
        }
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
  // Message background to open side panel to sticker tab
  safeSendMessage({
    action: 'OPEN_STICKER_PANEL',
    context: detectContext()
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

function checkAndInjectButton() {
  const context = detectContext();
  if (context.roId && !printButtonInjected) {
    setTimeout(injectPrintButton, 1000);
  } else if (!context.roId) {
    const existingButton = document.getElementById('mos-print-button');
    if (existingButton) {
      existingButton.remove();
      printButtonInjected = false;
    }
  }
  if (context.roId) {
    fetchShopFeatures(context.shopId, (features) => {
      if (features.dvi_prefill) setTimeout(injectPrefillButton, 200);
      if (features.enhance_notes) setTimeout(injectEnhanceButton, 400);
      if (features.dvi_prefill) setTimeout(injectBuildRoFromVhiButton, 600);
    });
  } else {
    const existingPrefill = document.getElementById('mos-prefill-dvi-btn');
    if (existingPrefill) existingPrefill.remove();
    prefillButtonInjected = false;
    prefillInFlight = false;
    const existingEnhance = document.getElementById('mos-enhance-notes-btn');
    if (existingEnhance) existingEnhance.remove();
    enhanceButtonInjected = false;
    enhanceInFlight = false;
    const existingBuild = document.getElementById('mos-build-ro-vhi-btn');
    if (existingBuild) existingBuild.remove();
    buildRoFromVhiButtonInjected = false;
    buildRoFromVhiInFlight = false;
    cachedFeatures = null;
  }
}

let prefillButtonInjected = false;
let cachedFeatures = null;
let featuresFetchInFlight = false;

function fetchShopFeatures(shopId, callback) {
  if (cachedFeatures) { callback(cachedFeatures); return; }
  if (featuresFetchInFlight) return;
  featuresFetchInFlight = true;
  safeSendMessage({ action: 'GET_SHOP_FEATURES', shopId, provider: 'tekmetric' }, (resp) => {
    featuresFetchInFlight = false;
    if (resp && resp.success) {
      cachedFeatures = resp.features;
    } else {
      cachedFeatures = {};
    }
    callback(cachedFeatures);
  });
}

function injectPrefillButton() {
  if (prefillButtonInjected) return;
  if (document.getElementById('mos-prefill-dvi-btn')) {
    prefillButtonInjected = true;
    return;
  }

  const context = detectContext();
  if (!context.roId) return;

  let targetContainer = null;
  const allButtons = document.querySelectorAll('button');
  for (const btn of allButtons) {
    const svg = btn.querySelector('svg');
    if (svg) {
      const svgContent = svg.innerHTML.toLowerCase();
      if (svgContent.includes('polyline') && svgContent.includes('rect') &&
          (btn.title?.toLowerCase().includes('print') ||
           btn.getAttribute('aria-label')?.toLowerCase().includes('print') ||
           svgContent.includes('6 9 6 2 18 2 18 9'))) {
        targetContainer = btn.parentElement;
        break;
      }
    }
    if (btn.dataset.testid?.includes('print') ||
        btn.className?.includes('print') ||
        btn.title?.toLowerCase() === 'print') {
      targetContainer = btn.parentElement;
      break;
    }
  }

  if (!targetContainer) {
    const iconRows = document.querySelectorAll('[class*="IconButton"], [class*="icon-button"], [class*="action-bar"]');
    for (const row of iconRows) {
      if (row.querySelectorAll('button').length >= 2) {
        targetContainer = row;
        break;
      }
    }
  }

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

function injectEnhanceButton() {
  if (enhanceButtonInjected) return;
  if (document.getElementById('mos-enhance-notes-btn')) {
    enhanceButtonInjected = true;
    return;
  }

  const context = detectContext();
  if (!context.roId) return;

  const prefillBtn = document.getElementById('mos-prefill-dvi-btn');
  const targetContainer = prefillBtn?.parentElement;
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
  const btn = document.getElementById('mos-enhance-notes-btn');
  if (btn) {
    btn.disabled = false;
    btn.style.opacity = '1';
    btn.style.cursor = 'pointer';
  }
}

function showEnhanceReviewModal(enhanced, inspectionId, context) {
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
  cancelBtn.addEventListener('click', () => {
    overlay.remove();
    resetEnhanceButton();
  });

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
    if (e.target === overlay) {
      overlay.remove();
      resetEnhanceButton();
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
  const targetContainer = prefillBtn?.parentElement;
  if (!targetContainer) return;

  const btn = document.createElement('button');
  btn.id = 'mos-build-ro-vhi-btn';
  btn.title = 'Build estimate from VHI (overdue + due-soon services)';
  btn.type = 'button';
  // Use a simple emoji-style SVG fallback so we don't require a new icon asset.
  btn.innerHTML = `
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#8B5CF6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
      <polyline points="14 2 14 8 20 8"/>
      <line x1="9" y1="13" x2="15" y2="13"/>
      <line x1="9" y1="17" x2="15" y2="17"/>
      <line x1="12" y1="10" x2="12" y2="10.01"/>
    </svg>`;

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
  header.innerHTML = `<div style="font-size:16px;font-weight:600;color:#111">Build estimate from VHI <span style="color:#6b7280;font-weight:400;font-size:13px">(${summary.overdue || 0} overdue, ${summary.dueSoon || 0} due soon)</span></div>`;

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
  const matched = (preview.summary && preview.summary.matchedCannedJobs) || 0;
  const total = proposed.length;
  const matchedNote = matched > 0
    ? `${matched} of ${total} jobs were pre-populated with parts and labor from your shop's canned jobs; the rest use a placeholder labor line. `
    : '';
  subhead.textContent = `Each selected item adds a customer concern and a job to this RO. ${matchedNote}Items already added in a prior run will be skipped automatically.`;
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

    const jobRow = document.createElement('div');
    Object.assign(jobRow.style, { fontSize: '12px', color: '#374151', lineHeight: '1.4' });
    const laborSummary = (item.job?.labor || []).map(l => `${l.name} (${l.hours}h)`).join(', ') || '—';
    const partsCount = (item.job?.parts || []).length;
    const cannedSrc = item.job && item.job.cannedJobSource;
    const sourceTag = cannedSrc
      ? ` <span style="font-size:10px;color:#065f46;background:#d1fae5;padding:1px 6px;border-radius:8px;margin-left:6px">from canned job</span>`
      : ` <span style="font-size:10px;color:#92400e;background:#fef3c7;padding:1px 6px;border-radius:8px;margin-left:6px">placeholder labor</span>`;
    jobRow.innerHTML = `<span style="font-weight:500;color:#6b7280">JOB:</span> ${escapeHtml(item.job?.name || item.title)}${sourceTag} — labor: ${escapeHtml(laborSummary)}${partsCount > 0 ? `, ${partsCount} part(s)` : ''}`;
    card.appendChild(jobRow);

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
  cancelBtn.addEventListener('click', () => {
    overlay.remove();
    resetBuildRoFromVhiButton();
  });

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
      markerPrefix: preview.markerPrefix || '[ai-suggested from VHI',
    }, () => {});
  });

  footer.appendChild(cancelBtn);
  footer.appendChild(applyBtn);
  modal.appendChild(footer);
  overlay.appendChild(modal);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      overlay.remove();
      resetBuildRoFromVhiButton();
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

function injectFloatingButton() {
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
  fab.innerHTML = `<img src="${imgUrl}" alt="Detect Dog" style="width: 40px; height: 40px; object-fit: contain; border-radius: 4px;" />`;
  
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
    padding: '2px',
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
  
  // Inject floating action button
  injectFloatingButton();
  
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
