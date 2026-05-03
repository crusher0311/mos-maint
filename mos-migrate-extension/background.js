// MOS Migrate Extension — Background Service Worker
//
// Owner-only standalone extension. Responsibilities:
//   1. Authenticate against the MOS backend.
//   2. Refuse to operate for any account that isn't `isSuperAdmin`.
//   3. Proxy authenticated MOS API calls for the side panel.
//   4. Capture Tekmetric `x-auth-token` headers from owner-opened
//      Tekmetric tabs and relay them to the MOS backend so the
//      server-side migration orchestrator can call Tekmetric on the
//      shop's behalf.
//
// All migration business logic lives server-side under
// `app/api/extension/tekmetric-migration/*` — this background script
// only ferries auth + API requests.

// ==================== STATE ====================
let mosApiToken = null;
let mosApiUrl = null;

// Per-shop timestamp of last successful x-auth-token relay (debounce so
// we don't hammer the backend on every Tekmetric XHR).
const xAuthTokenRelayMap = {};
const XAUTH_RELAY_INTERVAL = 30 * 60 * 1000; // 30 min per shop

// Last-seen Tekmetric shop id (parsed from the URL of the captured
// request) used to key the relay so we know which shop the token
// belongs to.
let tekmetricShopId = null;

// Restore persisted state once at startup.
const _stateReady = new Promise(resolve => {
  chrome.storage.local.get(['mosApiToken', 'mosApiUrl'], (result) => {
    if (result.mosApiToken) mosApiToken = result.mosApiToken;
    if (result.mosApiUrl) mosApiUrl = result.mosApiUrl;
    resolve();
  });
});

// Keep the side panel as the action surface; Chrome opens it when the
// owner clicks the toolbar icon.
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

// ==================== TEKMETRIC TOKEN CAPTURE ====================
// Capture x-auth-token from owner-opened Tekmetric tabs and relay to
// MOS backend so the migration orchestrator can call Tekmetric APIs.
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    // Track which Tekmetric shop the request is hitting.
    const shopMatch = details.url.match(/\/(?:token\/)?shop\/(\d+)/);
    if (shopMatch) {
      tekmetricShopId = shopMatch[1];
    }

    const tokenHeader = (details.requestHeaders || []).find(
      h => h.name.toLowerCase() === 'x-auth-token'
    );
    if (!tokenHeader || !tokenHeader.value) return;

    if (!mosApiToken || !mosApiUrl || !tekmetricShopId) return;

    const now = Date.now();
    const key = tekmetricShopId;
    const lastRelay = xAuthTokenRelayMap[key] || 0;
    if (now - lastRelay <= XAUTH_RELAY_INTERVAL) return;

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
        xAuthTokenRelayMap[key] = Date.now();
        console.log('[MOS Migrate] Relayed x-auth-token for shop', tekmetricShopId);
      } else {
        console.warn('[MOS Migrate] x-auth-token relay failed:', res.status);
      }
    }).catch(err => {
      console.warn('[MOS Migrate] x-auth-token relay error:', err.message);
    });
  },
  {
    urls: [
      'https://shop.tekmetric.com/api/*',
      'https://sandbox.tekmetric.com/api/*',
      'https://cba.tekmetric.com/api/*'
    ],
    types: ['xmlhttprequest']
  },
  ['requestHeaders']
);

