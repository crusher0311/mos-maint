let pendingJobData = null;

// ==================== LABOR RATE AUTO-UPDATE SECTION ====================
let tekmetricAuthToken = null;
let currentTekmetricShopId = null;
let currentTekmetricBaseUrl = null;
let lastProcessedRoId = null;

// Restore persisted Tekmetric context on service worker startup
chrome.storage.local.get(['tekmetricAuthToken', 'currentTekmetricShopId', 'currentTekmetricBaseUrl', 'lastProcessedRoId'], (result) => {
  if (result.tekmetricAuthToken) {
    tekmetricAuthToken = result.tekmetricAuthToken;
    console.log("[Background] Restored auth token from storage");
  }
  if (result.currentTekmetricShopId) {
    currentTekmetricShopId = result.currentTekmetricShopId;
    console.log("[Background] Restored shop ID from storage:", currentTekmetricShopId);
  }
  if (result.currentTekmetricBaseUrl) {
    currentTekmetricBaseUrl = result.currentTekmetricBaseUrl;
    console.log("[Background] Restored base URL from storage:", currentTekmetricBaseUrl);
  }
  if (result.lastProcessedRoId) {
    lastProcessedRoId = result.lastProcessedRoId;
  }
});

// Capture Tekmetric auth token, shop ID, and base URL from network requests
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    // Capture the base URL from the request (shop, sandbox, or cba)
    try {
      const url = new URL(details.url);
      currentTekmetricBaseUrl = url.origin;
      // Persist to storage
      chrome.storage.local.set({ currentTekmetricBaseUrl: currentTekmetricBaseUrl });
    } catch (e) {
      // Ignore URL parsing errors
    }
    
    // Match shop ID from URL patterns like /api/token/shop/123 or /api/shop/123
    const shopMatch = details.url.match(/\/(?:token\/)?shop\/(\d+)/);
    if (shopMatch) {
      currentTekmetricShopId = shopMatch[1];
      console.log("[Labor Rate] Shop ID captured:", currentTekmetricShopId);
      // Store for sidepanel to use AND persist for service worker restart
      chrome.storage.local.set({ currentTekmetricShopId: currentTekmetricShopId });
    }

    // Capture auth token from header AND persist it
    const tokenHeader = details.requestHeaders.find(
      (h) => h.name.toLowerCase() === "x-auth-token"
    );
    if (tokenHeader && tokenHeader.value) {
      tekmetricAuthToken = tokenHeader.value;
      console.log("[Labor Rate] Auth token captured and persisted");
      // Persist to storage so it survives service worker restarts
      chrome.storage.local.set({ tekmetricAuthToken: tokenHeader.value });
    }
  },
  {
    urls: [
      "https://shop.tekmetric.com/api/*",
      "https://sandbox.tekmetric.com/api/*",
      "https://cba.tekmetric.com/api/*"
    ],
    types: ["xmlhttprequest"]
  },
  ["requestHeaders"]
);

