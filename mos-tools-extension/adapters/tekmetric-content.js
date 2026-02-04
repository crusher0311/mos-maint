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
    roNumber: null, // User-friendly RO number displayed on page
    vin: null,
    vehicle: null,
    customer: null,
    mileage: null
  };

  // Extract shop ID and RO ID from URL
  // Patterns: /admin/shop/123/repair-orders/456 or /shop/123/repair-orders/456
  const urlMatch = url.match(/\/(?:admin\/)?shop\/(\d+)\/repair-orders\/(\d+)/);
  if (urlMatch) {
    context.shopId = urlMatch[1];
    context.roId = urlMatch[2];
  }
  
  // Try to extract display RO number from page header
  // Look for "RO #4261:" pattern in specific elements first, then fallback to full page
  try {
    // Strategy 1: Look for RO number in h1/h2/h3 headers (most reliable)
    const headers = document.querySelectorAll('h1, h2, h3, [class*="Header"], [class*="Title"], [data-testid*="header"]');
    for (const header of headers) {
      const roNumMatch = header.textContent.match(/RO\s*#\s*(\d+)/i);
      if (roNumMatch) {
        context.roNumber = roNumMatch[1];
        break;
      }
    }
    
    // Strategy 2: Look for breadcrumb or page title area
    if (!context.roNumber) {
      const breadcrumbs = document.querySelectorAll('[class*="breadcrumb"], [class*="Breadcrumb"], nav');
      for (const bc of breadcrumbs) {
        const roNumMatch = bc.textContent.match(/RO\s*#\s*(\d+)/i);
        if (roNumMatch) {
          context.roNumber = roNumMatch[1];
          break;
        }
      }
    }
    
    // Strategy 3: Fallback to full page text search
    if (!context.roNumber) {
      const pageText = document.body?.innerText || '';
      const roNumMatch = pageText.match(/RO\s*#\s*(\d+)/i);
      if (roNumMatch) {
        context.roNumber = roNumMatch[1];
      }
    }
  } catch (e) {
    console.warn('[MOS Tools] Error extracting RO number:', e);
  }

  // Try to extract vehicle info from the page
  try {
    // Look for vehicle info in the page header
    const vehicleHeader = document.querySelector('[data-testid="vehicle-info"]') ||
                         document.querySelector('.vehicle-info') ||
                         document.querySelector('[class*="VehicleInfo"]');
    
    if (vehicleHeader) {
      const text = vehicleHeader.textContent;
      // Try to parse "2019 Honda Accord" format
      const vehicleMatch = text.match(/(\d{4})\s+(\w+)\s+(.+)/);
      if (vehicleMatch) {
        context.vehicle = {
          year: parseInt(vehicleMatch[1]),
          make: vehicleMatch[2],
          model: vehicleMatch[3].trim()
        };
      }
    }

    // Look for VIN
    const vinElements = document.querySelectorAll('[data-testid*="vin"], [class*="vin"]');
    for (const el of vinElements) {
      const vinMatch = el.textContent.match(/[A-HJ-NPR-Z0-9]{17}/i);
      if (vinMatch) {
        context.vin = vinMatch[0].toUpperCase();
        break;
      }
    }

    // Look for mileage - multiple strategies
    // Strategy 1: Look for data-testid elements
    const mileageElements = document.querySelectorAll('[data-testid*="mileage"], [data-testid*="miles"], [data-testid*="odometer"]');
    for (const el of mileageElements) {
      const mileageMatch = el.textContent.match(/[\d,]+/);
      if (mileageMatch) {
        context.mileage = parseInt(mileageMatch[0].replace(/,/g, ''));
        break;
      }
    }
    
    // Strategy 2: Look for "In:" or "Out:" mileage pattern in the header
    if (!context.mileage) {
      const headerArea = document.querySelector('[class*="Header"]') || 
                        document.querySelector('[class*="header"]') ||
                        document.querySelector('header') ||
                        document.body;
      const headerText = headerArea?.textContent || '';
      // Match patterns like "In: 40,238" or "Out: 40,238"
      const inOutMatch = headerText.match(/(?:In|Out):\s*([\d,]+)/i);
      if (inOutMatch) {
        context.mileage = parseInt(inOutMatch[1].replace(/,/g, ''));
      }
    }
    
    // Strategy 3: Look for any element containing mileage-like numbers near "In" or "Out" text
    if (!context.mileage) {
      const allElements = document.querySelectorAll('span, div, p');
      for (const el of allElements) {
        const text = el.textContent?.trim() || '';
        if (/^(In|Out):?\s*[\d,]+$/i.test(text)) {
          const match = text.match(/[\d,]+/);
          if (match) {
            const value = parseInt(match[0].replace(/,/g, ''));
            if (value > 1000 && value < 1000000) { // Reasonable mileage range
              context.mileage = value;
              break;
            }
          }
        }
      }
    }

  } catch (err) {
    console.log("[MOS Tools] Error parsing page context:", err);
  }

  return context;
}

function updateContext() {
  const context = detectContext();
  
  // Only send update if context changed
  const contextStr = JSON.stringify(context);
  if (contextStr !== JSON.stringify(lastContext)) {
    lastContext = context;
    
    if (context.roId) {
      console.log("[MOS Tools] RO context detected:", context);
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

// ==================== INITIALIZATION ====================
function init() {
  // Initial context check
  updateContext();
  
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

// Wait for page to be ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
