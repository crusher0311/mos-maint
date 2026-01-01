// MOS Tools Extension - Background Service Worker
// Manages SMS session tokens, MOS authentication, and message routing

// ==================== STATE MANAGEMENT ====================
let mosApiToken = null;
let mosApiUrl = null;
let currentSmsContext = null;

// SMS-specific session tokens (memory-only for security)
const smsTokens = {
  tekmetric: null,
  protractor: null,
  autoflow: null
};

// Tekmetric-specific state
let tekmetricShopId = null;
let tekmetricBaseUrl = null;

// ==================== PERSISTENCE ====================
// Restore MOS auth on startup
chrome.storage.local.get(['mosApiToken', 'mosApiUrl', 'mosUser'], (result) => {
  if (result.mosApiToken) {
    mosApiToken = result.mosApiToken;
    console.log("[MOS] Restored API token from storage");
  }
  if (result.mosApiUrl) {
    mosApiUrl = result.mosApiUrl;
    console.log("[MOS] Restored API URL:", mosApiUrl);
  }
});

// Restore SMS context from session storage (survives service worker restarts within session)
chrome.storage.session.get(['tekmetricToken', 'tekmetricShopId', 'tekmetricBaseUrl', 'currentSmsContext'], (result) => {
  if (result.tekmetricToken) {
    smsTokens.tekmetric = result.tekmetricToken;
    console.log("[Tekmetric] Restored session token");
  }
  if (result.tekmetricShopId) {
    tekmetricShopId = result.tekmetricShopId;
  }
  if (result.tekmetricBaseUrl) {
    tekmetricBaseUrl = result.tekmetricBaseUrl;
  }
  if (result.currentSmsContext) {
    currentSmsContext = result.currentSmsContext;
  }
});

// ==================== TEKMETRIC TOKEN CAPTURE ====================
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    // Capture base URL
    try {
      const url = new URL(details.url);
      if (url.hostname.includes('tekmetric.com')) {
        tekmetricBaseUrl = url.origin;
        chrome.storage.session.set({ tekmetricBaseUrl });
      }
    } catch (e) {}
    
    // Capture shop ID from URL
    const shopMatch = details.url.match(/\/(?:token\/)?shop\/(\d+)/);
    if (shopMatch) {
      tekmetricShopId = shopMatch[1];
      chrome.storage.session.set({ tekmetricShopId });
      console.log("[Tekmetric] Shop ID captured:", tekmetricShopId);
    }

    // Capture auth token from header (memory + session storage only)
    const tokenHeader = details.requestHeaders.find(
      (h) => h.name.toLowerCase() === "x-auth-token"
    );
    if (tokenHeader && tokenHeader.value) {
      smsTokens.tekmetric = tokenHeader.value;
      chrome.storage.session.set({ tekmetricToken: tokenHeader.value });
      console.log("[Tekmetric] Auth token captured");
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

// ==================== SIDE PANEL BEHAVIOR ====================
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  .then(() => console.log('[MOS] Side panel opens on action click'))
  .catch((error) => console.error('[MOS] Failed to set side panel behavior:', error));

// ==================== MESSAGE HANDLERS ====================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Handle keepalive ping silently
  if (message.action === "PING") {
    sendResponse({ pong: true });
    return false;
  }
  
  console.log("[MOS] Message received:", message.action);

  // -------------------- MOS Authentication --------------------
  if (message.action === "MOS_LOGIN") {
    handleMosLogin(message.email, message.password, message.apiUrl)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "MOS_LOGOUT") {
    mosApiToken = null;
    chrome.storage.local.remove(['mosApiToken', 'mosUser']);
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "GET_MOS_AUTH") {
    sendResponse({
      isAuthenticated: !!mosApiToken,
      apiUrl: mosApiUrl
    });
    return false;
  }

  // -------------------- SMS Context --------------------
  if (message.action === "SET_SMS_CONTEXT") {
    currentSmsContext = message.context;
    chrome.storage.session.set({ currentSmsContext });
    console.log("[MOS] SMS context updated:", currentSmsContext);
    
    // Notify side panel of context change
    chrome.runtime.sendMessage({ 
      action: "SMS_CONTEXT_CHANGED", 
      context: currentSmsContext 
    }).catch(() => {});
    
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "GET_SMS_CONTEXT") {
    sendResponse({
      context: currentSmsContext,
      hasToken: !!smsTokens[currentSmsContext?.provider]
    });
    return false;
  }

  // -------------------- MOS API Calls --------------------
  if (message.action === "MOS_API_REQUEST") {
    handleMosApiRequest(message.endpoint, message.options)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // -------------------- Tekmetric API Calls --------------------
  if (message.action === "TEKMETRIC_API_REQUEST") {
    handleTekmetricApiRequest(message.endpoint, message.options)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "CREATE_TEKMETRIC_JOB") {
    createTekmetricJob(message.shopId, message.roId, message.jobData)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "GET_TEKMETRIC_STATE") {
    sendResponse({
      hasToken: !!smsTokens.tekmetric,
      shopId: tekmetricShopId,
      baseUrl: tekmetricBaseUrl
    });
    return false;
  }
});