// Listen for repair order navigation/creation
chrome.webRequest.onCompleted.addListener(
  async (details) => {
    if (!tekmetricAuthToken || !currentTekmetricShopId) {
      console.log("[Labor Rate] Skipping - no auth token or shop ID");
      return;
    }

    let roId = null;
    let shopId = currentTekmetricShopId;

    // Match patterns for repair order URLs
    // Pattern 1: /shop/123/repair-order/456 or /sandbox/123/repair-order/456 or /cba/123/repair-order/456
    const shopRoMatch = details.url.match(/\/(?:sandbox|shop|cba)\/(\d+)\/repair-order\/(\d+)/);
    if (shopRoMatch) {
      shopId = shopRoMatch[1];
      roId = shopRoMatch[2];
    }

    // Pattern 2: /repair-order/456/estimate (new RO created)
    const newRoMatch = details.url.match(/\/repair-order\/(\d+)\/estimate/);
    if (newRoMatch) {
      roId = newRoMatch[1];
    }

    // Pattern 3: /api/shop/123/repair-order/456 (API calls for all environments)
    const apiRoMatch = details.url.match(/\/api\/(?:shop|sandbox|cba)\/(\d+)\/repair-order\/(\d+)/);
    if (apiRoMatch) {
      shopId = apiRoMatch[1];
      roId = apiRoMatch[2];
    }
    
    // Pattern 4: Generic repair-order API pattern (fallback with shopId from captured data)
    if (!roId) {
      const genericRoMatch = details.url.match(/\/repair-order\/(\d+)(?:\/|$)/);
      if (genericRoMatch && currentTekmetricShopId) {
        roId = genericRoMatch[1];
        shopId = currentTekmetricShopId;
        console.log(`[Labor Rate] Using fallback pattern with captured shopId: ${shopId}`);
      }
    }

    if (!roId) return;

    // Prevent duplicate processing
    if (lastProcessedRoId === roId) {
      console.log(`[Labor Rate] Skipping duplicate RO: ${roId}`);
      return;
    }
    lastProcessedRoId = roId;

    console.log("[Labor Rate] Repair order detected:", roId, "Shop:", shopId);
    await processLaborRateUpdate(shopId, roId);
  },
  {
    urls: [
      "https://shop.tekmetric.com/api/shop/*/repair-order/*",
      "https://sandbox.tekmetric.com/api/shop/*/repair-order/*",
      "https://cba.tekmetric.com/api/shop/*/repair-order/*",
      "https://shop.tekmetric.com/api/repair-order/*/estimate",
      "https://sandbox.tekmetric.com/api/repair-order/*/estimate",
      "https://cba.tekmetric.com/api/repair-order/*/estimate"
    ],
    types: ["xmlhttprequest"]
  }
);

