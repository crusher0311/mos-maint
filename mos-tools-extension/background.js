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

// Labor rate rules cache
let laborRateRules = [];
let laborRateRulesLastFetch = 0;
const LABOR_RULES_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
let laborRateAutoApply = true; // Default on
let lastAppliedRoId = null; // Prevent duplicate applications

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

// Restore labor rate auto-apply setting
chrome.storage.local.get(['laborRateAutoApply'], (result) => {
  if (result.laborRateAutoApply !== undefined) {
    laborRateAutoApply = result.laborRateAutoApply;
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
      const isNewToken = !smsTokens.tekmetric;
      smsTokens.tekmetric = tokenHeader.value;
      chrome.storage.session.set({ tekmetricToken: tokenHeader.value });
      console.log("[Tekmetric] Auth token captured");

      // If we just got the token and have a pending context, try auto-apply
      if (isNewToken && laborRateAutoApply && mosApiToken && currentSmsContext?.roId && currentSmsContext.roId !== lastAppliedRoId) {
        autoApplyLaborRate(currentSmsContext).catch(err => {
          console.warn("[LaborRate] Deferred auto-apply error:", err.message);
        });
      }
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

  // Open side panel from content script FAB
  if (message.action === "OPEN_SIDE_PANEL") {
    if (sender.tab?.id) {
      chrome.sidePanel.open({ tabId: sender.tab.id })
        .then(() => sendResponse({ success: true }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true; // async response
    }
    sendResponse({ success: false, error: 'No tab ID' });
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
    chrome.storage.local.get(['mosUser'], (result) => {
      sendResponse({
        isAuthenticated: !!mosApiToken,
        apiUrl: mosApiUrl,
        defaultExtensionTab: result.mosUser?.defaultExtensionTab || null
      });
    });
    return true;
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
    
    // Auto-apply labor rate if enabled and we have a new RO
    if (laborRateAutoApply && mosApiToken && currentSmsContext?.roId && currentSmsContext.roId !== lastAppliedRoId) {
      autoApplyLaborRate(currentSmsContext).catch(err => {
        console.warn("[LaborRate] Auto-apply error:", err.message);
      });
    }
    
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

  // -------------------- Default Tab Preference --------------------
  if (message.action === "SAVE_DEFAULT_TAB") {
    handleMosApiRequest('/api/extension/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultExtensionTab: message.tab })
    }).then(result => {
      chrome.storage.local.get(['mosUser'], (stored) => {
        const user = stored.mosUser || {};
        user.defaultExtensionTab = message.tab;
        chrome.storage.local.set({ mosUser: user });
      });
      sendResponse({ success: true, defaultExtensionTab: message.tab });
    }).catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }

  // -------------------- Labor Rate Rules --------------------
  if (message.action === "GET_LABOR_RATE_RULES") {
    fetchLaborRateRules()
      .then(rules => sendResponse({ success: true, rules }))
      .catch(err => sendResponse({ success: false, error: err.message, rules: [] }));
    return true;
  }

  if (message.action === "SET_LABOR_RATE_AUTO_APPLY") {
    laborRateAutoApply = !!message.enabled;
    chrome.storage.local.set({ laborRateAutoApply });
    console.log("[LaborRate] Auto-apply:", laborRateAutoApply ? "enabled" : "disabled");
    sendResponse({ success: true, enabled: laborRateAutoApply });
    return false;
  }

  if (message.action === "GET_LABOR_RATE_AUTO_APPLY") {
    sendResponse({ enabled: laborRateAutoApply });
    return false;
  }

  if (message.action === "SAVE_LABOR_RATE_RULES") {
    handleMosApiRequest('/api/extension/labor-rates', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rules: message.rules })
    }).then(result => {
      if (result.ok === false) {
        sendResponse({ success: false, error: result.error || 'Failed to save rules' });
        return;
      }
      laborRateRules = result.rules || [];
      laborRateRulesLastFetch = Date.now();
      sendResponse({ success: true, rules: laborRateRules });
    }).catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }

  if (message.action === "APPLY_LABOR_RATE_NOW") {
    if (!currentSmsContext?.roId) {
      sendResponse({ success: false, error: "No repair order context" });
      return false;
    }
    lastAppliedRoId = null; // Reset so it can re-apply
    autoApplyLaborRate(currentSmsContext)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // -------------------- Concern Assistant --------------------
  if (message.action === "INSERT_CONCERN") {
    (async () => {
      try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs[0]?.id) {
          await chrome.tabs.sendMessage(tabs[0].id, {
            action: 'INJECT_CONCERN_TEXT',
            text: message.text
          });
          sendResponse({ success: true });
        } else {
          sendResponse({ success: false, error: 'No active tab found' });
        }
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  // -------------------- Sticker Printing --------------------
  if (message.action === "PRINT_STICKER_IMMEDIATE") {
    handleImmediateStickerPrint(message.context, sender.tab?.id, message.overrideInterval)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "OPEN_STICKER_PANEL") {
    // Open side panel and notify it to switch to sticker tab
    if (sender.tab?.id) {
      chrome.sidePanel.open({ tabId: sender.tab.id }).then(() => {
        // Give panel time to load, then tell it to switch to sticker tab
        setTimeout(() => {
          chrome.runtime.sendMessage({ 
            action: 'SWITCH_TO_STICKER_TAB',
            context: message.context
          }).catch(() => {});
        }, 500);
      }).catch(err => console.error('[MOS] Failed to open side panel:', err));
    }
    sendResponse({ success: true });
    return false;
  }

  // Forward print request from sidepanel to content script
  if (message.action === "PRINT_STICKER_VIA_CONTENT") {
    // Get the active tab to send the sticker to
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, {
          action: 'PRINT_STICKER_FROM_PANEL',
          sticker: message.sticker
        }, (response) => {
          sendResponse(response || { success: false });
        });
      } else {
        sendResponse({ success: false, error: 'No active tab' });
      }
    });
    return true; // Async response
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

// ==================== STICKER PRINTING ====================
const EURO_MAKES = ['bmw', 'mercedes', 'mercedes-benz', 'audi', 'volkswagen', 'vw', 'porsche', 'mini', 'volvo', 'land rover', 'jaguar', 'alfa romeo', 'fiat', 'maserati', 'ferrari', 'lamborghini', 'bentley', 'rolls-royce', 'aston martin', 'mclaren'];

function detectOilType(vehicle) {
  if (!vehicle) return 'synthetic';
  
  const make = (vehicle.make || '').toLowerCase();
  const fuelType = (vehicle.fuelType || '').toLowerCase();
  const engine = (vehicle.engine || '').toLowerCase();
  
  // Check for diesel
  if (fuelType === 'diesel' || engine.includes('diesel') || engine.includes('tdi') || engine.includes('duramax') || engine.includes('powerstroke') || engine.includes('cummins')) {
    return 'diesel';
  }
  
  // Check for European vehicles
  if (EURO_MAKES.includes(make)) {
    return 'euro';
  }
  
  // Default to synthetic for modern vehicles
  return 'synthetic';
}

async function handleImmediateStickerPrint(context, tabId, overrideInterval = null) {
  if (!mosApiToken) {
    throw new Error("Not authenticated with MOS. Please login first.");
  }
  
  if (!context || !context.shopId) {
    throw new Error("No shop context available");
  }
  
  const mileage = context.mileage;
  if (!mileage || mileage <= 0) {
    throw new Error("Could not detect vehicle mileage. Use right-click to customize.");
  }
  
  // Build request body
  const requestBody = {
    currentMileage: mileage,
    unit: 'mi',
    smsShopId: context.shopId,
    provider: context.provider || 'tekmetric'
  };
  
  // If override interval provided, use custom miles/months; otherwise auto-detect
  if (overrideInterval && overrideInterval.miles && overrideInterval.months) {
    requestBody.customMiles = overrideInterval.miles;
    requestBody.customMonths = overrideInterval.months;
    console.log(`[MOS] Using custom interval: ${overrideInterval.miles} mi / ${overrideInterval.months} mo`);
  } else {
    requestBody.intervalType = detectOilType(context.vehicle);
    console.log(`[MOS] Auto-detected oil type: ${requestBody.intervalType} for ${context.vehicle?.make || 'unknown'}`);
  }
  
  // Call the sticker API
  const response = await fetch(`${mosApiUrl}/api/extension/sticker`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${mosApiToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(requestBody)
  });
  
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error || `Sticker generation failed: ${response.status}`);
  }
  
  const data = await response.json();
  
  if (!data.success || !data.sticker) {
    throw new Error("Failed to generate sticker");
  }
  
  return {
    success: true,
    sticker: data.sticker,
    oilType: overrideInterval ? 'custom' : requestBody.intervalType
  };
}

