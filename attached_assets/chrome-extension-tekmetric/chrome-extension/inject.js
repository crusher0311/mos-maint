const allowedOrigins = [
  'http://localhost:5000',
  'https://localhost:5000',
];

if (window.location.hostname.endsWith('.replit.dev')) {
  allowedOrigins.push(window.location.origin);
}

chrome.storage.local.get(['appUrl'], (result) => {
  if (!result.appUrl) {
    chrome.storage.local.set({ 
      appUrl: window.location.origin 
    }, () => {
      console.log("Inject: Saved app URL to storage (first time):", window.location.origin);
    });
  } else {
    console.log("Inject: App URL already configured, not overwriting:", result.appUrl);
  }
});

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  
  const isAllowedOrigin = allowedOrigins.some(origin => 
    event.origin === origin || event.origin.endsWith('.replit.dev')
  );
  
  if (!isAllowedOrigin) {
    console.warn('Inject: Blocked message from untrusted origin:', event.origin);
    return;
  }
  
  if (event.data.action === "SEND_TO_TEKMETRIC") {
    console.log("Inject: Forwarding job data to background", event.data);
    
    // BACKUP: Also store directly to chrome.storage in case service worker is asleep
    chrome.storage.local.set({ 
      lastJobData: event.data.payload,
      timestamp: new Date().toISOString()
    }, () => {
      console.log("✅ Inject: Stored job data directly to chrome.storage.local (backup)");
    });
    
    // Forward to background script (primary method)
    chrome.runtime.sendMessage(event.data, (response) => {
      if (chrome.runtime.lastError) {
        console.error("❌ Inject: Error sending to background:", chrome.runtime.lastError);
      } else {
        console.log("✅ Inject: Background acknowledged:", response);
      }
    });
  }
});

console.log("Tekmetric Job Importer: Inject script loaded on repair search app");