async function processLaborRateUpdate(shopId, roId) {
  try {
    // Use the captured base URL (shop, sandbox, or cba) or fallback to shop.tekmetric.com
    const baseUrl = currentTekmetricBaseUrl || "https://shop.tekmetric.com";
    console.log("[Labor Rate] Using base URL:", baseUrl);
    
    // Fetch the repair order details
    const getRes = await fetch(`${baseUrl}/api/shop/${shopId}/repair-order/${roId}`, {
      headers: {
        "x-auth-token": tekmetricAuthToken,
        "content-type": "application/json"
      }
    });

    if (!getRes.ok) {
      console.error(`[Labor Rate] Failed to fetch RO: ${getRes.status}`);
      return;
    }

    const roData = await getRes.json();
    const currentRate = roData.laborRate;
    const make = roData.vehicle?.make?.toLowerCase();
    
    console.log(`[Labor Rate] Current rate: ${currentRate}, Vehicle make: ${make}`);

    if (!make) {
      console.log("[Labor Rate] No vehicle make found, skipping");
      return;
    }

    // Load saved labor rate groups from storage
    const data = await chrome.storage.local.get("laborRateGroups");
    const groups = data.laborRateGroups || [];

    if (groups.length === 0) {
      console.log("[Labor Rate] No labor rate groups configured");
      return;
    }

    // Find matching rate group
    let matchedRate = null;
    let matchedGroupName = null;

    for (const group of groups) {
      if (group.makes.some(m => m.toLowerCase() === make)) {
        matchedRate = group.laborRate;
        matchedGroupName = group.name;
        console.log(`[Labor Rate] Matched group '${group.name}' with rate: ${matchedRate}`);
        break;
      }
    }

    if (matchedRate === null) {
      console.log(`[Labor Rate] No matching group found for make: ${make}`);
      return;
    }

    // Apply labor rate if different
    if (currentRate !== matchedRate) {
      const payload = {
        laborRate: matchedRate,
        appointmentOption: roData.appointmentOption,
        customerTimeIn: roData.customerTimeIn,
        customerTimeOut: roData.customerTimeOut,
        defaultTechnicianId: roData.defaultTechnicianId,
        keytag: roData.keytag,
        leadSource: roData.leadSource,
        notes: roData.notes,
        poNumber: roData.poNumber,
        referrerId: roData.referrerId,
        referrerName: roData.referrerName,
        saveCustomerParts: roData.saveCustomerParts,
        serviceWriterId: roData.serviceWriterId
      };

      const putRes = await fetch(`${baseUrl}/api/repair-order/${roId}/summary`, {
        method: "PUT",
        headers: {
          "x-auth-token": tekmetricAuthToken,
          "content-type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      if (putRes.ok) {
        console.log(`[Labor Rate] Updated to $${(matchedRate / 100).toFixed(2)} (${matchedGroupName}) for RO: ${roId}`);

        // Notify content scripts to refresh UI
        chrome.tabs.query({ url: "*://*.tekmetric.com/*" }, (tabs) => {
          for (const tab of tabs) {
            chrome.tabs.sendMessage(tab.id, { 
              type: "REFRESH_LABOR_RATE_UI",
              rate: matchedRate,
              groupName: matchedGroupName
            }).catch(() => {
              // Content script may not be ready
            });
          }
        });
      } else {
        console.error(`[Labor Rate] Failed to update: ${putRes.status}`);
      }
    } else {
      console.log(`[Labor Rate] No change needed - rate already correct`);
    }
  } catch (err) {
    console.error("[Labor Rate] Error processing RO:", err);
  }
}

// ==================== END LABOR RATE SECTION ====================

// ==================== API-BASED JOB CREATION SECTION ====================

/**
 * Create a job in Tekmetric via direct API call
 * This is MUCH faster than UI automation (1-2 seconds vs 20-30 seconds)
 * 
 * @param {Object} params - Job creation parameters
 * @param {string} params.shopId - Tekmetric shop ID
 * @param {string} params.roId - Repair order ID
 * @param {Object} params.jobData - Job data from HEART Helper search
 * @returns {Promise<{success: boolean, error?: string, jobId?: number}>}
 */
async function createJobViaAPI({ shopId, roId, jobData }) {
  try {
    if (!tekmetricAuthToken) {
      return { success: false, error: "No Tekmetric auth token available. Please navigate to a repair order first." };
    }

    const baseUrl = currentTekmetricBaseUrl || "https://shop.tekmetric.com";
    console.log("[Job API] Creating job via API:", { shopId, roId, baseUrl });
    console.log("[Job API] Job data received:", jobData);

    // First, fetch the current RO to get vehicle info and other details
    const roRes = await fetch(`${baseUrl}/api/shop/${shopId}/repair-order/${roId}`, {
      headers: {
        "x-auth-token": tekmetricAuthToken,
        "content-type": "application/json"
      }
    });

    if (!roRes.ok) {
      console.error("[Job API] Failed to fetch RO:", roRes.status);
      return { success: false, error: `Failed to fetch repair order: ${roRes.status}` };
    }

    const roData = await roRes.json();
    console.log("[Job API] RO data fetched:", { 
      roNumber: roData.repairOrderNumber,
      vehicle: roData.vehicle?.year + " " + roData.vehicle?.make + " " + roData.vehicle?.model,
      laborRate: roData.laborRate
    });

    // Get the current labor rate from the RO (in cents)
    const laborRate = roData.laborRate || 15000; // Default to $150/hr if not set

    // Build the labor items array
    const laborItems = (jobData.laborItems || []).map(item => ({
      tempId: Math.random(),
      jobId: null,
      name: item.name || item.description || "Labor",
      hours: parseFloat(item.hours) || 1,
      rate: laborRate, // Use RO's labor rate
      technician: roData.defaultTechnician || null
    }));

    // Build the parts array
    const partsItems = (jobData.parts || []).map(part => ({
      tempId: Math.random(),
      jobId: null,
      name: part.name || part.description || "Part",
      partNumber: part.partNumber || "",
      oemPartNumber: "",
      brand: part.brand || "",
      cost: Math.round((parseFloat(part.cost) || 0) * 100), // Convert to cents
      quantity: parseInt(part.quantity) || 1,
      retail: Math.round((parseFloat(part.retail) || parseFloat(part.price) || 0) * 100), // Convert to cents
      position: "",
      partType: { id: 1, code: "PART" }
    }));

    // Build the vehicle description
    const vehicleDesc = roData.vehicle 
      ? `${roData.vehicle.year} ${roData.vehicle.make} ${roData.vehicle.model}`.trim()
      : "";

    // Build the job payload matching Tekmetric's expected structure
    // Use nullish coalescing (??) to respect RO values even when they're false
    const jobPayload = {
      repairOrderId: parseInt(roId),
      repairOrderNumber: roData.repairOrderNumber,
      repairOrderVehicleDescription: vehicleDesc,
      name: jobData.jobName || jobData.name || "New Job",
      status: "Pending",
      selected: true,
      archived: false,
      authorized: null,
      authorizedDate: null,
      milesOut: roData.milesOut ?? roData.vehicle?.mileageOut ?? null,
      technician: roData.defaultTechnician ?? null,
      labor: laborItems,
      parts: partsItems,
      discounts: [],
      fees: [],
      feeable: true,
      taxLabor: roData.taxLabor ?? false,
      taxParts: roData.taxParts ?? true,
      taxFees: roData.taxFees ?? true,
      taxTires: roData.taxTires ?? false,
      taxTiresFet: roData.taxTiresFet ?? true,
      note: jobData.note ?? null,
      notDeclined: true
    };

    console.log("[Job API] Sending job payload:", JSON.stringify(jobPayload, null, 2));

    // Create the job via POST
    const createRes = await fetch(`${baseUrl}/api/shop/${shopId}/job`, {
      method: "POST",
      headers: {
        "x-auth-token": tekmetricAuthToken,
        "content-type": "application/json",
        "accept": "application/json"
      },
      body: JSON.stringify(jobPayload)
    });

    if (!createRes.ok) {
      const errorText = await createRes.text();
      console.error("[Job API] Failed to create job:", createRes.status, errorText);
      return { success: false, error: `Failed to create job: ${createRes.status} - ${errorText}` };
    }

    const createdJob = await createRes.json();
    console.log("[Job API] Job created successfully:", createdJob.id, createdJob.name);

    return { 
      success: true, 
      jobId: createdJob.id,
      jobName: createdJob.name,
      laborCount: laborItems.length,
      partsCount: partsItems.length
    };

  } catch (err) {
    console.error("[Job API] Error creating job:", err);
    return { success: false, error: err.message };
  }
}

// ==================== END API JOB CREATION SECTION ====================

// Open side panel when extension icon is clicked
// This is the ONLY way to handle icon clicks - do NOT add chrome.action.onClicked
// as they are mutually exclusive
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  .then(() => console.log('Side panel behavior set: opens on action click'))
  .catch((error) => console.error('Failed to set side panel behavior:', error));

// Also set the side panel to be enabled for all tabs
chrome.sidePanel.setOptions({
  enabled: true
}).then(() => console.log('Side panel enabled for all tabs'))
  .catch((error) => console.error('Failed to enable side panel:', error));

// Create context menu on install - context menus preserve user gesture properly
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'openHeartHelper',
    title: 'Open HEART Helper',
    contexts: ['all']
  });
  console.log('Context menu created: Open HEART Helper');
});

