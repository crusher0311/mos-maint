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

  // -------------------- Telemetry (task #511) --------------------
  // Content scripts can't talk to /api/extension/telemetry directly (no
  // mosApiToken in their scope), so they relay via the background worker.
  if (message.action === "REPORT_TELEMETRY") {
    try {
      reportTelemetry(message.event, message.payload || {});
    } catch (_) { /* never throw from telemetry */ }
    sendResponse({ ok: true });
    return false;
  }

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
  // CONTRACT — DO NOT CHANGE WITHOUT UPDATING EVERY ADAPTER:
  // Every SMS adapter (Tekmetric, Shop-Ware, Autoflow, …) MUST push
  // shop / RO / VIN context updates as
  //
  //     chrome.runtime.sendMessage({ action: "SET_SMS_CONTEXT", context })
  //
  // (any other shape — e.g. { type: "SMS_CONTEXT_UPDATE" } — is silently
  // dropped and the side panel will hang on "Loading VHI…", which is the
  // exact regression that caused task #159.)
  //
  // The lockstep is enforced by mos-tools-extension/scripts/
  // check-sms-context-protocol.cjs (run via `npm run lint:sms-context`).
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

    // Fetch and relay inspections for this RO (Tekmetric reads the live
    // inspection via its SMS API). AutoFlow is read-only — we can't read
    // its inspection, so the VHI Coach overlay is driven straight from the
    // VIN + shop + mileage the AutoFlow adapter scrapes.
    if (currentSmsContext?.roId && currentSmsContext?.provider === 'tekmetric') {
      fetchAndRelayInspections(currentSmsContext).catch(err => {
        console.warn("[MOS Inspections] Fetch error:", err.message);
      });
    } else if (currentSmsContext?.provider === 'autoflow' && currentSmsContext?.vin) {
      fetchVhiCoachForAutoflow(currentSmsContext).catch(err => {
        console.warn("[VHI Coach] AutoFlow fetch error:", err.message);
      });
    } else if (sender?.tab?.id) {
      chrome.tabs.sendMessage(sender.tab.id, { action: "VHI_COACH_HIDE" }).catch(() => {});
    }

    sendResponse({ success: true });
    return false;
  }

  if (message.action === "GET_SHOP_FEATURES") {
    const shopId = message.shopId || currentSmsContext?.shopId;
    if (!mosApiToken || !shopId) {
      sendResponse({ success: false, features: {} });
      return false;
    }
    (async () => {
      try {
        const provider = message.provider || currentSmsContext?.provider || '';
        const res = await fetch(`${mosApiUrl}/api/extension/features?shopId=${shopId}&provider=${provider}&_token=${encodeURIComponent(mosApiToken)}`, {
          headers: { 'Authorization': `Bearer ${mosApiToken}` }
        });
        if (!res.ok) {
          sendResponse({ success: false, features: {} });
          return;
        }
        const data = await res.json();
        // Mirror lib/extension-write-guard so the content script can hide
        // the Create RO button for read-only users without an extra round
        // trip. mosUser is populated at login time in chrome.storage.local.
        const userRec = await new Promise(resolve =>
          chrome.storage.local.get(['mosUser'], r => resolve(r.mosUser || null))
        );
        const READ_ONLY_ROLES = new Set(['viewer', 'read_only', 'readonly']);
        const role = (userRec?.role || '').toString().toLowerCase();
        const isAdmin = userRec?.role === 'platform_admin' || userRec?.isPlatformAdmin === true;
        const canWrite = isAdmin || (!userRec?.readOnly && !READ_ONLY_ROLES.has(role));
        sendResponse({
          success: true,
          features: data.features || {},
          writeProvider: data.writeProvider || null,
          integrations: data.integrations || [],
          shopId: data.shopId || null,
          canWrite,
          floatingButtonEnabled: data.floatingButtonEnabled,
          floatingButtonOwnerEnabled: data.floatingButtonOwnerEnabled,
          floatingButtonUserPreference: data.floatingButtonUserPreference,
        });
      } catch (err) {
        console.warn("[MOS] Feature fetch error:", err.message);
        sendResponse({ success: false, features: {} });
      }
    })();
    return true;
  }

  // Open side panel and switch it to the Create RO view (Task #348).
  if (message.action === "OPEN_CREATE_RO_PANEL") {
    if (sender.tab?.id) {
      chrome.sidePanel.open({ tabId: sender.tab.id }).then(() => {
        setTimeout(() => {
          chrome.runtime.sendMessage({
            action: "SWITCH_TO_CREATE_RO",
            context: message.context || currentSmsContext,
          }).catch(() => {});
        }, 500);
      }).catch(err => console.error("[MOS] Failed to open side panel:", err));
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

  // ==================== AUTOFLOW VHI WRITE-BACK (analysis only) ====================
  // Unlike Tekmetric (where the background relays writes via x-auth-token),
  // AutoFlow writes must run in the page itself (same-origin session cookie)
  // through the content script + MAIN-world bridge. The background only
  // fetches VHI analysis from the MOS backend and hands it back; it performs
  // NO provider write here. Each handler responds asynchronously.
  if (message.action === "AF_ANALYZE_PREFILL") {
    (async () => {
      try {
        await _stateReady;
        if (!mosApiToken || !mosApiUrl) {
          sendResponse({ success: false, error: "Not signed in to MOS" });
          return;
        }
        const ctx = message.context || {};
        const res = await fetch(`${mosApiUrl}/api/extension/prefill-dvi`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${mosApiToken}`,
          },
          body: JSON.stringify({
            vin: ctx.vin,
            smsShopId: ctx.shopId,
            provider: "autoflow",
            mileage: ctx.mileage || 0,
            inspectionTasks: message.inspectionTasks || [],
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          sendResponse({ success: false, error: data.error || `HTTP ${res.status}` });
          return;
        }
        sendResponse(Object.assign({ success: true }, data));
      } catch (err) {
        console.warn("[AF Prefill] error:", err.message);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  if (message.action === "AF_ANALYZE_ENHANCE") {
    (async () => {
      try {
        await _stateReady;
        if (!mosApiToken || !mosApiUrl) {
          sendResponse({ success: false, error: "Not signed in to MOS" });
          return;
        }
        const ctx = message.context || {};
        const res = await fetch(`${mosApiUrl}/api/extension/enhance-findings`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${mosApiToken}`,
          },
          body: JSON.stringify({
            findings: message.findings || [],
            vehicleInfo: ctx.vehicle || { vin: ctx.vin },
            shopId: ctx.shopId,
            provider: "autoflow",
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          sendResponse({ success: false, error: data.error || `HTTP ${res.status}` });
          return;
        }
        sendResponse(Object.assign({ success: true }, data));
      } catch (err) {
        console.warn("[AF Enhance] error:", err.message);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  if (message.action === "AF_ANALYZE_BUILD_RO") {
    (async () => {
      try {
        await _stateReady;
        if (!mosApiToken || !mosApiUrl) {
          sendResponse({ success: false, error: "Not signed in to MOS" });
          return;
        }
        const ctx = message.context || {};
        const res = await fetch(`${mosApiUrl}/api/extension/build-ro-from-vhi`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${mosApiToken}`,
          },
          body: JSON.stringify({
            vin: ctx.vin,
            smsShopId: ctx.shopId,
            provider: "autoflow",
            mileage: ctx.mileage || 0,
            roId: ctx.roId,
            vehicleId: ctx.vehicleId || null,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          sendResponse({ success: false, error: data.error || `HTTP ${res.status}` });
          return;
        }
        sendResponse(Object.assign({ success: true }, data));
      } catch (err) {
        console.warn("[AF Build RO] error:", err.message);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  // Task #484: extension requests a short-lived Supabase Realtime token
  // scoped to a single shop. Server returns 503 when the feature flag is
  // off or env is missing — we surface that as success:false so the
  // overlay knows to fall back to polling.
  if (message.action === "GET_VHI_REALTIME_TOKEN") {
    (async () => {
      await _stateReady;
      if (!mosApiToken || !mosApiUrl) {
        sendResponse({ success: false, reason: "not_connected" });
        return;
      }
      try {
        const res = await fetch(`${mosApiUrl}/api/extension/realtime-token`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${mosApiToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            provider: message.provider || currentSmsContext?.provider || "tekmetric",
            smsShopId: message.smsShopId,
          }),
        });
        if (!res.ok) {
          sendResponse({ success: false, reason: `http_${res.status}` });
          return;
        }
        const data = await res.json();
        sendResponse({
          success: true,
          supabaseUrl: data.supabaseUrl,
          supabaseAnonKey: data.supabaseAnonKey,
          token: data.token,
          shopId: data.shopId,
          topicPrefix: data.topicPrefix,
          expiresAt: data.expiresAt,
        });
      } catch (err) {
        sendResponse({ success: false, reason: "fetch_error" });
      }
    })();
    return true;
  }

  // Task #484: realtime broadcast received in the content script → force
  // a refetch of the VHI coach for the current SMS context. Resetting
  // lastCoachRoId lets fetchVhiCoachData run again for the same RO.
  if (message.action === "REFETCH_VHI_COACH") {
    lastCoachRoId = null;
    lastInspectionFetchRoId = null;
    if (currentSmsContext?.roId && currentSmsContext?.provider === "tekmetric") {
      fetchAndRelayInspections(currentSmsContext).catch((err) => {
        console.warn("[VHI Coach] Realtime-triggered refetch error:", err.message);
      });
    } else if (currentSmsContext?.provider === "autoflow" && currentSmsContext?.vin) {
      fetchVhiCoachForAutoflow(currentSmsContext).catch((err) => {
        console.warn("[VHI Coach] Realtime-triggered AutoFlow refetch error:", err.message);
      });
    }
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "BUILD_RO_FROM_VHI") {
    console.log("[Build RO from VHI] Preview requested");
    const tabId = sender?.tab?.id || currentSmsContext?._tabId;
    const ctx = message.context || currentSmsContext;
    if (tabId && ctx) ctx._tabId = tabId;

    if (!ctx?.roId || !ctx?.vin || !ctx?.shopId) {
      if (tabId) {
        chrome.tabs.sendMessage(tabId, { action: "SHOW_TOAST", message: "Missing RO context for build", type: "error" }).catch(() => {});
        chrome.tabs.sendMessage(tabId, { action: "BUILD_RO_FROM_VHI_FAILED" }).catch(() => {});
      }
      sendResponse({ success: false, error: "Missing context" });
      return false;
    }

    fetchBuildRoFromVhiPreview(ctx).then(result => {
      if (tabId) {
        if (result.success && result.proposed && result.proposed.length > 0) {
          chrome.tabs.sendMessage(tabId, {
            action: "BUILD_RO_FROM_VHI_PREVIEW",
            preview: result,
            context: ctx,
          }).catch(() => {});
        } else if (result.success && (!result.proposed || result.proposed.length === 0)) {
          chrome.tabs.sendMessage(tabId, { action: "SHOW_TOAST", message: "No overdue or due-soon services found in VHI", type: "info" }).catch(() => {});
          chrome.tabs.sendMessage(tabId, { action: "BUILD_RO_FROM_VHI_FAILED" }).catch(() => {});
        } else {
          chrome.tabs.sendMessage(tabId, { action: "SHOW_TOAST", message: result.error || "Build failed", type: "error" }).catch(() => {});
          chrome.tabs.sendMessage(tabId, { action: "BUILD_RO_FROM_VHI_FAILED" }).catch(() => {});
        }
      }
    }).catch(err => {
      console.error("[Build RO from VHI] Preview error:", err);
      if (tabId) {
        chrome.tabs.sendMessage(tabId, { action: "SHOW_TOAST", message: "Build error: " + err.message, type: "error" }).catch(() => {});
        chrome.tabs.sendMessage(tabId, { action: "BUILD_RO_FROM_VHI_FAILED" }).catch(() => {});
      }
    });
    sendResponse({ success: true, started: true });
    return true;
  }

  if (message.action === "APPLY_BUILD_RO_FROM_VHI") {
    console.log("[Build RO from VHI] Apply requested");
    const tabId = sender?.tab?.id || currentSmsContext?._tabId;
    const ctx = message.context || currentSmsContext;
    const selected = message.selected || [];
    const markerPrefix = message.markerPrefix || "[VHI]";

    if (!ctx?.roId || selected.length === 0) {
      sendResponse({ success: false, error: "Missing context or no selection" });
      return false;
    }

    applyBuildRoFromVhi(ctx, selected, markerPrefix, tabId).then(result => {
      if (!tabId) return;
      if (result.success) {
        // Let the content script render a single rich toast that names failing items.
        chrome.tabs.sendMessage(tabId, { action: "BUILD_RO_FROM_VHI_COMPLETE", result }).catch(() => {});
      } else {
        chrome.tabs.sendMessage(tabId, { action: "BUILD_RO_FROM_VHI_FAILED", error: result.error || "Build failed" }).catch(() => {});
      }
    }).catch(err => {
      console.error("[Build RO from VHI] Apply error:", err);
      if (tabId) {
        chrome.tabs.sendMessage(tabId, { action: "BUILD_RO_FROM_VHI_FAILED", error: "Build error: " + err.message }).catch(() => {});
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
    (async () => {
      try {
        const result = await handleMosApiRequest(message.endpoint, message.options);
        sendResponse(result);
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
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

          console.log(`[Concern] Adding customer concern to RO #${roId}`);

          const res = await tekmetricFetch(
            `/api/repair-orders/${roId}/customer-concerns`,
            {
              method: 'POST',
              headers: { 'accept': 'application/json' },
              body: JSON.stringify({ concern: concernText }),
            },
            {
              shopId: currentSmsContext.shopId,
              label: 'concern.add-customer-concern',
              signalUserOnError: true,
            }
          );

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

    // Verify token works immediately. Task #502: a single 401 here used
    // to log "Token INVALID immediately after login" with no retry —
    // misleading because the only PG identity drift we're trying to
    // tolerate elsewhere shows up here too. Give the server one quick
    // retry before logging the alarming line.
    try {
      const verifyUrl = `${mosApiUrl}/api/extension/features?shopId=${data.user?.shopId || ''}&_token=${encodeURIComponent(data.token)}`;
      let verifyRes = await fetch(verifyUrl, {
        headers: { 'Authorization': `Bearer ${data.token}` }
      });
      console.log("[MOS] Token verify:", verifyRes.status);
      if (verifyRes.status === 401) {
        await new Promise(r => setTimeout(r, 500 + Math.random() * 250));
        verifyRes = await fetch(verifyUrl, {
          headers: { 'Authorization': `Bearer ${data.token}` }
        });
        console.log("[MOS] Token verify retry:", verifyRes.status);
        if (verifyRes.status === 401) {
          const body = await verifyRes.json().catch(() => ({}));
          if (body?.code === 'TOKEN_INVALID' || body?.code === 'TOKEN_EXPIRED' || body?.code === 'TOKEN_MISSING') {
            console.error("[MOS] Token INVALID immediately after login!", body);
          } else {
            console.warn("[MOS] Token verify transient 401 after retry — leaving token in place", body);
          }
        }
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

// Task #511: client-side telemetry. Best-effort, fire-and-forget POST to
// /api/extension/telemetry. Events are buffered and flushed in small
// batches so a burst (e.g. a retry storm) doesn't fan out to one HTTP
// call per event. NEVER throws — observability must not break the
// foreground call site. Payloads are intentionally tiny: event name,
// shop/user ids, endpoint shape, codes/counters. No inspection text, no
// PII, no full tokens.
const TELEMETRY_FLUSH_INTERVAL_MS = 3000;
const TELEMETRY_MAX_BUFFER = 50;
let _telemetryBuffer = [];
let _telemetryFlushTimer = null;
let _telemetryExtVersion = null;
function _getExtensionVersion() {
  if (_telemetryExtVersion) return _telemetryExtVersion;
  try {
    _telemetryExtVersion = chrome.runtime.getManifest().version;
  } catch (_) {
    _telemetryExtVersion = "unknown";
  }
  return _telemetryExtVersion;
}
async function _flushTelemetry() {
  _telemetryFlushTimer = null;
  if (_telemetryBuffer.length === 0) return;
  if (!mosApiToken || !mosApiUrl) {
    // Not signed in yet — drop buffered events rather than queueing
    // forever; a soft_expired on a logged-out client is meaningless.
    _telemetryBuffer = [];
    return;
  }
  const events = _telemetryBuffer.splice(0, TELEMETRY_MAX_BUFFER);
  try {
    const ua = (typeof navigator !== "undefined" && navigator.userAgent) || null;
    await fetch(`${mosApiUrl}/api/extension/telemetry`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${mosApiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        extensionVersion: _getExtensionVersion(),
        userAgent: ua,
        events,
      }),
    }).catch(() => {});
  } catch (_) { /* swallow */ }
}
function reportTelemetry(name, payload) {
  try {
    if (!name) return;
    const ctx = currentSmsContext || {};
    const ev = {
      event: String(name),
      occurredAt: Date.now(),
      provider: (payload && payload.provider) || ctx.provider || null,
      smsShopId: (payload && payload.smsShopId) || ctx.shopId || null,
      endpoint: (payload && payload.endpoint) || null,
      payload: payload || {},
    };
    _telemetryBuffer.push(ev);
    if (_telemetryBuffer.length >= TELEMETRY_MAX_BUFFER) {
      if (_telemetryFlushTimer) { clearTimeout(_telemetryFlushTimer); _telemetryFlushTimer = null; }
      _flushTelemetry();
      return;
    }
    if (!_telemetryFlushTimer) {
      _telemetryFlushTimer = setTimeout(_flushTelemetry, TELEMETRY_FLUSH_INTERVAL_MS);
    }
  } catch (_) { /* never throw from telemetry */ }
}

// Task #502: 401 retry policy.
//
// Old behavior: first 401 → silently re-login once → if that fails (or
// no saved creds), null out `mosApiToken` and remove it from
// `chrome.storage.local`. Every transient blip on /api/extension/*
// (PG identity lookup miss, DB hiccup, race with token-refresh writes)
// became a hard logout for the user.
//
// New behavior:
//   1. On 401, peek at the response body's `code` field
//      (TOKEN_MISSING | TOKEN_INVALID | TOKEN_EXPIRED | SHOP_FORBIDDEN
//      | AUTH_LOOKUP_FAILED). SHOP_FORBIDDEN is treated as terminal
//      (re-auth wouldn't help — caller error), AUTH_LOOKUP_FAILED is
//      treated as transient.
//   2. Retry the original request with exponential backoff + jitter
//      up to MOS_AUTH_RETRY_DELAYS_MS.length times. Each retry uses
//      the same token (we want the upstream blip to clear).
//   3. If 401s continue AND saved creds exist, attempt a SINGLE silent
//      re-auth and retry once with the new token.
//   4. Only when (a) the retry budget is exhausted AND (b) the silent
//      re-auth either failed or wasn't attempted AND (c) the most
//      recent 401's code is a terminal token code do we clear
//      mosApiToken from chrome.storage.local. Otherwise we leave the
//      token in place and surface a session-may-have-expired error to
//      the popup/overlay so the user can opt in to re-login.
// 503 / AUTH_LOOKUP_FAILED never clears the token under any
// circumstance.
const MOS_AUTH_RETRY_DELAYS_MS = [500, 1500, 4000];
// Only TOKEN_INVALID is treated as a real "your credentials are dead,
// log out now" signal after the retry budget + silent re-auth both
// fail. Everything else (TOKEN_EXPIRED, TOKEN_MISSING, SHOP_FORBIDDEN,
// AUTH_LOOKUP_FAILED, unknown codes) is soft — we surface a session-
// may-have-expired error but leave the token in place so the user
// chooses to re-login rather than being silently bounced. Per task
// #502: SHOP_FORBIDDEN is a route-scope mismatch (re-auth won't fix
// it), TOKEN_EXPIRED is recoverable via the popup login flow.
const TERMINAL_AUTH_CODES = new Set(['TOKEN_INVALID']);

function _jitter(ms) { return ms + Math.floor(Math.random() * (ms / 3)); }

async function _doMosFetch(endpoint, options, token) {
  const separator = endpoint.includes('?') ? '&' : '?';
  const urlWithToken = `${mosApiUrl}${endpoint}${separator}_token=${encodeURIComponent(token)}`;
  return fetch(urlWithToken, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
}

async function handleMosApiRequest(endpoint, options = {}) {
  await _stateReady;
  if (!mosApiToken) {
    throw new Error("Not authenticated with MOS");
  }

  const tokenAtStart = mosApiToken;
  let tokenUsed = tokenAtStart;
  let response = await _doMosFetch(endpoint, options, tokenUsed);

  let lastErrBody = null;
  let lastCode = null;

  if (response.status === 401) {
    lastErrBody = await response.clone().json().catch(() => ({}));
    lastCode = lastErrBody?.code || null;

    // Retry-with-backoff loop. We retry transient and terminal codes
    // alike — the point of the retry is to absorb upstream blips, and
    // a TOKEN_INVALID from a single PG identity-lookup race should not
    // be trusted on the first hit.
    for (let attempt = 0; attempt < MOS_AUTH_RETRY_DELAYS_MS.length; attempt += 1) {
      const delay = _jitter(MOS_AUTH_RETRY_DELAYS_MS[attempt]);
      console.log(`[MOS] 401 transient retry ${attempt + 1}/${MOS_AUTH_RETRY_DELAYS_MS.length} on ${endpoint} | code=${lastCode || 'none'} | sleep=${delay}ms`);
      await new Promise(r => setTimeout(r, delay));

      response = await _doMosFetch(endpoint, options, tokenUsed);
      if (response.status !== 401) break;

      lastErrBody = await response.clone().json().catch(() => ({}));
      lastCode = lastErrBody?.code || null;
    }
  }

  // Silent re-auth attempt — only if retries didn't recover and saved
  // credentials exist. Same as before, but now gated on the retry
  // budget being exhausted.
  if (response.status === 401) {
    const stored = await new Promise(resolve => chrome.storage.local.get(['mosLoginEmail', 'mosLoginPass'], resolve));
    if (stored.mosLoginEmail && stored.mosLoginPass) {
      console.log("[MOS] 401 silent re-auth attempted on", endpoint);
      try {
        await handleMosLogin(stored.mosLoginEmail, stored.mosLoginPass, mosApiUrl);
        tokenUsed = mosApiToken;
        response = await _doMosFetch(endpoint, options, tokenUsed);
        if (response.status === 401) {
          lastErrBody = await response.clone().json().catch(() => ({}));
          lastCode = lastErrBody?.code || null;
        }
      } catch (e) {
        console.error("[MOS] Silent re-auth failed:", e.message);
      }
    }
  }

  if (response.status === 401) {
    // Terminal vs transient decision. AUTH_LOOKUP_FAILED comes back as
    // 503 from the server normally, but if for any reason it arrives
    // as a 401 we still treat it as transient. Anything we don't
    // recognize is treated as transient too — better a stale "session
    // may have expired" prompt than a wrongful logout.
    const isTerminal = TERMINAL_AUTH_CODES.has(lastCode);
    if (isTerminal && mosApiToken === tokenAtStart) {
      console.log(`[MOS] 401 terminal — prompting user (code=${lastCode}) on ${endpoint}`);
      reportTelemetry("auth.token_invalid_cleared", { endpoint, code: lastCode, status: 401 });
      mosApiToken = null;
      chrome.storage.local.remove(['mosApiToken']);
      throw new Error("Session expired. Please login again.");
    }
    console.warn(`[MOS] 401 unresolved on ${endpoint} (code=${lastCode || 'none'}) — keeping token, surfacing soft session-expired`);
    reportTelemetry("auth.soft_expired", {
      endpoint,
      code: lastCode,
      status: 401,
      retryBudgetRemaining: 0,
    });
    const err = new Error("Session may have expired — click to re-login");
    err.code = "MOS_SESSION_SOFT_EXPIRED";
    err.serverCode = lastCode || null;
    throw err;
  }

  if (response.status === 503) {
    // Auth lookup transient failure on the server — surface but never
    // clear the token.
    const errorData = await response.json().catch(() => ({}));
    reportTelemetry("api.fetch_failure", {
      endpoint,
      status: 503,
      code: errorData?.code || null,
      reason: errorData?.error || null,
    });
    const err = new Error(errorData.error || "Server temporarily unavailable");
    err.code = "MOS_SERVER_TRANSIENT";
    err.serverCode = errorData?.code || null;
    throw err;
  }

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    // Skip telemetry on the telemetry endpoint itself to avoid feedback loops.
    if (!endpoint || endpoint.indexOf("/api/extension/telemetry") === -1) {
      reportTelemetry("api.fetch_failure", {
        endpoint,
        status: response.status,
        reason: errorData?.error || null,
      });
    }
    throw new Error(errorData.error || `API error: ${response.status}`);
  }

  return response.json();
}

// ==================== TEKMETRIC API FUNCTIONS ====================
const TEK_MAX_429_RETRIES = 5;
const TEK_MAX_BACKOFF_MS = 60000;

function compute429BackoffMs(attempt, retryAfterHeader) {
  if (retryAfterHeader) {
    const seconds = parseInt(retryAfterHeader, 10);
    if (!isNaN(seconds) && seconds > 0) {
      return Math.min(seconds * 1000 + Math.random() * 1000, TEK_MAX_BACKOFF_MS);
    }
  }
  const exponential = Math.pow(2, attempt) * 1000;
  const jitter = Math.random() * 1000;
  return Math.min(exponential + jitter, TEK_MAX_BACKOFF_MS);
}

async function tekmetricFetchWithBackoff(url, init, label) {
  for (let attempt = 1; attempt <= TEK_MAX_429_RETRIES + 1; attempt++) {
    const response = await fetch(url, init);
    if (response.status !== 429 || attempt > TEK_MAX_429_RETRIES) {
      return response;
    }
    const retryAfter = response.headers.get('Retry-After');
    const backoffMs = compute429BackoffMs(attempt, retryAfter);
    console.warn(`[Tekmetric] 429 on ${label || url} (attempt ${attempt}/${TEK_MAX_429_RETRIES}), backing off ${Math.round(backoffMs)}ms${retryAfter ? ` (Retry-After=${retryAfter})` : ''}`);
    await new Promise(r => setTimeout(r, backoffMs));
  }
  throw new Error(`Tekmetric exceeded ${TEK_MAX_429_RETRIES} retries on ${label || url}`);
}

// ==================== TEKMETRIC ENDPOINT REPORTER ====================
// Best-effort, non-blocking, debounced/batched telemetry for Tekmetric
// internal-API calls made from the extension. Reports get sanitized
// (numeric path segments → {id}, query string stripped) before they
// even leave the extension so RO numbers and other PII never make it
// into the report buffer.
const TEK_REPORT_FLUSH_INTERVAL_MS = 5000;
const TEK_REPORT_MAX_BATCH = 20;
const TEK_REPORT_MAX_QUEUE = 200;
const TEK_REPORT_PATH = '/api/extension/tek-endpoint-report';
let tekReportQueue = [];
let tekReportFlushTimer = null;
let tekReportFlushInFlight = false;

function tekSanitizeEndpointShape(pathOrUrl) {
  if (!pathOrUrl || typeof pathOrUrl !== 'string') return null;
  let s = pathOrUrl.trim();
  if (!s) return null;
  // Strip protocol+host so the shape is path-only — the panel groups
  // across base URLs (shop. / sandbox. / cba.) and we don't want them
  // splintered into separate buckets.
  s = s.replace(/^https?:\/\/[^/]+/i, '');
  // Strip query + fragment.
  const qIdx = s.indexOf('?');
  if (qIdx >= 0) s = s.slice(0, qIdx);
  const hIdx = s.indexOf('#');
  if (hIdx >= 0) s = s.slice(0, hIdx);
  // Drop trailing slash (except root).
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  // Replace numeric IDs (RO numbers, shop IDs, customer IDs, etc.)
  // with the literal `{id}`. This is the single most important step
  // for keeping the dataset PII-free and aggregations meaningful.
  s = s.replace(/\/\d+(?=\/|$)/g, '/{id}');
  if (s.length > 200) s = s.slice(0, 200);
  return s || null;
}

function tekScheduleReportFlush(immediate = false) {
  if (immediate) {
    if (tekReportFlushTimer) {
      clearTimeout(tekReportFlushTimer);
      tekReportFlushTimer = null;
    }
    tekFlushReports().catch(err => {
      console.warn('[Tekmetric Report] Flush error:', err.message);
    });
    return;
  }
  if (tekReportFlushTimer) return;
  tekReportFlushTimer = setTimeout(() => {
    tekReportFlushTimer = null;
    tekFlushReports().catch(err => {
      console.warn('[Tekmetric Report] Flush error:', err.message);
    });
  }, TEK_REPORT_FLUSH_INTERVAL_MS);
}

function tekEnqueueReport(entry) {
  if (!entry || !entry.endpointShape) return;
  // Hard cap the in-memory buffer so a sustained outage can't grow
  // unbounded. Drop oldest entries first — newest failures are more
  // useful for triage.
  if (tekReportQueue.length >= TEK_REPORT_MAX_QUEUE) {
    tekReportQueue.splice(0, tekReportQueue.length - TEK_REPORT_MAX_QUEUE + 1);
  }
  tekReportQueue.push(entry);
  if (tekReportQueue.length >= TEK_REPORT_MAX_BATCH) {
    tekScheduleReportFlush(true);
  } else {
    tekScheduleReportFlush(false);
  }
}

async function tekFlushReports() {
  if (tekReportFlushInFlight) return;
  if (tekReportQueue.length === 0) return;
  if (!mosApiToken || !mosApiUrl) {
    // No way to deliver — drop everything queued so we don't grow
    // unbounded while the user is logged out.
    tekReportQueue = [];
    return;
  }
  const batch = tekReportQueue.splice(0, TEK_REPORT_MAX_BATCH);
  tekReportFlushInFlight = true;
  try {
    const res = await fetch(`${mosApiUrl}${TEK_REPORT_PATH}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${mosApiToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ reports: batch })
    });
    if (!res.ok) {
      // Don't requeue — these are best-effort. A 401 just means the
      // user logged out while reports were buffered; spinning forever
      // would be worse than dropping them.
      console.warn(`[Tekmetric Report] Flush returned ${res.status}, dropping ${batch.length} report(s)`);
    }
  } catch (err) {
    console.warn('[Tekmetric Report] Flush network error:', err.message);
  } finally {
    tekReportFlushInFlight = false;
    // If more piled up while we were flushing, schedule another pass.
    if (tekReportQueue.length > 0) {
      tekScheduleReportFlush(tekReportQueue.length >= TEK_REPORT_MAX_BATCH);
    }
  }
}

function tekShowToastOnActiveTab(message, type = 'error') {
  // Best-effort: pick any open Tekmetric tab and surface the toast there.
  // We deliberately do NOT await — the user-facing signal must not block
  // whatever workflow triggered the failed fetch.
  try {
    chrome.tabs.query(
      { url: ['*://shop.tekmetric.com/*', '*://sandbox.tekmetric.com/*', '*://cba.tekmetric.com/*'] },
      (tabs) => {
        if (!tabs || tabs.length === 0) return;
        const tab = tabs.find(t => t.active) || tabs[0];
        if (!tab?.id) return;
        chrome.tabs.sendMessage(tab.id, {
          action: 'SHOW_TOAST',
          message,
          type,
        }).catch(() => {});
      }
    );
  } catch {}
}

// Build a Tekmetric request: path-prefix + token-injection. Idempotent
// re: headers — if the caller already passed `x-auth-token`, theirs wins
// (preserves backwards compatibility with any caller that needs to use
// a different token, e.g. the per-shop relay path).
function tekBuildRequest(endpoint, init = {}) {
  if (!endpoint || typeof endpoint !== 'string') {
    throw new Error('tekmetricFetch: endpoint must be a non-empty string');
  }
  const baseUrl = tekmetricBaseUrl || 'https://shop.tekmetric.com';
  const url = endpoint.startsWith('http')
    ? endpoint
    : `${baseUrl}${endpoint.startsWith('/') ? '' : '/'}${endpoint}`;

  // Merge headers case-insensitively so we don't double-up on
  // `x-auth-token` vs `X-Auth-Token`.
  const callerHeaders = init.headers || {};
  const lowerKeys = new Set(
    Object.keys(callerHeaders).map(k => k.toLowerCase())
  );
  const mergedHeaders = { ...callerHeaders };
  if (!lowerKeys.has('x-auth-token') && smsTokens.tekmetric) {
    mergedHeaders['x-auth-token'] = smsTokens.tekmetric;
  }
  if (!lowerKeys.has('content-type') && init.body != null) {
    mergedHeaders['content-type'] = 'application/json';
  }
  return {
    url,
    init: { ...init, headers: mergedHeaders },
  };
}

// Single Tekmetric fetch attempt with logging + queued telemetry.
// Returns the raw Response (or throws on a network error) so callers
// keep their existing `await res.text()` / `await res.json()` flow.
async function tekSingleAttempt(endpointForReport, url, init, opts) {
  const startedAt = Date.now();
  let response;
  let networkErr = null;
  try {
    response = await tekmetricFetchWithBackoff(url, init, opts.label || endpointForReport);
  } catch (err) {
    networkErr = err;
  }
  const elapsedMs = Date.now() - startedAt;
  const status = networkErr ? 0 : response.status;
  const method = (init.method || 'GET').toUpperCase();

  // Queue the report. We deliberately swallow shape failures (e.g.
  // missing endpoint) — telemetry must not surface to the caller.
  try {
    tekEnqueueReport({
      endpointShape: tekSanitizeEndpointShape(endpointForReport),
      method,
      status,
      elapsedMs,
      occurredAt: Date.now(),
      smsShopId: opts.shopId != null ? String(opts.shopId) : (tekmetricShopId || null),
      label: opts.label || null,
      isFallback: !!opts.isFallback,
      fallbackOf: opts.fallbackOf || null,
    });
  } catch {}

  if (networkErr) {
    console.warn(`[tekmetricFetch] ${method} ${endpointForReport} network error after ${elapsedMs}ms:`, networkErr.message);
    throw networkErr;
  }

  if (!response.ok) {
    console.warn(`[tekmetricFetch] ${method} ${endpointForReport} → ${status} in ${elapsedMs}ms${opts.label ? ` (${opts.label})` : ''}`);
  } else if (elapsedMs > 3000) {
    console.log(`[tekmetricFetch] ${method} ${endpointForReport} → ${status} in ${elapsedMs}ms (slow)`);
  }

  return response;
}

// Public helper. Wraps tekmetricFetchWithBackoff with:
//   - automatic baseUrl prefix + x-auth-token injection
//   - per-call latency/status logging
//   - per-call best-effort report into the batched reporter
//   - optional fallback chain (e.g. listing → detail-by-known-id) when
//     the primary returns one of `opts.fallbackOnStatuses` (defaults to
//     [404] — the "endpoint not exposed for this shop" case the
//     fallback chain was designed for)
//   - user-facing toast on final 4xx/5xx for mutating requests
//     (POST/PUT/PATCH/DELETE) by default; opt out with
//     `signalUserOnError: false`. GETs stay quiet by default since they
//     are typically background polls.
//
// `endpoint` MUST be a path (`/api/...`) — we rebuild the URL with the
// captured Tekmetric base. `opts.fallbacks` is an array of
// `{ endpoint, init? }` tried in order on a matching status.
//
// Idempotent: re-invoking with identical args produces identical
// behavior; we don't memoize, and we don't dedupe in-flight calls.
const DEFAULT_FALLBACK_STATUSES = [404];
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

async function tekmetricFetch(endpoint, init = {}, opts = {}) {
  if (!smsTokens.tekmetric) {
    throw new Error('No Tekmetric session token. Open a Tekmetric tab first.');
  }
  const method = ((init.method || 'GET') + '').toUpperCase();
  const isMutating = MUTATING_METHODS.has(method);
  const fallbackStatuses = Array.isArray(opts.fallbackOnStatuses)
    ? opts.fallbackOnStatuses
    : DEFAULT_FALLBACK_STATUSES;

  const built = tekBuildRequest(endpoint, init);
  let response = await tekSingleAttempt(endpoint, built.url, built.init, {
    label: opts.label,
    shopId: opts.shopId,
  });

  const shouldFallback = (status) =>
    Array.isArray(opts.fallbacks) &&
    opts.fallbacks.length > 0 &&
    fallbackStatuses.includes(status);

  if (!response.ok && shouldFallback(response.status)) {
    for (const fb of opts.fallbacks) {
      if (!fb || !fb.endpoint) continue;
      console.log(`[tekmetricFetch] Primary ${endpoint} returned ${response.status}, trying fallback ${fb.endpoint}`);
      try {
        const fbBuilt = tekBuildRequest(fb.endpoint, fb.init || {});
        const fbResponse = await tekSingleAttempt(fb.endpoint, fbBuilt.url, fbBuilt.init, {
          label: fb.label || opts.label,
          shopId: opts.shopId,
          isFallback: true,
          fallbackOf: opts.label || endpoint,
        });
        if (fbResponse.ok) {
          response = fbResponse;
          break;
        }
        // Track latest non-ok so the caller sees the most recent
        // failure status if every fallback fails. Don't keep cascading
        // unless the new status is also a fallback-trigger.
        response = fbResponse;
        if (!fallbackStatuses.includes(fbResponse.status)) break;
      } catch (err) {
        console.warn(`[tekmetricFetch] Fallback ${fb.endpoint} threw:`, err.message);
      }
    }
  }

  // Toast policy: by default we surface failures for mutations (the
  // user clicked a button, they need to know it failed). Background
  // GETs are silent unless the caller explicitly opts in.
  const signalUser =
    opts.signalUserOnError === false
      ? false
      : opts.signalUserOnError === true
        ? true
        : isMutating;

  if (!response.ok && signalUser) {
    const label = opts.label ? ` ${opts.label}` : '';
    tekShowToastOnActiveTab(
      `Tekmetric request failed (${response.status})${label}. Retry in a moment.`,
      response.status >= 500 ? 'error' : 'warning',
    );
  }

  return response;
}

async function handleTekmetricApiRequest(endpoint, options = {}) {
  // Route through the canonical helper so this entrypoint also gets
  // reporting + (future) fallback support, instead of bypassing it.
  const response = await tekmetricFetch(endpoint, options, {
    label: `handleTekmetricApiRequest:${endpoint}`,
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

  const effectiveShopId = shopId || tekmetricShopId;

  if (!effectiveShopId || !roId) {
    return { success: false, error: "Missing shop ID or repair order ID" };
  }

  try {
    // First fetch RO to get labor rate and vehicle info
    const roRes = await tekmetricFetch(
      `/api/shop/${effectiveShopId}/repair-order/${roId}`,
      {},
      { shopId: effectiveShopId, label: 'createTekmetricJob.fetch-ro' }
    );

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

    const createRes = await tekmetricFetch(
      `/api/shop/${effectiveShopId}/job`,
      {
        method: "POST",
        headers: { "accept": "application/json" },
        body: JSON.stringify(jobPayload),
      },
      {
        shopId: effectiveShopId,
        label: 'createTekmetricJob.post-job',
        signalUserOnError: true,
      }
    );

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

// Task #439: optional `intervals` argument lets us skip buckets the shop has
// hidden in settings. Precedence is diesel → euro → synthetic → conventional;
// if the preferred candidate is hidden we fall through to the next visible
// match, then to `defaultOilType` (if visible), then to any remaining visible
// bucket. Backward compatible — callers with no intervals get the prior
// behavior.
function detectOilType(vehicle, intervals, defaultOilType) {
  const isHidden = (key) => intervals && intervals[key] && intervals[key].hidden === true;
  // Precedence: diesel → euro → synthetic → conventional. When the matched
  // bucket is hidden we walk FORWARD in this list rather than jumping to a
  // different "match" — e.g. a BMW with `euro` hidden falls to `synthetic`,
  // NOT to `conventional`.
  const precedence = ['diesel', 'euro', 'synthetic', 'conventional'];

  // Default starting index = synthetic (modern shop default). Promote to
  // euro for European makes, diesel for diesel fuel/engines.
  let startIdx = 2;
  if (vehicle) {
    const make = (vehicle.make || '').toLowerCase();
    const fuelType = (vehicle.fuelType || '').toLowerCase();
    const engine = (vehicle.engine || '').toLowerCase();

    if (EURO_MAKES.includes(make)) startIdx = 1;
    if (
      fuelType === 'diesel' ||
      engine.includes('diesel') ||
      engine.includes('tdi') ||
      engine.includes('duramax') ||
      engine.includes('powerstroke') ||
      engine.includes('cummins')
    ) {
      startIdx = 0;
    }
  }

  for (let i = startIdx; i < precedence.length; i++) {
    if (!isHidden(precedence[i])) return precedence[i];
  }
  for (const key of precedence) {
    if (!isHidden(key)) return key;
  }
  if (defaultOilType && !isHidden(defaultOilType)) return defaultOilType;
  // Spec: fall back to shop default, or 'synthetic' if the default is also
  // hidden / absent. Never return a hidden bucket here.
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
  
  // Determine unit — check context flag first, then fetch shop config. We
  // also use the same fetched config to pass the shop's interval hide flags
  // and defaultOilType into detectOilType (task #439) so auto-detect skips
  // hidden buckets.
  let unit = 'mi';
  let shopIntervals;
  let shopDefaultOilType;
  if (context.useKilometers === true) {
    unit = 'km';
  }
  try {
    const configResp = await fetch(
      `${mosApiUrl}/api/extension/sticker?shopId=${encodeURIComponent(context.shopId)}&provider=${encodeURIComponent(context.provider || '')}&_token=${encodeURIComponent(mosApiToken)}`,
      { headers: { 'Authorization': `Bearer ${mosApiToken}` } }
    );
    if (configResp.ok) {
      const configData = await configResp.json();
      if (context.useKilometers == null && configData.config?.useKilometers) unit = 'km';
      shopIntervals = configData.config?.intervals;
      shopDefaultOilType = configData.config?.defaultOilType;
    }
  } catch (err) {
    console.warn('[MOS] Could not fetch sticker config for unit/intervals, using defaults:', err.message);
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
    requestBody.intervalType = detectOilType(context.vehicle, shopIntervals, shopDefaultOilType);
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

  const shopId = context.shopId || tekmetricShopId;
  if (!shopId) return;

  try {
    const res = await tekmetricFetch(
      `/api/shop/${shopId}/repair-orders/${context.roId}/inspections`,
      {},
      { shopId, label: 'inspections.list.relay' }
    );

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

// Canonical maintenance-service catalog used to drive the VHI Coach overlay
// on providers where the extension cannot read the live inspection from the
// SMS API. AutoFlow is read-only for us, so instead of inspection task names
// we send the full standard catalog: the /api/extension/vhi-coach endpoint
// maps each name to a service key and only the ones present in the vehicle's
// VHI plan get a real (overdue / due-soon / OK) status — yielding the
// vehicle's complete plan in the overlay. Mirrors lib/service-keys.ts's
// SERVICE_KEY_DISPLAY_NAMES.
const DEFAULT_VHI_COACH_TASKS = [
  "Oil Change",
  "Tire Rotation",
  "Cabin Air Filter",
  "Engine Air Filter",
  "Coolant Service",
  "Brake Fluid Service",
  "Automatic Transmission Fluid",
  "Manual Transmission Fluid",
  "Transfer Case Fluid",
  "Front Differential Fluid",
  "Rear Differential Fluid",
  "Power Steering Fluid",
  "Fuel Filter",
  "Spark Plugs",
  "Serpentine Belt",
  "Timing Belt",
  "Fuel System Cleaning",
  "Front Brake Pads",
  "Rear Brake Pads",
  "Front Brake Rotors",
  "Rear Brake Rotors",
  "Front Shocks / Struts",
  "Rear Shocks / Struts",
  "Wheel Alignment",
  "Battery",
  "Wiper Blades",
  "A/C Service",
  "Emissions Inspection",
  "Coolant Hoses",
];

// Shared POST to the VHI Coach endpoint + relay of the result to the page
// overlay. Provider-agnostic: Tekmetric supplies real inspection task names,
// AutoFlow supplies the canonical catalog above. Returns the parsed payload
// on success (truthy) so callers can update their dedup key.
async function postVhiCoachData(context, taskNames, provider) {
  if (!mosApiToken || !mosApiUrl) return null;
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
        provider: provider,
        mileage: context.mileage || null,
        inspectionTasks: taskNames,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.warn(`[VHI Coach] API error ${res.status}:`, text.substring(0, 200));
      return null;
    }

    const data = await res.json();
    console.log(`[VHI Coach] Got data:`, data.summary);

    const tabId = context._tabId;
    if (tabId) {
      chrome.tabs.sendMessage(tabId, {
        action: "VHI_COACH_DATA",
        data: data,
      }).catch(() => {});
    }
    return data;
  } catch (err) {
    console.warn("[VHI Coach] Error:", err.message);
    return null;
  }
}

// AutoFlow VHI Coach (read-only parity with Tekmetric). We can't read the
// AutoFlow inspection, so we drive the overlay from the VIN + shop + mileage
// the AutoFlow adapter scrapes, feeding the canonical service catalog as the
// task list. Realtime/polling refresh reuses the same path via
// REFETCH_VHI_COACH.
async function fetchVhiCoachForAutoflow(context) {
  await _stateReady;
  if (!mosApiToken || !mosApiUrl) return;
  if (!context?.vin || !context?.shopId) return;
  if (context.vin.length !== 17) return;

  // The endpoint requires a mileage for the VHI analysis. If AutoFlow hasn't
  // surfaced one yet, hide any stale overlay rather than 400-looping.
  if (!context.mileage) {
    if (context._tabId) {
      chrome.tabs.sendMessage(context._tabId, { action: "VHI_COACH_HIDE" }).catch(() => {});
    }
    return;
  }

  const coachKey = `${context.shopId}:${context.roId || context.vin}`;
  if (coachKey === lastCoachRoId) return;

  console.log(
    `[VHI Coach] AutoFlow fetch for VIN ${context.vin} (${DEFAULT_VHI_COACH_TASKS.length} catalog tasks)`
  );

  const data = await postVhiCoachData(context, DEFAULT_VHI_COACH_TASKS, "autoflow");
  if (data) lastCoachRoId = coachKey;
}

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

  const data = await postVhiCoachData(context, taskNames, "tekmetric");
  if (data) lastCoachRoId = coachKey;
}

async function prefillDviInspection(context, inspId, tabId) {
  await _stateReady;
  if (!mosApiToken || !mosApiUrl) return { success: false, error: "Not connected to MOS" };
  if (!smsTokens.tekmetric) return { success: false, error: "No Tekmetric session token" };
  if (!context?.vin || context.vin.length !== 17) return { success: false, error: "No VIN detected" };
  if (!context?.mileage) return { success: false, error: "No mileage detected on this RO" };

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
    // Listing → detail-by-known-id fallback when the listing endpoint
    // 404s for this shop. The detail endpoint accepts an inspection id
    // we know about from the supplied `inspId` arg; without that we
    // can only try the listing.
    const fallbacks = inspId
      ? [{
          endpoint: `/api/shop/${shopId}/repair-orders/${context.roId}/inspections/${inspId}`,
          label: 'inspections.detail-by-id.fallback',
        }]
      : [];
    const res = await tekmetricFetch(
      `/api/shop/${shopId}/repair-orders/${context.roId}/inspections`,
      {},
      {
        shopId,
        label: 'prefill-dvi.list-inspections',
        signalUserOnError: true,
        fallbacks,
      }
    );
    if (!res.ok) return { success: false, error: `Failed to fetch inspections (${res.status})` };
    const data = await res.json();
    // Detail-by-id endpoint returns the inspection object directly;
    // listing returns either an array or a paginated wrapper. Handle
    // both shapes uniformly.
    if (Array.isArray(data)) {
      inspArr = data;
    } else if (data && (data.content || data.data)) {
      inspArr = data.content || data.data || [];
    } else if (data && data.id) {
      inspArr = [data];
    } else {
      inspArr = [];
    }
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
      const res = await tekmetricFetch(
        `/api/shop/${shopId}/repair-orders/${context.roId}/inspections/${inspection.id}/tasks/${task.id}`,
        {
          method: "PUT",
          body: JSON.stringify(putBody),
        },
        { shopId, label: 'prefill-dvi.put-task' }
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

// ==================== BUILD RO FROM VHI ====================

async function fetchBuildRoFromVhiPreview(context) {
  await _stateReady;
  if (!mosApiToken || !mosApiUrl) return { success: false, error: "Not connected to MOS" };
  if (!context?.vin || context.vin.length !== 17) return { success: false, error: "No VIN detected" };
  if (!context?.mileage) return { success: false, error: "No mileage detected on this RO" };

  const shopId = context.shopId || tekmetricShopId;
  if (!shopId) return { success: false, error: "No shop ID" };

  let preview;
  try {
    const res = await fetch(`${mosApiUrl}/api/extension/build-ro-from-vhi`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${mosApiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        vin: context.vin,
        smsShopId: shopId,
        provider: context.provider || "tekmetric",
        mileage: context.mileage,
        roId: context.roId || null,
        vehicleId: context.vehicleId || null,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.warn(`[Build RO from VHI] Preview API error ${res.status}:`, text.substring(0, 200));
      let parsed = null;
      try { parsed = JSON.parse(text); } catch (_) {}
      return { success: false, error: parsed?.error || `VHI preview failed (${res.status})` };
    }

    preview = await res.json();
  } catch (err) {
    return { success: false, error: "VHI preview failed: " + err.message };
  }

  if (!preview.success) {
    return { success: false, error: preview.error || "No VHI data available" };
  }

  return preview;
}

async function applyBuildRoFromVhi(context, selected, markerPrefix, tabId) {
  await _stateReady;
  if (!smsTokens.tekmetric) return { success: false, error: "No Tekmetric session token" };
  if (!context?.roId) return { success: false, error: "No RO ID in context" };

  const baseUrl = tekmetricBaseUrl || "https://shop.tekmetric.com";
  const shopId = context.shopId || tekmetricShopId;
  if (!shopId) return { success: false, error: "No shop ID" };
  if (!Array.isArray(selected) || selected.length === 0) {
    return { success: false, error: "No items selected" };
  }

  // Marker handling.
  //
  // The server's proposal generator currently emits concern text starting
  // with the verbose marker "[ai-suggested from VHI: <title>] ...". Per
  // platform-admin direction in v1.27.3 we want the user-facing marker to
  // be the short "[VHI: <title>] ...". Rather than wait on a separate
  // server-side deploy, we rewrite the marker client-side immediately
  // before POSTing the concern (see rewriteVhiMarker below).
  //
  // markerRegex must therefore match BOTH formats so idempotency and
  // verification continue to work for legacy concerns already present on
  // ROs as well as any newly-rewritten ones:
  //   [VHI: Engine Oil] — desc                    (new, post-rewrite)
  //   [ai-suggested from VHI: Engine Oil] — desc  (legacy, server-emitted)
  //   [VHI] Engine Oil — desc                     (very old format)
  // markerPrefix from the message is intentionally ignored here — the
  // regex is now multi-format and the server prefix has drifted from it.
  const markerRegex = /^\[(?:ai-suggested from )?VHI(?::\s*([^\]]+)\]|\]\s+(.+?)(?:\s+[—-]\s|$))/i;
  // Helper: pull the title out of a marker match regardless of which
  // alternative branch matched. Group 1 is the bracketed-colon form,
  // group 2 is the legacy space form.
  const extractMarkerTitle = (match) => {
    if (!match) return null;
    const t = (match[1] ?? match[2] ?? "").trim();
    return t || null;
  };
  // Helper: rewrite the verbose server marker to the short user-facing
  // form. Idempotent — already-short markers pass through unchanged.
  const rewriteVhiMarker = (text) => {
    if (typeof text !== "string") return text;
    return text.replace(/^\s*\[ai-suggested from VHI:\s*([^\]]+)\]/i, "[VHI: $1]");
  };

  // Tekmetric inspection-rating constants. The technician-concerns endpoint
  // requires `inspectionRating` as a full {id,code,name} object (not just an
  // id). These two values were captured from real Tekmetric UI POSTs in
  // HARs supplied by Brandon on 2026-05-06:
  //   - red    "Requires Immediate Attention"  id=3 code=RQRSATTN
  //   - yellow "May Require Attention Soon"    id=2 code=MAYRQRATTN
  // We map overdue VHI items to red and everything else (due-soon, etc.)
  // to yellow. There's also a green "Looks Good" rating but VHI never
  // surfaces healthy items as actionable concerns, so we don't use it.
  const RATING_REQUIRES_ATTENTION = { id: 3, code: "RQRSATTN", name: "Requires Immediate Attention" };
  const RATING_MAY_REQUIRE_ATTENTION = { id: 2, code: "MAYRQRATTN", name: "May Require Attention Soon" };
  const ratingForStatus = (status) => {
    return status === "overdue" ? RATING_REQUIRES_ATTENTION : RATING_MAY_REQUIRE_ATTENTION;
  };

  // 1. Fetch existing technician concerns to detect already-stamped items
  //    (idempotency). Job-existence checks were removed in v1.27.2 along
  //    with job creation — see step 2 below.
  let existingConcernTitles = new Set();

  try {
    const concernsRes = await tekmetricFetchWithBackoff(
      `${baseUrl}/api/repair-orders/${context.roId}/technician-concerns`,
      {
        headers: { "x-auth-token": smsTokens.tekmetric, "content-type": "application/json" },
      },
      `build-ro-from-vhi GET concerns ${context.roId}`
    );
    if (concernsRes.ok) {
      const data = await concernsRes.json();
      const list = Array.isArray(data) ? data : (data?.data || []);
      for (const c of list) {
        // Tekmetric stores the concern title in `inspectionTask` (the
        // `concern` field we used pre-1.27.4 was wrong — it never existed
        // on the response). Fall back to `concern` defensively just in
        // case any older Tekmetric API ever does return that key.
        const text = (c?.inspectionTask || c?.concern || "").trim();
        const t = extractMarkerTitle(text.match(markerRegex));
        if (t) existingConcernTitles.add(t);
      }
      console.log(
        `[Build RO from VHI] Found ${existingConcernTitles.size} existing [VHI] concern(s) on RO ${context.roId}`
      );
    } else {
      const errText = await concernsRes.text().catch(() => "");
      console.warn(
        `[Build RO from VHI] GET concerns returned ${concernsRes.status}: ${errText.substring(0, 200)}`
      );
    }
  } catch (err) {
    console.warn("[Build RO from VHI] Failed to fetch existing concerns:", err.message);
  }

  // 2. For each selected item, create a technician concern (skip if already
  //    present). Job creation was REMOVED in v1.27.2 per platform-admin
  //    direction — the advisor now builds jobs themselves from the
  //    technician concerns. See CHANGELOG 1.27.2 for the why.
  const results = [];
  let added = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < selected.length; i++) {
    const item = selected[i];
    const sk = item.serviceKey;
    const titleKey = (item.title || "").trim();

    if (tabId) {
      chrome.tabs.sendMessage(tabId, {
        action: "BUILD_RO_FROM_VHI_PROGRESS",
        index: i,
        total: selected.length,
        title: item.title,
      }).catch(() => {});
    }

    const result = {
      serviceKey: sk,
      title: item.title,
      status: item.status,
      concernCreated: false,
      concernId: null,
      outcome: "pending",
      error: null,
    };

    if (existingConcernTitles.has(titleKey)) {
      result.outcome = "skipped_existing";
      skipped++;
      results.push(result);
      continue;
    }

    // POST the concern. We always read and log the response body so silent
    // server-side rejections are visible. Tekmetric was reportedly returning
    // 200 OK without persisting the concern (see commit message for v1.27.2);
    // the verification re-fetch after the loop catches this case and
    // demotes the result from "added" to "failed" so the toast tells the
    // truth instead of pretending success.
    try {
      const cRes = await tekmetricFetchWithBackoff(
        `${baseUrl}/api/repair-orders/${context.roId}/technician-concerns`,
        {
          method: "POST",
          headers: {
            "x-auth-token": smsTokens.tekmetric,
            "content-type": "application/json",
            accept: "application/json",
          },
          // The Tekmetric technician-concerns endpoint requires
          // BOTH `inspectionRating` (full {id,code,name} object) and
          // `inspectionTask` (free-text title). Pre-1.27.4 we sent
          // `{concern: "..."}` which silently 400'd with
          // {"inspectionRating":"required","inspectionTask":"required"}.
          // Shape verified against real Tekmetric UI HARs from 2026-05-06.
          // `inspectionTask` is just a string label — it does NOT need
          // to reference a real RO inspection task (the response confirms
          // hasRoInspectionTask:false, roInspectionId:null).
          body: JSON.stringify({
            inspectionRating: ratingForStatus(item.status),
            inspectionTask: rewriteVhiMarker(item.concern),
          }),
        },
        `build-ro-from-vhi POST concern ${sk}`
      );
      const cBody = await cRes.text();
      let cData = null;
      try { cData = cBody ? JSON.parse(cBody) : null; } catch { /* keep raw */ }

      if (!cRes.ok) {
        console.error(
          `[Build RO from VHI] concern POST FAILED status=${cRes.status} ` +
          `roId=${context.roId} item="${titleKey}" body=${cBody.substring(0, 500)}`
        );
        result.outcome = "failed";
        result.error = `concern create ${cRes.status}: ${cBody.substring(0, 200)}`;
        failed++;
        results.push(result);
        continue;
      }

      const created = cData?.data?.id ? cData.data : cData;
      console.log(
        `[Build RO from VHI] concern POST 2xx for "${titleKey}" — ` +
        `id=${created?.id ?? "(none in body)"} body=${cBody.substring(0, 300)}`
      );
      result.concernCreated = true;
      result.concernId = created?.id ?? null;
      result.outcome = "added";
      added++;
      existingConcernTitles.add(titleKey);
      results.push(result);
    } catch (err) {
      console.error(`[Build RO from VHI] concern POST threw: ${err.message}`);
      result.outcome = "failed";
      result.error = "concern create error: " + err.message;
      failed++;
      results.push(result);
      continue;
    }

    // -------------------------------------------------------------
    // [REMOVED in v1.27.2] Two-step job creation block previously
    // POSTed an empty job, then PUT a populated job with labor + parts
    // matched to the shop's canned jobs. Removed per platform-admin
    // direction so the feature only adds technician concerns; the
    // advisor builds the jobs themselves from those concerns.
    // -------------------------------------------------------------

    // gentle pacing
    await new Promise(r => setTimeout(r, 80));
  }

  // 3. Verification: re-fetch concerns and confirm everything we POSTed is
  //    actually visible in Tekmetric. This catches the silent-failure mode
  //    reported on 2026-05-05 (POST returned 2xx but no concerns appeared
  //    on the RO). Items whose POST returned 2xx but are missing from the
  //    re-fetch get demoted from "added" to "failed" so the user sees the
  //    real outcome instead of a misleading success toast.
  if (added > 0) {
    try {
      const verifyRes = await tekmetricFetchWithBackoff(
        `${baseUrl}/api/repair-orders/${context.roId}/technician-concerns`,
        {
          headers: { "x-auth-token": smsTokens.tekmetric, "content-type": "application/json" },
        },
        `build-ro-from-vhi VERIFY concerns ${context.roId}`
      );
      if (verifyRes.ok) {
        const verifyData = await verifyRes.json();
        const verifyList = Array.isArray(verifyData) ? verifyData : (verifyData?.data || []);
        // Build BOTH an id set and a title set so verification can prefer
        // id-match (bulletproof, no normalization concerns) and fall back
        // to title-match only when the POST response did not include an id.
        // This avoids false demotions when item titles contain " — " or
        // other characters that the markerRegex extracts ambiguously.
        const persistedIds = new Set();
        const persistedTitles = new Set();
        for (const c of verifyList) {
          if (c?.id != null) persistedIds.add(String(c.id));
          // Tekmetric stores the title in `inspectionTask`; see GET-parser
          // comment above for the same reason. Defensive `concern` fallback.
          const text = (c?.inspectionTask || c?.concern || "").trim();
          const t = extractMarkerTitle(text.match(markerRegex));
          if (t) persistedTitles.add(t);
        }
        const silentlyMissing = [];
        for (const r of results) {
          if (!r.concernCreated) continue;
          const verifiedById = r.concernId != null && persistedIds.has(String(r.concernId));
          const verifiedByTitle = persistedTitles.has((r.title || "").trim());
          if (verifiedById || verifiedByTitle) continue;
          silentlyMissing.push(r.title);
          r.outcome = "failed";
          r.error = "concern POST returned 2xx but concern is NOT visible in Tekmetric on re-fetch (silent server-side rejection)";
          added--;
          failed++;
        }
        if (silentlyMissing.length > 0) {
          console.error(
            `[Build RO from VHI] SILENT FAILURE: ${silentlyMissing.length} concern(s) POSTed but not visible in Tekmetric on re-fetch. ` +
            `Titles: ${silentlyMissing.slice(0, 5).join(", ")}${silentlyMissing.length > 5 ? "…" : ""}`
          );
        } else {
          console.log(
            `[Build RO from VHI] Verification PASSED: all ${added} new concern(s) visible on RO ${context.roId}`
          );
        }
      } else {
        console.warn(
          `[Build RO from VHI] Verification GET returned ${verifyRes.status} — cannot confirm concerns persisted; trusting POST 2xx responses`
        );
      }
    } catch (err) {
      console.warn(
        `[Build RO from VHI] Verification GET error: ${err.message} — cannot confirm concerns persisted`
      );
    }
  }

  // 4. Send audit log
  try {
    await fetch(`${mosApiUrl}/api/extension/build-ro-from-vhi/log`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${mosApiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        smsShopId: shopId,
        provider: context.provider || "tekmetric",
        roId: context.roId,
        roNumber: context.roNumber || null,
        vin: context.vin,
        summary: { selected: selected.length, added, skipped, failed },
        items: results,
      }),
    });
  } catch (err) {
    console.warn("[Build RO from VHI] Audit log post failed:", err.message);
  }

  // The originating tab will reload itself in response to the COMPLETE
  // message; no global JOB_CREATED broadcast (which would spam other open
  // Tekmetric tabs with a misleading "Job added: undefined" toast).

  const failedItems = results
    .filter((r) => r.outcome === "failed")
    .map((r) => ({ title: r.title, serviceKey: r.serviceKey, error: r.error }));

  return {
    success: true,
    added,
    skipped,
    failed,
    selected: selected.length,
    results,
    failedItems,
  };
}

async function fetchEnhancedFindings(context, inspId, tabId) {
  await _stateReady;
  if (!mosApiToken || !mosApiUrl) return { success: false, error: "Not connected to MOS" };
  if (!smsTokens.tekmetric) return { success: false, error: "No Tekmetric session token" };

  const shopId = context.shopId || tekmetricShopId;
  if (!shopId) return { success: false, error: "No shop ID" };

  if (tabId) {
    chrome.tabs.sendMessage(tabId, { action: "SHOW_TOAST", message: "Fetching inspection findings...", type: "info" }).catch(() => {});
  }

  let inspArr;
  try {
    const fallbacks = inspId
      ? [{
          endpoint: `/api/shop/${shopId}/repair-orders/${context.roId}/inspections/${inspId}`,
          label: 'inspections.detail-by-id.fallback',
        }]
      : [];
    const res = await tekmetricFetch(
      `/api/shop/${shopId}/repair-orders/${context.roId}/inspections`,
      {},
      {
        shopId,
        label: 'enhance-findings.list-inspections',
        signalUserOnError: true,
        fallbacks,
      }
    );
    if (!res.ok) return { success: false, error: `Failed to fetch inspections (${res.status})` };
    const data = await res.json();
    if (Array.isArray(data)) {
      inspArr = data;
    } else if (data && (data.content || data.data)) {
      inspArr = data.content || data.data || [];
    } else if (data && data.id) {
      inspArr = [data];
    } else {
      inspArr = [];
    }
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
        shopId: context.shopId || null,
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

  const shopId = context.shopId || tekmetricShopId;
  if (!shopId) return { success: false, error: "No shop ID" };

  let inspArr;
  try {
    const fallbacks = inspectionId
      ? [{
          endpoint: `/api/shop/${shopId}/repair-orders/${context.roId}/inspections/${inspectionId}`,
          label: 'inspections.detail-by-id.fallback',
        }]
      : [];
    const res = await tekmetricFetch(
      `/api/shop/${shopId}/repair-orders/${context.roId}/inspections`,
      {},
      {
        shopId,
        label: 'apply-enhanced.list-inspections',
        fallbacks,
      }
    );
    if (!res.ok) return { success: false, error: `Failed to fetch inspections (${res.status})` };
    const data = await res.json();
    if (Array.isArray(data)) {
      inspArr = data;
    } else if (data && (data.content || data.data)) {
      inspArr = data.content || data.data || [];
    } else if (data && data.id) {
      inspArr = [data];
    } else {
      inspArr = [];
    }
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
      const res = await tekmetricFetch(
        `/api/shop/${shopId}/repair-orders/${context.roId}/inspections/${itemInspId}/tasks/${task.id}`,
        {
          method: "PUT",
          body: JSON.stringify(putBody),
        },
        { shopId, label: 'enhance-notes.put-task' }
      );
      if (res.ok) { applied++; } else { failed++; }
    } catch { failed++; }

    if (applied % 5 === 0 && applied > 0) {
      await new Promise(r => setTimeout(r, 100));
    }
  }

  console.log(`[Enhance Findings] Applied: ${applied}, Failed: ${failed}`);

  const corrections = approved.filter(item =>
    item.aiOriginal && item.enhanced !== item.aiOriginal
  ).map(item => ({
    taskName: item.taskName,
    aiSuggested: item.aiOriginal,
    advisorWrote: item.enhanced,
  }));

  if (corrections.length > 0 && mosApiToken && mosApiUrl && context.shopId) {
    try {
      await fetch(`${mosApiUrl}/api/extension/enhance-corrections`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${mosApiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          shopId: context.shopId,
          corrections,
        }),
      });
      console.log(`[Enhance Findings] Saved ${corrections.length} advisor corrections for shop ${context.shopId}`);
    } catch (err) {
      console.warn("[Enhance Findings] Failed to save corrections:", err.message);
    }
  }

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
  let roData;
  try {
    const res = await tekmetricFetch(
      `/api/shop/${shopId}/repair-order/${context.roId}`,
      {},
      { shopId, label: 'labor-rate.get-ro' }
    );
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

  // Fetch estimate data — this is the endpoint Tekmetric uses to load
  // jobs with labor. If the estimate endpoint is unavailable for this
  // shop (404/5xx), the helper's fallback chain transparently retries
  // the jobs-list endpoint.
  let estimateData = null;
  try {
    const estRes = await tekmetricFetch(
      `/api/repair-order/${context.roId}/estimate`,
      {},
      {
        shopId,
        label: 'labor-rate.get-estimate',
        // Estimate endpoint can fail with 404 (not exposed for shop)
        // OR with 5xx (intermittent backend issue) — original behavior
        // was to always try /jobs when estimate didn't yield, so we
        // broaden the trigger here beyond the default [404].
        fallbackOnStatuses: [404, 500, 502, 503, 504],
        fallbacks: [{
          endpoint: `/api/shop/${shopId}/jobs?repairOrderId=${context.roId}`,
          label: 'labor-rate.get-jobs.fallback',
        }],
      }
    );
    if (estRes.ok) {
      estimateData = await estRes.json();
      const estPayload = estimateData.data || estimateData;
      // The estimate endpoint returns `{ data: { jobs: [...] } }` while
      // the jobs-list fallback returns either an array or
      // `{ content/data: [...] }`. Coerce to a single jobs array.
      let jobsArr = estPayload.jobs;
      if (!Array.isArray(jobsArr)) {
        if (Array.isArray(estimateData)) {
          jobsArr = estimateData;
        } else {
          jobsArr = estimateData.content || estimateData.data || [];
        }
      }
      if (Array.isArray(jobsArr) && jobsArr.length > 0) {
        roData.jobs = jobsArr;
        console.log(`[LaborRate] Loaded ${jobsArr.length} jobs with labor from estimate (or fallback)`);
      } else {
        console.log(`[LaborRate] Estimate returned 200 with no jobs`);
      }
    } else {
      console.log(`[LaborRate] Estimate (and fallback) returned ${estRes.status}`);
    }
  } catch (err) {
    console.warn("[LaborRate] Error fetching estimate:", err.message);
  }

  // Empty-result fallback (NOT status-based): the estimate endpoint
  // can return 200 with an empty `jobs` array even when the shop has
  // jobs on the RO (some shops gate labor visibility behind a separate
  // permission). The helper's fallback chain only triggers on status
  // codes, so we explicitly call the jobs-list endpoint here if the
  // estimate didn't populate any jobs. Preserves the pre-task #224
  // behavior where this second call was unconditional.
  if (!roData.jobs || roData.jobs.length === 0) {
    try {
      const jobsRes = await tekmetricFetch(
        `/api/shop/${shopId}/jobs?repairOrderId=${context.roId}`,
        {},
        { shopId, label: 'labor-rate.get-jobs.empty-estimate' }
      );
      if (jobsRes.ok) {
        const jobsBody = await jobsRes.json();
        const jobsArr = Array.isArray(jobsBody)
          ? jobsBody
          : (jobsBody.content || jobsBody.data || []);
        roData.jobs = Array.isArray(jobsArr) ? jobsArr : [];
        if (roData.jobs.length > 0) {
          console.log(`[LaborRate] Empty-estimate fallback fetched ${roData.jobs.length} jobs from jobs list (no labor data)`);
        }
      }
    } catch (err) {
      console.warn("[LaborRate] Error fetching jobs (empty-estimate fallback):", err.message);
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
      const custRes = await tekmetricFetch(
        `/api/shop/${shopId}/customer/${customer.id}`,
        {},
        { shopId, label: 'labor-rate.get-customer' }
      );
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
    const roResult = await applyLaborRateToRO(matchedRoRule, Math.round(matchedRoRule.rate * 100), roData, context, options);
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
      const jobResult = await applyLaborRatePerJob(rule, Math.round(rule.rate * 100), roData, context, options);
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
        const res = await tekmetricFetch(
          `/api/shop/${shopId}/job`,
          { method: 'POST', body: JSON.stringify(jobPayload) },
          { shopId, label: 'labor-rate.post-job-unmatched' }
        );
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

async function applyLaborRatePerJob(matchedRule, rateInCents, roData, context, options = {}) {
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
      const res = await tekmetricFetch(
        `/api/shop/${shopId}/job`,
        { method: 'POST', body: JSON.stringify(jobPayload) },
        { shopId, label: 'labor-rate.post-job-per-category' }
      );
      ownJobPostInFlight = false;

      if (res.ok) {
        await res.json();
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

async function applyLaborRateToRO(matchedRule, rateInCents, roData, context, options = {}) {
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

    const updateRes = await tekmetricFetch(
      `/api/repair-order/${context.roId}/summary`,
      { method: 'PUT', body: JSON.stringify(summaryPayload) },
      {
        shopId: context.shopId || tekmetricShopId,
        label: 'labor-rate.put-ro-summary',
        signalUserOnError: true,
      }
    );

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
