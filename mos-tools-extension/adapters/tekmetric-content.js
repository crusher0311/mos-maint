// MOS Tools - Tekmetric Content Script
// Detects RO context and communicates with background worker

console.log("[MOS Tools] Tekmetric content script loaded");

let lastContext = null;
let contextCheckInterval = null;

// ==================== CONTEXT DETECTION ====================
function detectContext() {
  const url = window.location.href;
  const context = {
    provider: "tekmetric",
    shopId: null,
    roId: null,
    roNumber: null,
    vin: null,
    vehicle: null,
    vehicleDisplay: null,
    customer: null,
    customerName: null,
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

    // ============ EXTRACT CUSTOMER NAME ============
    // Strategy 1: Look for Tekmetric-specific customer elements
    const customerSelectors = [
      '[data-testid*="customer-name"]',
      '[data-testid*="customerName"]',
      '[data-testid*="customer"]',
      '[class*="CustomerName"]',
      '[class*="customer-name"]',
      '[class*="customerInfo"]',
      '[class*="customer-info"]',
      'a[href*="/customers/"]'
    ];
    
    for (const sel of customerSelectors) {
      const elements = document.querySelectorAll(sel);
      for (const el of elements) {
        const text = el.textContent?.trim() || '';
        // Look for a name pattern (2-3 words starting with capitals)
        const nameMatch = text.match(/^([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+){1,2})$/);
        if (nameMatch && nameMatch[1].length > 3 && nameMatch[1].length < 50) {
          context.customerName = nameMatch[1];
          context.customer = { name: context.customerName };
          console.log('[MOS Tools] Customer name extracted via selector:', sel, context.customerName);
          break;
        }
      }
      if (context.customerName) break;
    }
    
    // Strategy 2: Look for customer link in breadcrumb or header
    if (!context.customerName) {
      const customerLinks = document.querySelectorAll('a[href*="/customer"]');
      for (const link of customerLinks) {
        const text = link.textContent?.trim() || '';
        // Must look like a name (not "View Customer" etc)
        if (text.length > 3 && text.length < 40 && /^[A-Z][a-zA-Z'-]+\s+[A-Z]/.test(text)) {
          context.customerName = text;
          context.customer = { name: context.customerName };
          console.log('[MOS Tools] Customer name extracted via customer link:', context.customerName);
          break;
        }
      }
    }
    
    // Strategy 3: Search page text for "Customer:" or "Owner:" label
    if (!context.customerName) {
      const customerPatterns = [
        /Customer[:\s]+([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+){1,2})/,
        /Owner[:\s]+([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+){1,2})/
      ];
      
      for (const pattern of customerPatterns) {
        const match = pageText.match(pattern);
        if (match && match[1]) {
          context.customerName = match[1].trim();
          context.customer = { name: context.customerName };
          console.log('[MOS Tools] Customer name extracted via label pattern:', context.customerName);
          break;
        }
      }
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
      chrome.runtime.sendMessage({ 
        action: "SET_SMS_CONTEXT", 
        context 
      }).catch(() => {});
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

  if (message.action === "INJECT_CONCERN_TEXT") {
    console.log("[MOS Tools] Injecting concern text into RO");
    const injected = injectConcernText(message.text);
    sendResponse({ success: injected });
    return false;
  }

  if (message.type === "REFRESH_LABOR_RATE_UI") {
    console.log("[MOS Tools] Labor rate updated, refreshing page");
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
  chrome.runtime.sendMessage({
    action: 'PRINT_STICKER_IMMEDIATE',
    context: {
      ...context,
      vehicle: getVehicleDetails()
    }
  }, (response) => {
    if (response && response.success) {
      // Print via iframe
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
  try {
    const result = await new Promise((resolve) => {
      chrome.runtime.sendMessage({
        action: 'MOS_API_REQUEST',
        endpoint: `/api/extension/sticker?shopId=${context.shopId}&provider=${context.provider || 'tekmetric'}`
      }, resolve);
    });
    
    if (result && result.config && result.config.intervals) {
      const cfg = result.config.intervals;
      // Build intervals from shop config
      if (cfg.conventional) {
        intervals.push({ 
          label: `Conventional: ${cfg.conventional.mileage.toLocaleString()} mi / ${cfg.conventional.months} mo`, 
          miles: cfg.conventional.mileage, 
          months: cfg.conventional.months,
          type: 'conventional'
        });
      }
      if (cfg.synthetic) {
        intervals.push({ 
          label: `Synthetic: ${cfg.synthetic.mileage.toLocaleString()} mi / ${cfg.synthetic.months} mo`, 
          miles: cfg.synthetic.mileage, 
          months: cfg.synthetic.months,
          type: 'synthetic'
        });
      }
      if (cfg.euro) {
        intervals.push({ 
          label: `Euro: ${cfg.euro.mileage.toLocaleString()} mi / ${cfg.euro.months} mo`, 
          miles: cfg.euro.mileage, 
          months: cfg.euro.months,
          type: 'euro'
        });
      }
      if (cfg.diesel) {
        intervals.push({ 
          label: `Diesel: ${cfg.diesel.mileage.toLocaleString()} mi / ${cfg.diesel.months} mo`, 
          miles: cfg.diesel.mileage, 
          months: cfg.diesel.months,
          type: 'diesel'
        });
      }
    }
  } catch (err) {
    console.error('[MOS] Failed to fetch sticker config:', err);
  }
  
  // Fallback to defaults if no intervals fetched
  if (intervals.length === 0) {
    intervals = [
      { label: 'Conventional: 3,000 mi / 3 mo', miles: 3000, months: 3, type: 'conventional' },
      { label: 'Synthetic: 5,000 mi / 6 mo', miles: 5000, months: 6, type: 'synthetic' },
      { label: 'Euro: 10,000 mi / 12 mo', miles: 10000, months: 12, type: 'euro' },
      { label: 'Diesel: 7,500 mi / 6 mo', miles: 7500, months: 6, type: 'diesel' }
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
        handleImmediatePrintWithInterval(interval.miles, interval.months);
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

function handleImmediatePrintWithInterval(miles, months) {
  const context = detectContext();
  if (!context.roId || !context.shopId) {
    showToast('No repair order detected', 'error');
    return;
  }
  
  showToast(`Generating sticker (${miles.toLocaleString()} mi)...`, 'info');
  
  // Send message to background to generate and print sticker with custom interval
  chrome.runtime.sendMessage({
    action: 'PRINT_STICKER_IMMEDIATE',
    context: {
      ...context,
      vehicle: getVehicleDetails()
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
  chrome.runtime.sendMessage({
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
    // Delay to ensure page is fully loaded
    setTimeout(injectPrintButton, 1000);
  } else if (!context.roId) {
    // Remove button if we navigated away from RO
    const existingButton = document.getElementById('mos-print-button');
    if (existingButton) {
      existingButton.remove();
      printButtonInjected = false;
    }
  }
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
  fab.title = 'Open MOS Tools';
  fab.type = 'button';
  
  const imgUrl = chrome.runtime.getURL('icons/mos-fab.png');
  fab.innerHTML = `<img src="${imgUrl}" alt="MOS Tools" style="width: 40px; height: 40px; object-fit: contain; border-radius: 4px;" />`;
  
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
  // Send message to background to open the side panel
  chrome.runtime.sendMessage({ action: 'OPEN_SIDE_PANEL' }, (response) => {
    if (chrome.runtime.lastError) {
      console.log('[MOS Tools] Could not open side panel:', chrome.runtime.lastError.message);
    }
  });
}

// ==================== INITIALIZATION ====================
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
}

// ==================== CONCERN INJECTION ====================
function injectConcernText(text) {
  const selectors = [
    'textarea[name*="concern"]',
    'textarea[name*="complaint"]',
    'textarea[placeholder*="concern"]',
    'textarea[placeholder*="complaint"]',
    'textarea[placeholder*="Concern"]',
    'textarea[placeholder*="Complaint"]',
    'textarea[data-testid*="concern"]',
    'textarea[data-testid*="complaint"]',
    'textarea[aria-label*="concern"]',
    'textarea[aria-label*="Concern"]',
    '.customer-concern textarea',
    '.concern-textarea',
    '[class*="concern"] textarea',
    '[class*="complaint"] textarea'
  ];

  let textarea = null;
  for (const sel of selectors) {
    textarea = document.querySelector(sel);
    if (textarea) break;
  }

  if (!textarea) {
    const allTextareas = document.querySelectorAll('textarea');
    for (const ta of allTextareas) {
      const label = ta.closest('label') || ta.closest('.form-group')?.querySelector('label');
      if (label && /concern|complaint/i.test(label.textContent)) {
        textarea = ta;
        break;
      }
    }
  }

  if (!textarea) {
    const allTextareas = document.querySelectorAll('textarea');
    if (allTextareas.length === 1) {
      textarea = allTextareas[0];
    }
  }

  if (textarea) {
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value'
    ).set;
    nativeInputValueSetter.call(textarea, text);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
    textarea.focus();
    showToast('Customer concern injected into RO', 'success');
    return true;
  }

  showToast('Could not find concern field. Text copied to clipboard.', 'warning');
  navigator.clipboard.writeText(text).catch(() => {});
  return false;
}

// Wait for page to be ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
