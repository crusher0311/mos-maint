const tabSelect = document.getElementById('default-tab');
const swAddModeSelect = document.getElementById('sw-add-mode');
const swAddModeGroup = document.getElementById('sw-add-mode-group');
const statusMessage = document.getElementById('status-message');
const notLoggedIn = document.getElementById('not-logged-in');
const settingsContent = document.getElementById('settings-content');

const featureTabMap = {
  'plan': 'maintenance',
  'failures': 'common_failures',
  'lookup': 'job_lookup',
  'canned': null,
  'rates': 'labor_rates',
  'sticker': 'oil_sticker',
  'specs': null
};

let currentFeatures = {};
let saveTimeout = null;
let swSaveTimeout = null;

// ==================== INJECTED BUTTON VISIBILITY (Task #1086) ====================
// Mirrors lib/extension-button-visibility.ts on the server: which buttons
// each adapter injects, and which shop feature entitlement (if any) gates
// them. Hiding is per-user; entitlements decide what CAN show at all.
const INJECTED_BUTTONS = [
  {
    provider: 'tekmetric', label: 'Tekmetric',
    buttons: [
      { key: 'oil_sticker', label: 'Oil Sticker (print)', feature: null },
      { key: 'dvi_prefill', label: 'Pre-fill DVI', feature: 'dvi_prefill' },
      { key: 'enhance_notes', label: 'Enhance Notes', feature: 'enhance_notes' },
      { key: 'add_vhi_recommendations', label: 'Add VHI recommendations', feature: 'dvi_prefill' },
    ],
  },
  {
    provider: 'autoflow', label: 'AutoFlow',
    buttons: [
      { key: 'oil_sticker', label: 'Oil Sticker (print)', feature: null },
      { key: 'dvi_prefill', label: 'Pre-fill DVI', feature: 'dvi_prefill' },
      { key: 'enhance_notes', label: 'Enhance Notes', feature: 'enhance_notes' },
      { key: 'add_vhi_recommendations', label: 'Add VHI recommendations', feature: 'dvi_prefill' },
      { key: 'create_ro', label: 'Create RO', feature: null },
    ],
  },
  {
    provider: 'shopware', label: 'Shop-Ware',
    buttons: [
      { key: 'oil_sticker', label: 'Oil Sticker (print)', feature: null },
    ],
  },
];

let buttonVisibilityPrefs = {}; // sparse: { provider: { key: false } }
let visSaveTimeout = null;

function renderButtonVisibility() {
  const container = document.getElementById('button-visibility-groups');
  if (!container) return;
  container.innerHTML = '';
  for (const group of INJECTED_BUTTONS) {
    const h = document.createElement('div');
    h.textContent = group.label;
    Object.assign(h.style, { fontWeight: '600', fontSize: '13px', color: '#374151', margin: '10px 0 6px' });
    container.appendChild(h);
    for (const b of group.buttons) {
      const row = document.createElement('label');
      Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 0', fontSize: '13px', color: '#111', cursor: 'pointer' });
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      const hidden = buttonVisibilityPrefs[group.provider] && buttonVisibilityPrefs[group.provider][b.key] === false;
      cb.checked = !hidden;
      const entitled = !b.feature || !!currentFeatures[b.feature];
      const span = document.createElement('span');
      span.textContent = b.label + (entitled ? '' : ' (not in your plan)');
      if (!entitled) {
        cb.disabled = true;
        row.style.opacity = '0.55';
        row.style.cursor = 'default';
      }
      cb.addEventListener('change', () => {
        if (!buttonVisibilityPrefs[group.provider]) buttonVisibilityPrefs[group.provider] = {};
        if (cb.checked) delete buttonVisibilityPrefs[group.provider][b.key];
        else buttonVisibilityPrefs[group.provider][b.key] = false;
        if (Object.keys(buttonVisibilityPrefs[group.provider]).length === 0) delete buttonVisibilityPrefs[group.provider];
        clearTimeout(visSaveTimeout);
        showVisStatus('Saving...', 'loading');
        visSaveTimeout = setTimeout(saveButtonVisibility, 400);
      });
      row.appendChild(cb);
      row.appendChild(span);
      container.appendChild(row);
    }
  }
}

async function loadButtonVisibility() {
  try {
    const result = await chrome.runtime.sendMessage({
      action: 'MOS_API_REQUEST',
      endpoint: '/api/extension/preferences',
    });
    if (result && result.injectedButtonVisibility) {
      buttonVisibilityPrefs = result.injectedButtonVisibility;
    }
  } catch (err) {
    console.error('[Options] Error loading button visibility:', err);
  }
  renderButtonVisibility();
}

async function saveButtonVisibility() {
  try {
    const result = await chrome.runtime.sendMessage({
      action: 'MOS_API_REQUEST',
      endpoint: '/api/extension/preferences',
      options: {
        method: 'PUT',
        body: JSON.stringify({ injectedButtonVisibility: buttonVisibilityPrefs }),
      },
    });
    if (result && result.success) {
      showVisStatus('Saved — changes apply on the next page load', 'success');
    } else {
      throw new Error((result && result.error) || 'Failed to save');
    }
  } catch (err) {
    console.error('[Options] Save button visibility error:', err);
    showVisStatus('Failed to save. Please try again.', 'error');
  }
}

