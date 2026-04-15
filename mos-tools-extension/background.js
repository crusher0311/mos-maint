// MOS Tools Extension - Background Service Worker
// Manages SMS session tokens, MOS authentication, and message routing

// ==================== STATE MANAGEMENT ====================
let mosApiToken = null;
let mosApiUrl = null;
let currentSmsContext = null;
let mosShops = [];

// SMS-specific session tokens (memory-only for security)
const smsTokens = {
  tekmetric: null,
  protractor: null,
  autoflow: null,
  shopware: null
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
let ownJobPostInFlight = false; // Track our own POST /job calls to avoid loops
let lastJobCount = 0; // Track job count to detect new jobs
let laborReapplyTimer = null; // Debounce timer for re-applying after new jobs
let lastInspectionFetchRoId = null; // Prevent duplicate inspection fetches
const xAuthTokenRelayMap = {}; // Per-shop timestamp of last successful x-auth-token relay
const XAUTH_RELAY_INTERVAL = 30 * 60 * 1000; // Relay x-auth-token at most once per 30 minutes per shop

// API Sniffer state (platform admin only)
let snifferActive = false;

// ==================== PERSISTENCE ====================
// Restore all persisted state on startup as a single awaitable promise.
// This prevents race conditions where message handlers fire before
// chrome.storage callbacks complete (e.g. after service worker restart).
const _stateReady = Promise.all([
  new Promise(resolve => {
    chrome.storage.local.get(['mosApiToken', 'mosApiUrl', 'mosUser', 'mosShops'], (result) => {
      if (result.mosApiToken) {
        mosApiToken = result.mosApiToken;
        console.log("[MOS] Restored API token from storage");
      }
      if (result.mosApiUrl) {
        mosApiUrl = result.mosApiUrl;
        console.log("[MOS] Restored API URL:", mosApiUrl);
      }
      if (result.mosShops) {
        mosShops = result.mosShops;
        console.log("[MOS] Restored shops:", mosShops.length);
      }
      resolve();
    });
  }),
  new Promise(resolve => {
    chrome.storage.local.get(['laborRateAutoApply'], (result) => {
      if (result.laborRateAutoApply !== undefined) {
        laborRateAutoApply = result.laborRateAutoApply;
      }
      resolve();
    });
  }),
  new Promise(resolve => {
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
      resolve();
    });
  }),
  new Promise(resolve => {
    chrome.storage.local.get(['mosSnifferActive'], (result) => {
      snifferActive = !!result.mosSnifferActive;
      if (snifferActive) console.log("[MOS Sniffer] Restored active state");
      resolve();
    });
  })
]);

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
    
    // Detect when Tekmetric UI adds/modifies a job — re-apply labor rates
    if (!ownJobPostInFlight && laborRateAutoApply && currentSmsContext?.roId) {
      const isJobPost = details.method === 'POST' && /\/api\/shop\/\d+\/job\b/.test(details.url);
      if (isJobPost) {
        console.log("[LaborRate] New job detected on RO, will re-apply rules");
        if (laborReapplyTimer) clearTimeout(laborReapplyTimer);
        laborReapplyTimer = setTimeout(() => {
          lastAppliedRoId = null; // Reset so it re-applies on same RO
          lastJobCount = 0;
          autoApplyLaborRate(currentSmsContext).catch(err => {
            console.warn("[LaborRate] Re-apply after new job error:", err.message);
          });
        }, 2000); // Wait 2s for Tekmetric to finish saving
      }
    }

    // Capture shop ID from URL
    const shopMatch = details.url.match(/\/(?:token\/)?shop\/(\d+)/);
    if (shopMatch) {
      const newShopId = shopMatch[1];
      if (newShopId !== tekmetricShopId) {
        tekmetricShopId = newShopId;
        chrome.storage.session.set({ tekmetricShopId });
        console.log("[Tekmetric] Shop ID captured:", tekmetricShopId);
        laborRateRulesLastFetch = 0;
        laborRateRules = [];
      } else {
        tekmetricShopId = newShopId;
      }
    }

    // Sniffer: capture webRequest-level data for API discovery
    if (snifferActive && details.method !== 'GET') {
      const safeHeaders = {};
      (details.requestHeaders || []).forEach(h => {
        const name = h.name.toLowerCase();
        if (name === 'x-auth-token' || name === 'authorization') {
          safeHeaders[h.name] = '[REDACTED]';
        } else if (name !== 'cookie') {
          safeHeaders[h.name] = h.value;
        }
      });
      snifferStoreCapture({
        method: details.method,
        url: details.url,
        requestHeaders: safeHeaders,
        requestBody: null,
        responseStatus: null,
        responseBody: null,
        source: 'webRequest'
      });
    }

    // Capture auth token from header (memory + session storage only)
    const tokenHeader = details.requestHeaders.find(
      (h) => h.name.toLowerCase() === "x-auth-token"
    );
    if (tokenHeader && tokenHeader.value) {
      const isNewToken = !smsTokens.tekmetric;
      smsTokens.tekmetric = tokenHeader.value;
      chrome.storage.session.set({ tekmetricToken: tokenHeader.value });

      // If we just got the token and have a pending context, try auto-apply
      if (isNewToken && laborRateAutoApply && mosApiToken && currentSmsContext?.roId && currentSmsContext.roId !== lastAppliedRoId) {
        autoApplyLaborRate(currentSmsContext).catch(err => {
          console.warn("[LaborRate] Deferred auto-apply error:", err.message);
        });
      }

      // Relay x-auth-token to MOS backend for server-side inspection fetching (debounced per shop)
      const now = Date.now();
      const shopRelayKey = tekmetricShopId || 'unknown';
      const lastRelay = xAuthTokenRelayMap[shopRelayKey] || 0;
      if (mosApiToken && mosApiUrl && tekmetricShopId && (now - lastRelay > XAUTH_RELAY_INTERVAL)) {
        fetch(`${mosApiUrl}/api/extension/auth-token`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${mosApiToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            provider: 'tekmetric',
            smsShopId: tekmetricShopId,
            token: tokenHeader.value
          })
        }).then(res => {
          if (res.ok) {
            xAuthTokenRelayMap[shopRelayKey] = Date.now();
            console.log("[MOS] Relayed x-auth-token for shop", tekmetricShopId);
          } else {
            console.warn("[MOS] x-auth-token relay failed:", res.status);
          }
        }).catch(err => {
          console.warn("[MOS] x-auth-token relay error:", err.message);
        });
      }
    }
  },
  {
    urls: [
      "https://shop.tekmetric.com/api/*",
      "https://sandbox.tekmetric.com/api/*",
      "https://cba.tekmetric.com/api/*",
      "https://*.autoflow.com/api/*",
      "https://*.autotext.me/api/*",
      "https://*.shop-ware.com/api/*"
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
    handleMosLogin(message.email, message.password, message.apiUrl, message.rememberMe !== false)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "MOS_LOGOUT") {
    mosApiToken = null;
    mosShops = [];
    chrome.storage.local.remove(['mosApiToken', 'mosUser', 'mosShops', 'mosLoginEmail', 'mosLoginPass', 'mosRememberMe']);
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "GET_MOS_AUTH") {
    _stateReady.then(() => {
      chrome.storage.local.get(['mosUser', 'mosShops'], (result) => {
        sendResponse({
          isAuthenticated: !!mosApiToken,
          apiUrl: mosApiUrl,
          defaultExtensionTab: result.mosUser?.defaultExtensionTab || null,
          shopwareAddMode: result.mosUser?.shopwareAddMode || null,
          shops: result.mosShops || [],
          user: result.mosUser || null
        });
      });
    });
    return true;
  }

  // -------------------- SMS Context --------------------
  if (message.action === "SET_SMS_CONTEXT") {
    currentSmsContext = message.context;
    if (sender?.tab?.id) currentSmsContext._tabId = sender.tab.id;
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

    // Fetch and relay inspections for this RO
    if (currentSmsContext?.roId && currentSmsContext?.provider === 'tekmetric') {
      fetchAndRelayInspections(currentSmsContext).catch(err => {
        console.warn("[MOS Inspections] Fetch error:", err.message);
      });
    } else if (sender?.tab?.id) {
      chrome.tabs.sendMessage(sender.tab.id, { action: "VHI_COACH_HIDE" }).catch(() => {});
    }

    sendResponse({ success: true });
    return false;
  }

  if (message.action === "ENHANCE_FINDINGS") {
    console.log("[Enhance Findings] Enhance requested");
    const tabId = sender?.tab?.id || currentSmsContext?._tabId;
    const ctx = message.context || currentSmsContext;

    if (!ctx?.roId || !ctx?.shopId) {
      if (tabId) {
        chrome.tabs.sendMessage(tabId, { action: "SHOW_TOAST", message: "Missing RO context", type: "error" }).catch(() => {});
        chrome.tabs.sendMessage(tabId, { action: "ENHANCE_FINDINGS_FAILED" }).catch(() => {});
      }
      sendResponse({ success: false, error: "Missing context" });
      return false;
    }

    fetchEnhancedFindings(ctx, message.inspectionId || null, tabId).then(result => {
      if (tabId) {
        if (result.success && result.enhanced && result.enhanced.length > 0) {
          chrome.tabs.sendMessage(tabId, {
            action: "ENHANCE_FINDINGS_PREVIEW",
            enhanced: result.enhanced,
            inspectionId: result.inspectionId,
            context: ctx,
          }).catch(() => {});
        } else if (result.success && (!result.enhanced || result.enhanced.length === 0)) {
          chrome.tabs.sendMessage(tabId, { action: "SHOW_TOAST", message: "Notes already look good — no changes needed", type: "info" }).catch(() => {});
          chrome.tabs.sendMessage(tabId, { action: "ENHANCE_FINDINGS_FAILED" }).catch(() => {});
        } else {
          const errMsg = result.error || "Enhancement failed";
          chrome.tabs.sendMessage(tabId, { action: "SHOW_TOAST", message: errMsg, type: "error" }).catch(() => {});
          chrome.tabs.sendMessage(tabId, { action: "ENHANCE_FINDINGS_FAILED" }).catch(() => {});
        }
      }
    }).catch(err => {
      console.error("[Enhance Findings] Error:", err);
      if (tabId) {
        chrome.tabs.sendMessage(tabId, { action: "SHOW_TOAST", message: "Enhance error: " + err.message, type: "error" }).catch(() => {});
        chrome.tabs.sendMessage(tabId, { action: "ENHANCE_FINDINGS_FAILED" }).catch(() => {});
      }
    });
    sendResponse({ success: true, started: true });
    return true;
  }

  if (message.action === "APPLY_ENHANCED_FINDINGS") {
    console.log("[Enhance Findings] Applying approved findings");
    const tabId = sender?.tab?.id;
    const ctx = message.context;
    const approved = message.approved;

    if (!ctx || !approved || approved.length === 0) {
      sendResponse({ success: false });
      return false;
    }

    applyEnhancedFindings(ctx, message.inspectionId, approved, tabId).then(result => {
      if (tabId) {
        if (result.success && result.applied > 0) {
          chrome.tabs.sendMessage(tabId, {
            action: "SHOW_TOAST",
            message: `Updated ${result.applied} findings`,
            type: "success"
          }).catch(() => {});
          setTimeout(() => {
            chrome.tabs.sendMessage(tabId, { action: "ENHANCE_FINDINGS_COMPLETE", result }).catch(() => {});
          }, 500);
        } else {
          chrome.tabs.sendMessage(tabId, { action: "SHOW_TOAST", message: result.error || "Failed to apply", type: "error" }).catch(() => {});
          chrome.tabs.sendMessage(tabId, { action: "ENHANCE_FINDINGS_FAILED" }).catch(() => {});
        }
      }
    }).catch(err => {
      if (tabId) {
        chrome.tabs.sendMessage(tabId, { action: "SHOW_TOAST", message: "Apply error: " + err.message, type: "error" }).catch(() => {});
        chrome.tabs.sendMessage(tabId, { action: "ENHANCE_FINDINGS_FAILED" }).catch(() => {});
      }
    });
    sendResponse({ success: true, started: true });
    return true;
  }

  if (message.action === "PREFILL_DVI") {
    console.log("[Prefill DVI] Prefill requested");
    const tabId = sender?.tab?.id || currentSmsContext?._tabId;
    const ctx = message.context || currentSmsContext;
    if (tabId) ctx._tabId = tabId;

    if (!ctx?.roId || !ctx?.vin || !ctx?.shopId) {
      if (tabId) {
        chrome.tabs.sendMessage(tabId, { action: "SHOW_TOAST", message: "Missing RO context for pre-fill", type: "error" }).catch(() => {});
        chrome.tabs.sendMessage(tabId, { action: "PREFILL_DVI_FAILED" }).catch(() => {});
      }
      sendResponse({ success: false, error: "Missing context" });
      return false;
    }

    prefillDviInspection(ctx, message.inspectionId || null, tabId).then(result => {
      if (tabId) {
        if (result.success && result.applied > 0) {
          const msg = `DVI pre-filled: ${result.applied} tasks updated (${result.summary?.overdue || 0} red, ${result.summary?.dueSoon || 0} yellow, ${result.summary?.ok || 0} green)`;
          chrome.tabs.sendMessage(tabId, { action: "SHOW_TOAST", message: msg, type: "success" }).catch(() => {});
          setTimeout(() => {
            chrome.tabs.sendMessage(tabId, { action: "PREFILL_DVI_COMPLETE", result }).catch(() => {});
          }, 500);
        } else {
          const errMsg = result.error || (result.applied === 0 ? "No tasks could be updated" : "Pre-fill failed");
          chrome.tabs.sendMessage(tabId, { action: "SHOW_TOAST", message: errMsg, type: "error" }).catch(() => {});
          chrome.tabs.sendMessage(tabId, { action: "PREFILL_DVI_FAILED" }).catch(() => {});
        }
      }
    }).catch(err => {
      console.error("[Prefill DVI] Error:", err);
      if (tabId) {
        chrome.tabs.sendMessage(tabId, { action: "SHOW_TOAST", message: "Pre-fill error: " + err.message, type: "error" }).catch(() => {});
        chrome.tabs.sendMessage(tabId, { action: "PREFILL_DVI_FAILED" }).catch(() => {});
      }
    });
    sendResponse({ success: true, started: true });
    return true;
  }

  if (message.action === "CATEGORY_CHANGED") {
    console.log("[LaborRate] Job category changed:", message.jobName, "→", message.newCategory);
    if (laborRateAutoApply && mosApiToken && currentSmsContext?.roId) {
      lastAppliedRoId = null;
      autoApplyLaborRate(currentSmsContext, { softRefresh: true }).catch(err => {
        console.warn("[LaborRate] Category change re-apply error:", err.message);
      });
    }
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "JOBS_AUTHORIZED") {
    console.log("[MOS] Jobs authorized on RO, notifying sidepanel to reload plan");
    chrome.runtime.sendMessage({ action: "PLAN_REFRESH_NEEDED", reason: "authorization" }).catch(() => {});
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

  if (message.action === "SW_ADD_SERVICE") {
    (async () => {
      try {
        if (!message.workOrderId) {
          sendResponse({ success: false, error: 'No work order ID — navigate to a work order first' });
          return;
        }
        const targetTabId = currentSmsContext?._tabId;
        let tabId;
        if (targetTabId) {
          tabId = targetTabId;
        } else {
          const tabs = await chrome.tabs.query({ url: ["*://*.shop-ware.com/*", "*://*.shop-ware-api-sandbox.com/*"] });
          if (tabs.length === 0) {
            sendResponse({ success: false, error: 'No Shop-Ware tab found' });
            return;
          }
          tabId = tabs[0].id;
        }
        chrome.tabs.sendMessage(tabId, {
          action: 'SW_ADD_SERVICE',
          serviceName: message.serviceName,
          workOrderId: message.workOrderId,
          vehicle: message.vehicle
        }, (res) => {
          sendResponse(res || { success: false, error: 'No response from content script' });
        });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  if (message.action === "SW_SEARCH_CANNED_JOBS") {
    (async () => {
      try {
        const targetTabId = currentSmsContext?._tabId;
        let tabId;
        if (targetTabId) {
          tabId = targetTabId;
        } else {
          const tabs = await chrome.tabs.query({ url: ["*://*.shop-ware.com/*", "*://*.shop-ware-api-sandbox.com/*"] });
          if (tabs.length === 0) {
            sendResponse({ success: false, error: 'No Shop-Ware tab found', results: [] });
            return;
          }
          tabId = tabs[0].id;
        }
        chrome.tabs.sendMessage(tabId, {
          action: 'SW_SEARCH_CANNED_JOBS',
          query: message.query,
          vehicle: message.vehicle,
          workOrderId: message.workOrderId
        }, (res) => {
          sendResponse(res || { success: false, error: 'No response', results: [] });
        });
      } catch (err) {
        sendResponse({ success: false, error: err.message, results: [] });
      }
    })();
    return true;
  }

  if (message.action === "SW_ADD_FINDING") {
    (async () => {
      try {
        if (!message.workOrderId) {
          sendResponse({ success: false, error: 'No work order ID — navigate to a work order first' });
          return;
        }
        const targetTabId = currentSmsContext?._tabId;
        let tabId;
        if (targetTabId) {
          tabId = targetTabId;
        } else {
          const tabs = await chrome.tabs.query({ url: ["*://*.shop-ware.com/*", "*://*.shop-ware-api-sandbox.com/*"] });
          if (tabs.length === 0) {
            sendResponse({ success: false, error: 'No Shop-Ware tab found' });
            return;
          }
          tabId = tabs[0].id;
        }
        chrome.tabs.sendMessage(tabId, {
          action: 'SW_ADD_FINDING',
          text: message.text,
          serviceName: message.serviceName || null,
          workOrderId: message.workOrderId,
          isDraft: message.isDraft,
          vehicle: message.vehicle || null
        }, (res) => {
          sendResponse(res || { success: false, error: 'No response from content script' });
        });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
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
    const saveShopParam = tekmetricShopId ? `?smsShopId=${tekmetricShopId}` : '';
    // Persist overrideCategoryRates/applyToAllLabor locally — server may not return them
    const newOverrides = {};
    (message.rules || []).forEach(r => {
      newOverrides[r.id] = {
        overrideCategoryRates: !!r.overrideCategoryRates,
        applyToAllLabor: !!r.applyToAllLabor,
      };
    });
    chrome.storage.local.get(['laborRateRuleOverrides'], (stored) => {
      const merged = Object.assign({}, stored.laborRateRuleOverrides || {}, newOverrides);
      chrome.storage.local.set({ laborRateRuleOverrides: merged });
    });
    handleMosApiRequest(`/api/extension/labor-rates${saveShopParam}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rules: message.rules })
    }).then(result => {
      if (result.ok === false) {
        sendResponse({ success: false, error: result.error || 'Failed to save rules' });
        return;
      }
      // Merge local overrides into in-memory rules so apply logic sees them immediately
      laborRateRules = (result.rules || []).map(r =>
        newOverrides[r.id] ? Object.assign({}, r, newOverrides[r.id]) : r
      );
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
        if (!currentSmsContext?.roId) {
          sendResponse({ success: false, error: 'No repair order context' });
          return;
        }

        const provider = currentSmsContext.provider || '';
        const concernText = message.text;

        if (provider === 'shopware') {
          console.log('[Concern] Injecting concern via Shop-Ware content script (internal API + DOM fallback)');
          let targetTabId = currentSmsContext?._tabId;
          if (!targetTabId) {
            const tabs = await chrome.tabs.query({ url: ["*://*.shop-ware.com/*", "*://*.shop-ware-api-sandbox.com/*"] });
            if (tabs.length > 0) targetTabId = tabs[0].id;
          }
          if (!targetTabId) {
            sendResponse({ success: false, error: 'No Shop-Ware tab found. Please paste the concern manually.' });
            return;
          }

          const trySend = (tabId) => new Promise((resolve) => {
            chrome.tabs.sendMessage(tabId, {
              action: 'INJECT_CONCERN_TEXT',
              text: concernText
            }, (res) => {
              if (chrome.runtime.lastError) {
                console.warn('[Concern] Content script not reachable:', chrome.runtime.lastError.message);
                resolve(null);
              } else {
                resolve(res);
              }
            });
          });

          let res = await trySend(targetTabId);
          if (!res) {
            try {
              console.log('[Concern] Re-injecting content script and retrying...');
              await chrome.scripting.executeScript({
                target: { tabId: targetTabId },
                files: ['adapters/shopware-content.js']
              });
              await new Promise(r => setTimeout(r, 500));
              res = await trySend(targetTabId);
            } catch (e) {
              console.error('[Concern] Script re-injection failed:', e.message);
            }
          }

          if (res?.success) {
            sendResponse({ success: true });
          } else {
            sendResponse({ success: false, error: 'Could not inject concern — please paste manually into the concern field.' });
          }
          return;
        }

        if (provider === 'protractor') {
          console.log(`[Concern] Adding concern to Protractor WO ${currentSmsContext.roId} via MOS API`);

          const result = await handleMosApiRequest('/api/extension/concern-assistant/inject-protractor', {
            method: 'POST',
            body: JSON.stringify({
              shopId: currentSmsContext.shopId,
              workOrderId: currentSmsContext.roId,
              contactId: currentSmsContext.customerId || null,
              serviceItemId: currentSmsContext.vehicleId || null,
              concernText
            })
          });

          if (result.ok) {
            console.log(`[Concern] Successfully added concern to Protractor WO ${currentSmsContext.roId}`);
            sendResponse({ success: true });
          } else {
            console.error(`[Concern] Protractor inject failed:`, result.error);
            sendResponse({ success: false, error: result.error || 'Failed to add concern' });
          }
        } else {
          if (!smsTokens.tekmetric) {
            sendResponse({ success: false, error: 'No Tekmetric auth token' });
            return;
          }

          const roId = currentSmsContext.roId;
          const baseUrl = currentSmsContext.smsBaseUrl || tekmetricBaseUrl || 'https://shop.tekmetric.com';

          console.log(`[Concern] Adding customer concern to RO #${roId}`);

          const res = await fetch(`${baseUrl}/api/repair-orders/${roId}/customer-concerns`, {
            method: 'POST',
            headers: {
              'accept': 'application/json',
              'content-type': 'application/json',
              'x-auth-token': smsTokens.tekmetric
            },
            body: JSON.stringify({ concern: concernText })
          });

          const resBody = await res.text();
          console.log(`[Concern] Response: ${res.status}`, resBody.substring(0, 300));

          if (res.ok) {
            console.log(`[Concern] Successfully added concern to RO #${roId}`);
            sendResponse({ success: true });

            const tabs = await chrome.tabs.query({ url: ["*://shop.tekmetric.com/*", "*://sandbox.tekmetric.com/*", "*://cba.tekmetric.com/*"] });
            for (const tab of tabs) {
              chrome.tabs.sendMessage(tab.id, {
                action: 'SHOW_TOAST',
                message: 'Customer concern added — refreshing...',
                type: 'success'
              }).catch(() => {});
              setTimeout(() => {
                chrome.tabs.reload(tab.id).catch(() => {});
              }, 1500);
            }
          } else {
            console.error(`[Concern] Failed: ${res.status}`, resBody.substring(0, 200));
            sendResponse({ success: false, error: `Failed: ${res.status}` });
          }
        }
      } catch (err) {
        console.error('[Concern] Error:', err.message);
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

  // -------------------- API Sniffer (Platform Admin Only) --------------------
  function isPlatformAdminUser(user) {
    return user?.role === 'platform_admin' || user?.isPlatformAdmin === true;
  }

  if (message.action === "SNIFFER_STATUS") {
    (async () => {
      const { mosUser } = await chrome.storage.local.get('mosUser');
      if (!isPlatformAdminUser(mosUser)) {
        sendResponse({ active: false });
        return;
      }
      const { mosSnifferActive } = await chrome.storage.local.get('mosSnifferActive');
      sendResponse({ active: !!mosSnifferActive });
    })();
    return true;
  }

  if (message.action === "SNIFFER_TOGGLE") {
    (async () => {
      const { mosUser } = await chrome.storage.local.get('mosUser');
      if (!isPlatformAdminUser(mosUser)) {
        sendResponse({ success: false, error: 'Not authorized' });
        return;
      }
      const active = !!message.active;
      await chrome.storage.local.set({ mosSnifferActive: active });
      snifferActive = active;
      console.log(`[MOS Sniffer] ${active ? 'Started' : 'Stopped'} capture`);

      broadcastSnifferState(active);

      sendResponse({ success: true, active });
    })();
    return true;
  }

  if (message.action === "SNIFFER_GET_CAPTURES") {
    (async () => {
      const { mosUser } = await chrome.storage.local.get('mosUser');
      if (!isPlatformAdminUser(mosUser)) {
        sendResponse({ captures: [] });
        return;
      }
      const { mosSnifferCaptures } = await chrome.storage.local.get('mosSnifferCaptures');
      let captures = mosSnifferCaptures || [];
      const f = message.filters || {};
      if (f.platform) captures = captures.filter(c => c.platform === f.platform);
      if (f.category) captures = captures.filter(c => c.categories?.includes(f.category));
      if (f.method) captures = captures.filter(c => c.method === f.method);
      if (f.search) {
        const term = f.search.toLowerCase();
        captures = captures.filter(c =>
          (c.url && c.url.toLowerCase().includes(term)) ||
          (c.requestBody && c.requestBody.toLowerCase().includes(term)) ||
          (c.responseBody && c.responseBody.toLowerCase().includes(term))
        );
      }
      sendResponse({ captures });
    })();
    return true;
  }

  if (message.action === "SNIFFER_CLEAR") {
    (async () => {
      const { mosUser } = await chrome.storage.local.get('mosUser');
      if (!isPlatformAdminUser(mosUser)) {
        sendResponse({ success: false, error: 'Not authorized' });
        return;
      }
      await chrome.storage.local.set({ mosSnifferCaptures: [] });
      sendResponse({ success: true });
    })();
    return true;
  }

  if (message.action === "SNIFFER_EXPORT") {
    (async () => {
      const { mosUser } = await chrome.storage.local.get('mosUser');
      if (!isPlatformAdminUser(mosUser)) {
        sendResponse({ data: null });
        return;
      }
      const { mosSnifferCaptures } = await chrome.storage.local.get('mosSnifferCaptures');
      let captures = mosSnifferCaptures || [];
      const f = message.filters || {};
      if (f.platform) captures = captures.filter(c => c.platform === f.platform);
      if (f.category) captures = captures.filter(c => c.categories?.includes(f.category));
      if (f.method) captures = captures.filter(c => c.method === f.method);
      if (f.search) {
        const term = f.search.toLowerCase();
        captures = captures.filter(c =>
          (c.url && c.url.toLowerCase().includes(term)) ||
          (c.requestBody && c.requestBody.toLowerCase().includes(term)) ||
          (c.responseBody && c.responseBody.toLowerCase().includes(term))
        );
      }
      sendResponse({
        data: {
          exportedAt: new Date().toISOString(),
          count: captures.length,
          captures
        }
      });
    })();
    return true;
  }

  if (message.action === "SNIFFER_CAPTURE_FROM_PAGE") {
    if (snifferActive && message.data) {
      snifferStoreCapture(message.data);
    }
    sendResponse({ success: true });
    return false;
  }
});

// ==================== API SNIFFER HELPERS ====================
const SNIFFER_CATEGORY_PATTERNS = {
  dvi: [/inspection/i, /dvi/i, /finding/i, /inspection.?task/i, /inspection.?rating/i],
  estimates: [/estimate/i, /job/i, /labor/i, /part[s]?\b/i, /canned.?job/i],
  scheduling: [/appointment/i, /schedule/i, /calendar/i, /booking/i],
  customers: [/customer/i, /contact/i, /client/i],
  vehicles: [/vehicle/i, /vin/i],
  communication: [/message/i, /sms/i, /email/i, /share/i, /send/i],
  authorization: [/authorize/i, /approval/i],
  repair_orders: [/repair.?order/i, /work.?order/i, /\/ro\//i, /summary/i]
};

function snifferCategorize(method, url) {
  const categories = [];
  const testStr = `${method} ${url}`;
  for (const [cat, patterns] of Object.entries(SNIFFER_CATEGORY_PATTERNS)) {
    if (patterns.some(p => p.test(testStr))) categories.push(cat);
  }
  return categories.length ? categories : ['other'];
}

function snifferDetectPlatform(url) {
  if (/tekmetric\.com/i.test(url)) return 'tekmetric';
  if (/autoflow\.com|autotext\.me/i.test(url)) return 'autoflow';
  if (/shop-ware\.com/i.test(url)) return 'shopware';
  return 'unknown';
}

const SNIFFER_MAX_BODY = 10000;
const SNIFFER_MAX_CAPTURES = 500;

async function snifferStoreCapture(entry) {
  if (!snifferActive) return;
  const capture = {
    id: `${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
    timestamp: Date.now(),
    platform: snifferDetectPlatform(entry.url),
    categories: snifferCategorize(entry.method, entry.url),
    method: entry.method,
    url: entry.url,
    path: (() => { try { return new URL(entry.url).pathname; } catch { return entry.url; } })(),
    requestHeaders: entry.requestHeaders || null,
    requestBody: entry.requestBody ? String(entry.requestBody).substring(0, SNIFFER_MAX_BODY) : null,
    responseStatus: entry.responseStatus || null,
    responseBody: entry.responseBody ? String(entry.responseBody).substring(0, SNIFFER_MAX_BODY) : null,
    source: entry.source || 'unknown'
  };

  try {
    const { mosSnifferCaptures: existing } = await chrome.storage.local.get('mosSnifferCaptures');
    const captures = existing || [];
    captures.push(capture);
    if (captures.length > SNIFFER_MAX_CAPTURES) captures.splice(0, captures.length - SNIFFER_MAX_CAPTURES);
    await chrome.storage.local.set({ mosSnifferCaptures: captures });
  } catch (err) {
    console.warn('[MOS Sniffer] Storage write failed, evicting old captures:', err.message);
    try {
      const { mosSnifferCaptures: existing } = await chrome.storage.local.get('mosSnifferCaptures');
      const captures = (existing || []).slice(-100);
      captures.push(capture);
      await chrome.storage.local.set({ mosSnifferCaptures: captures });
    } catch (e) {
      console.error('[MOS Sniffer] Storage critically full, clearing:', e.message);
      await chrome.storage.local.set({ mosSnifferCaptures: [capture] });
    }
  }
}

function broadcastSnifferState(active) {
  chrome.tabs.query({
    url: [
      'https://shop.tekmetric.com/*',
      'https://sandbox.tekmetric.com/*',
      'https://cba.tekmetric.com/*',
      'https://*.autoflow.com/*',
      'https://*.autotext.me/*',
      'https://*.shop-ware.com/*'
    ]
  }, (tabs) => {
    (tabs || []).forEach(tab => {
      chrome.tabs.sendMessage(tab.id, {
        action: 'MOS_SNIFFER_STATE_UPDATE',
        active
      }).catch(() => {});
    });
  });
}

// ==================== MOS API FUNCTIONS ====================
async function handleMosLogin(email, password, apiUrl, rememberMe = true) {
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
    
    mosShops = data.shops || [];
    
    const storageData = {
      mosApiToken: data.token,
      mosApiUrl: mosApiUrl,
      mosUser: data.user,
      mosShops: mosShops,
      mosRememberMe: rememberMe
    };
    
    if (rememberMe) {
      storageData.mosLoginEmail = email;
      storageData.mosLoginPass = password;
    } else {
      chrome.storage.local.remove(['mosLoginEmail', 'mosLoginPass']);
    }
    
    chrome.storage.local.set(storageData);

    console.log("[MOS] Login successful:", data.user?.email, "| token:", data.token?.substring(0, 20) + "...");

    // Verify token works immediately
    try {
      const verifyRes = await fetch(`${mosApiUrl}/api/extension/features?shopId=${data.user?.shopId || ''}&_token=${encodeURIComponent(data.token)}`, {
        headers: { 'Authorization': `Bearer ${data.token}` }
      });
      console.log("[MOS] Token verify:", verifyRes.status);
      if (verifyRes.status === 401) {
        const body = await verifyRes.json().catch(() => ({}));
        console.error("[MOS] Token INVALID immediately after login!", body);
      }
    } catch (e) {
      console.warn("[MOS] Token verify fetch failed:", e.message);
    }

    return { success: true, user: data.user, shops: data.shops || [] };
  } catch (err) {
    console.error("[MOS] Login error:", err);
    throw err;
  }
}

async function handleMosApiRequest(endpoint, options = {}, _retried = false) {
  await _stateReady;
  if (!mosApiToken) {
    throw new Error("Not authenticated with MOS");
  }

  const tokenUsed = mosApiToken;

  const separator = endpoint.includes('?') ? '&' : '?';
  const urlWithToken = `${mosApiUrl}${endpoint}${separator}_token=${encodeURIComponent(tokenUsed)}`;

  const response = await fetch(urlWithToken, {
    ...options,
    headers: {
      'Authorization': `Bearer ${tokenUsed}`,
      'Content-Type': 'application/json',
      ...options.headers
    }
  });

  // Handle 401 - retry once with saved credentials before giving up
  if (response.status === 401) {
    const errBody = await response.json().catch(() => ({}));
    console.error("[MOS] 401 on", endpoint, "| server:", errBody.error || "no detail", "| token match:", mosApiToken === tokenUsed, "| retried:", _retried);

    // If we haven't retried yet, try re-authenticating with saved credentials
    if (!_retried) {
      const stored = await new Promise(resolve => chrome.storage.local.get(['mosLoginEmail', 'mosLoginPass'], resolve));
      if (stored.mosLoginEmail && stored.mosLoginPass) {
        console.log("[MOS] 401 received, attempting silent re-auth...");
        try {
          await handleMosLogin(stored.mosLoginEmail, stored.mosLoginPass, mosApiUrl);
          return handleMosApiRequest(endpoint, options, true);
        } catch (e) {
          console.error("[MOS] Silent re-auth failed:", e.message);
        }
      }
    }

    if (mosApiToken === tokenUsed) {
      mosApiToken = null;
      chrome.storage.local.remove(['mosApiToken']);
    }
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
  
  // Determine unit — check context flag first, then fetch shop config
  let unit = 'mi';
  if (context.useKilometers === true) {
    unit = 'km';
  } else if (context.useKilometers == null) {
    try {
      const configResp = await fetch(
        `${mosApiUrl}/api/extension/sticker?shopId=${encodeURIComponent(context.shopId)}&provider=${encodeURIComponent(context.provider || '')}&_token=${encodeURIComponent(mosApiToken)}`,
        { headers: { 'Authorization': `Bearer ${mosApiToken}` } }
      );
      if (configResp.ok) {
        const configData = await configResp.json();
        if (configData.config?.useKilometers) unit = 'km';
      }
    } catch (err) {
      console.warn('[MOS] Could not fetch sticker config for unit, defaulting to mi:', err.message);
    }
  }

  const requestBody = {
    currentMileage: mileage,
    unit,
    smsShopId: context.shopId,
    provider: context.provider || ''
  };
  
  if (overrideInterval && overrideInterval.miles && overrideInterval.months) {
    requestBody.customMiles = overrideInterval.miles;
    requestBody.customMonths = overrideInterval.months;
    console.log(`[MOS] Using custom interval: ${overrideInterval.miles} ${unit} / ${overrideInterval.months} mo`);
  } else {
    requestBody.intervalType = detectOilType(context.vehicle);
    console.log(`[MOS] Auto-detected oil type: ${requestBody.intervalType} for ${context.vehicle?.make || 'unknown'}`);
  }

  // Add customer/vehicle data for auto booking
  if (context.customerName) requestBody.customerName = context.customerName;
  if (context.customerId) requestBody.customerId = context.customerId;
  if (context.customerPhone) requestBody.customerPhone = context.customerPhone;
  if (context.customerEmail) requestBody.customerEmail = context.customerEmail;
  if (context.vin) requestBody.vin = context.vin;
  if (context.roNumber) requestBody.roNumber = context.roNumber;
  if (context.vehicleId) requestBody.vehicleId = context.vehicleId;
  if (context.vehicle) {
    if (context.vehicle.year) requestBody.vehicleYear = context.vehicle.year;
    if (context.vehicle.make) requestBody.vehicleMake = context.vehicle.make;
    if (context.vehicle.model) requestBody.vehicleModel = context.vehicle.model;
  }
  
  // Call the sticker API
  const response = await fetch(`${mosApiUrl}/api/extension/sticker?_token=${encodeURIComponent(mosApiToken)}`, {
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
    const effectiveShopId = tekmetricShopId || currentSmsContext?.shopId;
    const shopParam = effectiveShopId ? `?smsShopId=${effectiveShopId}` : '';
    const data = await handleMosApiRequest(`/api/extension/labor-rates${shopParam}`);
    const serverRules = data.rules || [];
    // Merge locally-stored overrides (e.g. overrideCategoryRates, applyToAllLabor)
    // that the production server may not yet preserve
    const stored = await new Promise(resolve =>
      chrome.storage.local.get(['laborRateRuleOverrides'], resolve)
    );
    const overrides = stored.laborRateRuleOverrides || {};
    laborRateRules = serverRules.map(r =>
      overrides[r.id] ? Object.assign({}, r, overrides[r.id]) : r
    );
    laborRateRulesLastFetch = now;
    console.log(`[LaborRate] Fetched ${laborRateRules.length} rules for shop ${tekmetricShopId || 'default'}`);
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
    case 'model': {
      const vehicleModel = (vehicleData.model || '').toLowerCase();
      return values.some(v => vehicleModel.includes(v.toLowerCase()));
    }
    case 'fuelType': {
      const fuel = (vehicleData.fuelType || '').toLowerCase();
      return values.some(v => v.toLowerCase() === fuel);
    }
    case 'jobCategory': {
      const jobCategories = (vehicleData.jobCategories || []).map(c => c.toLowerCase());
      return values.some(v => {
        const lower = v.toLowerCase();
        return jobCategories.some(jc => jc.includes(lower) || lower.includes(jc));
      });
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
    case 'customerType': {
      const custType = (vehicleData.customerType || '').toLowerCase();
      if (!custType) return false;
      return values.some(v => v.toLowerCase() === custType);
    }
    case 'tag': {
      const custTags = (vehicleData.customerTags || []).map(t => t.toLowerCase());
      if (custTags.length === 0) return false;
      return values.some(v => custTags.some(t => t.includes(v.toLowerCase())));
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

// ==================== TEKMETRIC INSPECTION FETCH ====================
async function fetchAndRelayInspections(context) {
  await _stateReady;
  if (!context?.roId) return;
  if (context.provider && context.provider !== 'tekmetric') return;
  if (!smsTokens.tekmetric) return;
  if (context.roId === lastInspectionFetchRoId) return;

  const baseUrl = tekmetricBaseUrl || "https://shop.tekmetric.com";
  const shopId = context.shopId || tekmetricShopId;
  if (!shopId) return;

  try {
    const res = await fetch(`${baseUrl}/api/shop/${shopId}/repair-orders/${context.roId}/inspections`, {
      headers: {
        'x-auth-token': smsTokens.tekmetric,
        'content-type': 'application/json'
      }
    });

    if (!res.ok) {
      if (res.status !== 404) {
        console.warn(`[MOS Inspections] Failed to fetch inspections: ${res.status}`);
      }
      return;
    }

    const inspections = await res.json();
    const inspArr = Array.isArray(inspections) ? inspections : (inspections.content || inspections.data || []);
    if (!inspArr || inspArr.length === 0) return;

    console.log(`[MOS Inspections] Fetched ${inspArr.length} inspection(s) for RO ${context.roId}`);

    if (!mosApiToken || !mosApiUrl) {
      lastInspectionFetchRoId = context.roId;
      return;
    }

    const relayRes = await fetch(`${mosApiUrl}/api/extension/inspections`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${mosApiToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        provider: 'tekmetric',
        smsShopId: shopId,
        roId: context.roId,
        vin: context.vin || null,
        inspections: inspArr
      })
    });

    if (relayRes.ok) {
      const result = await relayRes.json();
      console.log(`[MOS Inspections] Relayed inspections to MOS:`, result);
      lastInspectionFetchRoId = context.roId;
    } else {
      console.warn(`[MOS Inspections] Failed to relay to MOS: ${relayRes.status}`);
    }

    fetchVhiCoachData(context, inspArr).catch(err => {
      console.warn("[VHI Coach] Fetch error:", err.message);
    });
  } catch (err) {
    console.warn("[MOS Inspections] Error:", err.message);
  }
}

let lastCoachRoId = null;

async function fetchVhiCoachData(context, inspections) {
  await _stateReady;
  if (!mosApiToken || !mosApiUrl) return;
  if (!context?.vin || !context?.shopId) return;
  if (context.vin.length !== 17) return;
  const coachKey = `${context.shopId}:${context.roId}`;
  if (coachKey === lastCoachRoId) return;

  const taskNames = [];
  const inspArr = Array.isArray(inspections) ? inspections : (inspections.content || inspections.data || []);

  function extractTaskNames(items) {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      const name = item.name || item.taskName || item.label;
      if (name && !taskNames.includes(name)) {
        taskNames.push(name);
      }
      if (item.tasks && Array.isArray(item.tasks)) {
        extractTaskNames(item.tasks);
      }
    }
  }

  for (const insp of inspArr) {
    const groups = insp.inspectionTasks || insp.groups || [];
    extractTaskNames(groups);

    const flatTasks = insp.tasks || [];
    extractTaskNames(flatTasks);
  }

  if (taskNames.length === 0) {
    console.log("[VHI Coach] No inspection task names found");
    return;
  }

  console.log(`[VHI Coach] Fetching for VIN ${context.vin}, ${taskNames.length} tasks`);

  try {
    const res = await fetch(`${mosApiUrl}/api/extension/vhi-coach`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${mosApiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        vin: context.vin,
        smsShopId: context.shopId,
        provider: "tekmetric",
        mileage: context.mileage || null,
        inspectionTasks: taskNames,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.warn(`[VHI Coach] API error ${res.status}:`, text.substring(0, 200));
      return;
    }

    const data = await res.json();
    console.log(`[VHI Coach] Got data:`, data.summary);

    lastCoachRoId = coachKey;

    const tabId = context._tabId;
    if (tabId) {
      chrome.tabs.sendMessage(tabId, {
        action: "VHI_COACH_DATA",
        data: data,
      }).catch(() => {});
    }
  } catch (err) {
    console.warn("[VHI Coach] Error:", err.message);
  }
}

async function prefillDviInspection(context, inspId, tabId) {
  await _stateReady;
  if (!mosApiToken || !mosApiUrl) return { success: false, error: "Not connected to MOS" };
  if (!smsTokens.tekmetric) return { success: false, error: "No Tekmetric session token" };
  if (!context?.vin || context.vin.length !== 17) return { success: false, error: "No VIN detected" };
  if (!context?.mileage) return { success: false, error: "No mileage detected on this RO" };

  const baseUrl = tekmetricBaseUrl || "https://shop.tekmetric.com";
  const shopId = context.shopId || tekmetricShopId;
  if (!shopId) return { success: false, error: "No shop ID" };

  if (tabId) {
    chrome.tabs.sendMessage(tabId, {
      action: "SHOW_TOAST",
      message: "Fetching inspection data...",
      type: "info"
    }).catch(() => {});
  }

  let inspArr;
  try {
    const res = await fetch(`${baseUrl}/api/shop/${shopId}/repair-orders/${context.roId}/inspections`, {
      headers: { "x-auth-token": smsTokens.tekmetric, "content-type": "application/json" }
    });
    if (!res.ok) return { success: false, error: `Failed to fetch inspections (${res.status})` };
    const data = await res.json();
    inspArr = Array.isArray(data) ? data : (data.content || data.data || []);
  } catch (err) {
    return { success: false, error: "Failed to fetch inspections: " + err.message };
  }

  if (!inspArr || inspArr.length === 0) return { success: false, error: "No inspections found on this RO" };

  let inspection;
  if (inspId) {
    inspection = inspArr.find(i => String(i.id) === String(inspId));
  } else {
    const incomplete = inspArr.filter(i => {
      const status = i.inspectionStatus?.code || i.status || "";
      const completed = i.completed === true || status === "COMPLETED" || status === "COMPLETE";
      return !completed;
    });
    inspection = incomplete.length > 0 ? incomplete[incomplete.length - 1] : inspArr[inspArr.length - 1];
    console.log(`[Prefill DVI] ${inspArr.length} inspections found, ${incomplete.length} incomplete, using inspection ${inspection.id} (status: ${inspection.inspectionStatus?.code || inspection.status || 'unknown'})`);
  }
  if (!inspection) return { success: false, error: "Inspection not found" };

  const allTasks = [];
  const groups = inspection.inspectionTasks || inspection.groups || [];
  for (const group of groups) {
    const tasks = group.tasks || [];
    for (const task of tasks) {
      const t = { ...task };
      if (!t.inspectionGroup && group.title) t.inspectionGroup = group.title;
      allTasks.push(t);
    }
  }

  if (allTasks.length === 0) return { success: false, error: "No inspection tasks found" };

  if (tabId) {
    chrome.tabs.sendMessage(tabId, {
      action: "SHOW_TOAST",
      message: `Analyzing ${allTasks.length} tasks with VHI data...`,
      type: "info"
    }).catch(() => {});
  }

  let prefillData;
  try {
    const res = await fetch(`${mosApiUrl}/api/extension/prefill-dvi`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${mosApiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        vin: context.vin,
        smsShopId: shopId,
        provider: "tekmetric",
        mileage: context.mileage,
        inspectionTasks: allTasks.map(t => ({ id: t.id, name: t.name, inspectionGroup: t.inspectionGroup })),
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.warn(`[Prefill DVI] API error ${res.status}:`, text.substring(0, 200));
      return { success: false, error: `VHI analysis failed (${res.status})` };
    }

    prefillData = await res.json();
  } catch (err) {
    return { success: false, error: "VHI analysis failed: " + err.message };
  }

  if (!prefillData.success || !prefillData.updates || prefillData.updates.length === 0) {
    return { success: false, error: prefillData.error || "No VHI data matched to inspection tasks" };
  }

  console.log(`[Prefill DVI] Got ${prefillData.updates.length} updates to apply`);

  if (tabId) {
    chrome.tabs.sendMessage(tabId, {
      action: "SHOW_TOAST",
      message: `Applying ${prefillData.updates.length} ratings...`,
      type: "info"
    }).catch(() => {});
  }

  let applied = 0;
  let failed = 0;

  for (const update of prefillData.updates) {
    const task = allTasks.find(t => t.id === update.taskId);
    if (!task) { failed++; continue; }

    const putBody = { ...task };
    putBody.inspectionRating = update.rating;
    putBody.finding = update.finding || task.finding || null;

    try {
      const res = await fetch(
        `${baseUrl}/api/shop/${shopId}/repair-orders/${context.roId}/inspections/${inspection.id}/tasks/${task.id}`,
        {
          method: "PUT",
          headers: {
            "x-auth-token": smsTokens.tekmetric,
            "content-type": "application/json",
          },
          body: JSON.stringify(putBody),
        }
      );

      if (res.ok) {
        applied++;
      } else {
        console.warn(`[Prefill DVI] Failed to update task ${task.name}: ${res.status}`);
        failed++;
      }
    } catch (err) {
      console.warn(`[Prefill DVI] Error updating task ${task.name}:`, err.message);
      failed++;
    }

    if (applied % 5 === 0 && applied > 0) {
      await new Promise(r => setTimeout(r, 100));
    }
  }

  console.log(`[Prefill DVI] Complete: ${applied} applied, ${failed} failed`);

  return {
    success: true,
    applied,
    failed,
    summary: prefillData.summary,
    vehicle: prefillData.vehicle,
    score: prefillData.score,
  };
}

async function fetchEnhancedFindings(context, inspId, tabId) {
  await _stateReady;
  if (!mosApiToken || !mosApiUrl) return { success: false, error: "Not connected to MOS" };
  if (!smsTokens.tekmetric) return { success: false, error: "No Tekmetric session token" };

  const baseUrl = tekmetricBaseUrl || "https://shop.tekmetric.com";
  const shopId = context.shopId || tekmetricShopId;
  if (!shopId) return { success: false, error: "No shop ID" };

  if (tabId) {
    chrome.tabs.sendMessage(tabId, { action: "SHOW_TOAST", message: "Fetching inspection findings...", type: "info" }).catch(() => {});
  }

  let inspArr;
  try {
    const res = await fetch(`${baseUrl}/api/shop/${shopId}/repair-orders/${context.roId}/inspections`, {
      headers: { "x-auth-token": smsTokens.tekmetric, "content-type": "application/json" }
    });
    if (!res.ok) return { success: false, error: `Failed to fetch inspections (${res.status})` };
    const data = await res.json();
    inspArr = Array.isArray(data) ? data : (data.content || data.data || []);
  } catch (err) {
    return { success: false, error: "Failed to fetch inspections: " + err.message };
  }

  if (!inspArr || inspArr.length === 0) return { success: false, error: "No inspections found on this RO" };

  const getFinding = (t) => {
    return t.finding || t.note || t.notes || t.comment || t.comments || null;
  };

  let inspectionsToSearch = [];
  if (inspId) {
    const match = inspArr.find(i => String(i.id) === String(inspId));
    if (match) inspectionsToSearch = [match];
  } else {
    inspectionsToSearch = inspArr;
  }

  if (inspectionsToSearch.length === 0) return { success: false, error: "Inspection not found" };

  console.log(`[Enhance Findings] Searching ${inspectionsToSearch.length} inspection(s) for findings`);

  const allTasks = [];
  let usedInspectionId = null;

  for (const insp of inspectionsToSearch) {
    const groups = insp.inspectionTasks || insp.groups || [];
    const status = insp.inspectionStatus?.code || insp.status || "";
    console.log(`[Enhance Findings] Inspection ${insp.id} (${status || 'unknown status'}) has ${groups.length} groups`);
    for (const group of groups) {
      const tasks = group.tasks || [];
      for (const task of tasks) {
        const f = getFinding(task);
        if (f && typeof f === "string" && f.trim().length > 0) {
          const t = { ...task, _inspectionId: insp.id };
          if (!t.inspectionGroup && group.title) t.inspectionGroup = group.title;
          allTasks.push(t);
          if (!usedInspectionId) usedInspectionId = insp.id;
        }
      }
    }
  }

  console.log(`[Enhance Findings] Found ${allTasks.length} tasks with findings across all inspections`);

  if (allTasks.length > 0) {
    const sample = allTasks[0];
    console.log(`[Enhance Findings] Sample task keys:`, Object.keys(sample).join(', '));
  }

  const tasksWithFindings = allTasks;

  if (tasksWithFindings.length === 0) {
    return { success: false, error: "No findings to enhance — tasks have no notes yet" };
  }

  if (tabId) {
    chrome.tabs.sendMessage(tabId, { action: "SHOW_TOAST", message: `Enhancing ${tasksWithFindings.length} findings with AI...`, type: "info" }).catch(() => {});
  }

  let enhanceData;
  try {
    const res = await fetch(`${mosApiUrl}/api/extension/enhance-findings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${mosApiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        findings: tasksWithFindings.map(t => ({
          taskId: t.id,
          taskName: t.name,
          finding: getFinding(t),
          rating: t.inspectionRating?.code || null,
        })),
        vehicleInfo: context.vehicleInfo || null,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      return { success: false, error: `AI enhancement failed (${res.status})` };
    }

    enhanceData = await res.json();
  } catch (err) {
    return { success: false, error: "Failed to call enhance API: " + err.message };
  }

  if (!enhanceData.success || !enhanceData.enhanced) {
    return { success: false, error: enhanceData.error || "No enhancements returned" };
  }

  const changed = enhanceData.enhanced.filter(e => e.enhanced !== e.original);
  console.log(`[Enhance Findings] AI returned ${enhanceData.enhanced.length} enhancements, ${changed.length} have changes`);

  const changedWithInspId = changed.map(e => {
    const task = tasksWithFindings.find(t => t.id === e.taskId);
    return { ...e, _inspectionId: task?._inspectionId || usedInspectionId };
  });

  return {
    success: true,
    enhanced: changedWithInspId,
    inspectionId: usedInspectionId,
  };
}

async function applyEnhancedFindings(context, inspectionId, approved, tabId) {
  await _stateReady;
  if (!smsTokens.tekmetric) return { success: false, error: "No Tekmetric session token" };

  const baseUrl = tekmetricBaseUrl || "https://shop.tekmetric.com";
  const shopId = context.shopId || tekmetricShopId;
  if (!shopId) return { success: false, error: "No shop ID" };

  let inspArr;
  try {
    const res = await fetch(`${baseUrl}/api/shop/${shopId}/repair-orders/${context.roId}/inspections`, {
      headers: { "x-auth-token": smsTokens.tekmetric, "content-type": "application/json" }
    });
    if (!res.ok) return { success: false, error: `Failed to fetch inspections (${res.status})` };
    const data = await res.json();
    inspArr = Array.isArray(data) ? data : (data.content || data.data || []);
  } catch (err) {
    return { success: false, error: "Failed to fetch inspections: " + err.message };
  }

  const tasksByInspection = {};
  for (const insp of inspArr) {
    const groups = insp.inspectionTasks || insp.groups || [];
    for (const group of groups) {
      for (const task of (group.tasks || [])) {
        if (!tasksByInspection[insp.id]) tasksByInspection[insp.id] = {};
        tasksByInspection[insp.id][task.id] = { ...task };
      }
    }
  }

  let applied = 0;
  let failed = 0;

  for (const item of approved) {
    const itemInspId = item._inspectionId || inspectionId;
    const task = tasksByInspection[itemInspId]?.[item.taskId];
    if (!task) { failed++; continue; }

    const putBody = { ...task };
    const findingField = task.finding !== undefined ? 'finding' : task.note !== undefined ? 'note' : task.notes !== undefined ? 'notes' : task.comment !== undefined ? 'comment' : 'finding';
    putBody[findingField] = item.enhanced;

    try {
      const res = await fetch(
        `${baseUrl}/api/shop/${shopId}/repair-orders/${context.roId}/inspections/${itemInspId}/tasks/${task.id}`,
        {
          method: "PUT",
          headers: { "x-auth-token": smsTokens.tekmetric, "content-type": "application/json" },
          body: JSON.stringify(putBody),
        }
      );
      if (res.ok) { applied++; } else { failed++; }
    } catch { failed++; }

    if (applied % 5 === 0 && applied > 0) {
      await new Promise(r => setTimeout(r, 100));
    }
  }

  console.log(`[Enhance Findings] Applied: ${applied}, Failed: ${failed}`);
  return { success: applied > 0, applied, failed };
}

async function autoApplyLaborRate(context, options = {}) {
  await _stateReady;
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
    if (roData.jobs) console.log(`[LaborRate] RO includes ${roData.jobs.length} jobs inline`);
  } catch (err) {
    console.warn("[LaborRate] Error fetching RO:", err.message);
    return;
  }

  // Fetch estimate data — this is the endpoint Tekmetric uses to load jobs with labor
  let estimateData = null;
  try {
    const estRes = await fetch(`${baseUrl}/api/repair-order/${context.roId}/estimate`, {
      headers: { 'x-auth-token': smsTokens.tekmetric, 'content-type': 'application/json' }
    });
    if (estRes.ok) {
      estimateData = await estRes.json();
      const estPayload = estimateData.data || estimateData;
      const jobsArr = estPayload.jobs || [];
      if (Array.isArray(jobsArr) && jobsArr.length > 0) {
        roData.jobs = jobsArr;
        console.log(`[LaborRate] Loaded ${jobsArr.length} jobs with labor from estimate`);
      } else {
        console.log(`[LaborRate] Estimate endpoint returned no jobs`);
      }
    } else {
      console.log(`[LaborRate] Estimate endpoint returned ${estRes.status}`);
    }
  } catch (err) {
    console.warn("[LaborRate] Error fetching estimate:", err.message);
  }

  // Fallback: fetch jobs from jobs list endpoint
  if (!roData.jobs || roData.jobs.length === 0) {
    try {
      const jobsRes = await fetch(`${baseUrl}/api/shop/${shopId}/jobs?repairOrderId=${context.roId}`, {
        headers: { 'x-auth-token': smsTokens.tekmetric, 'content-type': 'application/json' }
      });
      if (jobsRes.ok) {
        const jobsBody = await jobsRes.json();
        roData.jobs = jobsBody.content || jobsBody.data || jobsBody || [];
        if (Array.isArray(roData.jobs)) {
          console.log(`[LaborRate] Fetched ${roData.jobs.length} jobs from jobs list (no labor data)`);
        }
      }
    } catch (err) {
      console.warn("[LaborRate] Error fetching jobs:", err.message);
    }
  }

  // Build vehicle data for matching
  const vehicle = roData.vehicle || {};
  const customer = roData.customer || {};
  console.log(`[LaborRate] Vehicle: ${vehicle.year} ${vehicle.make} ${vehicle.model}`);
  const customerName = [customer.firstName, customer.lastName].filter(Boolean).join(' ').trim()
    || context.customerName || '';
  const customerPhones = [
    customer.phone, customer.phoneNumber, customer.cellPhone, customer.mobilePhone,
    ...(customer.phones || []).map(p => typeof p === 'string' ? p : p?.number || '')
  ].filter(Boolean);

  // Fetch full customer details if any rule uses customerType or tag conditions
  const extractCustomerType = (val) => {
    if (!val) return '';
    if (typeof val === 'string') return val;
    return val.name || val.label || val.type || '';
  };
  let customerType = extractCustomerType(customer.customerType);
  let customerTags = [];
  const needsCustomerDetails = rules.some(r =>
    (r.conditions || []).some(c => c.type === 'customerType' || c.type === 'tag')
  );
  if (needsCustomerDetails && customer.id && shopId) {
    try {
      const custRes = await fetch(`${baseUrl}/api/shop/${shopId}/customer/${customer.id}`, {
        headers: {
          'x-auth-token': smsTokens.tekmetric,
          'content-type': 'application/json'
        }
      });
      if (custRes.ok) {
        const custData = await custRes.json();
        console.log('[LaborRate] Raw customer API response keys:', Object.keys(custData).join(', '));
        console.log('[LaborRate] Raw customer tags fields:', JSON.stringify({
          tag: custData.tag,
          tags: custData.tags,
          labels: custData.labels,
          tagList: custData.tagList,
          tagNames: custData.tagNames,
          customerTags: custData.customerTags,
        }));
        customerType = extractCustomerType(custData.customerType) || customerType;
        const rawTags = custData.tag || custData.tags || custData.labels || custData.tagList || custData.tagNames || custData.customerTags || [];
        const tagsArr = Array.isArray(rawTags) ? rawTags : (rawTags ? [rawTags] : []);
        customerTags = tagsArr.map(t => typeof t === 'string' ? t : (t.name || t.label || t.value || ''));
        console.log(`[LaborRate] Customer details: type="${customerType}", tags=[${customerTags.join(', ')}]`);
      } else {
        console.log(`[LaborRate] Customer details fetch returned ${custRes.status}`);
      }
    } catch (err) {
      console.warn("[LaborRate] Error fetching customer details:", err.message);
    }
  }

  // Derive fuel type: use explicit field first, then detect from engine description
  let derivedFuelType = vehicle.fuelType || vehicle.fuelTypeName || '';
  if (!derivedFuelType) {
    const engineDesc = (vehicle.engine || vehicle.engineDescription || '').toLowerCase();
    if (engineDesc.includes('diesel') || engineDesc.includes('tdi') || engineDesc.includes('duramax') || engineDesc.includes('powerstroke') || engineDesc.includes('cummins')) {
      derivedFuelType = 'Diesel';
    } else if (engineDesc.includes('electric') || engineDesc.includes(' ev') || engineDesc.includes('bev')) {
      derivedFuelType = 'Electric';
    } else if (engineDesc.includes('hybrid') || engineDesc.includes('phev')) {
      derivedFuelType = 'Hybrid';
    } else if (engineDesc.includes('flex') || engineDesc.includes('e85')) {
      derivedFuelType = 'Flex Fuel';
    }
  }

  const vehicleData = {
    make: vehicle.make || context.vehicle?.make || '',
    year: vehicle.year || context.vehicle?.year || null,
    model: vehicle.model || vehicle.subModel || context.vehicle?.model || '',
    fuelType: derivedFuelType,
    jobCategories: (roData.jobs || []).map(j => {
      const cat = j.jobCategoryName || j.jobCategory?.name || j.jobCategory || j.category || j.type || '';
      return typeof cat === 'string' ? cat : '';
    }).filter(Boolean),
    customerName,
    customerPhones,
    customerType,
    customerTags,
    roData: roData
  };

  console.log("[LaborRate] Matching against vehicle:", vehicleData.year, vehicleData.make, vehicleData.model, "fuel:", vehicleData.fuelType, "categories:", JSON.stringify(vehicleData.jobCategories), "customer:", customerName, "phones:", customerPhones.length, "custType:", customerType, "tags:", JSON.stringify(customerTags));

  // Separate rules into per-job (has jobCategory condition) and RO-level (no jobCategory)
  const perJobRules = rules.filter(r => (r.conditions || []).some(c => c.type === 'jobCategory'));
  const roLevelRules = rules.filter(r => !(r.conditions || []).some(c => c.type === 'jobCategory'));

  let appliedAny = false;

  // Apply best matching RO-level rule (make/model/fuel/customer rules)
  const matchedRoRule = findMatchingRule(roLevelRules, vehicleData);
  if (matchedRoRule) {
    console.log(`[LaborRate] Matched RO-level rule: "${matchedRoRule.name}" (priority ${matchedRoRule.priority}) → $${matchedRoRule.rate}/hr`);
    const roResult = await applyLaborRateToRO(matchedRoRule, Math.round(matchedRoRule.rate * 100), roData, context, baseUrl, options);
    if (roResult?.success) appliedAny = true;
  } else {
    console.log("[LaborRate] No RO-level rule matched");
  }

  // Track which jobs were handled by per-job category rules
  const jobsHandledByPerJobRules = new Set();

  // Apply all matching per-job rules (category-based rules)
  // Skip if the matched RO-level rule is set to override all category rates
  if (matchedRoRule?.overrideCategoryRates) {
    console.log(`[LaborRate] Rule "${matchedRoRule.name}" has overrideCategoryRates — skipping per-job category rules`);
  }
  if (perJobRules.length > 0 && vehicleData.jobCategories.length > 0 && !matchedRoRule?.overrideCategoryRates) {
    const sorted = [...perJobRules].sort((a, b) => (b.priority || 0) - (a.priority || 0));
    for (const rule of sorted) {
      const matchMode = rule.matchMode || 'all';
      const nonCatConditions = (rule.conditions || []).filter(c => c.type !== 'jobCategory');
      const catConditions = (rule.conditions || []).filter(c => c.type === 'jobCategory');

      // Check non-category conditions first (make, model, fuel, etc.)
      let nonCatMatch = true;
      if (nonCatConditions.length > 0) {
        if (matchMode === 'all') {
          nonCatMatch = nonCatConditions.every(cond => matchRuleCondition(cond, vehicleData));
        } else {
          nonCatMatch = nonCatConditions.some(cond => matchRuleCondition(cond, vehicleData));
        }
      }
      if (!nonCatMatch) continue;

      // Check category conditions
      const catMatch = catConditions.some(cond => matchRuleCondition(cond, vehicleData));
      if (!catMatch) continue;

      console.log(`[LaborRate] Matched per-job rule: "${rule.name}" (priority ${rule.priority}) → $${rule.rate}/hr`);
      const jobResult = await applyLaborRatePerJob(rule, Math.round(rule.rate * 100), roData, context, baseUrl, options);
      if (jobResult?.success) {
        appliedAny = true;
        if (jobResult.handledJobIds) {
          jobResult.handledJobIds.forEach(id => jobsHandledByPerJobRules.add(id));
        }
      }
    }
  } else if (perJobRules.length > 0) {
    console.log("[LaborRate] Per-job rules exist but no job categories found on RO");
  }

  // Apply RO-level rate to jobs not handled by per-job rules (no category or unmatched category)
  if (matchedRoRule && (matchedRoRule.applyToAllLabor || perJobRules.length > 0)) {
    const roRateInCents = Math.round(matchedRoRule.rate * 100);
    const jobs = roData.jobs || [];
    const shopId = context.shopId || tekmetricShopId;
    let unmatchedUpdated = 0;

    for (const job of jobs) {
      if (jobsHandledByPerJobRules.has(job.id)) continue;

      const laborEntries = job.labor || job.laborEntries || job.laborItems || [];
      if (laborEntries.length === 0) continue;

      let anyNeedsUpdate = false;
      for (const labor of laborEntries) {
        if ((labor.rate || 0) !== roRateInCents) {
          anyNeedsUpdate = true;
          break;
        }
      }

      if (!anyNeedsUpdate) {
        console.log(`[LaborRate] Job "${job.name}" labor already at RO rate $${matchedRoRule.rate}/hr`);
        continue;
      }

      const updatedLabor = laborEntries.map(l => ({ ...l, rate: roRateInCents }));
      const jobPayload = { ...job, labor: updatedLabor };

      try {
        console.log(`[LaborRate] Updating unmatched job "${job.name}" labor to RO rate $${matchedRoRule.rate}/hr`);
        const res = await fetch(`${baseUrl}/api/shop/${shopId}/job`, {
          method: 'POST',
          headers: { 'x-auth-token': smsTokens.tekmetric, 'content-type': 'application/json' },
          body: JSON.stringify(jobPayload)
        });
        if (res.ok) {
          unmatchedUpdated++;
          console.log(`[LaborRate] Updated job "${job.name}" labor to $${matchedRoRule.rate}/hr`);
        } else {
          console.error(`[LaborRate] Failed to update job "${job.name}":`, res.status);
        }
      } catch (err) {
        console.error(`[LaborRate] Error updating job "${job.name}":`, err);
      }
    }

    if (unmatchedUpdated > 0) {
      console.log(`[LaborRate] Applied RO rate to ${unmatchedUpdated} unmatched job(s)`);
      appliedAny = true;
      chrome.runtime.sendMessage({
        action: "LABOR_RATE_APPLIED",
        success: true,
        ruleName: matchedRoRule.name,
        rate: matchedRoRule.rate,
        roNumber: context.roNumber || context.roId
      }).catch(() => {});
      const toastMsg = `${matchedRoRule.name}: $${matchedRoRule.rate}/hr applied to ${unmatchedUpdated} job(s)`;
      chrome.tabs.query({ url: ["*://shop.tekmetric.com/*", "*://sandbox.tekmetric.com/*", "*://cba.tekmetric.com/*"] }, (tabs) => {
        for (const tab of tabs) {
          chrome.tabs.sendMessage(tab.id, { type: "REFRESH_LABOR_RATE_UI", soft: false, toastMessage: toastMsg }).catch(() => {});
        }
      });
    }
  }

  if (!appliedAny && !matchedRoRule) {
    console.log("[LaborRate] No matching rules found");
  }

  lastAppliedRoId = context.roId;
}

async function applyLaborRatePerJob(matchedRule, rateInCents, roData, context, baseUrl, options = {}) {
  const categoryValues = (matchedRule.conditions || [])
    .filter(c => c.type === 'jobCategory')
    .flatMap(c => c.values || [])
    .map(v => v.toLowerCase());

  const jobs = roData.jobs || [];
  let updatedCount = 0;
  let skippedCount = 0;
  const updatedJobNames = [];
  const handledJobIds = [];

  for (const job of jobs) {
    const jobCat = (job.jobCategoryName || job.jobCategory?.name || job.jobCategory || job.category || job.type || '').toLowerCase();

    if (!jobCat) {
      console.log(`[LaborRate] Job "${job.name}" has no category, skipping per-job rule`);
      continue;
    }
    const matches = categoryValues.some(cv => jobCat.includes(cv) || cv.includes(jobCat));
    if (!matches) {
      console.log(`[LaborRate] Job "${job.name}" category "${jobCat}" does not match rule categories [${categoryValues.join(',')}]`);
      continue;
    }

    if (job.id) handledJobIds.push(job.id);

    const laborEntries = job.labor || job.laborEntries || job.laborItems || [];
    if (laborEntries.length === 0) {
      console.log(`[LaborRate] Job "${job.name}" matches category but has no labor lines yet`);
      continue;
    }

    const shopId = context.shopId || tekmetricShopId;
    let anyLaborNeedsUpdate = false;

    for (const labor of laborEntries) {
      const currentRate = labor.rate || 0;
      if (currentRate === rateInCents) {
        console.log(`[LaborRate] Labor "${labor.name}" on job "${job.name}" already at $${rateInCents/100}/hr, skipping`);
        skippedCount++;
      } else {
        anyLaborNeedsUpdate = true;
      }
    }

    if (!anyLaborNeedsUpdate) continue;

    // Update labor rates by POSTing the entire job with modified labor entries
    // (Tekmetric saves job+labor together via POST /api/shop/{shopId}/job)
    const updatedLabor = laborEntries.map(l => ({
      ...l,
      rate: rateInCents
    }));

    const jobPayload = {
      ...job,
      labor: updatedLabor
    };

    try {
      const laborNames = laborEntries.filter(l => (l.rate || 0) !== rateInCents).map(l => l.name).join(', ');
      console.log(`[LaborRate] Updating job "${job.name}" labor (${laborNames}) to $${rateInCents/100}/hr via POST /job`);

      ownJobPostInFlight = true;
      const res = await fetch(`${baseUrl}/api/shop/${shopId}/job`, {
        method: 'POST',
        headers: { 'x-auth-token': smsTokens.tekmetric, 'content-type': 'application/json' },
        body: JSON.stringify(jobPayload)
      });
      ownJobPostInFlight = false;

      if (res.ok) {
        const resData = await res.json();
        updatedCount += updatedLabor.length;
        if (!updatedJobNames.includes(job.name)) updatedJobNames.push(job.name);
        console.log(`[LaborRate] Updated ${updatedLabor.length} labor line(s) on job "${job.name}" to $${rateInCents/100}/hr`);
      } else {
        const errText = await res.text();
        console.error(`[LaborRate] Failed to update job "${job.name}": ${res.status}`, errText.substring(0, 300));
      }
    } catch (err) {
      ownJobPostInFlight = false;
      console.error(`[LaborRate] Error updating job "${job.name}":`, err.message);
    }
  }

  lastAppliedRoId = context.roId;

  if (updatedCount === 0 && skippedCount > 0) {
    console.log(`[LaborRate] All matching labor lines already at target rate, skipped ${skippedCount}`);
    return { success: true, noChange: true, handledJobIds };
  }

  if (updatedCount > 0) {
    console.log(`[LaborRate] Applied "${matchedRule.name}" to ${updatedCount} labor line(s) on jobs: ${updatedJobNames.join(', ')}`);

    chrome.runtime.sendMessage({
      action: "LABOR_RATE_APPLIED",
      success: true,
      ruleName: matchedRule.name,
      rate: matchedRule.rate,
      perJob: true,
      updatedCount,
      jobNames: updatedJobNames,
      roNumber: context.roNumber || context.roId
    }).catch(() => {});

    const softRefresh = options.softRefresh || false;
    const toastMsg = `${matchedRule.name}: $${matchedRule.rate}/hr applied to ${updatedJobNames.join(', ')}`;
    chrome.tabs.query({ url: ["*://shop.tekmetric.com/*", "*://sandbox.tekmetric.com/*", "*://cba.tekmetric.com/*"] }, (tabs) => {
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, { type: "REFRESH_LABOR_RATE_UI", soft: softRefresh, toastMessage: toastMsg }).catch(() => {});
      }
    });

    return { success: true, ruleName: matchedRule.name, rate: matchedRule.rate, updatedCount, handledJobIds };
  }

  console.log("[LaborRate] No matching jobs/labor found for category rule");
  return { success: false, error: "No matching jobs found for category", handledJobIds };
}

async function applyLaborRateToRO(matchedRule, rateInCents, roData, context, baseUrl, options = {}) {
  const currentRate = roData.laborRate || 0;
  console.log(`[LaborRate] Current rate on RO: ${currentRate} (${currentRate/100}/hr), target: ${rateInCents} (${matchedRule.rate}/hr)`);

  if (rateInCents === currentRate) {
    console.log(`[LaborRate] Rate already matches ($${matchedRule.rate}/hr), skipping`);
    lastAppliedRoId = context.roId;
    return;
  }

  try {
    const summaryPayload = {
      laborRate: rateInCents,
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

    console.log(`[LaborRate] Sending PUT to /api/repair-order/${context.roId}/summary with laborRate: ${rateInCents} ($${matchedRule.rate}/hr)`);

    const updateRes = await fetch(`${baseUrl}/api/repair-order/${context.roId}/summary`, {
      method: 'PUT',
      headers: {
        'x-auth-token': smsTokens.tekmetric,
        'content-type': 'application/json'
      },
      body: JSON.stringify(summaryPayload)
    });

    const updateBody = await updateRes.text();
    console.log(`[LaborRate] RO update: ${updateRes.status}`);

    if (!updateRes.ok) {
      console.error("[LaborRate] Failed to update rate:", updateRes.status, updateBody);
      chrome.runtime.sendMessage({
        action: "LABOR_RATE_APPLIED",
        success: false,
        error: `Failed to update rate: ${updateRes.status}`
      }).catch(() => {});
      return { success: false, error: `Update failed: ${updateRes.status}` };
    }

    lastAppliedRoId = context.roId;
    console.log(`[LaborRate] Applied "${matchedRule.name}" - $${matchedRule.rate}/hr (${rateInCents} cents) to RO #${context.roNumber || context.roId}`);

    chrome.runtime.sendMessage({
      action: "LABOR_RATE_APPLIED",
      success: true,
      ruleName: matchedRule.name,
      rate: matchedRule.rate,
      previousRate: currentRate / 100,
      roNumber: context.roNumber || context.roId
    }).catch(() => {});

    const softRefresh = options.softRefresh || false;
    const toastMsg = `${matchedRule.name}: $${matchedRule.rate}/hr applied to RO`;
    chrome.tabs.query({ url: ["*://shop.tekmetric.com/*", "*://sandbox.tekmetric.com/*", "*://cba.tekmetric.com/*"] }, (tabs) => {
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, { type: "REFRESH_LABOR_RATE_UI", soft: softRefresh, toastMessage: toastMsg }).catch(() => {});
      }
    });

    return { success: true, ruleName: matchedRule.name, rate: matchedRule.rate };
  } catch (err) {
    console.error("[LaborRate] Error updating rate:", err);
    return { success: false, error: err.message };
  }
}

console.log("[MOS Tools] Background service worker loaded");