// ==================== MESSAGE ROUTER ====================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'PING') {
    sendResponse({ pong: true });
    return false;
  }

  if (message.action === 'OPEN_SIDE_PANEL') {
    if (sender.tab?.id) {
      chrome.sidePanel.open({ tabId: sender.tab.id })
        .then(() => sendResponse({ success: true }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;
    }
    sendResponse({ success: false, error: 'No tab ID' });
    return false;
  }

  if (message.action === 'MOS_LOGIN') {
    handleMosLogin(message.email, message.password, message.apiUrl, message.rememberMe !== false)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === 'MOS_LOGOUT') {
    mosApiToken = null;
    chrome.storage.local.remove([
      'mosApiToken', 'mosUser', 'mosShops',
      'mosLoginEmail', 'mosLoginPass', 'mosRememberMe'
    ]);
    sendResponse({ success: true });
    return false;
  }

  if (message.action === 'GET_MOS_AUTH') {
    _stateReady.then(() => {
      chrome.storage.local.get(['mosUser', 'mosShops'], (result) => {
        sendResponse({
          isAuthenticated: !!mosApiToken,
          apiUrl: mosApiUrl,
          shops: result.mosShops || [],
          user: result.mosUser || null
        });
      });
    });
    return true;
  }

  if (message.action === 'MOS_API_REQUEST') {
    (async () => {
      // Defense in depth: only super-admin (owner) accounts may hit any
      // backend in this extension. The server enforces this for
      // tekmetric-migration routes too — this short-circuit just keeps
      // a non-owner from ever firing a request from this extension.
      const { mosUser } = await chrome.storage.local.get('mosUser');
      if (!isSuperAdminUser(mosUser)) {
        sendResponse({ success: false, error: 'Not authorized: super admin only' });
        return;
      }
      try {
        const result = await handleMosApiRequest(message.endpoint, message.options);
        sendResponse(result);
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  return false;
});

function isSuperAdminUser(user) {
  return user?.isSuperAdmin === true;
}

// ==================== MOS API ====================
async function handleMosLogin(email, password, apiUrl, rememberMe = true) {
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

  // Owner-only gate: if the authenticated user isn't on the
  // SUPER_ADMIN_EMAILS allowlist, drop the credentials immediately and
  // refuse to render the wizard.
  if (!isSuperAdminUser(data.user)) {
    chrome.storage.local.remove([
      'mosApiToken', 'mosUser', 'mosShops',
      'mosLoginEmail', 'mosLoginPass', 'mosRememberMe'
    ]);
    mosApiToken = null;
    return { success: false, error: 'This extension is for the MOS owner only.', notAuthorized: true };
  }

  mosApiToken = data.token;

  const storageData = {
    mosApiToken: data.token,
    mosApiUrl: mosApiUrl,
    mosUser: data.user,
    mosShops: data.shops || [],
    mosRememberMe: rememberMe
  };
  if (rememberMe) {
    storageData.mosLoginEmail = email;
    storageData.mosLoginPass = password;
  } else {
    chrome.storage.local.remove(['mosLoginEmail', 'mosLoginPass']);
  }
  chrome.storage.local.set(storageData);

  console.log('[MOS Migrate] Login successful:', data.user?.email);
  return { success: true, user: data.user, shops: data.shops || [] };
}

async function handleMosApiRequest(endpoint, options = {}, _retried = false) {
  await _stateReady;
  if (!mosApiToken) throw new Error('Not authenticated with MOS');

  const tokenUsed = mosApiToken;
  const separator = endpoint.includes('?') ? '&' : '?';
  const urlWithToken = `${mosApiUrl}${endpoint}${separator}_token=${encodeURIComponent(tokenUsed)}`;

  const response = await fetch(urlWithToken, {
    ...options,
    headers: {
      'Authorization': `Bearer ${tokenUsed}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  if (response.status === 401) {
    // Try a single silent re-auth with stored credentials before giving up.
    if (!_retried) {
      const stored = await new Promise(resolve =>
        chrome.storage.local.get(['mosLoginEmail', 'mosLoginPass'], resolve)
      );
      if (stored.mosLoginEmail && stored.mosLoginPass) {
        try {
          const r = await handleMosLogin(stored.mosLoginEmail, stored.mosLoginPass, mosApiUrl);
          if (r.success) return handleMosApiRequest(endpoint, options, true);
        } catch (e) {
          console.error('[MOS Migrate] Silent re-auth failed:', e.message);
        }
      }
    }
    if (mosApiToken === tokenUsed) {
      mosApiToken = null;
      chrome.storage.local.remove(['mosApiToken']);
    }
    throw new Error('Session expired. Please login again.');
  }

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error || `API error: ${response.status}`);
  }

  return response.json();
}