// ==================== LABOR RATE RULES ====================
async function fetchLaborRateRules(forceRefresh = false) {
  if (!mosApiToken) return [];

  const now = Date.now();
  if (!forceRefresh && laborRateRules.length > 0 && (now - laborRateRulesLastFetch) < LABOR_RULES_CACHE_TTL) {
    return laborRateRules;
  }

  try {
    const data = await handleMosApiRequest('/api/extension/labor-rates');
    laborRateRules = data.rules || [];
    laborRateRulesLastFetch = now;
    console.log(`[LaborRate] Fetched ${laborRateRules.length} rules`);
    return laborRateRules;
  } catch (err) {
    console.error("[LaborRate] Failed to fetch rules:", err);
    return laborRateRules; // Return cached if available
  }
}

function matchRuleCondition(condition, vehicleData) {
  const { type, values } = condition;
  if (!values || values.length === 0) return true; // Empty values = always match

  switch (type) {
    case 'make': {
      const vehicleMake = (vehicleData.make || '').toLowerCase();
      return values.some(v => v.toLowerCase() === vehicleMake);
    }
    case 'fuelType': {
      const fuel = (vehicleData.fuelType || '').toLowerCase();
      return values.some(v => v.toLowerCase() === fuel);
    }
    case 'jobCategory': {
      const jobCategories = (vehicleData.jobCategories || []).map(c => c.toLowerCase());
      return values.some(v => jobCategories.includes(v.toLowerCase()));
    }
    case 'customer': {
      const customerName = (vehicleData.customerName || '').toLowerCase();
      const customerPhones = (vehicleData.customerPhones || []).map(p => p.replace(/\D/g, ''));
      return values.some(v => {
        const lower = v.toLowerCase();
        if (customerName.includes(lower)) return true;
        const digits = v.replace(/\D/g, '');
        if (digits.length >= 4 && customerPhones.some(p => p.includes(digits))) return true;
        return false;
      });
    }
    case 'roField': {
      const fieldPath = condition.field;
      if (!fieldPath) return false;
      const fieldValue = getNestedValue(vehicleData.roData, fieldPath);
      if (fieldValue == null || fieldValue === '') return false;
      const fieldStr = String(fieldValue).toLowerCase();
      return values.some(v => fieldStr.includes(v.toLowerCase()));
    }
    default:
      return false;
  }
}