// ==================== MOS API FUNCTIONS ====================
async function handleMosLogin(email, password, apiUrl) {
  try {
    // Remove trailing slash from API URL
    mosApiUrl = (apiUrl || 'https://mos.tools').replace(/\/+$/, '');
    
    const response = await fetch(`${mosApiUrl}/api/extension/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || `Login failed: ${response.status}`);
    }

    const data = await response.json();
    mosApiToken = data.token;
    
    // Persist auth
    chrome.storage.local.set({
      mosApiToken: data.token,
      mosApiUrl: mosApiUrl,
      mosUser: data.user
    });

    console.log("[MOS] Login successful:", data.user?.email);
    return { success: true, user: data.user };
  } catch (err) {
    console.error("[MOS] Login error:", err);
    throw err;
  }
}

async function handleMosApiRequest(endpoint, options = {}) {
  if (!mosApiToken) {
    throw new Error("Not authenticated with MOS");
  }

  const response = await fetch(`${mosApiUrl}${endpoint}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${mosApiToken}`,
      'Content-Type': 'application/json',
      ...options.headers
    }
  });

  // Handle 401 - token expired
  if (response.status === 401) {
    mosApiToken = null;
    chrome.storage.local.remove(['mosApiToken']);
    throw new Error("Session expired. Please login again.");
  }

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error || `API error: ${response.status}`);
  }

  return response.json();
}

// ==================== TEKMETRIC API FUNCTIONS ====================
async function handleTekmetricApiRequest(endpoint, options = {}) {
  if (!smsTokens.tekmetric) {
    throw new Error("No Tekmetric session. Please navigate to a repair order first.");
  }

  const baseUrl = tekmetricBaseUrl || "https://shop.tekmetric.com";
  
  const response = await fetch(`${baseUrl}${endpoint}`, {
    ...options,
    headers: {
      'x-auth-token': smsTokens.tekmetric,
      'Content-Type': 'application/json',
      ...options.headers
    }
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Tekmetric API error ${response.status}: ${errorText}`);
  }

  return response.json();
}

async function createTekmetricJob(shopId, roId, jobData) {
  if (!smsTokens.tekmetric) {
    return { success: false, error: "No Tekmetric session. Navigate to a repair order first." };
  }

  const baseUrl = tekmetricBaseUrl || "https://shop.tekmetric.com";
  const effectiveShopId = shopId || tekmetricShopId;

  if (!effectiveShopId || !roId) {
    return { success: false, error: "Missing shop ID or repair order ID" };
  }

  try {
    // First fetch RO to get labor rate and vehicle info
    const roRes = await fetch(`${baseUrl}/api/shop/${effectiveShopId}/repair-order/${roId}`, {
      headers: {
        "x-auth-token": smsTokens.tekmetric,
        "content-type": "application/json"
      }
    });

    if (!roRes.ok) {
      return { success: false, error: `Failed to fetch repair order: ${roRes.status}` };
    }

    const roData = await roRes.json();
    const laborRate = roData.laborRate || 15000; // Default $150/hr in cents

    // Build labor items
    const laborItems = (jobData.laborItems || []).map(item => ({
      tempId: Math.random(),
      jobId: null,
      name: item.name || item.description || "Labor",
      hours: parseFloat(item.hours) || 1,
      rate: laborRate,
      technician: roData.defaultTechnician || null
    }));

    // Build parts items
    const partsItems = (jobData.parts || []).map(part => ({
      tempId: Math.random(),
      jobId: null,
      name: part.name || part.description || "Part",
      partNumber: part.partNumber || "",
      oemPartNumber: "",
      brand: part.brand || "",
      cost: Math.round((parseFloat(part.cost) || 0) * 100),
      quantity: parseInt(part.quantity) || 1,
      retail: Math.round((parseFloat(part.retail) || parseFloat(part.price) || 0) * 100),
      position: "",
      partType: { id: 1, code: "PART" }
    }));

    const vehicleDesc = roData.vehicle 
      ? `${roData.vehicle.year} ${roData.vehicle.make} ${roData.vehicle.model}`.trim()
      : "";

    const jobPayload = {
      repairOrderId: parseInt(roId),
      repairOrderNumber: roData.repairOrderNumber,
      repairOrderVehicleDescription: vehicleDesc,
      name: jobData.name || jobData.jobName || "New Job",
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

    console.log("[Tekmetric] Creating job:", jobPayload.name);

    const createRes = await fetch(`${baseUrl}/api/shop/${effectiveShopId}/job`, {
      method: "POST",
      headers: {
        "x-auth-token": smsTokens.tekmetric,
        "content-type": "application/json",
        "accept": "application/json"
      },
      body: JSON.stringify(jobPayload)
    });

    if (!createRes.ok) {
      const errorText = await createRes.text();
      return { success: false, error: `Failed to create job: ${createRes.status} - ${errorText}` };
    }

    const createdJob = await createRes.json();
    console.log("[Tekmetric] Job created:", createdJob.id);

    // Notify content script to refresh the page
    chrome.tabs.query({ url: "*://*.tekmetric.com/*" }, (tabs) => {
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, { 
          action: "JOB_CREATED",
          jobId: createdJob.id,
          jobName: createdJob.name
        }).catch(() => {});
      }
    });

    return { 
      success: true, 
      jobId: createdJob.id,
      jobName: createdJob.name,
      laborCount: laborItems.length,
      partsCount: partsItems.length
    };

  } catch (err) {
    console.error("[Tekmetric] Error creating job:", err);
    return { success: false, error: err.message };
  }
}

console.log("[MOS Tools] Background service worker loaded");