// Handle context menu clicks - use tabId for proper side panel opening
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'openHeartHelper' && tab?.id) {
    console.log('Context menu clicked - opening side panel for tab:', tab.id);
    chrome.sidePanel.open({ tabId: tab.id })
      .then(() => console.log('Context menu: Side panel opened'))
      .catch((err) => console.error('Context menu: Failed to open side panel:', err));
  }
});

// Handle keyboard shortcut - this preserves user gesture!
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'open-side-panel' && tab?.id) {
    console.log('Keyboard shortcut pressed - opening side panel for tab:', tab.id);
    chrome.sidePanel.open({ tabId: tab.id })
      .then(() => console.log('Keyboard shortcut: Side panel opened'))
      .catch((err) => console.error('Keyboard shortcut: Failed to open side panel:', err));
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Log ALL messages for debugging
  console.log("📨 Message received:", message.action, "from tab:", sender.tab?.id);
  
  // Open side panel via extension page (workaround for user gesture requirement)
  if (message.action === "OPEN_SIDE_PANEL") {
    console.log("🚀 OPEN_SIDE_PANEL handler triggered for tab:", sender.tab?.id);
    
    if (sender.tab && sender.tab.id && sender.tab.windowId) {
      // Create a new tab with our extension page that will open the side panel
      // This is a workaround for the user gesture requirement
      const relayUrl = chrome.runtime.getURL(`sidepanel-opener.html?tabId=${sender.tab.id}&windowId=${sender.tab.windowId}`);
      console.log("Creating relay tab:", relayUrl);
      
      chrome.tabs.create({ 
        url: relayUrl, 
        active: false,
        index: 0 // Put at beginning so it's less intrusive
      }).then((tab) => {
        console.log("Relay tab created:", tab.id);
      }).catch((error) => {
        console.error("Failed to create relay tab:", error);
      });
    } else {
      console.error("No tab ID or window ID available from sender");
    }
    // No response needed, don't return true
    return false;
  }
  
  if (message.action === "SEND_TO_TEKMETRIC") {
    console.log("Background: Received job data from web app", message.payload);
    
    pendingJobData = message.payload;
    
    chrome.storage.local.set({ 
      lastJobData: message.payload,
      timestamp: new Date().toISOString()
    }, () => {
      console.log("Background: Job data stored successfully");
      sendResponse({ success: true });
    });
    
    return true; // Keep this because storage.set is async
  }
  
  if (message.action === "STORE_PENDING_JOB") {
    console.log("Background: Storing pending job from content script", message.jobData);
    pendingJobData = message.jobData;
    
    // CRITICAL: Store in chrome.storage.local, not just memory!
    // Service worker goes to sleep and memory is wiped
    chrome.storage.local.set({ 
      lastJobData: message.jobData,
      timestamp: new Date().toISOString()
    }, () => {
      console.log("Background: Job data stored in persistent storage");
      sendResponse({ success: true });
    });
    
    return true; // Async response
  }
  
  if (message.action === "GET_PENDING_JOB") {
    console.log("Background: Content script requesting pending job");
    // Get from storage instead of memory (service worker may have been reloaded)
    chrome.storage.local.get(['lastJobData'], (result) => {
      console.log("Background: Retrieved from storage:", result.lastJobData ? "Job found" : "No job");
      sendResponse({ jobData: result.lastJobData || null });
    });
    return true; // Async response
  }
  
  if (message.action === "CLEAR_PENDING_JOB") {
    console.log("Background: Clearing pending job");
    pendingJobData = null;
    chrome.storage.local.remove(['lastJobData'], () => {
      console.log("Background: Cleared job data from storage");
      sendResponse({ success: true });
    });
    return true; // Async response
  }
  
  if (message.action === "GET_LAST_JOB") {
    chrome.storage.local.get(['lastJobData', 'timestamp'], (result) => {
      sendResponse({ 
        jobData: result.lastJobData,
        timestamp: result.timestamp
      });
    });
    return true; // Keep this because storage.get is async
  }

  // API-based job creation - much faster than UI automation!
  if (message.action === "CREATE_JOB_VIA_API") {
    console.log("[Job API] Received CREATE_JOB_VIA_API message:", message);
    
    const { shopId, roId, jobData } = message;
    
    if (!shopId || !roId || !jobData) {
      sendResponse({ success: false, error: "Missing required parameters (shopId, roId, or jobData)" });
      return true;
    }

    // Use the captured shopId if not provided, or the one from the message
    const effectiveShopId = shopId || currentTekmetricShopId;
    
    if (!effectiveShopId) {
      sendResponse({ success: false, error: "No shop ID available. Please navigate to a repair order first." });
      return true;
    }

    createJobViaAPI({ shopId: effectiveShopId, roId, jobData })
      .then(result => {
        console.log("[Job API] Create job result:", result);
        
        // If successful, notify Tekmetric tabs to refresh
        if (result.success) {
          chrome.tabs.query({ url: "*://*.tekmetric.com/*" }, (tabs) => {
            for (const tab of tabs) {
              chrome.tabs.sendMessage(tab.id, { 
                type: "JOB_CREATED_VIA_API",
                jobId: result.jobId,
                jobName: result.jobName
              }).catch(() => {
                // Content script may not be ready
              });
            }
          });
        }
        
        sendResponse(result);
      })
      .catch(err => {
        console.error("[Job API] Error:", err);
        sendResponse({ success: false, error: err.message });
      });
    
    return true; // Async response
  }

  // Get current Tekmetric context (auth token status, shop ID, etc.)
  if (message.action === "GET_TEKMETRIC_CONTEXT") {
    sendResponse({
      hasAuthToken: !!tekmetricAuthToken,
      shopId: currentTekmetricShopId,
      baseUrl: currentTekmetricBaseUrl
    });
    return false;
  }

  // GET_VEHICLE_INFO - Fetch vehicle data from Tekmetric API (same pattern as labor rate)
  if (message.action === "GET_VEHICLE_INFO" || message.type === "GET_VEHICLE_INFO") {
    console.log("[Background] GET_VEHICLE_INFO received:", { 
      shopId: message.shopId, 
      roId: message.roId,
      hasToken: !!tekmetricAuthToken,
      storedShopId: currentTekmetricShopId
    });
    
    const shopId = message.shopId || currentTekmetricShopId;
    const roId = message.roId || lastProcessedRoId;
    
    if (!tekmetricAuthToken) {
      console.warn("[Background] No auth token - cannot fetch vehicle info");
      sendResponse({ year: null, make: null, model: null, engine: null, error: "No auth token" });
      return false;
    }
    
    if (!shopId || !roId) {
      console.warn("[Background] Missing shopId or roId:", { shopId, roId });
      sendResponse({ year: null, make: null, model: null, engine: null, error: "Missing shopId or roId" });
      return false;
    }
    
    const baseUrl = currentTekmetricBaseUrl || "https://shop.tekmetric.com";
    
    // Fetch RO data from Tekmetric API (same as labor rate tool)
    fetch(`${baseUrl}/api/shop/${shopId}/repair-order/${roId}`, {
      headers: {
        "x-auth-token": tekmetricAuthToken,
        "content-type": "application/json"
      }
    })
    .then(res => {
      if (!res.ok) throw new Error(`API returned ${res.status}`);
      return res.json();
    })
    .then(roData => {
      const vehicle = roData.vehicle || {};
      console.log("[Background] Vehicle info from API:", {
        year: vehicle.year,
        make: vehicle.make,
        model: vehicle.model,
        engine: vehicle.engineDescription || vehicle.engine,
        vin: vehicle.vin,
        mileageIn: roData.milesIn || roData.mileageIn
      });
      sendResponse({
        year: vehicle.year || null,
        make: vehicle.make || null,
        model: vehicle.model || null,
        engine: vehicle.engineDescription || vehicle.engine || null,
        vin: vehicle.vin || null,
        mileageIn: roData.milesIn || roData.mileageIn || null,
        shopId: shopId,
        roId: roId
      });
    })
    .catch(err => {
      console.error("[Background] Failed to fetch vehicle info:", err);
      sendResponse({ year: null, make: null, model: null, engine: null, error: err.message });
    });
    
    return true; // Async response
  }
});

console.log("Tekmetric Job Importer: Background service worker loaded (v3.23.0)");