function showVisStatus(message, type) {
  const el = document.getElementById('button-visibility-status');
  if (!el) return;
  el.className = `status-message ${type}`;
  el.innerHTML = `<span>${message}</span>`;
  if (type === 'success') {
    setTimeout(() => { el.className = 'status-message'; }, 3000);
  }
}

async function init() {
  try {
    const authStatus = await chrome.runtime.sendMessage({ action: 'GET_MOS_AUTH' });

    if (!authStatus || !authStatus.isAuthenticated) {
      notLoggedIn.style.display = 'block';
      settingsContent.style.display = 'none';
      return;
    }

    notLoggedIn.style.display = 'none';
    settingsContent.style.display = 'block';

    if (authStatus.defaultExtensionTab) {
      tabSelect.value = authStatus.defaultExtensionTab;
    }
    if (authStatus.shopwareAddMode) {
      swAddModeSelect.value = authStatus.shopwareAddMode;
    }

    loadFeatures();
    loadButtonVisibility();
    checkShopwareIntegration();
    checkPlatformAdmin(authStatus);

    tabSelect.addEventListener('change', () => {
      clearTimeout(saveTimeout);
      showStatus('Saving...', 'loading');
      saveTimeout = setTimeout(() => saveDefaultTab(tabSelect.value), 300);
    });

    swAddModeSelect.addEventListener('change', () => {
      clearTimeout(swSaveTimeout);
      showStatus('Saving...', 'loading');
      swSaveTimeout = setTimeout(() => saveSwAddMode(swAddModeSelect.value), 300);
    });
  } catch (err) {
    console.error('[Options] Init error:', err);
    notLoggedIn.style.display = 'block';
    settingsContent.style.display = 'none';
  }
}

async function loadFeatures() {
  try {
    const stored = await chrome.storage.local.get(['mosUser']);
    const shopId = stored.mosUser?.shopId;
    if (!shopId) return;

    const result = await chrome.runtime.sendMessage({
      action: 'MOS_API_REQUEST',
      endpoint: `/api/extension/features?shopId=${shopId}`
    });

    if (result && result.features) {
      currentFeatures = result.features;
      updateSelectOptions();
      // Re-render visibility toggles with entitlement locks now known.
      renderButtonVisibility();
    }
  } catch (err) {
    console.error('[Options] Error loading features:', err);
  }
}

function updateSelectOptions() {
  Array.from(tabSelect.options).forEach(option => {
    if (!option.value) return;
    const featureKey = featureTabMap[option.value];
    const hasAccess = featureKey ? currentFeatures[featureKey] : true;

    if (!hasAccess) {
      option.disabled = true;
      option.textContent = option.textContent.replace(/ \(locked\)$/, '') + ' (locked)';
    } else {
      option.disabled = false;
      option.textContent = option.textContent.replace(/ \(locked\)$/, '');
    }
  });

  if (tabSelect.selectedOptions[0]?.disabled) {
    tabSelect.value = '';
  }
}

async function checkShopwareIntegration() {
  try {
    const stored = await chrome.storage.local.get(['mosUser']);
    const shopId = stored.mosUser?.shopId;
    if (!shopId) return;

    const result = await chrome.runtime.sendMessage({
      action: 'MOS_API_REQUEST',
      endpoint: `/api/settings/integrations`
    });

    if (result?.shopware?.configured) {
      swAddModeGroup.style.display = 'block';
    }
  } catch (err) {
    console.error('[Options] Error checking Shop-Ware integration:', err);
  }
}

async function saveSwAddMode(mode) {
  try {
    const result = await chrome.runtime.sendMessage({
      action: 'MOS_API_REQUEST',
      endpoint: '/api/extension/preferences',
      options: {
        method: 'PUT',
        body: JSON.stringify({ shopwareAddMode: mode })
      }
    });

    if (result.success) {
      const stored = await chrome.storage.local.get(['mosUser']);
      if (stored.mosUser) {
        stored.mosUser.shopwareAddMode = mode;
        await chrome.storage.local.set({ mosUser: stored.mosUser });
      }
      showStatus('Saved successfully', 'success');
    } else {
      throw new Error(result.error || 'Failed to save');
    }
  } catch (err) {
    console.error('[Options] Save SW add mode error:', err);
    showStatus('Failed to save. Please try again.', 'error');
  }
}

async function saveDefaultTab(tab) {
  try {
    const result = await chrome.runtime.sendMessage({
      action: 'SAVE_DEFAULT_TAB',
      tab: tab || null
    });

    if (result.success) {
      showStatus('Saved successfully', 'success');
    } else {
      throw new Error(result.error || 'Failed to save');
    }
  } catch (err) {
    console.error('[Options] Save error:', err);
    showStatus('Failed to save. Please try again.', 'error');
  }
}

function checkPlatformAdmin(authStatus) {
  if (authStatus.user?.role === 'platform_admin' || authStatus.user?.isPlatformAdmin === true) {
    document.getElementById('dev-tools-section').style.display = 'block';
  }
}

function showStatus(message, type) {
  statusMessage.className = `status-message ${type}`;
  const icons = {
    success: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
    error: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
    loading: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>'
  };
  statusMessage.innerHTML = `${icons[type] || ''}<span>${message}</span>`;

  if (type === 'success') {
    setTimeout(() => { statusMessage.className = 'status-message'; }, 3000);
  }
}

init();
