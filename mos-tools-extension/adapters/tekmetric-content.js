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

    // Look for mileage
    const mileageElements = document.querySelectorAll('[data-testid*="mileage"], [data-testid*="miles"]');
    for (const el of mileageElements) {
      const mileageMatch = el.textContent.match(/[\d,]+/);
      if (mileageMatch) {
        context.mileage = parseInt(mileageMatch[0].replace(/,/g, ''));
        break;
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
  
  // Create the MOS Print button - icon-only style to match Tekmetric's UI
  const button = document.createElement('button');
  button.id = 'mos-print-button';
  button.title = 'MOS Oil Sticker\nLeft-click: Print | Right-click: Customize';
  button.type = 'button';
  button.innerHTML = `
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <polyline points="6 9 6 2 18 2 18 9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      <rect x="6" y="14" width="12" height="8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  `;
  
  Object.assign(button.style, {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '32px',
    height: '32px',
    padding: '0',
    backgroundColor: '#EA580C',
    color: 'white',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    marginLeft: '4px',
    transition: 'background-color 0.2s'
  });
  
  button.addEventListener('mouseenter', () => {
    button.style.backgroundColor = '#C2410C';
  });
  
  button.addEventListener('mouseleave', () => {
    button.style.backgroundColor = '#EA580C';
  });
  
  // Left-click: Immediate print
  button.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    handleImmediatePrint();
  });
  
  // Right-click: Open side panel to sticker tab
  button.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openStickerPanel();
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
      showToast('Sticker printed!', 'success');
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
