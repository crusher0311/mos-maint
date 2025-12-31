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

  // Check for context changes on URL changes (SPA navigation)
  let lastUrl = window.location.href;
  contextCheckInterval = setInterval(() => {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      updateContext();
    }
  }, 500);

  // Also listen for popstate (browser back/forward)
  window.addEventListener('popstate', updateContext);
}

// Wait for page to be ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