function getNestedValue(obj, path) {
  if (!obj || !path) return null;
  const parts = path.split('.');
  let current = obj;
  for (const part of parts) {
    if (current == null) return null;
    current = current[part];
  }
  return current;
}

function findMatchingRule(rules, vehicleData) {
  // Rules are already sorted by priority (highest first from server)
  const sorted = [...rules].sort((a, b) => (b.priority || 0) - (a.priority || 0));

  for (const rule of sorted) {
    if (!rule.conditions || rule.conditions.length === 0) {
      // No conditions = matches everything (default rule)
      return rule;
    }

    const matchMode = rule.matchMode || 'all';
    let matches;

    if (matchMode === 'all') {
      matches = rule.conditions.every(cond => matchRuleCondition(cond, vehicleData));
    } else {
      matches = rule.conditions.some(cond => matchRuleCondition(cond, vehicleData));
    }

    if (matches) return rule;
  }

  return null;
}

async function autoApplyLaborRate(context) {
  if (!mosApiToken || !context?.roId) return;

  // Currently only supports Tekmetric
  if (context.provider && context.provider !== 'tekmetric') {
    console.log("[LaborRate] Auto-apply only supported for Tekmetric, skipping:", context.provider);
    return;
  }

  if (!smsTokens.tekmetric) {
    console.log("[LaborRate] Waiting for Tekmetric token, will retry when captured");
    return;
  }

  const rules = await fetchLaborRateRules();
  if (rules.length === 0) {
    console.log("[LaborRate] No rules configured, skipping");
    return;
  }

  const shopId = context.shopId || tekmetricShopId;
  if (!shopId) return;

  // Fetch full RO details from Tekmetric to get vehicle fuelType and job info
  const baseUrl = tekmetricBaseUrl || "https://shop.tekmetric.com";
  let roData;
  try {
    const res = await fetch(`${baseUrl}/api/shop/${shopId}/repair-order/${context.roId}`, {
      headers: {
        'x-auth-token': smsTokens.tekmetric,
        'content-type': 'application/json'
      }
    });
    if (!res.ok) {
      console.warn("[LaborRate] Failed to fetch RO details:", res.status);
      return;
    }
    roData = await res.json();
  } catch (err) {
    console.warn("[LaborRate] Error fetching RO:", err.message);
    return;
  }

  // Build vehicle data for matching
  const vehicle = roData.vehicle || {};
  const customer = roData.customer || {};
  const customerName = [customer.firstName, customer.lastName].filter(Boolean).join(' ').trim()
    || context.customerName || '';
  const customerPhones = [
    customer.phone, customer.phoneNumber, customer.cellPhone, customer.mobilePhone,
    ...(customer.phones || []).map(p => typeof p === 'string' ? p : p?.number || '')
  ].filter(Boolean);
  const vehicleData = {
    make: vehicle.make || context.vehicle?.make || '',
    year: vehicle.year || context.vehicle?.year || null,
    model: vehicle.model || context.vehicle?.model || '',
    fuelType: vehicle.fuelType || vehicle.fuelTypeName || '',
    jobCategories: (roData.jobs || []).map(j => j.category || j.type || '').filter(Boolean),
    customerName,
    customerPhones,
    roData: roData
  };

  console.log("[LaborRate] Matching against vehicle:", vehicleData.make, vehicleData.fuelType, "customer:", customerName, "phones:", customerPhones.length);

  const matchedRule = findMatchingRule(rules, vehicleData);
  if (!matchedRule) {
    console.log("[LaborRate] No matching rule found");
    lastAppliedRoId = context.roId;
    return;
  }

  // Convert rate from dollars to cents for Tekmetric
  const rateInCents = Math.round(matchedRule.rate * 100);
  const currentRate = roData.laborRate || 0;

  if (rateInCents === currentRate) {
    console.log(`[LaborRate] Rate already matches ($${matchedRule.rate}/hr), skipping`);
    lastAppliedRoId = context.roId;
    return;
  }

  // Update the RO labor rate via Tekmetric API
  try {
    const updateRes = await fetch(`${baseUrl}/api/shop/${shopId}/repair-order/${context.roId}`, {
      method: 'PATCH',
      headers: {
        'x-auth-token': smsTokens.tekmetric,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ laborRate: rateInCents })
    });

    if (!updateRes.ok) {
      const errText = await updateRes.text();
      console.error("[LaborRate] Failed to update rate:", updateRes.status, errText);
      // Notify sidepanel of error
      chrome.runtime.sendMessage({
        action: "LABOR_RATE_APPLIED",
        success: false,
        error: `Failed to update rate: ${updateRes.status}`
      }).catch(() => {});
      return { success: false, error: `Update failed: ${updateRes.status}` };
    }

    lastAppliedRoId = context.roId;
    console.log(`[LaborRate] Applied "${matchedRule.name}" - $${matchedRule.rate}/hr to RO #${context.roNumber || context.roId}`);

    // Notify sidepanel of success
    chrome.runtime.sendMessage({
      action: "LABOR_RATE_APPLIED",
      success: true,
      ruleName: matchedRule.name,
      rate: matchedRule.rate,
      previousRate: currentRate / 100,
      roNumber: context.roNumber || context.roId
    }).catch(() => {});

    return { success: true, ruleName: matchedRule.name, rate: matchedRule.rate };
  } catch (err) {
    console.error("[LaborRate] Error updating rate:", err);
    return { success: false, error: err.message };
  }
}

console.log("[MOS Tools] Background service worker loaded");
