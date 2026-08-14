// MOS Tools Side Panel Application

// ==================== SEARCH NORMALIZATION ====================
const SERVICE_SEARCH_MAPPINGS = [
  { patterns: [/engine oil/i, /oil and filter/i, /oil & filter/i, /motor oil/i, /oil change/i, /lube.*oil/i], normalized: 'oil change' },
  { patterns: [/cabin air filter/i, /cabin filter/i, /in.?cabin/i, /pollen filter/i], normalized: 'cabin filter' },
  { patterns: [/engine air filter/i, /air cleaner element/i, /air filter element/i], normalized: 'air filter' },
  { patterns: [/brake fluid/i, /brake.*flush/i], normalized: 'brake fluid' },
  { patterns: [/coolant/i, /antifreeze/i, /cooling system/i], normalized: 'coolant' },
  { patterns: [/transmission fluid/i, /trans fluid/i, /atf/i, /auto trans/i, /cvt fluid/i], normalized: 'transmission fluid' },
  { patterns: [/transfer case/i], normalized: 'transfer case' },
  { patterns: [/differential fluid/i, /diff fluid/i, /front differential/i, /rear differential/i], normalized: 'differential' },
  { patterns: [/spark plug/i, /ignition plug/i], normalized: 'spark plug' },
  { patterns: [/tire rotat/i, /rotate tire/i, /wheel rotation/i], normalized: 'tire rotation' },
  { patterns: [/drive belt/i, /serpentine belt/i, /accessory belt/i, /v.?belt/i], normalized: 'drive belt' },
  { patterns: [/timing belt/i, /timing chain/i, /cam belt/i], normalized: 'timing belt' },
  { patterns: [/battery replace/i, /battery service/i, /^battery$/i], normalized: 'battery' },
  { patterns: [/power steering/i], normalized: 'power steering' },
  { patterns: [/wiper blade/i, /windshield wiper/i], normalized: 'wiper' },
  { patterns: [/shock.*absorber/i, /strut.*replace/i, /shocks.*struts/i, /front shocks/i, /rear shocks/i], normalized: 'shocks struts' },
  { patterns: [/fuel filter/i, /fuel system/i], normalized: 'fuel filter' },
  { patterns: [/throttle body/i, /throttle.*clean/i], normalized: 'throttle body' },
  { patterns: [/fuel injection/i, /injector.*clean/i, /fuel inject.*service/i], normalized: 'fuel injection' },
  { patterns: [/wheel align/i, /front.*align/i, /4.?wheel align/i], normalized: 'alignment' },
  { patterns: [/brake pad/i, /front brake/i, /rear brake/i, /brake.*service/i, /disc brake/i], normalized: 'brake' },
  { patterns: [/synthetic.*oil/i], normalized: 'synthetic oil change' },
  { patterns: [/conventional.*oil/i], normalized: 'oil change' },
];

function normalizeServiceSearch(rawName) {
  if (!rawName) return rawName;
  const trimmed = rawName.trim();
  for (const mapping of SERVICE_SEARCH_MAPPINGS) {
    for (const pattern of mapping.patterns) {
      if (pattern.test(trimmed)) {
        return mapping.normalized;
      }
    }
  }
  return trimmed
    .replace(/\s*-\s*(replacement|service|inspection|check)\s*$/i, '')
    .replace(/\s+(replacement|service)\s*$/i, '')
    .trim();
}

// Task #1112: report uncaught side-panel JS errors to the background
// telemetry relay (throttled per signature; message only, no stacks).
try {
  globalThis.MosTelemetryCore?.installErrorHooks({
    surface: "sidepanel",
    // The side panel persists across shop switches — scope the throttle
    // to the shop on screen so suppressed counts never cross shops.
    getScope: () => {
      try { return (currentContext && currentContext.shopId) || null; } catch (_) { return null; }
    },
    send: (payload) => {
      try {
        const p = chrome.runtime.sendMessage({ action: "REPORT_TELEMETRY", event: "client.error", payload });
        if (p && p.catch) p.catch(() => {});
      } catch (_) {}
    },
  });
} catch (_) { /* never throw from telemetry */ }

// ==================== STATE ====================
let isAuthenticated = false;
let currentUserCanWrite = true; // Conservative default; refined via GET_MOS_AUTH.
let currentContext = null;
let currentTab = 'plan';

// Client-side plan cache so revisiting an RO (tab switch or RO re-open) is
// instant instead of re-hitting /api/extension/plan over the network every
// time. Stale-while-revalidate: a cached entry paints immediately; if it's
// older than the TTL we still paint it, then refresh quietly in the
// background. Keyed by shop+RO. Capped to avoid unbounded growth.
const PLAN_CACHE_TTL_MS = 5 * 60 * 1000;
const PLAN_CACHE_MAX = 30;
const planCache = new Map(); // cacheKey -> { data, ts }
function planCacheKey(ctx) {
  if (!ctx || !ctx.roId) return null;
  return `${ctx.shopId || ''}::${ctx.roId}`;
}
function setPlanCache(key, data) {
  if (!key) return;
  planCache.set(key, { data, ts: Date.now() });
  if (planCache.size > PLAN_CACHE_MAX) {
    const oldest = planCache.keys().next().value;
    if (oldest !== undefined) planCache.delete(oldest);
  }
}
// After a job is successfully added to the current RO, flip the matching VHI
// card(s) to "On Estimate" right away and expire the cached plan. Without
// this, the page reload that follows a Tekmetric add repaints from a
// still-fresh client cache (5-min TTL) whose items were computed BEFORE the
// add — so the card keeps showing "+ Add" even though the job is now on the
// estimate (seen live on RO #26362: control arm + alignment added, badge
// never appeared). Expiring `ts` keeps the instant repaint but forces a
// quiet background revalidation, where the server recomputes On Estimate
// from the live RO via service-key pattern matching (the authoritative
// check — this local title match is only an optimistic preview of it).
function markServiceOnEstimate(jobName, cacheKeyOverride) {
  try {
    // Callers snapshot the cache key before their (slow) add request so a
    // late success after the user switched ROs never marks the wrong entry.
    const key = cacheKeyOverride || planCacheKey(currentContext);
    if (!key) return;
    const entry = planCache.get(key);
    if (!entry || !entry.data) return;
    const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const target = norm(jobName);
    let flipped = false;
    if (target) {
      for (const bucket of ['overdue', 'dueSoon', 'complimentary', 'recommended']) {
        for (const item of entry.data[bucket] || []) {
          if (item.onCurrentRO) continue;
          const t = norm(item.title || item.service || item.name);
          if (t && (t === target || t.includes(target) || target.includes(t))) {
            item.onCurrentRO = true;
            flipped = true;
          }
        }
      }
    }
    // Expire (don't delete) so the next visit still paints instantly from
    // cache but re-checks with the server in the background.
    entry.ts = 0;
    // Only repaint if the user is still viewing the RO the job was added to.
    if (flipped && currentContext && key === planCacheKey(currentContext)) {
      renderPlan(entry.data, currentContext.roId, currentContext.shopId);
    }
  } catch (err) {
    console.warn('[MOS] markServiceOnEstimate failed:', err?.message || err);
  }
}
// Tabs the main extension actually renders. Used to sanitize a stored
// `defaultExtensionTab` from the user record — e.g. legacy `"migrate"`
// values from before the Migrate wizard was extracted into the
// standalone `mos-migrate-extension/` (Task #292) must fall back to a
// real tab so we never try to switchTab() onto a missing panel.
const VALID_DEFAULT_TABS = ['plan', 'failures', 'jobs', 'specs', 'rates', 'concern'];
function sanitizeDefaultTab(tab) {
  return VALID_DEFAULT_TABS.includes(tab) ? tab : 'plan';
}
let userDefaultTab = null;
let shopwareAddMode = 'finding-published';
let keytagContextEnriched = false;
let currentPlanShopLogo = null;
let currentPlanLocationId = null;
let currentReportUrl = null;
// Removed SMS toggle - now using MOS Enriched only
let failuresDataMap = new Map(); // Store failure objects by ID to avoid JSON in HTML
let cannedJobsDataMap = new Map(); // Store canned job objects by ID to avoid JSON in HTML
let lookupJobsDataMap = new Map(); // Store lookup job objects by ID to avoid JSON in HTML
let shopFeatures = {
  maintenance: true,
  job_lookup: false,
  common_failures: false,
  oil_sticker: false,
  keytags: false,
  auto_booking: false,
  part_xref: false,
  labor_rates: false,
  concern_assistant: false,
  estimate_assist: false
};
let mosShops = [];
let resolvedMosShopId = null;
let resolvedWriteProvider = null;
// Task #340: track the shop's distance preference so every "mi"/"km" label in
// the side panel (mileage chip, tooltips, last-done, interval/dueAt/overdue
// text) reflects the shop's units. Defaults to miles until the features or
// plan response confirms otherwise.
let shopDistanceUnit = 'miles';
function getDistLabel() {
  return shopDistanceUnit === 'kilometers' ? 'km' : 'mi';
}
// Full-word distance axis label for progress-bar rows ("Kilometers" / "Miles").
// Drives the VHI Coach progress-bar axis label off the shop's resolved unit so
// metric shops never see a hardcoded "Miles" row next to km values.
function getDistAxisLabel() {
  return shopDistanceUnit === 'kilometers' ? 'Kilometers' : 'Miles';
}
let concernState = {
  concern: '',
  conversationId: null,
  questions: [],
  askedQuestions: [],
  noMoreQuestions: false,
  exchanges: [],
  cleanedText: ''
};

// Mirror of lib/concernSkipLearning.ts normalizeQuestion — keep in sync so the
// extension client-side dedup matches the server (Task #682).
function normalizeConcernQuestion(q) {
  if (!q) return '';
  return String(q)
    .toLowerCase()
    .replace(/^\s*\d+[.)]\s*/, '')
    .replace(/^\s*[-*]\s*/, '')
    .replace(/[\s\u00a0]+/g, ' ')
    .trim()
    .replace(/[?!.,;:"'()\[\]]+$/g, '')
    .trim();
}

// Drop any new question that repeats one already asked (across all rounds) or
// repeats within the returned set itself. Client-side safety net on top of the
// server-side dedup (Task #682).
function dedupeConcernQuestions(newQuestions, alreadyAsked) {
  const seen = new Set();
  (alreadyAsked || []).forEach(q => {
    const norm = normalizeConcernQuestion(q);
    if (norm) seen.add(norm);
  });
  const out = [];
  (newQuestions || []).forEach(q => {
    const text = String(q || '');
    const norm = normalizeConcernQuestion(text);
    if (!norm || seen.has(norm)) return;
    seen.add(norm);
    out.push(text);
  });
  return out;
}

// When true, the Concern Assistant was launched from the Create RO flow, so its
// finished write-up should flow back into the new repair order instead of being
// injected into an already-open RO.
let concernReturnToCro = false;

// One-shot guard: when returning from the Concern Assistant we re-enter the
// Create RO tab without resetting the in-progress wizard (which would wipe the
// customer/vehicle/job selections and the concern we just wrote back).
let croPreserveStateOnInit = false;

// ==================== DOM ELEMENTS ====================
const elements = {
  // States
  loadingState: document.getElementById('loading-state'),
  loginState: document.getElementById('login-state'),
  mainState: document.getElementById('main-state'),
  
  // Login
  loginForm: document.getElementById('login-form'),
  emailInput: document.getElementById('email'),
  passwordInput: document.getElementById('password'),
  togglePasswordBtn: document.getElementById('toggle-password'),
  apiUrlInput: document.getElementById('api-url'),
  rememberMeCheckbox: document.getElementById('remember-me'),
  loginError: document.getElementById('login-error'),
  
  // Header
  refreshBtn: document.getElementById('refresh-btn'),
  logoutBtn: document.getElementById('logout-btn'),

  // Floating launcher button (per-user) setting
  floatingBtnSetting: document.getElementById('floating-btn-setting'),
  floatingBtnCheckbox: document.getElementById('floating-btn-checkbox'),
  floatingBtnLockedNote: document.getElementById('floating-btn-locked-note'),
  
  // Context
  noContext: document.getElementById('no-context'),
  hasContext: document.getElementById('has-context'),
  vehicleDisplay: document.getElementById('vehicle-display'),
  roDisplay: document.getElementById('ro-display'),
  mileageDisplay: document.getElementById('mileage-display'),
  mileageWarning: document.getElementById('mileage-warning'),
  
  // Tabs
  tabBtns: document.querySelectorAll('.tab-btn'),
  tabPanels: document.querySelectorAll('.tab-panel'),
  
  // Plan
  planLoading: document.getElementById('plan-loading'),
  planEmpty: document.getElementById('plan-empty'),
  planContent: document.getElementById('plan-content'),
  overdueSection: document.getElementById('overdue-section'),
  overdueList: document.getElementById('overdue-list'),
  dueSoonSection: document.getElementById('due-soon-section'),
  dueSoonList: document.getElementById('due-soon-list'),
  complimentarySection: document.getElementById('complimentary-section'),
  complimentaryList: document.getElementById('complimentary-list'),
  recommendedSection: document.getElementById('recommended-section'),
  recommendedList: document.getElementById('recommended-list'),
  
  // Job Lookup
  jobSearch: document.getElementById('job-search'),
  jobSearchBtn: document.getElementById('job-search-btn'),
  lookupLoading: document.getElementById('lookup-loading'),
  lookupEmpty: document.getElementById('lookup-empty'),
  lookupResults: document.getElementById('lookup-results'),
  
  // Canned Jobs
  cannedSearch: document.getElementById('canned-search'),
  cannedLoading: document.getElementById('canned-loading'),
  cannedEmpty: document.getElementById('canned-empty'),
  cannedList: document.getElementById('canned-list'),
  
  // Common Failures
  failuresLoading: document.getElementById('failures-loading'),
  failuresEmpty: document.getElementById('failures-empty'),
  failuresContent: document.getElementById('failures-content'),
  failuresSource: document.getElementById('failures-source'),
  failuresList: document.getElementById('failures-list'),
  
  // Sticker
  stickerLoading: document.getElementById('sticker-loading'),
  stickerSection: document.getElementById('sticker-section'),
  stickerForm: document.getElementById('sticker-form'),
  stickerDisabled: document.getElementById('sticker-disabled'),
  stickerMileage: document.getElementById('sticker-mileage'),
  stickerUnit: document.getElementById('sticker-unit'),
  stickerInterval: document.getElementById('sticker-interval'),
  customIntervalFields: document.getElementById('custom-interval-fields'),
  customMonths: document.getElementById('custom-months'),
  customMileage: document.getElementById('custom-mileage'),
  stickerTagline: document.getElementById('sticker-tagline'),
  stickerIncludeQR: document.getElementById('sticker-include-qr'),
  stickerQRToggle: document.getElementById('sticker-qr-toggle'),
  stickerPrintBtn: document.getElementById('sticker-print-btn'),
  stickerError: document.getElementById('sticker-error'),
  
  // Keytag
  keytagSection: document.getElementById('keytag-section'),
  keytagForm: document.getElementById('keytag-form'),
  keytagCustomer: document.getElementById('keytag-customer'),
  keytagVehicle: document.getElementById('keytag-vehicle'),
  keytagRo: document.getElementById('keytag-ro'),
  keytagMileage: document.getElementById('keytag-mileage'),
  keytagPrintBtn: document.getElementById('keytag-print-btn'),
  keytagError: document.getElementById('keytag-error'),
  
  // Labor Rates
  ratesLoading: document.getElementById('rates-loading'),
  ratesMain: document.getElementById('rates-main'),
  ratesList: document.getElementById('rates-list'),
  ratesAutoApplyToggle: document.getElementById('rates-auto-apply-toggle'),
  ratesApplyNowBtn: document.getElementById('rates-apply-now-btn'),
  ratesError: document.getElementById('rates-error'),
  ratesAddBtn: document.getElementById('rates-add-btn'),
  ratesForm: document.getElementById('rates-form'),
  rateFormName: document.getElementById('rate-form-name'),
  rateFormMakes: document.getElementById('rate-form-makes'),
  rateFormModels: document.getElementById('rate-form-models'),
  rateFormCategories: document.getElementById('rate-form-categories'),
  rateFormFuelType: document.getElementById('rate-form-fuel-type'),
  rateFormCustomerType: document.getElementById('rate-form-customer-type'),
  rateFormTags: document.getElementById('rate-form-tags'),
  rateFormRate: document.getElementById('rate-form-rate'),
  rateFormPriority: document.getElementById('rate-form-priority'),
  rateFormApplyAllWrap: document.getElementById('rate-form-apply-all-wrap'),
  rateFormApplyAllLabor: document.getElementById('rate-form-apply-all-labor'),
  rateFormOverrideCatWrap: document.getElementById('rate-form-override-cat-wrap'),
  rateFormOverrideCategoryRates: document.getElementById('rate-form-override-category-rates'),
  rateFormCancel: document.getElementById('rate-form-cancel'),
  rateFormSave: document.getElementById('rate-form-save'),
  rateFormSaveText: document.getElementById('rate-form-save-text'),
  rateFormEditId: document.getElementById('rate-form-edit-id'),
  ratesEmptyHint: document.getElementById('rates-empty-hint'),

  // Concern Assistant
  concernLoading: document.getElementById('concern-loading'),
  concernStart: document.getElementById('concern-start'),
  concernConversation: document.getElementById('concern-conversation'),
  concernResult: document.getElementById('concern-result'),
  concernInput: document.getElementById('concern-input'),
  concernSubmitBtn: document.getElementById('concern-submit-btn'),
  concernOriginalText: document.getElementById('concern-original-text'),
  concernQuestions: document.getElementById('concern-questions'),
  concernReviewBtn: document.getElementById('concern-review-btn'),
  concernFinishBtn: document.getElementById('concern-finish-btn'),
  concernCleanedText: document.getElementById('concern-cleaned-text'),
  concernCopyBtn: document.getElementById('concern-copy-btn'),
  concernInjectBtn: document.getElementById('concern-inject-btn'),
  concernNewBtn: document.getElementById('concern-new-btn'),
  concernUseForRoBtn: document.getElementById('concern-use-for-ro-btn'),
  concernError: document.getElementById('concern-error'),
  croConcernAiBtn: document.getElementById('cro-concern-ai-btn')
};

// ==================== SHOP RESOLUTION ====================
function resolveAutoflowShop(autoflowSubdomain) {
  if (!mosShops.length || !autoflowSubdomain) return null;

  const wanted = String(autoflowSubdomain).replace(/\.autotext\.me$/i, '').toLowerCase();

  // Primary: match the explicit AutoFlow subdomain the server now sends on
  // every shop. This resolves dual shops (AutoFlow front-end backed by
  // Protractor/Tekmetric) whose `provider` is the back-end, not "autoflow" —
  // the case that previously fell through to the "Could not resolve" warning.
  for (const shop of mosShops) {
    if (shop.autoflowSubdomain &&
        String(shop.autoflowSubdomain).replace(/\.autotext\.me$/i, '').toLowerCase() === wanted) {
      return shop;
    }
  }

  // v4 URLs carry a shop NUMBER (app.autoflow.com/shop/<number>), a different
  // identifier than the v3 subdomain. Match any number the server has already
  // learned for a shop (see the AutoFlow auto-learn in findShopBySmsId).
  for (const shop of mosShops) {
    if (Array.isArray(shop.autoflowShopNumbers) &&
        shop.autoflowShopNumbers.some(n => String(n).toLowerCase() === wanted)) {
      return shop;
    }
  }

  for (const shop of mosShops) {
    if (shop.smsShopId === autoflowSubdomain && shop.provider === 'autoflow') {
      return shop;
    }
  }
  for (const shop of mosShops) {
    if (shop.smsShopId && shop.provider === 'autoflow' && (
      autoflowSubdomain === shop.smsShopId.replace(/\.autotext\.me$/i, '')
    )) {
      return shop;
    }
  }

  // Single AutoFlow shop in this user's list → any AutoFlow page must be it.
  // Mirrors the server's single-candidate auto-learn and clears the "could not
  // resolve" warning on a brand-new v4 URL before the learned number has
  // synced into this shop list (the list refreshes at next login).
  const autoflowShops = mosShops.filter(s =>
    s.autoflowSubdomain ||
    (Array.isArray(s.autoflowShopNumbers) && s.autoflowShopNumbers.length > 0) ||
    s.provider === 'autoflow'
  );
  if (autoflowShops.length === 1) {
    return autoflowShops[0];
  }

  if (mosShops.length === 1) {
    return mosShops[0];
  }
  return null;
}

function getWriteProvider(mosShopId) {
  if (!mosShops.length || !mosShopId) return null;
  
  for (const shop of mosShops) {
    if (shop.shopId === mosShopId && shop.writeProvider) {
      return shop.writeProvider;
    }
  }
  
  for (const shop of mosShops) {
    if (shop.shopId === mosShopId) {
      if (shop.provider === 'tekmetric' || shop.provider === 'protractor' || shop.provider === 'shopware') {
        return shop.provider;
      }
    }
  }
  return null;
}

function enrichContextWithMosShop(context) {
  if (!context || context.provider !== 'autoflow') return context;
  
  const autoflowSubdomain = context.shopId;
  const matchedShop = resolveAutoflowShop(autoflowSubdomain);
  
  if (matchedShop) {
    resolvedMosShopId = matchedShop.shopId;
    context.mosShopId = matchedShop.shopId;
    context.autoflowSubdomain = autoflowSubdomain;
    context.shopName = matchedShop.name;
    
    const writeProvider = getWriteProvider(matchedShop.shopId);
    if (writeProvider && writeProvider !== 'autoflow') {
      resolvedWriteProvider = writeProvider;
      context.writeProvider = writeProvider;
    }
    
    console.log('[MOS] AutoFlow shop resolved:', {
      autoflowSubdomain,
      mosShopId: matchedShop.shopId,
      shopName: matchedShop.name,
      readProvider: 'autoflow',
      writeProvider: writeProvider || 'none'
    });
  } else {
    console.warn('[MOS] Could not resolve AutoFlow subdomain to MOS shop:', autoflowSubdomain);
  }
  
  return context;
}

// ==================== INITIALIZATION ====================
async function init() {
  const authStatus = await sendMessage({ action: 'GET_MOS_AUTH' });
  
  if (authStatus.isAuthenticated) {
    isAuthenticated = true;
    mosShops = authStatus.shops || [];

    if (authStatus.defaultExtensionTab) {
      userDefaultTab = sanitizeDefaultTab(authStatus.defaultExtensionTab);
      currentTab = userDefaultTab;
    }
    if (authStatus.shopwareAddMode) {
      shopwareAddMode = authStatus.shopwareAddMode;
    }

    showMainState();
    
    const contextStatus = await sendMessage({ action: 'GET_SMS_CONTEXT' });
    if (contextStatus.context) {
      updateContext(contextStatus.context);
    }
  } else {
    showLoginState();
  }
  
  setupEventListeners();
}

function setPasswordVisibility(show) {
  if (!elements.passwordInput || !elements.togglePasswordBtn) return;
  elements.passwordInput.type = show ? 'text' : 'password';
  const eye = elements.togglePasswordBtn.querySelector('.icon-eye');
  const eyeOff = elements.togglePasswordBtn.querySelector('.icon-eye-off');
  if (eye) eye.classList.toggle('hidden', show);
  if (eyeOff) eyeOff.classList.toggle('hidden', !show);
  const label = show ? 'Hide password' : 'Show password';
  elements.togglePasswordBtn.setAttribute('aria-label', label);
  elements.togglePasswordBtn.setAttribute('title', label);
  elements.togglePasswordBtn.setAttribute('aria-pressed', show ? 'true' : 'false');
}

function setupEventListeners() {
  // Login form
  elements.loginForm.addEventListener('submit', handleLogin);

  // Show/hide password toggle
  if (elements.togglePasswordBtn) {
    elements.togglePasswordBtn.addEventListener('click', () => {
      setPasswordVisibility(elements.passwordInput.type === 'password');
    });
  }
  
  // Refresh
  elements.refreshBtn.addEventListener('click', () => {
    loadPlan(true);
  });
  
  const shareVhiBtn = document.getElementById('share-vhi-btn');
  if (shareVhiBtn) {
    shareVhiBtn.addEventListener('click', async () => {
      if (!currentReportUrl) return;
      try {
        await navigator.clipboard.writeText(currentReportUrl);
        shareVhiBtn.classList.add('copied');
        const label = shareVhiBtn.querySelector('span');
        if (label) label.textContent = 'Copied!';
        setTimeout(() => {
          shareVhiBtn.classList.remove('copied');
          if (label) label.textContent = 'Share VHI';
        }, 2000);
      } catch (err) {
        console.warn('[MOS] Clipboard write failed, opening in new tab:', err);
        window.open(currentReportUrl, '_blank');
      }
    });
  }

  // Logout
  elements.logoutBtn.addEventListener('click', handleLogout);

  // Floating launcher button per-user toggle
  if (elements.floatingBtnCheckbox) {
    elements.floatingBtnCheckbox.addEventListener('change', handleFloatingButtonToggle);
  }
  
  // Tab navigation - allow clicking locked tabs to show upgrade overlay
  elements.tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      switchTab(btn.dataset.tab);
    });
  });

  // Sub-tab navigation (inside Jobs tab)
  document.querySelectorAll('.sub-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      switchJobsSubTab(btn.dataset.subtab);
    });
  });
  
  // Canned job search
  elements.cannedSearch.addEventListener('input', () => {
    filterCannedJobs(elements.cannedSearch.value);
  });
  
  // Job search
  elements.jobSearchBtn.addEventListener('click', handleJobSearch);
  elements.jobSearch.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleJobSearch();
  });
  
  // Sticker form
  elements.stickerInterval.addEventListener('change', () => {
    const isCustom = elements.stickerInterval.value === 'custom';
    elements.customIntervalFields.classList.toggle('hidden', !isCustom);
  });
  
  elements.stickerMileage.addEventListener('input', (e) => {
    e.target.value = formatMileageInput(e.target.value);
  });
  
  elements.customMileage.addEventListener('input', (e) => {
    e.target.value = formatMileageInput(e.target.value);
  });
  
  elements.stickerPrintBtn.addEventListener('click', handleStickerPrint);
  
  // Keytag print button
  if (elements.keytagPrintBtn) {
    elements.keytagPrintBtn.addEventListener('click', handleKeytagPrint);
  }
  
  // Labor Rates
  if (elements.ratesAutoApplyToggle) {
    elements.ratesAutoApplyToggle.addEventListener('change', async () => {
      const enabled = elements.ratesAutoApplyToggle.checked;
      await sendMessage({ action: 'SET_LABOR_RATE_AUTO_APPLY', enabled });
      showNotification(`Auto-apply ${enabled ? 'enabled' : 'disabled'}`, 'info');
    });
  }
  if (elements.ratesApplyNowBtn) {
    elements.ratesApplyNowBtn.addEventListener('click', handleApplyLaborRateNow);
  }
  if (elements.ratesAddBtn) {
    elements.ratesAddBtn.addEventListener('click', () => showRateForm());
  }
  if (elements.rateFormCancel) {
    elements.rateFormCancel.addEventListener('click', hideRateForm);
  }
  if (elements.rateFormSave) {
    elements.rateFormSave.addEventListener('click', handleSaveRateGroup);
  }
  document.querySelectorAll('.rate-color-swatch').forEach(swatch => {
    swatch.addEventListener('click', (e) => {
      e.preventDefault();
      document.querySelectorAll('.rate-color-swatch').forEach(s => s.classList.remove('active'));
      swatch.classList.add('active');
    });
  });
  
  // Concern Assistant
  if (elements.concernSubmitBtn) {
    elements.concernSubmitBtn.addEventListener('click', handleConcernSubmit);
  }
  // Enter submits the concern (Shift+Enter for a new line), so advisors don't
  // have to leave the keyboard and click "Generate Follow-Up Questions".
  if (elements.concernInput) {
    elements.concernInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleConcernSubmit();
      }
    });
  }
  if (elements.concernReviewBtn) {
    elements.concernReviewBtn.addEventListener('click', handleConcernReview);
  }
  if (elements.concernFinishBtn) {
    elements.concernFinishBtn.addEventListener('click', handleConcernFinish);
  }
  if (elements.concernCopyBtn) {
    elements.concernCopyBtn.addEventListener('click', handleConcernCopy);
  }
  if (elements.concernInjectBtn) {
    elements.concernInjectBtn.addEventListener('click', handleConcernInject);
  }
  if (elements.concernNewBtn) {
    elements.concernNewBtn.addEventListener('click', handleConcernNew);
  }
  if (elements.concernUseForRoBtn) {
    elements.concernUseForRoBtn.addEventListener('click', handleConcernUseForRo);
  }
  if (elements.croConcernAiBtn) {
    elements.croConcernAiBtn.addEventListener('click', handleCroConcernAi);
  }

  // Listen for context changes from background
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'SMS_CONTEXT_CHANGED') {
      updateContext(message.context);
    }
    if (message.action === 'SWITCH_TO_STICKER_TAB') {
      if (message.context) {
        updateContext(message.context);
      }
      switchTab('sticker');
    }
    if (message.action === 'SWITCH_TO_CREATE_RO') {
      if (message.context) {
        updateContext(message.context);
      }
      // Force the create-ro tab visible even before features have loaded —
      // the click came from the AutoFlow Create RO button which already
      // verified writeProvider === 'protractor'.
      const btn = document.querySelector('.tab-btn[data-tab="create-ro"]');
      if (btn) btn.classList.remove('hidden');
      switchTab('create-ro');
    }
    if (message.action === 'PLAN_REFRESH_NEEDED') {
      console.log('[MOS] Plan refresh triggered:', message.reason);
      loadPlan(true);
    }
    if (message.action === 'LABOR_RATE_APPLIED') {
      if (message.success) {
        const rate = typeof message.rate === 'number' ? message.rate.toFixed(2) : message.rate;
        if (message.perJob) {
          showNotification(
            `Labor rate updated: "${message.ruleName}" → $${rate}/hr on ${message.jobNames?.join(', ') || 'jobs'}`,
            'success'
          );
        } else if (message.previousRate != null) {
          const prevRate = typeof message.previousRate === 'number' ? message.previousRate.toFixed(2) : message.previousRate;
          showNotification(
            `Labor rate updated: "${message.ruleName}" → $${rate}/hr (was $${prevRate}/hr)`,
            'success'
          );
        } else {
          showNotification(
            `Labor rate updated: "${message.ruleName}" → $${rate}/hr`,
            'success'
          );
        }
      } else {
        showNotification(`Labor rate error: ${message.error}`, 'error');
      }
    }
  });
}

function formatMileageInput(value) {
  const numericValue = value.replace(/[^\d]/g, '');
  if (!numericValue) return '';
  return parseInt(numericValue, 10).toLocaleString();
}

// ==================== STATE MANAGEMENT ====================
function showLoadingState() {
  elements.loadingState.classList.remove('hidden');
  elements.loginState.classList.add('hidden');
  elements.mainState.classList.add('hidden');
}

function showLoginState() {
  elements.loadingState.classList.add('hidden');
  elements.loginState.classList.remove('hidden');
  elements.mainState.classList.add('hidden');
  setPasswordVisibility(false);
  chrome.storage.local.get(['mosLoginEmail', 'mosRememberMe'], (stored) => {
    if (stored.mosRememberMe !== false && stored.mosLoginEmail) {
      elements.emailInput.value = stored.mosLoginEmail;
      elements.rememberMeCheckbox.checked = true;
      elements.passwordInput.focus();
    } else {
      elements.rememberMeCheckbox.checked = false;
      elements.emailInput.focus();
    }
  });
}

function showMainState() {
  elements.loadingState.classList.add('hidden');
  elements.loginState.classList.add('hidden');
  elements.mainState.classList.remove('hidden');
  showSupportFab();
  applyPlatformAdminVisibility();
}

// Reveal platform-admin-only UI elements.
async function applyPlatformAdminVisibility() {
  try {
    const auth = await sendMessage({ action: 'GET_MOS_AUTH' });
    const u = auth?.user;
    const isAdmin = u?.role === 'platform_admin' || u?.isPlatformAdmin === true;
    document.querySelectorAll('[data-platform-admin-only="true"]').forEach(el => {
      el.classList.toggle('hidden', !isAdmin);
    });
    // Mirror server-side checkExtensionWritePermission so read-only users
    // never see the "Create RO" entry point client-side.
    const READ_ONLY_ROLES = new Set(['viewer', 'read_only', 'readonly']);
    const role = (u?.role || '').toString().toLowerCase();
    currentUserCanWrite = isAdmin || (!u?.readOnly && !READ_ONLY_ROLES.has(role));
    updateTabAccessibility();
  } catch (e) {
    console.warn('[MOS] platform-admin visibility check failed:', e);
  }
}

const RO_INDEPENDENT_TABS = ['rates', 'concern', 'create-ro'];

function switchJobsSubTab(subtab) {
  const subBtns = document.querySelectorAll('#tab-jobs .sub-tab-btn');
  subBtns.forEach(btn => btn.classList.toggle('active', btn.dataset.subtab === subtab));
  const lookupPanel = document.getElementById('subtab-lookup');
  const cannedPanel = document.getElementById('subtab-canned');
  if (lookupPanel) lookupPanel.classList.toggle('hidden', subtab !== 'lookup');
  if (cannedPanel) cannedPanel.classList.toggle('hidden', subtab !== 'canned');
}

function switchTab(tab) {
  if (tab === 'lookup') { tab = 'jobs'; switchJobsSubTab('lookup'); }
  else if (tab === 'canned') { tab = 'jobs'; switchJobsSubTab('canned'); }

  // Leaving the Concern Assistant for anywhere other than itself cancels the
  // Create RO "return" mode, so a later standalone concern doesn't wrongly show
  // the "Use for Repair Order" button. (handleConcernUseForRo already cleared
  // the flag before it switches here.)
  if (currentTab === 'concern' && tab !== 'concern' && concernReturnToCro) {
    concernReturnToCro = false;
    if (elements.concernUseForRoBtn) elements.concernUseForRoBtn.classList.add('hidden');
    if (elements.concernInjectBtn) elements.concernInjectBtn.classList.remove('hidden');
  }

  currentTab = tab;
  
  elements.tabBtns.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  
  elements.tabPanels.forEach(panel => {
    panel.classList.toggle('hidden', panel.id !== `tab-${tab}`);
    panel.classList.toggle('active', panel.id === `tab-${tab}`);
  });
  
  const featureMap = {
    'plan': 'maintenance',
    'failures': 'common_failures',
    'jobs': 'job_lookup',
    'rates': 'labor_rates',
    'concern': 'concern_assistant',
    'estimate': 'estimate_assist',
    'sticker': 'oil_sticker',
    'create-ro': null,
    'specs': null
  };
  const featureKey = featureMap[tab];
  const hasAccess = featureKey ? shopFeatures[featureKey] : true;
  
  const panel = document.getElementById(`tab-${tab}`);
  if (panel) {
    let overlay = panel.querySelector('.upgrade-overlay');
    if (!hasAccess) {
      if (!overlay) {
        const featureNames = {
          'plan': 'Vehicle Health Indicator',
          'failures': 'Common Failures Advisor',
          'jobs': 'Job Lookup / History Writer',
          'rates': 'Labor Rate Rules',
          'concern': 'Customer Concern Assistant',
          'estimate': 'Estimate Assist',
          'sticker': 'Oil Sticker & Keytag Printing'
        };
        const featureName = featureNames[tab] || tab;
        overlay = document.createElement('div');
        overlay.className = 'upgrade-overlay';
        overlay.innerHTML = `
          <div class="upgrade-overlay-content">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="color: var(--gray-300); margin-bottom: 12px;">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
              <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
            </svg>
            <p class="upgrade-title">${featureName}</p>
            <p class="upgrade-message">This feature is not included in your current subscription.</p>
            <p class="upgrade-cta">Contact your administrator or upgrade your subscription to unlock this feature.</p>
          </div>
        `;
        panel.prepend(overlay);
      }
      overlay.classList.remove('hidden');
      Array.from(panel.children).forEach(child => {
        if (!child.classList.contains('upgrade-overlay')) {
          child.style.display = 'none';
        }
      });
      return;
    } else {
      if (overlay) overlay.classList.add('hidden');
      Array.from(panel.children).forEach(child => {
        if (!child.classList.contains('upgrade-overlay')) {
          child.style.display = '';
        }
      });
    }
  }
  
  const needsRo = !RO_INDEPENDENT_TABS.includes(tab);
  if (needsRo && (!currentContext || !currentContext.roId)) {
    let roOverlay = panel.querySelector('.ro-required-overlay');
    if (!roOverlay) {
      roOverlay = document.createElement('div');
      roOverlay.className = 'ro-required-overlay';
      roOverlay.innerHTML = `
        <div class="upgrade-overlay-content">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="color: var(--gray-300); margin-bottom: 12px;">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
            <line x1="16" y1="13" x2="8" y2="13"/>
            <line x1="16" y1="17" x2="8" y2="17"/>
          </svg>
          <p class="upgrade-title">Repair Order Required</p>
          <p class="upgrade-message">Open a repair order in your shop management system to use this feature.</p>
        </div>
      `;
      panel.prepend(roOverlay);
    }
    roOverlay.classList.remove('hidden');
    Array.from(panel.children).forEach(child => {
      if (!child.classList.contains('ro-required-overlay') && !child.classList.contains('upgrade-overlay')) {
        child.style.display = 'none';
      }
    });
    return;
  } else {
    const roOverlay = panel.querySelector('.ro-required-overlay');
    if (roOverlay) roOverlay.classList.add('hidden');
    Array.from(panel.children).forEach(child => {
      if (!child.classList.contains('ro-required-overlay') && !child.classList.contains('upgrade-overlay')) {
        child.style.display = '';
      }
    });
  }

  if (tab === 'plan' && currentContext?.roId) {
    loadPlan();
  } else if (tab === 'failures' && currentContext?.roId) {
    loadCommonFailures();
  } else if (tab === 'jobs' && currentContext?.roId) {
    loadCannedJobs();
  } else if (tab === 'rates') {
    loadLaborRates();
  } else if (tab === 'sticker' && currentContext?.roId) {
    loadKeytagSection();
    loadStickerConfig();
  } else if (tab === 'specs') {
    loadVehicleSpecs();
  } else if (tab === 'create-ro') {
    initCreateRoTab();
  }
}

function updateContext(context) {
  if (context && context.provider === 'autoflow') {
    context = enrichContextWithMosShop(context);
  }
  
  const prevContext = currentContext;
  currentContext = context;
  
  if (!prevContext || !context || prevContext.roId !== context.roId || prevContext.shopId !== context.shopId) {
    keytagContextEnriched = false;
    keytagStatus = 'idle';
    keytagInFlightKey = null;
    keytagLastEnrichedKey = null;
    currentPlanShopLogo = null;
    currentPlanLocationId = null;
    currentReportUrl = null;
    const shareBtn = document.getElementById('share-vhi-btn');
    if (shareBtn) shareBtn.classList.add('hidden');
  }
  
  if (prevContext && context && prevContext.roId === context.roId && prevContext.shopId === context.shopId) {
    if (prevContext.vehicle && !context.vehicle) currentContext.vehicle = prevContext.vehicle;
    if (prevContext.vehicleDisplay && !context.vehicleDisplay) currentContext.vehicleDisplay = prevContext.vehicleDisplay;
    if (prevContext.vin && !context.vin) currentContext.vin = prevContext.vin;
    if (prevContext.mileage && !context.mileage) currentContext.mileage = prevContext.mileage;
    // Task #645: the scraped on-screen odometer must survive re-scrapes that
    // momentarily miss it (and is never clobbered by the server-resolved
    // mileage written into `.mileage` after a plan response).
    if (prevContext.scrapedOdometer && !context.scrapedOdometer) currentContext.scrapedOdometer = prevContext.scrapedOdometer;
    if (prevContext.roNumber && !context.roNumber) currentContext.roNumber = prevContext.roNumber;
    if (prevContext.customerName && !context.customerName) currentContext.customerName = prevContext.customerName;
    if (prevContext.customerId && !context.customerId) currentContext.customerId = prevContext.customerId;
    if (prevContext.vehicleId && !context.vehicleId) currentContext.vehicleId = prevContext.vehicleId;
    if (prevContext.customerPhone && !context.customerPhone) currentContext.customerPhone = prevContext.customerPhone;
    if (prevContext.customerEmail && !context.customerEmail) currentContext.customerEmail = prevContext.customerEmail;
  }
  
  if (context && (context.roId || context.shopId)) {
    elements.noContext.classList.add('hidden');
    elements.hasContext.classList.remove('hidden');
    
    if (context.roId) {
      if (context.vehicle) {
        elements.vehicleDisplay.textContent = 
          `${context.vehicle.year} ${context.vehicle.make} ${context.vehicle.model}`;
      } else {
        elements.vehicleDisplay.textContent = 'Vehicle';
      }
      const roLabel = context.provider === 'protractor' ? 'WO' : (context.provider === 'autoflow' ? 'Ticket' : 'RO');
      elements.roDisplay.textContent = `${roLabel} #${context.roNumber || context.roId}`;
      
      if (context.mileage) {
        elements.mileageDisplay.textContent = `${context.mileage.toLocaleString()} ${getDistLabel()}`;
        elements.mileageDisplay.classList.remove('hidden');
        if (context.mileageEstimated) {
          elements.mileageDisplay.classList.add('mileage-estimated');
          const details = context.mileageEstimateDetails;
          elements.mileageDisplay.title = details
            ? `Estimated from CARFAX (${details.dataPoints} data points)\nLast recorded: ${details.lastRecordedMileage.toLocaleString()} ${getDistLabel()} on ${details.lastRecordedDate}\nAvg: ${details.milesPerDay} ${getDistLabel()}/day`
            : 'Estimated from CARFAX service history';
        } else {
          elements.mileageDisplay.classList.remove('mileage-estimated');
          elements.mileageDisplay.title = '';
        }
      } else {
        elements.mileageDisplay.classList.add('hidden');
      }
      // Task #649: cached context carries no discrepancy flag; clear any stale
      // warning until the fresh plan response decides whether to re-show it.
      elements.mileageWarning?.classList.add('hidden');
    } else {
      elements.vehicleDisplay.textContent = '';
      elements.roDisplay.textContent = '';
      elements.mileageDisplay.classList.add('hidden');
      elements.mileageWarning?.classList.add('hidden');
    }
    
    fetchShopFeatures();
    
    const roChanged = !prevContext || prevContext.roId !== context.roId;
    // Task #1094: repaint the undo bar for the (possibly new) RO.
    refreshUndoBar();
    if (context.roId && roChanged) {
      if (currentTab === 'plan') {
        loadPlan();
      } else if (currentTab === 'failures') {
        loadCommonFailures();
      } else if (currentTab === 'jobs') {
        loadCannedJobs();
      } else if (currentTab === 'specs') {
        loadVehicleSpecs();
      }
    } else if (RO_INDEPENDENT_TABS.includes(currentTab)) {
      switchTab(currentTab);
    } else if (!context.roId) {
      // No RO available and the current tab needs one → fall back to an
      // RO-independent tab.
      switchTab(RO_INDEPENDENT_TABS[0]);
    }
    // else: same RO re-fired (roChanged === false) while on an RO-dependent
    // tab — stay put. Previously this branch force-switched to the first
    // RO-independent tab, yanking the user off Plan/Jobs ("snap-back").
  } else {
    elements.noContext.classList.remove('hidden');
    elements.hasContext.classList.add('hidden');
    document.getElementById('undo-bar')?.classList.add('hidden');
  }
}

// Features can fail to load transiently (a brief DB / shop-resolution blip on
// the server, now signalled as a 503). When that happens we must NOT clobber
// the last-known-good feature set with an all-off default — that flashes the
// scary "not included in your subscription" lock at a writer mid-shift.
// Instead: keep what we have, retry quietly with backoff, and only ever apply
// a real features payload.
const FEATURES_RETRY_DELAYS_MS = [800, 2000, 4000, 8000];
let featuresFetchSeq = 0;

function applyShopFeatures(result) {
  shopFeatures = result.features;
  // Task #340: pick up shop distance preference early so the mileage
  // chip and any tooltips that fire before the plan response use the
  // right unit.
  if (result.distanceUnit === 'kilometers' || result.distanceUnit === 'miles') {
    shopDistanceUnit = result.distanceUnit;
  }
  updateTabAccessibility();

  if (result.shopId && currentContext) {
    currentContext.mosShopId = result.shopId;
    resolvedMosShopId = result.shopId;
  }
  if (result.writeProvider && currentContext) {
    resolvedWriteProvider = result.writeProvider;
    currentContext.writeProvider = result.writeProvider;
  }
  if (result.integrations && currentContext) {
    currentContext.integrations = result.integrations;
  }
  // Floating launcher button: owner per-shop gate + per-user preference.
  floatingOwnerEnabled =
    typeof result.floatingButtonOwnerEnabled === 'boolean'
      ? result.floatingButtonOwnerEnabled
      : null;
  floatingUserPreference =
    typeof result.floatingButtonUserPreference === 'boolean'
      ? result.floatingButtonUserPreference
      : null;
  renderFloatingButtonSetting();
}

async function fetchShopFeatures() {
  if (!currentContext || !currentContext.shopId) return;

  // Sequence guard: a newer call (the writer switched ROs/shops) cancels any
  // in-flight retry loop so we never apply a stale shop's features.
  const mySeq = ++featuresFetchSeq;
  const shopAtStart = currentContext.shopId;
  // Snapshot the provider up front too. The retry loop below awaits between
  // attempts, and currentContext can be cleared to null mid-loop (writer
  // closes the RO / context re-detect races during login on a fresh machine).
  // Reading currentContext.provider inside the loop then threw "Cannot read
  // properties of null (reading 'provider')", which got swallowed as a
  // transient error and retried until it gave up — so features never loaded.
  const providerAtStart = currentContext.provider || '';

  for (let attempt = 0; ; attempt++) {
    if (mySeq !== featuresFetchSeq) return;

    let result;
    try {
      result = await sendMessage({
        action: 'MOS_API_REQUEST',
        endpoint: `/api/extension/features?shopId=${shopAtStart}&provider=${providerAtStart}`
      });
    } catch (err) {
      result = { error: (err && err.message) || 'fetch failed' };
    }

    // Superseded while awaiting — drop this result.
    if (mySeq !== featuresFetchSeq) return;

    if (result && result.features) {
      applyShopFeatures(result);
      return;
    }

    // Transient / error (e.g. 503): keep last-known-good features and retry
    // quietly. Never overwrite with an all-off lock.
    console.warn(
      `[MOS] Features load transient (attempt ${attempt + 1}); keeping last-known-good`,
      result && result.error
    );
    if (attempt >= FEATURES_RETRY_DELAYS_MS.length) {
      console.error('[MOS] Features load failed after retries; left last-known-good in place');
      return;
    }
    await new Promise((r) => setTimeout(r, FEATURES_RETRY_DELAYS_MS[attempt]));
  }
}

// Per-user control of the floating "Detect Dog" launcher button. The owner's
// per-shop switch is a hard gate: when the owner has it off, the user cannot
// turn it on (checkbox is disabled and an explanatory note shows). When the
// owner has it on, the user may turn it off for themselves.
let floatingOwnerEnabled = null;   // null = unknown, true/false once resolved
let floatingUserPreference = null; // null = unset (defaults on), true/false explicit
let floatingSaveInFlight = false;

function renderFloatingButtonSetting() {
  if (!elements.floatingBtnSetting || !elements.floatingBtnCheckbox) return;
  // Only show the control once we know the owner state.
  if (floatingOwnerEnabled === null) {
    elements.floatingBtnSetting.classList.add('hidden');
    return;
  }
  elements.floatingBtnSetting.classList.remove('hidden');

  const ownerOff = floatingOwnerEnabled === false;
  const userResolved = floatingUserPreference === null ? true : floatingUserPreference;

  elements.floatingBtnCheckbox.disabled = ownerOff || floatingSaveInFlight;
  elements.floatingBtnCheckbox.checked = ownerOff ? false : userResolved;

  if (elements.floatingBtnLockedNote) {
    elements.floatingBtnLockedNote.classList.toggle('hidden', !ownerOff);
  }
}

async function handleFloatingButtonToggle() {
  if (!elements.floatingBtnCheckbox) return;
  if (floatingOwnerEnabled === false) {
    // Hard gate — shouldn't be reachable (disabled), but guard anyway.
    renderFloatingButtonSetting();
    return;
  }
  const desired = elements.floatingBtnCheckbox.checked;
  floatingSaveInFlight = true;
  elements.floatingBtnCheckbox.disabled = true;
  try {
    const result = await sendMessage({
      action: 'MOS_API_REQUEST',
      endpoint: `/api/extension/preferences`,
      options: {
        method: 'PUT',
        body: JSON.stringify({ floatingDetectDogEnabled: desired })
      }
    });
    if (result && result.success) {
      floatingUserPreference = desired;
    } else {
      console.error('[MOS] Failed to save floating button preference:', result && result.error);
    }
  } catch (err) {
    console.error('[MOS] Error saving floating button preference:', err);
  } finally {
    floatingSaveInFlight = false;
    renderFloatingButtonSetting();
  }
}

function updateTabAccessibility() {
  const featureMap = {
    'plan': 'maintenance',
    'failures': 'common_failures',
    'jobs': 'job_lookup',
    'rates': 'labor_rates',
    'concern': 'concern_assistant',
    'estimate': 'estimate_assist',
    'sticker': 'oil_sticker',
    'create-ro': null,
    'specs': null
  };

  const isShopWare = currentContext?.provider === 'shopware';
  const isTekmetric = currentContext?.provider === 'tekmetric';
  const effectiveWriteProvider = currentContext?.writeProvider || resolvedWriteProvider || null;
  const hiddenForProvider = isShopWare ? ['jobs'] : [];
  // Create RO is Protractor-write-only — keep it hidden everywhere else.
  // Also hide it client-side for read-only users so they never see the
  // entry point (server enforces a 403 as a defence in depth).
  if (effectiveWriteProvider !== 'protractor' || !currentUserCanWrite) {
    hiddenForProvider.push('create-ro');
  }
  // Task #808: the standalone Tekmetric Declined/Deferred tab (#741) was
  // removed — declined work now surfaces inline on the VHI plan tab with an
  // "Add all to RO" action. The Protractor Create-RO deferred pane remains.
  
  let firstAvailableTab = null;
  
  elements.tabBtns.forEach(btn => {
    const tab = btn.dataset.tab;

    if (hiddenForProvider.includes(tab)) {
      btn.style.display = 'none';
      return;
    }
    // Platform-admin-only and super-admin-only tabs are gated by the
    // .hidden class via applyPlatformAdminVisibility(). Don't reset their
    // display here; otherwise non-admin users would see the button.
    if (btn.dataset.platformAdminOnly === 'true' || btn.dataset.superAdminOnly === 'true') {
      return;
    }
    btn.style.display = '';

    const featureKey = featureMap[tab];
    const hasAccess = featureKey ? shopFeatures[featureKey] : true;
    
    if (hasAccess) {
      btn.classList.remove('disabled');
      btn.removeAttribute('data-tooltip');
      if (!firstAvailableTab) firstAvailableTab = tab;
    } else {
      btn.classList.add('disabled');
      btn.setAttribute('data-tooltip', 'Upgrade to unlock');
    }
  });

  // The Create RO "Use AI Assistant" button is only meaningful when the shop
  // has the Concern Assistant feature.
  if (elements.croConcernAiBtn) {
    elements.croConcernAiBtn.classList.toggle('hidden', !shopFeatures.concern_assistant);
  }

  let targetTab = currentTab;
  
  if (userDefaultTab) {
    const defaultFeatureKey = featureMap[userDefaultTab];
    const defaultHasAccess = defaultFeatureKey ? shopFeatures[defaultFeatureKey] : true;
    if (defaultHasAccess) {
      targetTab = userDefaultTab;
    }
  }
  
  const targetFeatureKey = featureMap[targetTab];
  const targetHasAccess = targetFeatureKey ? shopFeatures[targetFeatureKey] : true;
  if (!targetHasAccess && firstAvailableTab) {
    switchTab(firstAvailableTab);
  } else {
    switchTab(targetTab);
  }
}

// ==================== AUTHENTICATION ====================
async function handleLogin(e) {
  e.preventDefault();
  
  const email = elements.emailInput.value;
  const password = elements.passwordInput.value;
  const apiUrl = elements.apiUrlInput.value || 'https://mos.tools';
  const rememberMe = elements.rememberMeCheckbox.checked;
  
  elements.loginError.classList.add('hidden');
  elements.loginForm.querySelector('button').disabled = true;
  elements.loginForm.querySelector('button').textContent = 'Signing in...';
  
  try {
    const result = await sendMessage({
      action: 'MOS_LOGIN',
      email,
      password,
      apiUrl,
      rememberMe
    });
    
    if (result.success) {
      isAuthenticated = true;
      mosShops = result.shops || [];

      if (result.user?.defaultExtensionTab) {
        userDefaultTab = sanitizeDefaultTab(result.user.defaultExtensionTab);
        currentTab = userDefaultTab;
      }
      if (result.user?.shopwareAddMode) {
        shopwareAddMode = result.user.shopwareAddMode;
      }

      showMainState();
      
      const contextStatus = await sendMessage({ action: 'GET_SMS_CONTEXT' });
      if (contextStatus.context) {
        updateContext(contextStatus.context);
      }
    } else {
      throw new Error(result.error || 'Login failed');
    }
  } catch (err) {
    elements.loginError.textContent = err.message;
    elements.loginError.classList.remove('hidden');
  } finally {
    elements.loginForm.querySelector('button').disabled = false;
    elements.loginForm.querySelector('button').textContent = 'Sign In';
  }
}

async function handleLogout() {
  await sendMessage({ action: 'MOS_LOGOUT' });
  isAuthenticated = false;
  currentContext = null;
  specsCache = {};
  hideSupportFab();
  closeSupportChat();
  supportMessages = [];
  supportSessionId = null;
  supportShowEscalate = false;
  showLoginState();
}

// ==================== PLAN ====================
async function loadPlan(forceRefresh = false) {
  if (!currentContext || !currentContext.roId) {
    elements.planLoading.classList.add('hidden');
    elements.planEmpty.classList.remove('hidden');
    elements.planContent.classList.add('hidden');
    return;
  }

  // Snapshot the request identity so a slow/late response can never clobber a
  // newer RO the user has since switched to, or yank focus back to this tab.
  const reqRoId = currentContext.roId;
  const reqShopId = currentContext.shopId;
  const reqProvider = currentContext.provider || '';
  const reqVin = currentContext.vin || '';
  // Task #645: the on-screen RO odometer the advisor entered. Forwarded so the
  // server can anchor the VHI on it instead of falling to a CARFAX estimate.
  const reqOdometer = currentContext.scrapedOdometer || null;
  const cacheKey = planCacheKey(currentContext);

  // Stale-while-revalidate: paint cached content instantly when we have it.
  let servedFromCache = false;
  if (!forceRefresh && cacheKey) {
    const entry = planCache.get(cacheKey);
    if (entry) {
      renderPlan(entry.data, reqRoId, reqShopId);
      servedFromCache = true;
      // Fresh enough → skip the network entirely (truly instant revisit).
      if (Date.now() - entry.ts < PLAN_CACHE_TTL_MS) return;
      // Otherwise fall through and refresh quietly behind the cached view.
    }
  }

  if (forceRefresh) {
    elements.refreshBtn?.classList.add('spinning');
  }
  // Only show the loading skeleton when we have nothing to display yet.
  if (!servedFromCache) {
    elements.planLoading.classList.remove('hidden');
    elements.planEmpty.classList.add('hidden');
    elements.planContent.classList.add('hidden');
  }

  try {
    const params = new URLSearchParams({
      shopId: reqShopId,
      roId: reqRoId,
      provider: reqProvider
    });
    if (reqVin) params.set('vin', reqVin);
    if (reqOdometer) params.set('odometer', String(reqOdometer));
    if (forceRefresh) params.set('refresh', 'true');
    
    let result;
    let lastError;
    for (let attempt = 0; attempt < 2; attempt++) {
      result = await sendMessage({
        action: 'MOS_API_REQUEST',
        endpoint: `/api/extension/plan?${params}`
      }, 60000);
      
      if (!result.error) break;
      lastError = result.error;
      if (attempt === 0 && (lastError.includes('timed out') || lastError.includes('timeout'))) {
        console.log('[MOS] Plan request timed out, retrying...');
        continue;
      }
      break;
    }
    
    if (result.error) throw new Error(result.error);

    setPlanCache(cacheKey, result);
    renderPlan(result, reqRoId, reqShopId);
  } catch (err) {
    // The user already moved on to another RO/shop — drop this stale failure.
    if (currentContext?.roId !== reqRoId || currentContext?.shopId !== reqShopId) return;
    // We already have cached content on screen — keep it rather than wiping
    // the view with an error for a background refresh that failed.
    if (servedFromCache) {
      console.warn('[MOS] Background plan refresh failed, keeping cached view:', err);
      return;
    }
    console.error('[MOS] Error loading plan:', err);
    elements.planLoading.classList.add('hidden');
    elements.planEmpty.classList.remove('hidden');
    elements.planEmpty.querySelector('p').textContent = err.message;
  } finally {
    elements.refreshBtn?.classList.remove('spinning');
  }
}

// Task #649: render a subtle, non-blocking odometer-disagreement warning.
// The plan endpoint emits a `mileage_discrepancy` flag (same contract as the
// partner VHI endpoint) when the advisor-entered odometer is below a higher
// recorded reading beyond tolerance — a likely typo (dropped digit) that would
// otherwise silently skew the overdue/due-soon math. We show what was entered
// vs the last record so the advisor can confirm or correct.
function renderMileageWarning(data) {
  const el = elements.mileageWarning;
  if (!el) return;
  const flag = Array.isArray(data && data.flags)
    ? data.flags.find(f => f && f.code === 'mileage_discrepancy')
    : null;
  if (!flag || !flag.details) {
    el.classList.add('hidden');
    el.textContent = '';
    el.title = '';
    return;
  }
  const d = flag.details;
  const entered = typeof d.currentMiles === 'number' ? d.currentMiles.toLocaleString() : d.currentMiles;
  const prior = typeof d.priorMiles === 'number' ? d.priorMiles.toLocaleString() : d.priorMiles;
  const unit = getDistLabel();
  el.textContent = `Entered ${entered} ${unit} — last record ${prior} ${unit}${d.priorSource ? ` (${d.priorSource})` : ''}. Confirm the odometer.`;
  el.title = flag.message || '';
  el.classList.remove('hidden');
}

function renderPlan(data, reqRoId, reqShopId) {
  // Stale-response guard: if the user has switched to a different RO (or shop —
  // roIds can collide across shops/providers) while this response or background
  // refresh was in flight, drop it so we don't paint the wrong vehicle or
  // overwrite currentContext with stale values.
  if (reqRoId != null && currentContext &&
      (currentContext.roId !== reqRoId || currentContext.shopId !== reqShopId)) {
    return;
  }
  elements.planLoading.classList.add('hidden');
  
  // Update vehicle/mileage display from API response (more reliable than page scraping)
  // Also update currentContext.vehicle so Job Lookup has access to vehicle info
  if (data.vehicle) {
    const v = data.vehicle;
    if (v.year && v.make && v.model) {
      const displayText = `${v.year} ${v.make} ${v.model}`;
      elements.vehicleDisplay.textContent = displayText;
      if (currentContext) {
        currentContext.vehicle = {
          year: v.year,
          make: v.make,
          model: v.model,
          engine: v.engine || null
        };
        currentContext.vehicleDisplay = displayText;
        console.log('[MOS] Updated context with vehicle from API:', currentContext.vehicle);
      }
    } else if (v.vin) {
      elements.vehicleDisplay.textContent = `VIN: ${v.vin.slice(-6)}`;
    }
    if (v.vin && currentContext) {
      currentContext.vin = v.vin.toUpperCase();
      console.log('[MOS] Updated VIN from API:', currentContext.vin);
    }
  }
  console.log('[MOS] Plan response mileage:', data.mileage, 'estimated:', data.mileageEstimated, 'fromCache:', data.fromDashboardCache);
  // Task #340: prefer the plan response's distance unit for downstream labels;
  // it's the most authoritative because the plan endpoint already converted
  // intervals/dueAt to shop units.
  if (data.distanceUnit === 'kilometers' || data.distanceUnit === 'miles') {
    shopDistanceUnit = data.distanceUnit;
  }
  if (data.mileage) {
    elements.mileageDisplay.textContent = `${data.mileage.toLocaleString()} ${getDistLabel()}`;
    elements.mileageDisplay.classList.remove('hidden');
    if (currentContext) {
      currentContext.mileage = data.mileage;
      currentContext.mileageEstimated = !!data.mileageEstimated;
      currentContext.mileageEstimateDetails = data.mileageEstimateDetails || null;
    }
    if (data.mileageEstimated) {
      elements.mileageDisplay.classList.add('mileage-estimated');
      const details = data.mileageEstimateDetails;
      elements.mileageDisplay.title = details
        ? `Estimated from CARFAX (${details.dataPoints} data points)\nLast recorded: ${details.lastRecordedMileage.toLocaleString()} ${getDistLabel()} on ${details.lastRecordedDate}\nAvg: ${details.milesPerDay} ${getDistLabel()}/day`
        : 'Estimated from CARFAX service history';
    } else {
      elements.mileageDisplay.classList.remove('mileage-estimated');
      elements.mileageDisplay.title = '';
    }
  }
  // Task #649: subtle, non-blocking warning when the entered odometer
  // disagrees sharply with the vehicle's recorded history.
  renderMileageWarning(data);
  // Update RO number from API response (repairOrderNumber is the friendly number)
  if (data.repairOrderNumber && currentContext) {
    currentContext.roNumber = String(data.repairOrderNumber);
    elements.roDisplay.textContent = `RO #${data.repairOrderNumber}`;
    console.log('[MOS] Updated RO number from API:', data.repairOrderNumber);
  }
  // Update customer name from API response
  if (data.customerName && currentContext) {
    currentContext.customerName = data.customerName;
    console.log('[MOS] Updated customer name from API:', data.customerName);
  }
  
  // Store shop branding for use in service item rendering
  if (data.shopLogo) {
    currentPlanShopLogo = data.shopLogo;
  }
  if (data.locationIdentifier) {
    currentPlanLocationId = data.locationIdentifier;
  }

  if (data.reportUrl) {
    currentReportUrl = data.reportUrl;
    const shareBtn = document.getElementById('share-vhi-btn');
    if (shareBtn) {
      shareBtn.classList.remove('hidden');
      shareBtn.classList.remove('copied');
      const label = shareBtn.querySelector('span');
      if (label) label.textContent = 'Share VHI';
    }
  }

  keytagContextEnriched = true;
  if (typeof updateKeytagFields === 'function') {
    updateKeytagFields();
  }
  
  function sortItemsActionableFirst(items) {
    if (!items) return items;
    return [...items].sort((a, b) => {
      const aHandled = a.approvedThisVisit ? 2 : a.onCurrentRO ? 1 : 0;
      const bHandled = b.approvedThisVisit ? 2 : b.onCurrentRO ? 1 : 0;
      return aHandled - bHandled;
    });
  }

  data.overdue = sortItemsActionableFirst(data.overdue);
  data.dueSoon = sortItemsActionableFirst(data.dueSoon);
  data.complimentary = sortItemsActionableFirst(data.complimentary);
  data.recommended = sortItemsActionableFirst(data.recommended);

  const hasOverdue = data.overdue && data.overdue.length > 0;
  const hasDueSoon = data.dueSoon && data.dueSoon.length > 0;
  const hasComplimentary = data.complimentary && data.complimentary.length > 0;
  const hasRecommended = data.recommended && data.recommended.length > 0;
  
  if (!hasOverdue && !hasDueSoon && !hasComplimentary && !hasRecommended) {
    elements.planEmpty.classList.remove('hidden');
    return;
  }
  
  elements.planContent.classList.remove('hidden');
  
  // Task #865: bucket count pills next to the section titles.
  const setSectionCount = (id, count) => {
    const el = document.getElementById(id);
    if (el) el.textContent = String(count);
  };
  setSectionCount('overdue-count', (data.overdue || []).length);
  setSectionCount('due-soon-count', (data.dueSoon || []).length);
  setSectionCount('complimentary-count', (data.complimentary || []).length);
  setSectionCount('recommended-count', (data.recommended || []).length);
  
  // Render overdue
  elements.overdueSection.classList.toggle('hidden', !hasOverdue);
  if (hasOverdue) {
    elements.overdueList.innerHTML = data.overdue.map(item => 
      createServiceItemHTML(item, 'overdue')
    ).join('');
  }
  updateAddAllDeclinedButton(data);
  
  // Render due soon
  elements.dueSoonSection.classList.toggle('hidden', !hasDueSoon);
  if (hasDueSoon) {
    elements.dueSoonList.innerHTML = data.dueSoon.map(item => 
      createServiceItemHTML(item, 'due-soon')
    ).join('');
  }
  
  // Render complimentary
  elements.complimentarySection.classList.toggle('hidden', !hasComplimentary);
  if (hasComplimentary) {
    elements.complimentaryList.innerHTML = data.complimentary.map(item => 
      createServiceItemHTML(item, 'complimentary')
    ).join('');
  }
  
  // Render recommended
  elements.recommendedSection.classList.toggle('hidden', !hasRecommended);
  if (hasRecommended) {
    elements.recommendedList.innerHTML = data.recommended.map(item => 
      createServiceItemHTML(item, 'recommended')
    ).join('');
  }
  
  // Setup dropdown handlers
  setupAddDropdowns();
}

// ==================== ADD ALL DECLINED WORK (Task #808) ====================
// One-click "add every previously declined Tekmetric job to the current RO".
// The server endpoint lists the declined jobs, resolves the open RO, and
// dedupes against jobs already on it; the actual writes happen here via
// CREATE_TEKMETRIC_JOB using the page session (same path as single job adds).
let addAllDeclinedInFlight = false;

function updateAddAllDeclinedButton(data) {
  const btn = document.getElementById('add-all-declined-btn');
  if (!btn) return;
  const isTekmetric = currentContext?.provider === 'tekmetric';
  const declinedCount = (data.overdue || []).filter(
    (i) => i.declined && i.declined.origin === 'tekmetric'
  ).length;
  const show = isTekmetric && declinedCount > 0 && !!currentContext?.roId && currentUserCanWrite;
  btn.classList.toggle('hidden', !show);
  if (show) {
    btn.textContent = `+ Add All Declined (${declinedCount})`;
    if (!btn._mosClickBound) {
      btn._mosClickBound = true;
      btn.addEventListener('click', handleAddAllDeclinedWork);
    }
  }
}

async function handleAddAllDeclinedWork() {
  const btn = document.getElementById('add-all-declined-btn');
  if (addAllDeclinedInFlight) return;
  if (!currentContext?.shopId || !currentContext?.vin) {
    showNotification('Missing shop or vehicle VIN — reload the repair order first.', 'error');
    return;
  }
  addAllDeclinedInFlight = true;
  // Snapshot before the slow add requests — see markServiceOnEstimate.
  const reqPlanCacheKey = planCacheKey(currentContext);
  const originalLabel = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Adding…'; }

  try {
    const result = await sendMessage({
      action: 'MOS_API_REQUEST',
      endpoint: '/api/extension/tekmetric/add-declined-work',
      options: {
        method: 'POST',
        body: JSON.stringify({
          shopId: currentContext.shopId,
          vin: currentContext.vin,
          roId: currentContext.roId || null,
        }),
      },
    }, 90000, 'Still gathering declined work — please keep this panel open…');
    if (result?.error) throw new Error(result.error);

    const jobs = result?.jobs || [];
    const addable = jobs.filter((j) => !j.skipped);
    const skippedCount = jobs.length - addable.length;
    if (addable.length === 0) {
      showNotification(
        skippedCount > 0
          ? `All ${skippedCount} declined job${skippedCount !== 1 ? 's are' : ' is'} already on this RO.`
          : 'No declined work found for this vehicle.',
        'info'
      );
      return;
    }

    // Add sequentially so each job's outcome is reported and one failure
    // never aborts the rest.
    let added = 0;
    const failures = [];
    for (const job of addable) {
      if (btn) btn.textContent = `Adding ${added + failures.length + 1}/${addable.length}…`;
      const jobData = {
        name: job.title || 'Declined job',
        laborItems: (job.lines || []).filter(l => l.lineType === 'labor').map(item => ({
          name: item.description || job.title,
          hours: item.hours || item.quantity || 1
        })),
        parts: (job.lines || []).filter(l => l.lineType === 'part').map(part => ({
          name: part.description || 'Part',
          partNumber: part.partNumber || '',
          brand: part.manufacturer || '',
          quantity: part.quantity || 1,
          cost: part.unitPrice || 0,
          retail: part.unitPrice || 0,
          // Task #809 — declined-work lines carry the real part cost when the
          // original Tekmetric job knew it; send it as `unitCost` so the
          // background writes it through instead of estimating from retail.
          ...(Number(part.cost) > 0 ? { unitCost: Number(part.cost) } : {})
        })),
        note: job.description || ''
      };
      try {
        const res = await sendMessage({
          action: 'CREATE_TEKMETRIC_JOB',
          shopId: currentContext.shopId,
          roId: result.repairOrderId,
          jobData
        }, undefined, 'Still adding this job — big shops can take a minute. Please keep this panel open…');
        if (res?.success) {
          added++;
          markServiceOnEstimate(job.title, reqPlanCacheKey);
          // Task #1094: the background snapshotted each created job for undo.
        } else {
          failures.push(`${job.title}: ${res?.error || 'unknown error'}`);
        }
      } catch (err) {
        failures.push(`${job.title}: ${err.message}`);
      }
    }

    const parts = [`Added ${added} of ${addable.length} declined job${addable.length !== 1 ? 's' : ''}`];
    if (skippedCount > 0) parts.push(`${skippedCount} already on RO`);
    if (failures.length > 0) {
      console.error('[MOS] Add-all-declined failures:', failures);
      parts.push(`${failures.length} failed`);
    }
    showNotification(parts.join(' · '), failures.length > 0 ? 'warning' : 'success');
    if (added > 0) refreshUndoBar();
  } catch (err) {
    console.error('[MOS] Add all declined work error:', err);
    showNotification(err.message || 'Could not add declined work.', 'error');
  } finally {
    addAllDeclinedInFlight = false;
    if (btn) { btn.disabled = false; btn.textContent = originalLabel; }
  }
}

// ==================== SIDE-PANEL UNDO (Task #1094) ====================
// Side-panel write actions (add job / canned job / declined add-all) capture
// the created job / service-package identifiers into the same background
// snapshot store the injected-button undo chip uses (Task #1086). The bar at
// the top of the Plan tab lists what was added and offers a one-click undo:
//   * tekmetric — background deletes the created jobs via the page session;
//   * protractor — server removes the added service package(s) via
//     /api/extension/jobs/remove-from-ro.
// Shop-Ware adds have no delete path today, so they aren't snapshotted.
let undoBarInFlight = false;

// Pull created Tekmetric job ids out of the apply-canned-job server response.
// The route returns `{ success, repairOrderId, result }` where `result` is
// Tekmetric's own envelope; depending on API version the created jobs appear
// as an array of ids or of job objects, at the top level or under `data`.
function extractTekmetricCreatedJobIds(response) {
  const out = [];
  const scan = (v) => {
    if (Array.isArray(v)) {
      for (const el of v) {
        if (typeof el === 'number') out.push(el);
        else if (el && typeof el === 'object' && el.id != null) out.push(el.id);
      }
    }
  };
  const r = response?.result;
  scan(r);
  scan(r?.data);
  scan(r?.jobs);
  return out;
}

// Record one side-panel add into the snapshot store. Tekmetric single adds
// are snapshotted by the background inside CREATE_TEKMETRIC_JOB; this helper
// covers the server-mediated paths (Tekmetric canned, Protractor).
async function recordSidepanelAdd(provider, shopId, roId, items) {
  if (!provider || shopId == null || roId == null || !items || items.length === 0) return;
  try {
    await sendMessage({
      action: 'UNDO_SNAPSHOT_SAVE',
      snapshot: { provider, shopId, roId, kind: 'sidepanel_add_job', mergeItems: true, items },
    });
  } catch (err) {
    console.warn('[MOS Undo] Failed to save side-panel undo snapshot:', err?.message || err);
  }
  refreshUndoBar();
}

// The (provider, shopId) pairs a snapshot for the current context could have
// been keyed under. Tekmetric contexts key by the Tekmetric shop id; adds
// routed to Protractor key by the MOS shop id.
function undoBarQueryTargets() {
  const ctx = currentContext;
  if (!ctx) return [];
  const targets = [];
  if (ctx.provider === 'tekmetric') {
    targets.push({ provider: 'tekmetric', shopId: ctx.shopId });
  }
  const writeProvider = ctx.writeProvider || resolvedWriteProvider || ctx.provider;
  if (writeProvider === 'protractor') {
    const mosShopId = ctx.mosShopId || resolvedMosShopId || ctx.shopId;
    if (mosShopId != null) targets.push({ provider: 'protractor', shopId: mosShopId });
  }
  return targets;
}

async function refreshUndoBar() {
  const bar = document.getElementById('undo-bar');
  if (!bar) return;
  const ctx = currentContext;
  const roId = ctx?.roId;
  const targets = undoBarQueryTargets();
  if (!roId || targets.length === 0) { bar.classList.add('hidden'); return; }
  const reqKey = planCacheKey(ctx);
  try {
    const lists = await Promise.all(targets.map(t =>
      sendMessage({ action: 'UNDO_SNAPSHOT_LIST', provider: t.provider, shopId: t.shopId, roId })
        .then(r => (r && r.success && Array.isArray(r.snapshots)) ? r.snapshots : [])
        .catch(() => [])
    ));
    // A slow response must never paint another RO's undo bar.
    if (planCacheKey(currentContext) !== reqKey) return;
    const snaps = lists.flat().filter(s => s.kind === 'sidepanel_add_job' && Array.isArray(s.items) && s.items.length > 0);
    if (snaps.length === 0) { bar.classList.add('hidden'); return; }
    const total = snaps.reduce((n, s) => n + s.items.length, 0);
    const names = snaps.flatMap(s => s.items.map(it => it.name || it.title || 'job'));
    const summaryEl = document.getElementById('undo-bar-summary');
    if (summaryEl) {
      summaryEl.textContent = `Added from panel: ${total} job${total === 1 ? '' : 's'}`;
      summaryEl.title = names.join('\n');
    }
    const btn = document.getElementById('undo-bar-btn');
    if (btn && !btn._mosClickBound) {
      btn._mosClickBound = true;
      btn.addEventListener('click', handleUndoBarClick);
    }
    bar._mosSnaps = snaps;
    bar.classList.toggle('hidden', !currentUserCanWrite);
  } catch (err) {
    console.warn('[MOS Undo] refreshUndoBar failed:', err?.message || err);
  }
}

async function handleUndoBarClick() {
  const bar = document.getElementById('undo-bar');
  const btn = document.getElementById('undo-bar-btn');
  const snaps = bar?._mosSnaps || [];
  if (undoBarInFlight || snaps.length === 0) return;
  const names = snaps.flatMap(s => s.items.map(it => it.name || it.title || 'job'));
  if (!window.confirm('Remove the job(s) just added from this repair order?\n\n' + names.map(n => '• ' + n).join('\n'))) return;
  undoBarInFlight = true;
  const originalLabel = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Undoing…'; }
  let reverted = 0;
  let failed = 0;
  try {
    for (const snap of snaps) {
      if (snap.provider === 'tekmetric') {
        try {
          const res = await sendMessage({ action: 'UNDO_APPLY_TEKMETRIC', key: snap.key }, 90000, 'Still undoing — please keep this panel open…');
          // Partial failures keep their un-deleted items in the snapshot
          // (background rewrites it), so the bar stays up for a retry.
          if (res && typeof res.reverted === 'number') {
            reverted += res.reverted;
            failed += res.failed || 0;
          } else {
            failed += res?.success ? 0 : snap.items.length;
          }
        } catch (err) {
          failed += snap.items.length;
          console.warn('[MOS Undo] Tekmetric undo failed:', err?.message || err);
        }
      } else if (snap.provider === 'protractor') {
        // Server-side removal, one package per item. The snapshot is cleared
        // only when every item is gone; a retried undo is safe — the server
        // treats an already-removed package as success.
        let snapFailed = 0;
        for (const it of snap.items) {
          if (!it.servicePackageId || !it.workOrderId) { snapFailed++; failed++; continue; }
          try {
            const res = await sendMessage({
              action: 'MOS_API_REQUEST',
              endpoint: '/api/extension/jobs/remove-from-ro',
              options: {
                method: 'POST',
                body: JSON.stringify({
                  shopId: Number(snap.shopId),
                  workOrderId: it.workOrderId,
                  servicePackageId: it.servicePackageId,
                }),
              },
            }, 90000, 'Still undoing — please keep this panel open…');
            if (res?.success) reverted++;
            else { snapFailed++; failed++; console.warn('[MOS Undo] remove-from-ro failed:', res?.error); }
          } catch (err) {
            snapFailed++; failed++;
            console.warn('[MOS Undo] remove-from-ro error:', err?.message || err);
          }
        }
        if (snapFailed === 0) {
          await sendMessage({ action: 'UNDO_SNAPSHOT_CLEAR', key: snap.key }).catch(() => {});
        }
      }
    }
    showNotification(
      failed > 0
        ? `Undo finished with issues: ${reverted} removed, ${failed} failed — check the RO in your SMS.`
        : `Undo complete: ${reverted} job${reverted === 1 ? '' : 's'} removed.`,
      failed > 0 ? 'warning' : 'success'
    );
    // The plan cache was computed with these jobs on the estimate — expire it
    // and repaint so "On Estimate" badges clear.
    const key = planCacheKey(currentContext);
    const entry = key && planCache.get(key);
    if (entry) entry.ts = 0;
    if (currentTab === 'plan' && currentContext?.roId) loadPlan(true);
    // Nudge the SMS page to reload so the removal is visible there too.
    if (reverted > 0) {
      notifyPageJobCreated(
        ["*://*.tekmetric.com/*", "*://*.autoflow.com/*", "*://*.autotext.me/*", "*://*.protractor.com/*"],
        'undo', 'Undo'
      );
    }
  } finally {
    undoBarInFlight = false;
    if (btn) { btn.disabled = false; btn.textContent = originalLabel; }
    refreshUndoBar();
  }
}

let dropdownClickHandlerRegistered = false;

function setupAddDropdowns() {
  document.querySelectorAll('.btn-add-toggle').forEach(btn => {
    if (btn._mosClickBound) return;
    btn._mosClickBound = true;
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (currentContext?.provider === 'shopware') {
        const service = JSON.parse(btn.dataset.service);
        if (shopwareAddMode === 'finding-draft') {
          await handleSwAddFinding(service, true);
        } else if (shopwareAddMode === 'add-service') {
          await handleAddService(service);
        } else {
          await handleSwAddFinding(service, false);
        }
        return;
      }
      const dropdownId = btn.dataset.dropdown;
      const dropdown = document.getElementById(dropdownId);
      document.querySelectorAll('.add-dropdown-menu').forEach(menu => {
        if (menu.id !== dropdownId) menu.classList.add('hidden');
      });
      dropdown.classList.toggle('hidden');
    });

    btn.addEventListener('contextmenu', (e) => {
      if (currentContext?.provider !== 'shopware') return;
      e.preventDefault();
      e.stopPropagation();
      const dropdownId = btn.dataset.dropdown;
      const dropdown = document.getElementById(dropdownId);
      document.querySelectorAll('.add-dropdown-menu').forEach(menu => {
        if (menu.id !== dropdownId) menu.classList.add('hidden');
      });
      dropdown.classList.toggle('hidden');
    });
  });

  document.querySelectorAll('.add-dropdown-item').forEach(item => {
    if (item._mosClickBound) return;
    item._mosClickBound = true;
    item.addEventListener('click', async (e) => {
      e.stopPropagation();
      const action = item.dataset.action;
      const service = JSON.parse(item.dataset.service);
      
      // Close dropdown
      item.closest('.add-dropdown-menu').classList.add('hidden');
      
      // Get the service name from various possible field names
      const serviceName = service.service || service.name || service.title || service.repair || service.jobTitle || 'Unknown Service';
      const normalizedName = normalizeServiceSearch(serviceName);
      
      if (action === 'search-history') {
        switchTab('lookup');
        elements.jobSearch.value = normalizedName;
        await handleJobSearch();
      } else if (action === 'search-canned') {
        switchTab('canned');
        elements.cannedSearch.value = normalizedName;
        filterCannedJobs(normalizedName);
      } else if (action === 'add-generic') {
        await handleAddService(service);
      } else if (action === 'sw-finding-publish') {
        shopwareAddMode = 'finding-published';
        chrome.storage.local.get('mosUser', (data) => {
          if (data.mosUser) { data.mosUser.shopwareAddMode = 'finding-published'; chrome.storage.local.set({ mosUser: data.mosUser }); }
        });
        await handleSwAddFinding(service, false);
      } else if (action === 'sw-finding-draft') {
        shopwareAddMode = 'finding-draft';
        chrome.storage.local.get('mosUser', (data) => {
          if (data.mosUser) { data.mosUser.shopwareAddMode = 'finding-draft'; chrome.storage.local.set({ mosUser: data.mosUser }); }
        });
        await handleSwAddFinding(service, true);
      } else if (action === 'sw-add-service') {
        shopwareAddMode = 'add-service';
        chrome.storage.local.get('mosUser', (data) => {
          if (data.mosUser) { data.mosUser.shopwareAddMode = 'add-service'; chrome.storage.local.set({ mosUser: data.mosUser }); }
        });
        await handleAddService(service);
      }
    });
  });

  // Register global click handler only once
  if (!dropdownClickHandlerRegistered) {
    dropdownClickHandlerRegistered = true;
    document.addEventListener('click', () => {
      document.querySelectorAll('.add-dropdown-menu').forEach(menu => {
        menu.classList.add('hidden');
      });
    });
  }
}

function highlightCannedJob(serviceName, attempts = 0) {
  const items = document.querySelectorAll('#canned-list .job-item');
  const searchTerm = serviceName.toLowerCase();
  
  // If no items and we haven't retried too many times, wait and retry
  if (items.length === 0 && attempts < 5) {
    setTimeout(() => highlightCannedJob(serviceName, attempts + 1), 300);
    return;
  }
  
  for (const item of items) {
    const title = item.querySelector('.job-title')?.textContent?.toLowerCase() || '';
    if (title.includes(searchTerm) || searchTerm.includes(title.split(' ')[0])) {
      item.scrollIntoView({ behavior: 'smooth', block: 'center' });
      item.style.outline = '2px solid var(--primary)';
      setTimeout(() => item.style.outline = '', 2000);
      break;
    }
  }
}

function formatLastDone(last, currentMileage) {
  if (!last || (!last.miles && !last.date)) return null;

  // Task #434: implied anchors lead with "Anchored to <parent>" so the
  // VHI overlay matches the dashboard / printed VHR phrasing — the
  // child service wasn't directly performed, the parent (e.g. tire
  // replacement) was, and that's what reset the interval clock.
  const impliedParent = last.impliedFromParentName && String(last.impliedFromParentName).trim();
  let text = impliedParent ? `Anchored to ${impliedParent}` : 'Last done';
  if (last.miles) {
    text += ` at ${last.miles.toLocaleString()} ${getDistLabel()}`;
  }
  if (last.date) {
    const date = new Date(last.date);
    text += ` on ${date.toLocaleDateString()}`;
  }
  
  // Source logo
  let logo = '';
  if (last.source === 'external') {
    // CARFAX logo
    logo = `<img src="icons/carfax-badge.png" alt="CARFAX" class="source-logo" title="From CARFAX" />`;
  } else if (last.source === 'shop') {
    // Shop branding logo + location identifier
    const locId = currentPlanLocationId ? ` (${escapeHtml(currentPlanLocationId)})` : '';
    if (currentPlanShopLogo) {
      logo = `<img src="${escapeHtml(currentPlanShopLogo)}" alt="Shop" class="source-logo" title="From Shop${locId}" />`;
    } else {
      logo = `<span class="source-logo shop-logo" title="From Shop${locId}">
        <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
          <path d="M12 2L4 6v12l8 4 8-4V6l-8-4zm0 2.18l6 3v9.64l-6 3-6-3V7.18l6-3z"/>
          <path d="M12 6a3 3 0 100 6 3 3 0 000-6z"/>
        </svg>
      </span>`;
    }
  }
  
  return { text, logo };
}

// ==================== SERVICE ICONS (Task #865) ====================
// Ports lib/service-icons.ts so the sidepanel resolves the same pictogram
// as the dashboard / customer-facing VHR. Artwork lives in icons/service/.
const SERVICE_ICON_FILES = {
  brake_pads_front: 'brakes.svg',
  brake_pads_rear: 'brakes.svg',
  brake_fluid: 'brake_fluid.svg',
  wiper_blades: 'wiper_blades.svg',
  transmission_fluid: 'transmission_fluid.svg',
  engine_air_filter: 'air_filter.svg',
  cabin_air_filter: 'cabin_air_filter.svg',
  spark_plugs: 'spark_plugs.svg',
  engine_oil: 'oil_change.svg',
  oil_change: 'oil_change.svg',
  tires_rotate: 'tire_rotation.svg',
  coolant: 'coolant.svg',
  differential_rear: 'differential.svg',
  differential_front: 'differential.svg',
  serpentine_belt: 'serpentine_belt.svg',
  transfer_case: 'transfer_case.svg',
  battery: 'battery.svg',
  power_steering: 'power_steering.svg',
  fuel_system: 'fuel_system.svg',
  coolant_hoses: 'coolant_hoses.svg',
  front_shocks: 'shocks.svg',
  rear_shocks: 'shocks.svg',
  wheel_alignment: 'wheel_alignment.svg',
  lubricate: 'lubricate.svg',
  bolt_torque: 'bolt_torque.svg',
  oil_reminder: 'oil_reminder.svg',
  chassis_body: 'chassis_body.svg',
  lighting: 'lighting.svg',
  general_service: 'general_service.svg',
  dvi_finding: 'dvi_finding.svg',
};

// Keyword -> icon-key matching; order matters (specific before broad).
// Mirrors titleKeywordMap in lib/service-icons.ts.
const SERVICE_ICON_KEYWORDS = [
  [['torque', 're-torque', 'retorque', 'bolt', 'nut'], 'bolt_torque'],
  [['propeller shaft', 'prop shaft', 'driveshaft', 'drive shaft', 'lubricate'], 'lubricate'],
  [['oil reminder', 'maint reqd', 'oil reset', 'reset oil', 'oil replacement reminder'], 'oil_reminder'],
  [['chassis', 'body', 'tighten'], 'chassis_body'],
  [['serpentine', 'drive belt', 'accessory belt', 'v-belt', 'timing belt'], 'serpentine_belt'],
  [['transfer case'], 'transfer_case'],
  [['differential front', 'front differential'], 'differential_front'],
  [['differential rear', 'rear differential'], 'differential_rear'],
  [['differential'], 'differential_rear'],
  [['transmission', 'trans fluid', 'atf'], 'transmission_fluid'],
  [['coolant hose', 'radiator hose', 'heater hose'], 'coolant_hoses'],
  [['coolant', 'antifreeze'], 'coolant'],
  [['brake pad', 'front brake', 'rear brake', 'brake shoe'], 'brake_pads_front'],
  [['brake fluid'], 'brake_fluid'],
  [['cabin filter', 'cabin air'], 'cabin_air_filter'],
  [['air filter', 'engine filter'], 'engine_air_filter'],
  [['spark plug', 'ignition'], 'spark_plugs'],
  [['oil change', 'engine oil', 'motor oil', 'oil filter'], 'oil_change'],
  [['tire rotat', 'rotate tire'], 'tires_rotate'],
  [['wiper', 'windshield wiper'], 'wiper_blades'],
  [['battery'], 'battery'],
  [['power steering', 'steering fluid'], 'power_steering'],
  [['fuel system', 'fuel inject', 'fuel filter', 'fuel induction'], 'fuel_system'],
  [['shock', 'strut', 'suspension'], 'front_shocks'],
  [['wheel align', 'alignment'], 'wheel_alignment'],
  [['headlight', 'head lamp', 'tail light', 'taillight', 'turn signal', 'marker light', 'fog light', 'license plate light', 'bulb', 'lamp', 'lighting', 'exterior lights', 'interior lights'], 'lighting'],
  [['inspect', 'check', 'examine', 'visual'], 'general_service'],
];

function resolveServiceIconFile(serviceKey, title) {
  if (!serviceKey && !title) return SERVICE_ICON_FILES.general_service;
  const isDviFinding = !!serviceKey && (String(serviceKey).startsWith('dvi_finding') || String(serviceKey).startsWith('dvi_unmapped'));
  if (serviceKey && SERVICE_ICON_FILES[serviceKey]) return SERVICE_ICON_FILES[serviceKey];
  const titleLower = String(title || serviceKey || '').toLowerCase();
  for (const [keywords, iconKey] of SERVICE_ICON_KEYWORDS) {
    if (keywords.some((kw) => titleLower.includes(kw))) {
      if (isDviFinding && iconKey === 'general_service') return SERVICE_ICON_FILES.dvi_finding;
      return SERVICE_ICON_FILES[iconKey];
    }
  }
  if (isDviFinding) return SERVICE_ICON_FILES.dvi_finding;
  return SERVICE_ICON_FILES.general_service;
}

function getOverdueText(item, type) {
  // Axis-aware overdue summary: prefer the new structured progress so we can
  // say "8,868 mi over • 4 mos over" matching the dashboard headlines.
  const p = item && item.progress;
  if (type === 'overdue' && p) {
    const parts = [];
    if (p.miles && p.miles.status === 'overdue' && p.miles.headline) parts.push(p.miles.headline);
    if (p.time && p.time.status === 'overdue' && p.time.headline) parts.push(p.time.headline);
    if (parts.length) return `<span class="overdue-amount">${parts.join(' • ')}</span>`;
  }
  if (type === 'overdue' && item.milesToGo != null && item.milesToGo < 0) {
    const overdue = Math.abs(item.milesToGo);
    return `<span class="overdue-amount">${overdue.toLocaleString()} ${getDistLabel()} overdue</span>`;
  }
  return '';
}

// Task #865: single dominant-axis gradient progress bar, mirroring the
// dashboard's IntervalProgressRow (calm AppFueled/public-VHR style). Picks
// the worst axis (overdue > soon > ok; tie broken by higher percent) and
// renders ONE green→amber→red gradient track with a small axis indicator.
function renderProgressBars(item, type) {
  const p = item && item.progress;
  if (!p) return '';
  const rank = (axis) => {
    if (!axis || (axis.percent == null && axis.status !== 'overdue')) return -1;
    return axis.status === 'overdue' ? 2 : axis.status === 'soon' ? 1 : 0;
  };
  const milesRank = rank(p.miles);
  const timeRank = rank(p.time);
  let axis = null;
  let isMiles = true;
  if (milesRank < 0 && timeRank < 0) return '';
  if (milesRank > timeRank) { axis = p.miles; isMiles = true; }
  else if (timeRank > milesRank) { axis = p.time; isMiles = false; }
  else {
    const mp = (p.miles && p.miles.percent) || 0;
    const tp = (p.time && p.time.percent) || 0;
    if (tp > mp) { axis = p.time; isMiles = false; }
    else { axis = p.miles; isMiles = true; }
  }
  if (!axis) return '';
  const pct = axis.percent != null
    ? Math.max(0, Math.min(100, Math.round(axis.percent)))
    : (axis.status === 'overdue' ? 100 : null);
  if (pct == null && !axis.headline) return '';
  const cls = axis.status === 'overdue' ? 'overdue'
            : axis.status === 'soon' ? 'soon'
            : 'ok';
  const headline = axis.headline ? escapeHtml(axis.headline) : '';
  const label = isMiles ? getDistAxisLabel().toUpperCase() : 'TIME';
  const fillPct = pct == null ? 0 : pct;
  // Anchor the gradient to the full track width so a half-full bar shows
  // green→amber, not the whole green→red ramp squeezed in.
  const bgSize = fillPct > 0 ? Math.round(10000 / fillPct) : 100;
  return `
    <div class="vhi-bar-single">
      <span class="vhi-bar-axis">${label}</span>
      <div class="vhi-bar-track"><div class="vhi-bar-gradient" style="width:${fillPct}%;background-size:${bgSize}% 100%;"></div></div>
      ${headline ? `<span class="vhi-bar-headline ${cls}">${headline}</span>` : ''}
    </div>
  `;
}

function createServiceItemHTML(item, type) {
  const itemId = `service-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  
  // Get service name from various possible field names
  // API sends 'service', some places use 'name' or 'title'
  const serviceName = item.service || item.name || item.title || item.serviceKey || 'Unknown Service';
  
  // Status badge color based on type (recommended = upcoming in display)
  const badgeClass = type === 'overdue' ? 'badge-overdue' : 
                     type === 'due-soon' ? 'badge-due-soon' :
                     type === 'complimentary' ? 'badge-complimentary' : 'badge-upcoming';
  const badgeText = type === 'overdue' ? 'Overdue' : 
                    type === 'due-soon' ? 'Due soon' :
                    type === 'complimentary' ? 'Additional' : '';
  
  // Task #865: service pictogram in the card header (same resolution logic
  // as the dashboard / customer-facing VHR).
  const iconFile = resolveServiceIconFile(item.serviceKey || null, serviceName);
  const iconHtml = `<img src="icons/service/${iconFile}" alt="" class="service-icon" />`;
  
  // Category badge
  const categoryBadge = item.category ? 
    `<span class="category-badge">${escapeHtml(item.category)}</span>` : '';
  
  // Interval info (OEM or Shop)
  const intervalText = item.intervalText || 
    (item.interval ? `OEM: ${item.interval.toLocaleString()} ${getDistLabel()}` : '');
  const isShopInterval = item.intervalSource === 'shop' || item.usingShopInterval;
  
  // Due at and overdue info
  const dueAtText = item.dueAt ? `Due at ${item.dueAt.toLocaleString()} ${getDistLabel()}` : '';
  const overdueText = getOverdueText(item, type);
  
  // Last done info with logo, or reason text (e.g. "No record of this service being performed.")
  // For DVI Finding items the technician's note is the meaningful body — prefer it
  // over the generic "no record" fallback. For other items, append the note when present.
  const lastDone = formatLastDone(item.last, currentContext?.mileage);
  const techNote = (item.notes || '').trim();
  const isDviFinding = item.category === 'DVI Finding' || item.source === 'dvi';
  let lastDoneHtml;
  if (lastDone) {
    lastDoneHtml = `<div class="last-done">${lastDone.text} ${lastDone.logo}</div>`;
  } else if (isDviFinding && techNote) {
    lastDoneHtml = `<div class="last-done reason-text">${escapeHtml(techNote)}</div>`;
  } else {
    lastDoneHtml = `<div class="last-done reason-text">${escapeHtml(item.reason || 'No record of this service being performed.')}</div>`;
  }
  if (techNote && !isDviFinding) {
    lastDoneHtml += `<div class="last-done reason-text" style="margin-top:4px;"><strong>Tech note:</strong> ${escapeHtml(techNote)}</div>`;
  }
  
  // Check if we have full job details from canned job match
  const hasFullDetails = item.laborItems && item.laborItems.length > 0;
  const addLabel = hasFullDetails ? 'Add with Labor/Parts' : 'Add Generic Job';
  const addIcon = hasFullDetails 
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22,4 12,14.01 9,11.01"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
  
  const isOnRoNotApproved = item.onCurrentRO && !item.approvedThisVisit;

  return `
    <li class="service-item ${type}${item.approvedThisVisit ? ' approved-visit' : ''}">
      <div class="service-header">
        <div class="service-name">${iconHtml}<span>${escapeHtml(serviceName)}</span></div>
        <div class="add-dropdown">
          ${item.approvedThisVisit ? `
          <button class="btn-approved btn-add-toggle" data-dropdown="${itemId}" data-service='${JSON.stringify(item)}'>
            Approved
          </button>
          ` : isOnRoNotApproved ? `
          <button class="btn-on-estimate btn-add-toggle" data-dropdown="${itemId}" data-service='${JSON.stringify(item)}'>
            On Estimate
          </button>
          ` : `
          <button class="btn-add btn-add-toggle" data-dropdown="${itemId}" data-service='${JSON.stringify(item)}'>
            + Add
          </button>
          `}
          <div id="${itemId}" class="add-dropdown-menu hidden">
            ${currentContext?.provider === 'shopware' ? `
            <button class="add-dropdown-item ${shopwareAddMode === 'finding-published' ? 'add-primary' : ''}" data-action="sw-finding-publish" data-service='${JSON.stringify(item)}'>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14,2 14,8 20,8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/>
              </svg>
              Add Finding (Published)${shopwareAddMode === 'finding-published' ? ' <span class="default-badge">default</span>' : ''}
            </button>
            <button class="add-dropdown-item ${shopwareAddMode === 'finding-draft' ? 'add-primary' : ''}" data-action="sw-finding-draft" data-service='${JSON.stringify(item)}'>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
              </svg>
              Add Finding (Draft)${shopwareAddMode === 'finding-draft' ? ' <span class="default-badge">default</span>' : ''}
            </button>
            <button class="add-dropdown-item ${shopwareAddMode === 'add-service' ? 'add-primary' : ''}" data-action="sw-add-service" data-service='${JSON.stringify(item)}'>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
              Add Service (Direct to RO)${shopwareAddMode === 'add-service' ? ' <span class="default-badge">default</span>' : ''}
            </button>
            ` : `
            ${hasFullDetails ? `
            <button class="add-dropdown-item add-primary" data-action="add-generic" data-service='${JSON.stringify(item)}'>
              ${addIcon}
              ${addLabel}
            </button>
            ` : ''}
            <button class="add-dropdown-item" data-action="search-history" data-service='${JSON.stringify(item)}'>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
              </svg>
              Search History
            </button>
            <button class="add-dropdown-item" data-action="search-canned" data-service='${JSON.stringify(item)}'>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="9" x2="15" y2="9"/><line x1="9" y1="15" x2="15" y2="15"/>
              </svg>
              Search Canned Jobs
            </button>
            ${!hasFullDetails ? `
            <button class="add-dropdown-item" data-action="add-generic" data-service='${JSON.stringify(item)}'>
              ${addIcon}
              ${addLabel}
            </button>
            ` : ''}
            `}
          </div>
        </div>
      </div>
      <div class="service-badges">
        ${categoryBadge}
        ${badgeText ? `<span class="status-badge ${badgeClass}">${badgeText}</span>` : ''}
        <span class="interval-badge ${isShopInterval ? 'shop' : 'oem'}">${isShopInterval && currentPlanShopLogo ? `<img src="${escapeHtml(currentPlanShopLogo)}" alt="" class="interval-shop-logo" />` : ''}${intervalText}</span>
        ${item.engineRiskFlag ? `
        <span class="engine-risk-badge" title="${escapeHtml(item.engineRiskReason || 'Engine flagged for accelerated oil wear.')}">
          ⚠ Engine flagged — long oil interval
        </span>
        ` : ''}
        ${item.declined ? (() => {
          // Task #808: surface declined-work provenance on the VHI item. Older
          // cached plans may carry a bare object with no date — degrade cleanly.
          const dt = item.declined.declinedAt ? new Date(item.declined.declinedAt) : null;
          const dateStr = (dt && !isNaN(dt.getTime())) ? dt.toLocaleDateString() : '';
          const tipParts = [];
          if (dateStr) tipParts.push(`Declined on ${dateStr}`);
          if (item.declined.roNumber) tipParts.push(`RO #${item.declined.roNumber}`);
          if (item.declined.reason) tipParts.push(item.declined.reason);
          return `<span class="status-badge" style="background:#ffedd5;color:#c2410c;border:1px solid #fdba74;" title="${escapeHtml(tipParts.join(' · ') || 'Previously declined')}">Declined${dateStr ? ` ${escapeHtml(dateStr)}` : ''}</span>`;
        })() : ''}
      </div>
      ${renderProgressBars(item, type)}
      <div class="service-details">
        ${dueAtText ? `<div class="due-info">${dueAtText}${overdueText ? ' • ' + overdueText : ''}</div>` : ''}
        ${item.estimatedDueDate && (type === 'due-soon' || type === 'recommended') ? `<div class="estimated-date">Est. due ${new Date(item.estimatedDueDate + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</div>` : ''}
        ${lastDoneHtml}
      </div>
    </li>
  `;
}

// ==================== COMMON FAILURES ====================
async function loadCommonFailures() {
  // If no vehicle data but we have RO context, try to fetch from Plan API
  if (currentContext && currentContext.roId && !currentContext.vehicle) {
    elements.failuresLoading.classList.remove('hidden');
    elements.failuresEmpty.classList.add('hidden');
    elements.failuresContent.classList.add('hidden');
    
    try {
      const params = new URLSearchParams({
        shopId: currentContext.shopId,
        roId: currentContext.roId,
        provider: currentContext.provider || ''
      });
      if (currentContext.vin) params.set('vin', currentContext.vin);
      // Task #645: keep the shared plan-cache key consistent with loadPlan.
      if (currentContext.scrapedOdometer) params.set('odometer', String(currentContext.scrapedOdometer));
      
      const result = await sendMessage({
        action: 'MOS_API_REQUEST',
        endpoint: `/api/extension/plan?${params}`
      });
      
      // Update context with vehicle data from Plan API
      if (result.vehicle) {
        const v = result.vehicle;
        if (v.year && v.make && v.model) {
          currentContext.vehicle = {
            year: v.year,
            make: v.make,
            model: v.model,
            engine: v.engine || null
          };
          console.log('[MOS] Updated context with vehicle from Plan API for failures:', currentContext.vehicle);
        }
      }
      if (result.mileage && !currentContext.mileage) {
        currentContext.mileage = result.mileage;
      }
    } catch (err) {
      console.error('[MOS] Error fetching vehicle for failures:', err);
    }
  }
  
  if (!currentContext || !currentContext.vehicle) {
    elements.failuresLoading.classList.add('hidden');
    elements.failuresEmpty.classList.remove('hidden');
    elements.failuresContent.classList.add('hidden');
    elements.failuresEmpty.querySelector('p').textContent = 'Navigate to a vehicle to see common failures.';
    return;
  }
  
  const { year, make, model, engine } = currentContext.vehicle;
  const mileage = currentContext.mileage;
  
  if (!year || !make || !model || !mileage) {
    elements.failuresLoading.classList.add('hidden');
    elements.failuresEmpty.classList.remove('hidden');
    elements.failuresContent.classList.add('hidden');
    elements.failuresEmpty.querySelector('p').textContent = 'Vehicle year, make, model, and mileage are required.';
    return;
  }
  
  elements.failuresLoading.classList.remove('hidden');
  elements.failuresEmpty.classList.add('hidden');
  elements.failuresContent.classList.add('hidden');
  
  try {
    const params = new URLSearchParams({
      year: String(year),
      make: make,
      model: model,
      mileage: String(mileage),
      enterprise: 'true'
    });
    if (engine) params.set('engine', engine);
    
    const result = await sendMessage({
      action: 'MOS_API_REQUEST',
      endpoint: `/api/vehicle/common-failures?${params}`,
      // Fail fast: the server now bounds its own AI/Mongo work and degrades to
      // defaults, so a request that hasn't returned in 30s is a hung network /
      // proxy hop, not a slow-but-working call. Surface a clear message instead
      // of spinning indefinitely.
      options: { timeoutMs: 30000 }
    });
    
    if (result.error) throw new Error(result.error);
    
    renderCommonFailures(result);
  } catch (err) {
    console.error('[MOS] Error loading common failures:', err);
    elements.failuresLoading.classList.add('hidden');
    elements.failuresEmpty.classList.remove('hidden');
    elements.failuresEmpty.querySelector('p').textContent = err.message || 'Failed to load common failures.';
  }
}

function renderCommonFailures(data) {
  elements.failuresLoading.classList.add('hidden');
  
  const failures = data.failures || [];
  
  if (failures.length === 0) {
    elements.failuresEmpty.classList.remove('hidden');
    elements.failuresEmpty.querySelector('p').textContent = 'No common failures found for this vehicle at this mileage.';
    return;
  }
  
  elements.failuresContent.classList.remove('hidden');
  
  // Source badge - API returns "shop_pattern", "ai", or mixed
  const source = data.source || 'ai';
  let sourceClass, sourceText;
  if (source === 'shop_pattern' || source === 'shop') {
    sourceClass = 'source-shop';
    sourceText = '📊 Based on Your Shop Data';
  } else if (source === 'ai') {
    sourceClass = 'source-ai';
    sourceText = '🤖 AI Predictions';
  } else {
    sourceClass = 'source-mixed';
    sourceText = '📊 Mixed: Shop + AI Data';
  }
  
  elements.failuresSource.className = `failures-source-badge ${sourceClass}`;
  elements.failuresSource.textContent = sourceText;
  
  // Clear previous failure data and render new items
  failuresDataMap.clear();
  elements.failuresList.innerHTML = failures.map((failure, index) => {
    const failureId = `failure-${index}`;
    failuresDataMap.set(failureId, failure);
    return createFailureItemHTML(failure, failureId);
  }).join('');
  
  // Setup add button handlers
  setupFailureHandlers();
}

function createFailureItemHTML(failure, failureId) {
  // Get title from various possible field names (API returns 'repair', shopMatch has 'title')
  const title = failure.repair || failure.jobTitle || failure.title || failure.shopMatch?.title || 'Unknown Repair';
  
  // Get confidence from matchConfidence or urgency
  const urgency = failure.urgency || 'low';
  const confidenceClass = urgency === 'high' ? 'confidence-high' : 
                          urgency === 'medium' ? 'confidence-medium' : 'confidence-low';
  const confidenceText = urgency === 'high' ? 'High Priority' : 
                         urgency === 'medium' ? 'Medium' : 'Low';
  
  // Get shop match data if available
  const shopMatch = failure.shopMatch || {};
  const occurrences = shopMatch.occurrences || failure.occurrences || 0;
  const avgTotal = shopMatch.avgTotal || failure.avgTotal || 0;
  const avgHours = shopMatch.avgHours || failure.avgHours || 0;
  const description = failure.description || '';
  const mileageRange = failure.typicalMileageRange || '';
  
  return `
    <li class="failure-item">
      <div class="failure-header">
        <div class="failure-title">${escapeHtml(title)}</div>
        <button class="btn-add btn-add-failure" data-failure-id="${failureId}">
          + Add
        </button>
      </div>
      <div class="failure-badges">
        <span class="confidence-badge ${confidenceClass}">${confidenceText}</span>
        ${occurrences > 0 ? `<span class="occurrence-badge">${occurrences} repairs</span>` : ''}
        ${mileageRange ? `<span class="mileage-badge">${mileageRange}</span>` : ''}
      </div>
      ${description ? `<div class="failure-description">${escapeHtml(description)}</div>` : ''}
      <div class="failure-details">
        ${avgTotal > 0 ? `<div class="failure-stat"><span class="failure-stat-label">Avg Cost:</span> <span class="failure-stat-value">$${avgTotal.toFixed(0)}</span></div>` : ''}
        ${avgHours > 0 ? `<div class="failure-stat"><span class="failure-stat-label">Avg Hours:</span> <span class="failure-stat-value">${avgHours.toFixed(1)}h</span></div>` : ''}
      </div>
    </li>
  `;
}

function setupFailureHandlers() {
  document.querySelectorAll('.btn-add-failure').forEach(btn => {
    btn.addEventListener('click', async () => {
      // Lookup failure from Map by ID (avoids JSON in HTML attributes)
      const failureId = btn.dataset.failureId;
      const failure = failuresDataMap.get(failureId);
      if (!failure) {
        console.error('[MOS] Failure not found:', failureId);
        return;
      }
      // Search for this job in history using the correct field
      const jobTitle = failure.repair || failure.jobTitle || failure.title || failure.shopMatch?.title || '';
      const normalizedTitle = normalizeServiceSearch(jobTitle);
      switchTab('lookup');
      elements.jobSearch.value = normalizedTitle;
      await handleJobSearch();
    });
  });
}

// ==================== JOB LOOKUP ====================
async function handleJobSearch() {
  const query = elements.jobSearch.value.trim();
  if (!query) return;
  
  elements.lookupLoading.classList.remove('hidden');
  elements.lookupEmpty.classList.add('hidden');
  elements.lookupResults.classList.add('hidden');
  
  try {
    const params = new URLSearchParams({ q: query });
    if (currentContext?.shopId) params.set('shopId', currentContext.shopId);
    if (currentContext?.roId) params.set('roId', currentContext.roId); // Pass roId for server-side vehicle lookup
    params.set('provider', currentContext?.provider || '');
    if (currentContext?.vehicle) {
      if (currentContext.vehicle.year) params.set('year', currentContext.vehicle.year);
      if (currentContext.vehicle.make) params.set('make', currentContext.vehicle.make);
      if (currentContext.vehicle.model) params.set('model', currentContext.vehicle.model);
      if (currentContext.vehicle.engine) params.set('engine', currentContext.vehicle.engine);
    }
    // Pass VIN so the server can DataOne-decode the target and fire ACES
    // tier matches. Without this, dataOneEnhanced stays false and ACES
    // never engages regardless of repair type.
    if (currentContext?.vin) params.set('vin', currentContext.vin);
    
    const result = await sendMessage({
      action: 'MOS_API_REQUEST',
      endpoint: `/api/extension/jobs/search?${params}`
    });
    
    if (result.error) throw new Error(result.error);
    
    renderJobResults(result.jobs || [], { dataOneEnhanced: result.dataOneEnhanced });
    // Non-blocking: decorate each result that was previously performed on THIS
    // vehicle with a "Last performed …" badge. Fails soft — never disrupts the
    // job search flow, and rows with no record get no badge.
    fetchLastPerformedForResults(result.jobs || []);
  } catch (err) {
    console.error('[MOS] Error searching jobs:', err);
    elements.lookupLoading.classList.add('hidden');
    elements.lookupEmpty.classList.remove('hidden');
    elements.lookupEmpty.querySelector('p').textContent = err.message;
  }
}

// Task #743: guards against a stale last-performed response landing after a
// newer search has started. Each search bumps the token; a response whose
// token no longer matches is discarded so it can never decorate the wrong
// result set. (Stale badges are also cleared implicitly because every search
// re-renders the results list HTML from scratch in renderJobResults.)
let lastPerformedToken = 0;

/**
 * Batch-resolve "last performed on THIS vehicle" for the visible job results
 * and inject a per-result badge on each row that has a prior performed record.
 * Fact-only: rows with no record get no badge (never a false "never done").
 * Non-blocking — always fails soft so the Jobs flow keeps working.
 */
async function fetchLastPerformedForResults(jobs) {
  const vin = currentContext?.vin;
  if (!vin || !Array.isArray(jobs) || jobs.length === 0) return;
  const myToken = ++lastPerformedToken;

  // Unique, non-empty result names (the match is name-based on the server).
  const names = [];
  const seen = new Set();
  for (const job of jobs) {
    const nm = String(job.title || job.name || '').trim();
    const key = nm.toLowerCase();
    if (nm && !seen.has(key)) {
      seen.add(key);
      names.push(nm);
    }
  }
  if (names.length === 0) return;

  try {
    const params = new URLSearchParams();
    params.set('vin', vin);
    if (currentContext?.shopId) params.set('shopId', currentContext.shopId);
    if (currentContext?.roId) params.set('roId', currentContext.roId);
    params.set('provider', currentContext?.provider || '');
    const odo = currentContext?.scrapedOdometer || currentContext?.mileage;
    if (odo) params.set('miles', String(odo));
    for (const nm of names) params.append('name', nm);

    const result = await sendMessage({
      action: 'MOS_API_REQUEST',
      endpoint: `/api/extension/jobs/last-performed?${params}`
    });

    // A newer search superseded this one — discard so we never decorate the
    // current (different) result set with stale facts.
    if (myToken !== lastPerformedToken) return;

    const byName = new Map();
    for (const r of (result?.results || [])) {
      if (r && r.lastPerformed) byName.set(String(r.name || '').trim().toLowerCase(), r.lastPerformed);
    }
    if (byName.size === 0) return;

    // "Last performed on this vehicle" is a VIN-authoritative fact, so it must
    // only appear where it genuinely applies to THIS vehicle — never stamped on
    // the other-vehicle pricing-reference cards (that read as if a different
    // car was serviced on this visit). Two cases:
    //   (a) A same-VIN donor card is present → badge THAT card (it's the real
    //       VIN match, already pinned to the top with the "VIN Match" pill).
    //   (b) No same-VIN card (the common case — results are similar vehicles
    //       used only for pricing) → surface a single "This vehicle" summary
    //       row at the very top, built from the vehicle's own history, and
    //       leave every reference card clean.
    let vinCardBadged = false;
    const rows = elements.lookupResults.querySelectorAll('li.job-item');
    rows.forEach((li) => {
      const lookupId = li.getAttribute('data-lookup-id');
      const job = lookupId ? lookupJobsDataMap.get(lookupId) : null;
      if (!job || !job.sameVin) return; // reference cards stay clean
      const nm = String((job.title || job.name) || '').trim().toLowerCase();
      const lp = nm ? byName.get(nm) : null;
      if (lp) { injectLastPerformedBadge(li, lp); vinCardBadged = true; }
    });

    if (!vinCardBadged) {
      // Prefer the history record tied to the best-ranked result that has one
      // (jobs are already score-sorted); fall back to the most recent record.
      let best = null;
      for (const job of jobs) {
        const nm = String((job.title || job.name) || '').trim().toLowerCase();
        const lp = nm ? byName.get(nm) : null;
        if (lp) { best = lp; break; }
      }
      if (!best) {
        for (const lp of byName.values()) {
          if (!best) { best = lp; continue; }
          // Prefer a dated record, and among dated ones the most recent.
          if (lp.date && (!best.date || lp.date > best.date)) best = lp;
        }
      }
      if (best) renderThisVehicleBanner(best);
    }
  } catch (err) {
    // Non-blocking enrichment — swallow errors.
  }
}

/**
 * Render a single "This vehicle" summary row at the top of the results list.
 * Used when the searched service has prior history on THIS vehicle but no
 * same-VIN donor card surfaced — so the VIN-match fact is shown once, clearly,
 * instead of being (mis)stamped onto other-vehicle reference cards.
 */
function renderThisVehicleBanner(lp) {
  if (!elements.lookupResults || !lp) return;
  // Clear any prior banner so a re-run never stacks duplicates.
  const existing = elements.lookupResults.querySelector('.this-vehicle-banner');
  if (existing) existing.remove();

  const date = lp.displayDate ? ` ${lp.displayDate}` : '';
  const miles = lp.miles != null
    ? ` \u00b7 ${lp.milesEstimated ? '~' : ''}${lp.miles.toLocaleString()} mi`
    : '';
  const sourceColor = lp.source === 'carfax' ? '#c2410c' : '#15803d';

  const div = document.createElement('div');
  div.className = 'this-vehicle-banner';
  div.title = lp.summary || '';
  div.style.cssText = 'display:flex;align-items:center;gap:7px;font-size:12px;color:#065f46;background:#ecfdf5;border:1px solid #a7f3d0;border-radius:8px;padding:8px 10px;margin-bottom:8px;';
  div.innerHTML = `<span style="font-size:14px;">\u{1F697}</span><span><strong>This vehicle</strong> \u2014 last performed${escapeHtml(date)}${escapeHtml(miles)} \u00b7 <span style="color:${sourceColor};font-weight:600;">${escapeHtml(lp.sourceLabel || '')}</span></span>`;

  elements.lookupResults.insertBefore(div, elements.lookupResults.firstChild);
}

function injectLastPerformedBadge(li, lp) {
  const anchor = li.querySelector('.job-last-performed');
  if (!anchor) return;
  // Defensive: clear any prior badge in this row before re-injecting.
  anchor.innerHTML = '';

  const date = lp.displayDate ? ` ${lp.displayDate}` : '';
  const miles = lp.miles != null
    ? ` \u00b7 ${lp.milesEstimated ? '~' : ''}${lp.miles.toLocaleString()} mi`
    : '';
  const sourceColor = lp.source === 'carfax' ? '#c2410c' : '#15803d';

  anchor.title = lp.summary || '';
  anchor.style.cssText = 'display:inline-flex;align-items:center;gap:5px;font-size:11px;color:#374151;background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:3px 7px;margin-top:4px;';
  anchor.innerHTML = `<span>\u{1F552}</span><span><strong>Last performed</strong>${escapeHtml(date)}${escapeHtml(miles)} \u00b7 <span style="color:${sourceColor};font-weight:500;">${escapeHtml(lp.sourceLabel || '')}</span></span>`;
}

function renderJobResults(jobs, meta) {
  elements.lookupLoading.classList.add('hidden');
  
  if (jobs.length === 0) {
    elements.lookupEmpty.classList.remove('hidden');
    elements.lookupEmpty.querySelector('p').textContent = 'No matching jobs found.';
    return;
  }
  
  // Clear previous data and build new list with Map storage
  lookupJobsDataMap.clear();
  elements.lookupResults.classList.remove('hidden');

  // When the API couldn't decode the target VIN through DataOne, ACES tier
  // matches (Exact Fit ACES / Same engine / Same submodel) cannot fire — so
  // every score on this page is from the legacy heuristic scorer. Surface
  // that visibly so an advisor doesn't think "Exact Fit 94%" is the same
  // confidence level as "Exact Fit (ACES) 100%".
  let banner = '';
  if (meta && meta.dataOneEnhanced === false) {
    banner = '<div style="background:#fef3c7;border:1px solid #fcd34d;color:#78350f;padding:8px 10px;border-radius:6px;font-size:12px;margin-bottom:8px;">' +
      '<strong>ACES match unavailable</strong> — vehicle VIN didn\'t decode through DataOne, so scores below are from the heuristic scorer only.' +
      '</div>';
  }

  elements.lookupResults.innerHTML = banner + jobs.map((job, index) => {
    const jobId = `lookup-${index}`;
    lookupJobsDataMap.set(jobId, job);
    return createJobItemHTML(job, jobId);
  }).join('');
  
  // Add toggle and action handlers
  setupJobItemHandlers();
}

function getBandStyle(band) {
  switch (band) {
    case 'exact': return 'badge-exact';
    case 'likely': return 'badge-likely';
    case 'possible': return 'badge-possible';
    default: return 'badge-poor';
  }
}

function getAcesTierBadge(tier) {
  switch (tier) {
    case 'exact_aces':
      return {
        label: 'Exact Fit',
        tooltip: 'Exact ACES match \u2014 same year, make, model, submodel, and engine as the target vehicle.',
        className: 'aces-exact',
      };
    case 'engine_match':
      return {
        label: 'Same engine',
        tooltip: 'Same engine in a different chassis \u2014 strong match for engine, oil, cooling, fuel, and exhaust work.',
        className: 'aces-engine',
      };
    case 'submodel_match':
      return {
        label: 'Same chassis',
        tooltip: 'Same chassis with a different engine option \u2014 strong match for body, brakes, suspension, steering, and wheel/tire work.',
        className: 'aces-submodel',
      };
    default:
      return null;
  }
}

function createJobItemHTML(job, lookupId) {
  const vehicle = job.vehicle ? 
    `${job.vehicle.year || ''} ${job.vehicle.make || ''} ${job.vehicle.model || ''}`.trim() : '';
  const engine = job.vehicle?.engine ? ` | ${job.vehicle.engine}` : '';
  
  const totalAmount = job.totals?.totalAmount || 0;
  const laborHours = job.laborItems?.reduce((sum, l) => sum + (l.hours || 0), 0) || 0;
  const partsCount = job.parts?.length || 0;
  const lineCount = (job.laborItems?.length || 0) + partsCount;
  
  const matchBand = job.matchBand || 'poor';
  const matchLabel = job.matchBandLabel || `${job.matchScore || 0}%`;
  const matchScore = job.matchScore || 0;
  const matchReason = job.matchReason || '';
  const acesBadge = getAcesTierBadge(job.acesTier);
  const acesBadgeHtml = acesBadge
    ? `<span class="match-badge aces-badge ${acesBadge.className}" title="${escapeHtml(acesBadge.tooltip)}">${escapeHtml(acesBadge.label)}</span>`
    : '';

  // Same-VIN donors (jobs performed on this exact vehicle) get a prominent
  // "VIN Match" pill and are always sorted to the top by the server. Rendered
  // first so it reads as the most trustworthy match in the row.
  const vinBadgeHtml = job.sameVin
    ? `<span class="match-badge vin-match-badge" title="This job was performed on this exact vehicle (same VIN) — the most reliable match.">VIN Match</span>`
    : '';

  return `
    <li class="job-item" data-job-id="${job._id}" data-lookup-id="${lookupId}">
      <div class="job-header">
        <div class="job-header-left">
          <div class="job-title-row">
            <span class="job-title">${escapeHtml(job.title || job.name)}</span>
            ${vinBadgeHtml}
            ${(job.sameVin || job.acesTier === 'exact_aces') ? '' : `<span class="match-badge ${getBandStyle(matchBand)}">${matchLabel}</span>`}
            ${acesBadgeHtml}
            <span class="match-score">${matchScore}%</span>
          </div>
          <div class="job-last-performed" data-lookup-id="${lookupId}"></div>
          <div class="job-vehicle">${vehicle}${engine}</div>
          ${job.location ? `<div class="job-location">📍 ${escapeHtml(job.location)}</div>` : ''}
          ${matchReason ? `<div class="job-match-reason">${escapeHtml(matchReason)}</div>` : ''}
        </div>
        <div class="job-header-right">
          <div class="job-price">$${totalAmount.toFixed(2)}</div>
          <div class="job-lines">${lineCount} line${lineCount !== 1 ? 's' : ''}</div>
        </div>
      </div>
      <div class="job-details hidden">
        <div class="job-summary-row">
          <div class="summary-item"><span class="summary-label">Labor:</span> ${laborHours.toFixed(1)}h</div>
          <div class="summary-item"><span class="summary-label">Parts:</span> ${partsCount}</div>
          <div class="summary-item"><span class="summary-label">Total:</span> $${totalAmount.toFixed(2)}</div>
        </div>
        ${job.laborItems?.length ? `
          <div class="job-section">
            <div class="job-section-title">Labor</div>
            ${job.laborItems.map(item => `
              <div class="line-item">
                <span class="line-type labor">labor</span>
                <span class="line-desc">${escapeHtml(item.name || item.description)}</span>
                <span class="line-qty">${item.hours}h</span>
              </div>
            `).join('')}
          </div>
        ` : ''}
        ${job.parts?.length ? `
          <div class="job-section">
            <div class="job-section-title">Parts</div>
            ${job.parts.map(part => `
              <div class="line-item">
                <span class="line-type part">part</span>
                <span class="line-desc">${escapeHtml(part.name || part.description)}</span>
                ${part.partNumber ? `<span class="line-pn">${part.partNumber}</span>` : ''}
                <span class="line-qty">x${part.quantity}</span>
                <span class="line-price">$${(part.retail || 0).toFixed(2)}</span>
              </div>
            `).join('')}
          </div>
        ` : ''}
        <div class="job-footer">
          <div class="job-meta">WO #${job.workOrderNumber || 'N/A'}</div>
          <button class="btn-add btn-add-job" data-lookup-id="${lookupId}">
            + Add to RO
          </button>
        </div>
      </div>
    </li>
  `;
}

function setupJobItemHandlers() {
  document.querySelectorAll('.job-header').forEach(header => {
    header.addEventListener('click', () => {
      const details = header.nextElementSibling;
      details.classList.toggle('hidden');
    });
  });
  
  document.querySelectorAll('.btn-add-job').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const lookupId = btn.dataset.lookupId;
      const job = lookupJobsDataMap.get(lookupId);
      if (job) {
        handleAddJob(job);
      } else {
        console.error('[MOS] Lookup job not found:', lookupId);
      }
    });
  });
}

// Store loaded canned jobs for filtering
let allCannedJobs = [];

// ==================== CANNED JOBS ====================
async function loadCannedJobs() {
  if (!currentContext || !currentContext.roId) {
    elements.cannedLoading.classList.add('hidden');
    elements.cannedEmpty.classList.remove('hidden');
    elements.cannedEmpty.querySelector('p').textContent = 'Navigate to a repair order to view canned jobs.';
    elements.cannedList.classList.add('hidden');
    return;
  }
  
  elements.cannedLoading.classList.remove('hidden');
  elements.cannedEmpty.classList.add('hidden');
  elements.cannedList.classList.add('hidden');
  elements.cannedSearch.value = '';
  
  try {
    const cannedProvider = currentContext.writeProvider || resolvedWriteProvider || currentContext.provider || '';
    const cannedShopId = (cannedProvider === 'protractor' && currentContext.mosShopId) 
      ? currentContext.mosShopId 
      : currentContext.shopId;
    const result = await sendMessage({
      action: 'MOS_API_REQUEST',
      endpoint: `/api/extension/canned-jobs?shopId=${cannedShopId}&provider=${cannedProvider}`
    });
    
    // Handle error responses from MOS API
    if (result.error || result.success === false) {
      throw new Error(result.error || 'Failed to load canned jobs');
    }
    
    allCannedJobs = result.jobs || [];
    
    renderCannedJobs(allCannedJobs);
  } catch (err) {
    console.error('[MOS] Error loading canned jobs:', err);
    elements.cannedLoading.classList.add('hidden');
    elements.cannedEmpty.classList.remove('hidden');
    elements.cannedEmpty.querySelector('p').textContent = err.message;
  }
}

function renderCannedJobs(jobs) {
  elements.cannedLoading.classList.add('hidden');
  
  if (jobs.length === 0) {
    elements.cannedEmpty.classList.remove('hidden');
    return;
  }
  
  // Clear previous data and build new list with Map storage
  cannedJobsDataMap.clear();
  elements.cannedList.classList.remove('hidden');
  elements.cannedList.innerHTML = jobs.map((job, index) => {
    const cannedId = `canned-${index}`;
    cannedJobsDataMap.set(cannedId, job);
    return `
      <li class="job-item">
        <div class="job-header" style="cursor: default;">
          <div>
            <div class="job-title">${escapeHtml(job.name)}</div>
            ${job.description ? `<div class="job-meta">${escapeHtml(job.description)}</div>` : ''}
          </div>
          <button class="btn-add btn-add-canned" data-canned-id="${cannedId}">+ Add</button>
        </div>
      </li>
    `;
  }).join('');
  
  // Add click handlers using Map lookup
  document.querySelectorAll('.btn-add-canned').forEach(btn => {
    btn.addEventListener('click', () => {
      const cannedId = btn.dataset.cannedId;
      const job = cannedJobsDataMap.get(cannedId);
      if (job) {
        handleAddCannedJob(job);
      } else {
        console.error('[MOS] Canned job not found:', cannedId);
      }
    });
  });
}

function filterCannedJobs(searchTerm) {
  const term = searchTerm.toLowerCase().trim();
  
  if (!term) {
    renderCannedJobs(allCannedJobs);
    return;
  }
  
  const searchWords = term.split(/\s+/).filter(w => w.length > 1);
  
  const filtered = allCannedJobs.filter(job => {
    const name = (job.name || '').toLowerCase();
    const description = (job.description || '').toLowerCase();
    const combined = name + ' ' + description;
    if (name.includes(term) || description.includes(term)) return true;
    return searchWords.length > 0 && searchWords.every(word => combined.includes(word));
  });
  
  if (filtered.length === 0) {
    elements.cannedList.classList.add('hidden');
    elements.cannedEmpty.classList.remove('hidden');
    elements.cannedEmpty.querySelector('p').textContent = `No canned jobs matching "${searchTerm}".`;
  } else {
    elements.cannedEmpty.classList.add('hidden');
    renderCannedJobs(filtered);
  }
}

// ==================== JOB ACTIONS ====================
async function handleAddService(service) {
  // Check if we have full job details from matching canned job
  const hasFullDetails = service.laborItems && service.laborItems.length > 0;
  
  // Convert service recommendation to a job and add
  const jobData = {
    name: service.name,
    laborItems: hasFullDetails 
      ? service.laborItems 
      : [{ name: service.name, hours: service.laborHours || 1 }],
    parts: service.parts || []
  };
  
  await handleAddJob(jobData);
}

async function handleSwAddFinding(service, isDraft = false) {
  if (!currentContext || !currentContext.roId) {
    showNotification('No repair order context. Navigate to a work order first.', 'error');
    return;
  }

  const serviceName = service.service || service.name || service.title || service.repair || service.jobTitle || 'Unknown Service';
  const findingText = serviceName;

  try {
    const result = await sendMessage({
      action: 'SW_ADD_FINDING',
      text: findingText,
      serviceName: serviceName,
      workOrderId: currentContext.roId,
      isDraft,
      vehicle: currentContext.vehicle || null
    });
    if (result.success) {
      const status = isDraft ? 'Draft' : 'Published';
      const name = result.jobName || serviceName;
      showNotification(`Finding added (${status}): ${name}`, 'success');
    } else {
      throw new Error(result.error || 'Failed to add finding');
    }
  } catch (err) {
    console.error('[MOS] Error adding Shop-Ware finding:', err);
    showNotification(err.message, 'error');
  }
}

// Returns true when the job was added, false on failure — callers that show
// per-job button states (Send to RO, companion "+ Add", Add all) rely on this
// because errors are handled in here (notification) rather than thrown.
// Task #888 — `source` marks where the job came from ('canned' makes the
// server keep the template's own labor rate instead of the RO/cached rate).
async function handleAddJob(job, source) {
  if (!currentContext) {
    alert('No repair order context. Please navigate to a repair order.');
    return false;
  }
  // Snapshot before the slow add request — see markServiceOnEstimate.
  const reqPlanCacheKey = planCacheKey(currentContext);

  if (currentContext.provider === 'shopware') {
    const serviceName = job.title || job.name;
    try {
      const result = await sendMessage({
        action: 'SW_ADD_SERVICE',
        serviceName,
        workOrderId: currentContext.roId,
        vehicle: currentContext.vehicle || null
      }, undefined, 'Still adding this job — big shops can take a minute. Please keep this panel open…');
      if (result.success) {
        showNotification(`Added: ${result.jobName || serviceName}`, 'success');
        markServiceOnEstimate(result.jobName || serviceName, reqPlanCacheKey);
        return true;
      } else {
        throw new Error(result.error || 'Failed to add service');
      }
    } catch (err) {
      console.error('[MOS] Error adding Shop-Ware service:', err);
      showNotification(err.message, 'error');
      return false;
    }
  }

  const effectiveWriteProvider = currentContext.writeProvider || resolvedWriteProvider || null;

  if (effectiveWriteProvider === 'protractor' || currentContext.provider === 'protractor') {
    const jobData = {
      title: job.title || job.name,
      description: job.note || job.description || '',
      laborItems: (job.laborItems || job.lines?.filter(l => l.lineType === 'labor') || []).map(item => {
        // Task #888 — pass the job's own labor rate through so a canned
        // template's saved rate can win server-side.
        const rate = Number(item.rate) > 0 ? Number(item.rate)
          : Number(item.unitPrice) > 0 ? Number(item.unitPrice)
          : 0;
        return {
          name: item.name || item.description,
          hours: item.hours || item.quantity || 1,
          ...(rate > 0 ? { rate } : {})
        };
      }),
      parts: (job.parts || job.lines?.filter(l => l.lineType === 'part') || []).map(part => {
        // Task #681 — send the REAL part cost as `unitCost`, separate from the
        // legacy `cost` field (which falls back to retail below and must never
        // be written as Protractor's Cost — that would report 0% parts GP).
        // Real cost exists on: (a) an explicit `unitCost`, or (b) a history
        // line (`lineType === 'part'`) whose `cost` was captured server-side
        // from Protractor's flat Cost field. KB/AI parts have no real cost.
        const realUnitCost =
          (Number(part.unitCost) > 0 && Number(part.unitCost)) ||
          (part.lineType === 'part' && Number(part.cost) > 0 && Number(part.cost)) ||
          0;
        return {
          name: part.name || part.description,
          partNumber: part.partNumber || '',
          brand: part.brand || part.manufacturer || '',
          quantity: part.quantity || 1,
          cost: part.cost || part.unitPrice || 0,
          retail: part.retail || part.price || part.extendedPrice || 0,
          ...(realUnitCost > 0 ? { unitCost: realUnitCost } : {})
        };
      })
    };

    const mosShopId = currentContext.mosShopId || resolvedMosShopId || currentContext.shopId;

    try {
      const result = await sendMessage({
        action: 'MOS_API_REQUEST',
        endpoint: `/api/extension/jobs/add-to-ro`,
        options: {
          method: 'POST',
          // Task #661 (follows #657): like the canned add-to-RO paths,
          // this Protractor custom-job add runs several slow upstream
          // calls server-side (open-WO search, vehicle-by-VIN, fetch
          // WOs, then write), so a valid session can straddle a
          // transient MOS-auth blip and surface a false "session may
          // have expired" prompt mid-shift. Widen the 401 retry budget
          // to ride that blip out. Safe because a 401 is rejected at
          // auth time, before any write — and a sustained TOKEN_INVALID
          // still clears the token once the budget is exhausted.
          authRetryDelaysMs: [500, 1500, 4000, 8000, 12000],
          body: JSON.stringify({
            shopId: Number(mosShopId),
            roNumber: currentContext.roId ? String(currentContext.roId) : undefined,
            vin: currentContext.vehicle?.vin || undefined,
            // Prefer the GUID captured when this RO was just created in
            // Protractor — its OData number-search returns nothing for open WOs
            // and the VIN->cache fallback lags right after creation.
            workOrderGuid: getRecentlyCreatedWoGuid(currentContext.vehicle?.vin, currentContext.roId),
            // Task #888 — 'canned' keeps the template's saved labor rate.
            source: source || undefined,
            job: jobData
          })
        }
        // The widened 401 retry schedule above adds up to ~26s of delays on
        // top of the background's 45s fetch cap, so the panel must wait
        // longer than the 60s default or a retried-but-successful add shows a
        // false timeout while the background still completes it.
      }, 90000, 'Still adding this job — big shops can take a minute. Please keep this panel open…');

      if (result.success) {
        showNotification(`Added: ${result.jobName || jobData.title}`, 'success');
        markServiceOnEstimate(result.jobName || jobData.title, reqPlanCacheKey);
        // Task #1094: snapshot for undo (server returns the created package id).
        if (result.servicePackageId && result.workOrderId) {
          recordSidepanelAdd('protractor', mosShopId, currentContext.roId, [{
            name: result.jobName || jobData.title,
            servicePackageId: result.servicePackageId,
            workOrderId: result.workOrderId,
          }]);
        }
        return true;
      } else {
        throw new Error(result.error || 'Failed to add job to Protractor');
      }
    } catch (err) {
      console.error('[MOS] Error adding Protractor job:', err);
      showNotification(err.message, 'error');
      return false;
    }
  }

  const jobData = {
    name: job.title || job.name,
    laborItems: (job.laborItems || job.lines?.filter(l => l.lineType === 'labor') || []).map(item => ({
      name: item.name || item.description,
      hours: item.hours || item.quantity || 1
    })),
    parts: (job.parts || job.lines?.filter(l => l.lineType === 'part') || []).map(part => {
      // Task #809 — same rule as the Protractor path above: only a real cost
      // is sent as `unitCost` (an explicit `unitCost` — set server-side on
      // search results — or a history line's captured `cost`). The legacy
      // `cost` field below can carry retail as a fallback and is never used
      // as a cost source by the background.
      const realUnitCost =
        (Number(part.unitCost) > 0 && Number(part.unitCost)) ||
        (part.lineType === 'part' && Number(part.cost) > 0 && Number(part.cost)) ||
        0;
      return {
        name: part.name || part.description,
        partNumber: part.partNumber || '',
        brand: part.brand || part.manufacturer || '',
        quantity: part.quantity || 1,
        cost: part.cost || part.unitPrice || 0,
        retail: part.retail || part.price || part.extendedPrice || 0,
        ...(realUnitCost > 0 ? { unitCost: realUnitCost } : {})
      };
    }),
    note: job.note || job.description || ''
  };
  
  try {
    const result = await sendMessage({
      action: 'CREATE_TEKMETRIC_JOB',
      shopId: currentContext.shopId,
      roId: currentContext.roId,
      jobData
    }, undefined, 'Still adding this job — big shops can take a minute. Please keep this panel open…');
    
    if (result.success) {
      showNotification(`Added: ${result.jobName}`, 'success');
      markServiceOnEstimate(result.jobName || jobData.name, reqPlanCacheKey);
      // Task #1094: the background snapshotted the created job id inside
      // CREATE_TEKMETRIC_JOB — just repaint the undo bar.
      refreshUndoBar();
      return true;
    } else {
      throw new Error(result.error || 'Failed to add job');
    }
  } catch (err) {
    console.error('[MOS] Error adding job:', err);
    showNotification(err.message, 'error');
    return false;
  }
}

// Notify the SMS page tab(s) that a job was added so they refresh and the
// mechanic sees the new job without a manual reload. Replaces the old silent
// `.catch(() => {})` fire-and-forget: we now log a diagnostic when no matching
// tab is open or when every delivery fails, so a missing auto-refresh is
// visible in the console instead of being swallowed.
function notifyPageJobCreated(urlPatterns, jobName, providerLabel) {
  try {
    chrome.tabs.query({ url: urlPatterns }, (tabs) => {
      if (chrome.runtime.lastError) {
        console.warn(`[MOS] JOB_CREATED tab query failed (${providerLabel}):`, chrome.runtime.lastError.message);
        return;
      }
      if (!tabs || tabs.length === 0) {
        console.warn(`[MOS] JOB_CREATED: no open ${providerLabel} tab found to refresh after adding "${jobName}". Mechanic may need to reload manually.`);
        return;
      }
      let pending = tabs.length;
      let delivered = 0;
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, { action: 'JOB_CREATED', jobName })
          .then(() => { delivered++; })
          .catch((err) => {
            console.warn(`[MOS] JOB_CREATED message to ${providerLabel} tab ${tab.id} failed:`, err?.message || err);
          })
          .finally(() => {
            pending--;
            if (pending === 0) {
              if (delivered === 0) {
                console.warn(`[MOS] JOB_CREATED: found ${tabs.length} ${providerLabel} tab(s) but none acknowledged the refresh for "${jobName}".`);
              } else {
                console.log(`[MOS] JOB_CREATED delivered to ${delivered}/${tabs.length} ${providerLabel} tab(s) for "${jobName}".`);
              }
            }
          });
      }
    });
  } catch (err) {
    console.warn(`[MOS] JOB_CREATED notify (${providerLabel}) threw:`, err?.message || err);
  }
}

async function handleAddCannedJob(job) {
  console.log('[MOS] handleAddCannedJob called:', job);
  
  if (!currentContext) {
    alert('No repair order context. Please navigate to a repair order.');
    return;
  }
  // Snapshot before the slow add request — see markServiceOnEstimate.
  const reqPlanCacheKey = planCacheKey(currentContext);

  if (currentContext.provider === 'shopware') {
    const serviceName = job.name || job.title;
    try {
      const result = await sendMessage({
        action: 'SW_ADD_SERVICE',
        serviceName,
        workOrderId: currentContext.roId,
        vehicle: currentContext.vehicle || null
      }, undefined, 'Still adding this job — big shops can take a minute. Please keep this panel open…');
      if (result.success) {
        showNotification(`Added: ${result.jobName || serviceName}`, 'success');
        markServiceOnEstimate(result.jobName || serviceName, reqPlanCacheKey);
      } else {
        throw new Error(result.error || 'Failed to add service');
      }
    } catch (err) {
      console.error('[MOS] Error adding Shop-Ware canned job:', err);
      showNotification(err.message, 'error');
    }
    return;
  }

  const effectiveWriteProvider = currentContext.writeProvider || resolvedWriteProvider || null;

  if (effectiveWriteProvider === 'protractor' || currentContext.provider === 'protractor') {
    const cannedJobId = job.tekmetricId || job.id || job.code;
    const cannedJobTitle = job.name || job.title;
    const mosShopId = currentContext.mosShopId || resolvedMosShopId || currentContext.shopId;

    console.log('[MOS] Adding canned job via Protractor:', { cannedJobId, cannedJobTitle, mosShopId, roId: currentContext.roId });

    if (cannedJobId && (job.source === 'protractor' || job.source === 'tekmetric')) {
      try {
        const result = await sendMessage({
          action: 'MOS_API_REQUEST',
          endpoint: `/api/extension/jobs/apply-canned`,
          options: {
            method: 'POST',
            // Task #657: this endpoint runs several slow upstream calls
            // server-side, so it's far more likely to straddle a
            // transient MOS-auth blip than the quick lookup-tab calls.
            // Widen the 401 retry budget so a valid session isn't
            // surfaced as a false "session may have expired" prompt. A
            // 401 is rejected at auth time (before any write), so the
            // extra retries are safe.
            authRetryDelaysMs: [500, 1500, 4000, 8000, 12000],
            body: JSON.stringify({
              shopId: Number(mosShopId),
              roNumber: currentContext.roId ? String(currentContext.roId) : undefined,
              vin: currentContext.vehicle?.vin || undefined,
              cannedJobId: String(cannedJobId),
              cannedJobTitle
            })
          }
          // The widened 401 retry schedule above adds up to ~26s of delays on
          // top of the background's 45s fetch cap, so the panel must wait
          // longer than 60s or a retried-but-successful add shows a false
          // timeout while the background still completes it.
        }, 90000, 'Still adding this job — big shops can take a minute. Please keep this panel open…');

        if (result.success) {
          showNotification(`Added: ${result.jobName || cannedJobTitle}`, 'success');
          markServiceOnEstimate(result.jobName || cannedJobTitle, reqPlanCacheKey);

          // Task #1094: snapshot for undo (server returns the applied package id).
          if (result.servicePackageId && result.workOrderId) {
            recordSidepanelAdd('protractor', mosShopId, currentContext.roId, [{
              name: result.jobName || cannedJobTitle,
              servicePackageId: result.servicePackageId,
              workOrderId: result.workOrderId,
            }]);
          }

          // Refresh the Protractor shop's page so the new job appears without a
          // manual reload — mirrors the Tekmetric JOB_CREATED path. These shops
          // are viewed through AutoFlow/autotext (and occasionally protractor.com),
          // so target all three; missing-tab cases are logged, not swallowed.
          notifyPageJobCreated(
            ["*://*.autoflow.com/*", "*://*.autotext.me/*", "*://*.protractor.com/*"],
            result.jobName || cannedJobTitle,
            'Protractor'
          );
        } else {
          throw new Error(result.error || 'Failed to add canned job');
        }
      } catch (err) {
        console.error('[MOS] Error adding Protractor canned job:', err);
        showNotification(err.message || 'Failed to add canned job', 'error');
      }
    } else {
      console.log('[MOS] Adding as generic Protractor job (no canned job ID)');
      // Task #888 — mark as canned so the template's labor rate is kept.
      await handleAddJob(job, 'canned');
    }
    return;
  }

  const tekmetricId = job.tekmetricId || job.id;
  
  console.log('[MOS] Adding canned job:', { name: job.name, tekmetricId, source: job.source, roId: currentContext.roId });
  
  if (job.source === 'tekmetric' && tekmetricId) {
    try {
      const result = await sendMessage({
        action: 'MOS_API_REQUEST',
        endpoint: `/api/tekmetric/apply-canned-job?shopId=${currentContext.shopId}&provider=tekmetric`,
        options: {
          method: 'POST',
          // Task #657: this endpoint runs slow upstream calls server-side
          // (open-RO search, vehicle-by-VIN, fetch WOs, then apply), so
          // it's far more likely to straddle a transient MOS-auth blip
          // than the Job Lookup tab — which for Tekmetric bypasses MOS
          // auth entirely. Widen the 401 retry budget so a valid session
          // isn't surfaced as a false "session may have expired" prompt.
          // A 401 is rejected at auth time (before any write), so the
          // extra retries are safe.
          authRetryDelaysMs: [500, 1500, 4000, 8000, 12000],
          body: JSON.stringify({ 
            repairOrderId: currentContext.roId,
            cannedJobId: String(tekmetricId),
            cannedJobTitle: job.name
          })
        }
        // The widened 401 retry schedule above adds up to ~26s of delays on
        // top of the background's 45s fetch cap, so the panel must wait
        // longer than 60s or a retried-but-successful add shows a false
        // timeout while the background still completes it.
      }, 90000, 'Still adding this job — big shops can take a minute. Please keep this panel open…');
      
      console.log('[MOS] Tekmetric canned job add result:', result);
      
      if (result.error) {
        throw new Error(result.error);
      }
      
      showNotification(`Added: ${job.name}`, 'success');
      markServiceOnEstimate(job.name, reqPlanCacheKey);

      // Task #1094: this path writes via the server's official Tekmetric API,
      // so pull the created job id(s) out of its response (best-effort — the
      // envelope nests them under result/data depending on the API version).
      const createdIds = extractTekmetricCreatedJobIds(result);
      if (createdIds.length > 0) {
        recordSidepanelAdd('tekmetric', currentContext.shopId, result.repairOrderId || currentContext.roId,
          createdIds.map(id => ({ jobId: id, name: job.name })));
      }

      notifyPageJobCreated(["*://*.tekmetric.com/*"], job.name, 'Tekmetric');
    } catch (err) {
      console.error('[MOS] Error adding canned job:', err);
      showNotification(err.message || 'Failed to add canned job', 'error');
    }
  } else {
    console.log('[MOS] Adding as generic job (no tekmetricId)');
    // Task #888 — mark as canned so the template's labor rate is kept.
    await handleAddJob(job, 'canned');
  }
}

// ==================== LABOR RATES ====================
let currentLaborRateRules = [];

async function loadLaborRates() {
  elements.ratesLoading.classList.remove('hidden');
  elements.ratesMain.classList.add('hidden');
  elements.ratesError.classList.add('hidden');

  try {
    const autoApplyResult = await sendMessage({ action: 'GET_LABOR_RATE_AUTO_APPLY' });
    elements.ratesAutoApplyToggle.checked = !!autoApplyResult.enabled;

    const result = await sendMessage({ action: 'GET_LABOR_RATE_RULES' });
    elements.ratesLoading.classList.add('hidden');

    if (result.success) {
      currentLaborRateRules = result.rules || [];
      renderLaborRateRules();
      elements.ratesMain.classList.remove('hidden');
    } else {
      elements.ratesError.textContent = result.error || 'Failed to load rules';
      elements.ratesError.classList.remove('hidden');
      elements.ratesMain.classList.remove('hidden');
    }
  } catch (err) {
    console.error('[MOS] Error loading labor rates:', err);
    elements.ratesLoading.classList.add('hidden');
    elements.ratesError.textContent = err.message || 'Failed to load labor rate groups';
    elements.ratesError.classList.remove('hidden');
    elements.ratesMain.classList.remove('hidden');
  }
}

function renderLaborRateRules() {
  const sorted = [...currentLaborRateRules].sort((a, b) => (b.priority || 0) - (a.priority || 0));
  
  if (sorted.length === 0) {
    elements.ratesList.innerHTML = '';
    elements.ratesEmptyHint.classList.remove('hidden');
    return;
  }
  
  elements.ratesEmptyHint.classList.add('hidden');

  elements.ratesList.innerHTML = sorted.map(rule => {
    const makes = (rule.conditions || [])
      .filter(c => c.type === 'make')
      .flatMap(c => c.values || []);
    const models = (rule.conditions || [])
      .filter(c => c.type === 'model')
      .flatMap(c => c.values || []);
    const categories = (rule.conditions || [])
      .filter(c => c.type === 'jobCategory')
      .flatMap(c => c.values || []);
    const fuelTypes = (rule.conditions || [])
      .filter(c => c.type === 'fuelType')
      .flatMap(c => c.values || []);
    const customerTypes = (rule.conditions || [])
      .filter(c => c.type === 'customerType')
      .flatMap(c => c.values || []);
    const tags = (rule.conditions || [])
      .filter(c => c.type === 'tag')
      .flatMap(c => c.values || []);
    const makesText = makes.length > 0 ? makes.join(', ') : 'All vehicles';
    const modelsText = models.length > 0 ? models.join(', ') : '';
    const categoriesText = categories.length > 0 ? categories.join(', ') : '';
    const fuelText = fuelTypes.length > 0 ? fuelTypes.join(', ') : '';
    const customerTypeText = customerTypes.length > 0 ? customerTypes.join(', ') : '';
    const tagsText = tags.length > 0 ? tags.join(', ') : '';
    const color = rule.color || '#3B82F6';

    return `
      <div class="rate-group-card" data-rule-id="${escapeHtml(rule.id)}">
        <div class="rate-group-color-bar" style="background:${color}"></div>
        <div class="rate-group-body">
          <div class="rate-group-header">
            <span class="rate-group-name">${escapeHtml(rule.name)}</span>
            <span class="rate-group-amount">$${Number(rule.rate).toFixed(2)}/hr</span>
          </div>
          <div class="rate-group-makes">${escapeHtml(makesText)}</div>
          ${modelsText ? `<div class="rate-group-categories"><span class="rate-group-tag">Models:</span> ${escapeHtml(modelsText)}</div>` : ''}
          ${fuelText ? `<div class="rate-group-categories"><span class="rate-group-tag">Fuel:</span> ${escapeHtml(fuelText)}</div>` : ''}
          ${customerTypeText ? `<div class="rate-group-categories"><span class="rate-group-tag">Customer:</span> ${escapeHtml(customerTypeText)}</div>` : ''}
          ${tagsText ? `<div class="rate-group-categories"><span class="rate-group-tag">Tags:</span> ${escapeHtml(tagsText)}</div>` : ''}
          ${categoriesText ? `<div class="rate-group-categories"><span class="rate-group-tag">Jobs:</span> ${escapeHtml(categoriesText)}</div>` : ''}
          ${rule.applyToAllLabor ? `<div class="rate-group-categories"><span class="rate-group-tag" style="color:#10B981;">Applies to all job labor</span></div>` : ''}
          ${rule.priority ? `<div class="rate-group-priority">Priority: ${rule.priority}</div>` : ''}
          <div class="rate-group-actions">
            <button class="rate-group-edit-btn" data-rule-id="${escapeHtml(rule.id)}" title="Edit">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
              </svg>
              Edit
            </button>
            <button class="rate-group-delete-btn" data-rule-id="${escapeHtml(rule.id)}" title="Delete">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
              </svg>
              Delete
            </button>
          </div>
        </div>
      </div>
    `;
  }).join('');

  elements.ratesList.querySelectorAll('.rate-group-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => handleEditRateGroup(btn.dataset.ruleId));
  });
  elements.ratesList.querySelectorAll('.rate-group-delete-btn').forEach(btn => {
    btn.addEventListener('click', () => handleDeleteRateGroup(btn.dataset.ruleId));
  });
}

function showRateForm(editRule = null) {
  elements.ratesForm.classList.remove('hidden');
  elements.ratesAddBtn.classList.add('hidden');

  if (editRule) {
    elements.rateFormName.value = editRule.name || '';
    const makes = (editRule.conditions || [])
      .filter(c => c.type === 'make')
      .flatMap(c => c.values || []);
    const models = (editRule.conditions || [])
      .filter(c => c.type === 'model')
      .flatMap(c => c.values || []);
    const categories = (editRule.conditions || [])
      .filter(c => c.type === 'jobCategory')
      .flatMap(c => c.values || []);
    const fuelTypes = (editRule.conditions || [])
      .filter(c => c.type === 'fuelType')
      .flatMap(c => c.values || []);
    const customerTypes = (editRule.conditions || [])
      .filter(c => c.type === 'customerType')
      .flatMap(c => c.values || []);
    const tags = (editRule.conditions || [])
      .filter(c => c.type === 'tag')
      .flatMap(c => c.values || []);
    elements.rateFormMakes.value = makes.join(', ');
    elements.rateFormModels.value = models.join(', ');
    elements.rateFormFuelType.value = fuelTypes[0] || '';
    elements.rateFormCustomerType.value = customerTypes[0] || '';
    elements.rateFormTags.value = tags.join(', ');
    elements.rateFormCategories.value = categories.join(', ');
    elements.rateFormRate.value = editRule.rate || '';
    elements.rateFormPriority.value = editRule.priority || 0;
    elements.rateFormEditId.value = editRule.id;
    elements.rateFormSaveText.textContent = 'Update Group';
    elements.rateFormApplyAllLabor.checked = !!editRule.applyToAllLabor;
    elements.rateFormOverrideCategoryRates.checked = !!editRule.overrideCategoryRates;
    console.log('[LaborRate] Loading rule into form — overrideCategoryRates:', editRule.overrideCategoryRates, 'applyToAllLabor:', editRule.applyToAllLabor, 'raw rule:', JSON.stringify(editRule));

    const isRoLevel = categories.length === 0;
    elements.rateFormApplyAllWrap.style.display = isRoLevel ? '' : 'none';
    elements.rateFormOverrideCatWrap.style.display = isRoLevel ? '' : 'none';

    const color = editRule.color || '#3B82F6';
    document.querySelectorAll('.rate-color-swatch').forEach(s => {
      s.classList.toggle('active', s.dataset.color === color);
    });
  } else {
    elements.rateFormName.value = '';
    elements.rateFormMakes.value = '';
    elements.rateFormModels.value = '';
    elements.rateFormFuelType.value = '';
    elements.rateFormCustomerType.value = '';
    elements.rateFormTags.value = '';
    elements.rateFormCategories.value = '';
    elements.rateFormRate.value = '';
    elements.rateFormPriority.value = '0';
    elements.rateFormEditId.value = '';
    elements.rateFormSaveText.textContent = 'Add Group';
    elements.rateFormApplyAllLabor.checked = false;
    elements.rateFormOverrideCategoryRates.checked = false;
    elements.rateFormApplyAllWrap.style.display = '';
    elements.rateFormOverrideCatWrap.style.display = '';
    document.querySelectorAll('.rate-color-swatch').forEach(s => s.classList.remove('active'));
    document.querySelector('.rate-color-swatch')?.classList.add('active');
  }

  updateApplyAllVisibility();
  elements.rateFormCategories.removeEventListener('input', updateApplyAllVisibility);
  elements.rateFormCategories.addEventListener('input', updateApplyAllVisibility);
  elements.rateFormName.focus();
}

function updateApplyAllVisibility() {
  const hasCategories = elements.rateFormCategories.value.trim().length > 0;
  elements.rateFormApplyAllWrap.style.display = hasCategories ? 'none' : '';
  elements.rateFormOverrideCatWrap.style.display = hasCategories ? 'none' : '';
}

function hideRateForm() {
  elements.ratesForm.classList.add('hidden');
  elements.ratesAddBtn.classList.remove('hidden');
  elements.rateFormEditId.value = '';
}

async function handleSaveRateGroup() {
  const name = elements.rateFormName.value.trim();
  const makesRaw = elements.rateFormMakes.value.trim();
  const categoriesRaw = elements.rateFormCategories.value.trim();
  const rate = parseFloat(elements.rateFormRate.value) || 0;
  const priority = parseInt(elements.rateFormPriority.value) || 0;
  const editId = elements.rateFormEditId.value;
  const activeColor = document.querySelector('.rate-color-swatch.active');
  const color = activeColor ? activeColor.dataset.color : '#3B82F6';

  if (!name) {
    showNotification('Please enter a group name', 'error');
    elements.rateFormName.focus();
    return;
  }
  if (rate <= 0) {
    showNotification('Please enter a valid labor rate', 'error');
    elements.rateFormRate.focus();
    return;
  }

  const makes = makesRaw ? makesRaw.split(',').map(m => m.trim()).filter(Boolean) : [];
  const modelsRaw = elements.rateFormModels.value.trim();
  const models = modelsRaw ? modelsRaw.split(',').map(m => m.trim()).filter(Boolean) : [];
  const categories = categoriesRaw ? categoriesRaw.split(',').map(c => c.trim()).filter(Boolean) : [];
  const fuelType = elements.rateFormFuelType.value.trim();
  const customerType = elements.rateFormCustomerType.value.trim();
  const tagsRaw = elements.rateFormTags.value.trim();
  const tags = tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : [];
  const conditions = [];
  if (makes.length > 0) {
    conditions.push({ type: 'make', label: 'Vehicle Makes', values: makes });
  }
  if (models.length > 0) {
    conditions.push({ type: 'model', label: 'Vehicle Models', values: models });
  }
  if (fuelType) {
    conditions.push({ type: 'fuelType', label: 'Fuel Type', values: [fuelType] });
  }
  if (customerType) {
    conditions.push({ type: 'customerType', label: 'Customer Type', values: [customerType] });
  }
  if (tags.length > 0) {
    conditions.push({ type: 'tag', label: 'Customer Tags', values: tags });
  }
  if (categories.length > 0) {
    conditions.push({ type: 'jobCategory', label: 'Job Categories', values: categories });
  }

  const applyToAllLabor = categories.length === 0 && elements.rateFormApplyAllLabor.checked;
  const overrideCategoryRates = categories.length === 0 && elements.rateFormOverrideCategoryRates.checked;
  console.log('[LaborRate] Saving rule — applyToAllLabor:', applyToAllLabor, 'overrideCategoryRates:', overrideCategoryRates, 'categories:', categories.length);

  const ruleData = {
    name,
    rate,
    priority,
    conditions,
    matchMode: 'all',
    color,
    applyToAllLabor,
    overrideCategoryRates,
  };

  let updatedRules;
  if (editId) {
    updatedRules = currentLaborRateRules.map(r =>
      r.id === editId ? { ...r, ...ruleData, updatedAt: new Date().toISOString() } : r
    );
  } else {
    ruleData.id = 'temp_' + Date.now();
    ruleData.createdAt = new Date().toISOString();
    updatedRules = [...currentLaborRateRules, ruleData];
  }

  elements.rateFormSave.disabled = true;
  elements.rateFormSaveText.textContent = 'Saving...';

  try {
    const result = await sendMessage({ action: 'SAVE_LABOR_RATE_RULES', rules: updatedRules });
    if (result.success) {
      currentLaborRateRules = updatedRules;
      renderLaborRateRules();
      hideRateForm();
      showNotification(editId ? 'Group updated' : 'Group added', 'success');
    } else {
      showNotification(result.error || 'Failed to save', 'error');
    }
  } catch (err) {
    showNotification(err.message || 'Failed to save labor rate group', 'error');
  } finally {
    elements.rateFormSave.disabled = false;
    elements.rateFormSaveText.textContent = editId ? 'Update Group' : 'Add Group';
  }
}

function handleEditRateGroup(ruleId) {
  const rule = currentLaborRateRules.find(r => r.id === ruleId);
  if (rule) {
    showRateForm(rule);
  }
}

async function handleDeleteRateGroup(ruleId) {
  const rule = currentLaborRateRules.find(r => r.id === ruleId);
  if (!rule) return;

  if (!confirm(`Delete "${rule.name}"? This cannot be undone.`)) return;

  const updatedRules = currentLaborRateRules.filter(r => r.id !== ruleId);

  try {
    const result = await sendMessage({ action: 'SAVE_LABOR_RATE_RULES', rules: updatedRules });
    if (result.success) {
      currentLaborRateRules = result.rules || updatedRules;
      renderLaborRateRules();
      showNotification(`"${rule.name}" deleted`, 'info');
    } else {
      showNotification(result.error || 'Failed to delete', 'error');
    }
  } catch (err) {
    showNotification(err.message || 'Failed to delete group', 'error');
  }
}

async function handleApplyLaborRateNow() {
  if (!currentContext?.roId) {
    showNotification('Navigate to a repair order first', 'error');
    return;
  }

  elements.ratesApplyNowBtn.disabled = true;
  elements.ratesApplyNowBtn.innerHTML = `
    <div class="spinner-tiny"></div>
    Applying...
  `;

  try {
    const result = await sendMessage({ action: 'APPLY_LABOR_RATE_NOW' });
    if (result.success) {
      showNotification(
        `Labor rate updated: "${result.ruleName}" → $${result.rate.toFixed(2)}/hr`,
        'success'
      );
    } else if (result.noMatch) {
      showNotification('No matching rule for this vehicle', 'info');
    } else {
      showNotification(result.error || 'Failed to apply labor rate', 'error');
    }
  } catch (err) {
    showNotification(err.message || 'Failed to apply labor rate', 'error');
  } finally {
    elements.ratesApplyNowBtn.disabled = false;
    elements.ratesApplyNowBtn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
      Apply Now
    `;
  }
}

// ==================== STICKER & KEYTAG ====================
let stickerConfig = null;
let keytagEnabled = false;
// Oil-sticker entitlement as last seen from /api/extension/sticker.
//   true  = enabled, false = definitively disabled, null = unknown/transient.
// Kept separate so a transient sticker-config fetch error never gets
// downgraded into a permanent "not enabled" notice.
let stickerEnabled = null;

const STICKER_OIL_TYPE_ORDER = ['conventional', 'synthetic', 'euro', 'diesel'];
const STICKER_OIL_BUILTIN_LABELS = {
  conventional: 'Conventional',
  synthetic: 'Synthetic',
  euro: 'European',
  diesel: 'Diesel'
};

// Task #439: rebuild the Oil Type <select> from the shop's interval config.
// Hidden buckets are skipped; custom labels override the built-in names.
// "Custom..." is always appended as the last option. If the current
// selection is no longer visible, snap to the shop's defaultOilType (if
// visible) or the first visible bucket.
function populateStickerIntervalOptions(config) {
  const sel = elements.stickerInterval;
  if (!sel) return;

  const intervals = (config && config.intervals) || {};
  // On first load the sidepanel HTML ships with only a placeholder
  // <option value="custom"> (the rest are populated dynamically), so
  // sel.value === 'custom' on the very first call. That's NOT a real user
  // choice — treat it as "no prior selection" so we snap to the shop's
  // default/first visible bucket instead of leaving the dropdown on
  // Custom (which would silently change default print behavior).
  const isFirstPopulation = !sel.dataset.stickerIntervalsPopulated;
  const previousValue = isFirstPopulation ? null : sel.value;

  const visible = STICKER_OIL_TYPE_ORDER.filter(
    (key) => intervals[key]?.hidden !== true
  );

  sel.innerHTML = '';
  visible.forEach((key) => {
    const opt = document.createElement('option');
    opt.value = key;
    const custom = intervals[key]?.label && String(intervals[key].label).trim();
    opt.textContent = custom || STICKER_OIL_BUILTIN_LABELS[key];
    sel.appendChild(opt);
  });
  const customOpt = document.createElement('option');
  customOpt.value = 'custom';
  customOpt.textContent = 'Custom...';
  sel.appendChild(customOpt);
  sel.dataset.stickerIntervalsPopulated = '1';

  let desired = previousValue;
  if (desired === null || (desired !== 'custom' && !visible.includes(desired))) {
    const shopDefault = config?.defaultOilType;
    if (shopDefault && visible.includes(shopDefault)) {
      desired = shopDefault;
    } else if (visible.length > 0) {
      desired = visible[0];
    } else {
      desired = 'custom';
    }
  }
  sel.value = desired;

  // Hide/show the custom-fields panel to match the (possibly snapped) value.
  if (elements.customIntervalFields) {
    elements.customIntervalFields.classList.toggle('hidden', sel.value !== 'custom');
  }
}

// The shared "Printing features are not enabled for your shop" notice covers
// BOTH printing features (oil stickers + keytags). Only show it when we have a
// definitive answer that BOTH are off — never on a transient/unknown sticker
// state, and never while keytags are enabled (the keytag form would be visible
// right above it, which is the contradiction users reported).
function updatePrintDisabledMessage() {
  if (!elements.stickerDisabled) return;
  const keytagsOn = shopFeatures.keytags === true;
  const allPrintingDefinitivelyOff = stickerEnabled === false && !keytagsOn;
  elements.stickerDisabled.classList.toggle('hidden', !allPrintingDefinitivelyOff);
}

async function loadStickerConfig() {
  try {
    // Build endpoint with shop context if available
    let endpoint = '/api/extension/sticker';
    if (currentContext && currentContext.shopId) {
      const provider = currentContext.provider || '';
      endpoint += `?shopId=${currentContext.shopId}&provider=${provider}`;
    }
    
    const result = await sendMessage({
      action: 'MOS_API_REQUEST',
      endpoint
    });
    
    if (result.error) {
      // Transient fetch failure (e.g. backend slowness): do NOT render the
      // permanent "not enabled — contact your administrator" notice, which
      // wrongly implies the shop lost the feature. Keep the last-known-good
      // sticker state and still refresh the (independent) keytag section.
      console.error('[MOS] Sticker config error (transient — keeping last-known state):', result.error);
      loadKeytagSection();
      updatePrintDisabledMessage();
      return;
    }
    
    stickerConfig = result.config;
    stickerEnabled = result.enabled === true;
    
    if (!stickerEnabled) {
      // Oil sticker is genuinely off for this shop. Hide its section; the
      // shared "no printing features" notice is decided centrally so it only
      // appears when keytags are ALSO off.
      if (elements.stickerSection) elements.stickerSection.classList.add('hidden');
      loadKeytagSection();
      updatePrintDisabledMessage();
      return;
    }
    
    // Show sticker section
    if (elements.stickerSection) elements.stickerSection.classList.remove('hidden');
    
    // Set default unit based on config
    if (stickerConfig.useKilometers) {
      elements.stickerUnit.value = 'km';
    }

    // Task #439: populate the Oil Type dropdown from the shop's interval
    // config — skip hidden buckets, prefer the per-shop custom label, and
    // always keep "Custom..." as the last option. Snap selection to the
    // shop's default oil type (or the first visible bucket) if it isn't
    // already a valid visible value.
    populateStickerIntervalOptions(stickerConfig);
    
    // Pre-fill mileage from current context if available
    if (currentContext && currentContext.mileage) {
      elements.stickerMileage.value = currentContext.mileage.toLocaleString();
    }
    
    // Check if keytags feature is enabled and load keytag section (no await needed)
    loadKeytagSection();
    updatePrintDisabledMessage();
    
  } catch (err) {
    console.error('[MOS] Failed to load sticker config:', err);
  }
}

// Status enum drives the Print button lock state.
//   idle: section just opened, no fetch yet
//   loading: fetch in flight
//   ready: webhook/API gave us customerName + vehicleDisplay → safe to print
//   insufficient: API returned but missing required fields → keep locked
//   error: fetch failed → keep locked
let keytagStatus = 'idle';
let keytagInFlightKey = null; // shopId|roId of the currently-in-flight enrichment
let keytagLastEnrichedKey = null; // shopId|roId we last successfully enriched

function makeRoKey(ctx) {
  if (!ctx?.shopId || !ctx?.roId) return null;
  return `${ctx.shopId}|${ctx.roId}`;
}

function recomputeKeytagPrintLock() {
  if (keytagStatus === 'ready') {
    setKeytagPrintLocked(false, '');
  } else if (keytagStatus === 'loading' || keytagStatus === 'idle') {
    setKeytagPrintLocked(true, 'Loading vehicle info…');
  } else if (keytagStatus === 'insufficient') {
    setKeytagPrintLocked(true, 'Vehicle info not yet synced from Tekmetric. Try again in a moment.');
  } else if (keytagStatus === 'error') {
    setKeytagPrintLocked(true, 'Could not load vehicle info. Try refreshing.');
  }
}

async function loadKeytagSection() {
  keytagEnabled = shopFeatures.keytags === true;
  
  if (!keytagEnabled || !elements.keytagSection) {
    if (elements.keytagSection) elements.keytagSection.classList.add('hidden');
    return;
  }
  
  elements.keytagSection.classList.remove('hidden');

  const roKey = makeRoKey(currentContext);

  // If we've already successfully enriched THIS ro, just refresh the form.
  if (roKey && keytagLastEnrichedKey === roKey && keytagStatus === 'ready') {
    updateKeytagFields();
    recomputeKeytagPrintLock();
    return;
  }

  // If a fetch for this same RO is already in flight, just let it finish.
  if (roKey && keytagInFlightKey === roKey) {
    recomputeKeytagPrintLock();
    return;
  }

  // New / different RO context.
  //
  // Instant-fill: the interceptor parses Tekmetric's own /repair-order/{id}
  // API response into a per-RO cache, which flows into currentContext as
  // customerName + vehicleDisplay (RO-scoped — the cache is keyed by roId and
  // the panel's smart-merge only carries fields within the same RO, so this is
  // never a previous customer). When that captured identity is already here,
  // populate the form and UNLOCK Print immediately. The backend ro-context
  // call still runs below to confirm/refine, but it no longer gates the writer
  // behind a round-trip or flashes a "loading" lock on a known-good RO.
  const haveInstantIdentity = !!(
    currentContext &&
    currentContext.customerName &&
    currentContext.vehicleDisplay
  );

  if (haveInstantIdentity) {
    updateKeytagFields();
    keytagStatus = 'ready';
    keytagContextEnriched = true;
    if (roKey) keytagLastEnrichedKey = roKey;
  } else {
    // No reliable captured identity yet — clear the form (DOM scrape is
    // unreliable: Tekmetric sometimes renders literal label text like
    // "Name"/"Vehicle" before React hydrates) and lock Print until the API
    // responds.
    if (elements.keytagCustomer) elements.keytagCustomer.value = '';
    if (elements.keytagVehicle) elements.keytagVehicle.value = '';
    if (elements.keytagRo) elements.keytagRo.value = '';
    if (elements.keytagMileage) elements.keytagMileage.value = '';
    keytagStatus = 'loading';
  }
  recomputeKeytagPrintLock();

  if (!roKey) return;

  keytagInFlightKey = roKey;
  try {
    const params = new URLSearchParams({
      shopId: currentContext.shopId,
      roId: currentContext.roId,
    });
    if (currentContext.provider) params.set('provider', currentContext.provider);
    if (currentContext.vin) params.set('vin', currentContext.vin);

    const result = await sendMessage({
      action: 'MOS_API_REQUEST',
      endpoint: `/api/extension/ro-context?${params}`
    });

    // Stale-response guard: discard if the user navigated to a different RO
    // while this request was in flight.
    if (makeRoKey(currentContext) !== roKey) {
      return;
    }

    if (result && !result.error) {
      const newCustomerName = result.customerName || null;
      const newVehicleDisplay = result.vehicleDisplay
        || (result.vehicle ? `${result.vehicle.year} ${result.vehicle.make} ${result.vehicle.model}` : null);

      if (newCustomerName) currentContext.customerName = newCustomerName;
      if (result.repairOrderNumber) currentContext.roNumber = String(result.repairOrderNumber);
      if (result.mileage) currentContext.mileage = result.mileage;
      if (result.vehicle) {
        currentContext.vehicle = { year: result.vehicle.year, make: result.vehicle.make, model: result.vehicle.model, engine: null };
        currentContext.vehicleDisplay = newVehicleDisplay;
      }
      if (result.vin) currentContext.vin = result.vin.toUpperCase();

      updateKeytagFields();

      if (newCustomerName && newVehicleDisplay) {
        keytagStatus = 'ready';
        keytagContextEnriched = true;
        keytagLastEnrichedKey = roKey;
      } else if (!haveInstantIdentity) {
        // Only fall to "insufficient" if we never had a good instant fill —
        // a sparse backend reply must not re-lock an already-populated form.
        keytagStatus = 'insufficient';
      }
    } else if (!haveInstantIdentity) {
      keytagStatus = 'insufficient';
    }
  } catch (e) {
    console.log('[MOS] Keytag context enrichment failed:', e);
    // A backend blip must never re-lock a form we already instant-filled.
    if (makeRoKey(currentContext) === roKey && !haveInstantIdentity) {
      keytagStatus = 'error';
    }
  } finally {
    if (keytagInFlightKey === roKey) keytagInFlightKey = null;
    if (makeRoKey(currentContext) === roKey) {
      recomputeKeytagPrintLock();
    }
  }
}

function setKeytagPrintLocked(locked, message) {
  if (elements.keytagPrintBtn) {
    elements.keytagPrintBtn.disabled = !!locked;
    elements.keytagPrintBtn.style.opacity = locked ? '0.5' : '1';
    elements.keytagPrintBtn.style.cursor = locked ? 'not-allowed' : 'pointer';
  }
  if (elements.keytagError) {
    if (locked && message) {
      elements.keytagError.textContent = message;
      elements.keytagError.classList.remove('hidden');
    } else {
      elements.keytagError.classList.add('hidden');
    }
  }
}

// Separate function to update keytag fields - can be called when context updates
function updateKeytagFields() {
  if (!currentContext || !elements.keytagSection) return;
  
  if (elements.keytagVehicle && currentContext.vehicleDisplay) {
    elements.keytagVehicle.value = currentContext.vehicleDisplay;
  }
  if (elements.keytagRo && currentContext.roNumber) {
    elements.keytagRo.value = currentContext.roNumber;
  }
  if (elements.keytagMileage && currentContext.mileage) {
    elements.keytagMileage.value = currentContext.mileage.toLocaleString();
  }
  if (elements.keytagCustomer && currentContext.customerName) {
    elements.keytagCustomer.value = currentContext.customerName;
  }
}

async function handleKeytagPrint() {
  const customerName = elements.keytagCustomer?.value?.trim() || '';
  const vehicleInfo = elements.keytagVehicle?.value?.trim() || '';
  const roNumber = elements.keytagRo?.value?.trim() || '';
  const mileage = elements.keytagMileage?.value?.replace(/,/g, '') || '';
  
  if (!customerName) {
    if (elements.keytagError) {
      elements.keytagError.textContent = 'Please enter a customer name';
      elements.keytagError.classList.remove('hidden');
    }
    return;
  }
  
  if (elements.keytagError) elements.keytagError.classList.add('hidden');
  elements.stickerLoading.classList.remove('hidden');
  if (elements.keytagPrintBtn) elements.keytagPrintBtn.disabled = true;
  
  try {
    const body = {
      customerName,
      vehicleInfo,
      roNumber,
      mileage: parseInt(mileage, 10) || 0,
      vin: currentContext?.vin || ''
    };
    
    // Add shop context
    if (currentContext && currentContext.shopId) {
      body.smsShopId = currentContext.shopId;
      body.provider = currentContext.provider || '';
    }
    
    const result = await sendMessage({
      action: 'MOS_API_REQUEST',
      endpoint: '/api/extension/keytag',
      options: {
        method: 'POST',
        body: JSON.stringify(body)
      }
    });
    
    if (!result.success || !result.image) {
      throw new Error(result.error || 'Failed to generate keytag');
    }
    
    // Print the keytag using same mechanism as sticker
    const keytagData = {
      dataUrl: result.image,
      widthInches: result.dimensions?.width || '3.45in',
      heightInches: result.dimensions?.height || '1.11in'
    };
    printKeytagImage(keytagData);
    showNotification('Keytag generated!', 'success');
    
  } catch (err) {
    console.error('[MOS] Keytag print error:', err);
    if (elements.keytagError) {
      elements.keytagError.textContent = err.message || 'Failed to generate keytag';
      elements.keytagError.classList.remove('hidden');
    }
  } finally {
    elements.stickerLoading.classList.add('hidden');
    // Restore the lock state owned by enrichment, not a blanket re-enable.
    // If the RO is still ready, this re-enables Print; otherwise it stays locked.
    recomputeKeytagPrintLock();
  }
}

function printKeytagImage(keytag) {
  console.log('[MOS] Sending keytag to content script for printing');
  
  // Try to print via content script first
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]?.id) {
      chrome.tabs.sendMessage(tabs[0].id, {
        action: 'PRINT_STICKER',
        sticker: keytag
      }, (response) => {
        if (chrome.runtime.lastError || !response?.success) {
          printKeytagViaWindow(keytag);
        }
      });
    } else {
      printKeytagViaWindow(keytag);
    }
  });
}

function printKeytagViaWindow(keytag) {
  const printWindow = window.open('', '_blank', 'width=600,height=400');
  if (!printWindow) {
    showNotification('Please allow popups to print', 'error');
    return;
  }
  
  printWindow.document.write(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Print Keytag</title>
      <style>
        @page { size: ${keytag.widthInches || '3.5in'} ${keytag.heightInches || '1.125in'}; margin: 0; }
        body { margin: 0; padding: 0; }
        img {
          width: ${keytag.widthInches || '3.5in'};
          height: ${keytag.heightInches || '1.125in'};
          display: block;
        }
      </style>
    </head>
    <body>
      <img id="keytag" src="${keytag.dataUrl}" />
    </body>
    </html>
  `);
  
  const img = printWindow.document.getElementById('keytag');
  img.onload = () => {
    setTimeout(() => {
      printWindow.print();
      printWindow.close();
    }, 100);
  };
  printWindow.document.close();
}

async function handleStickerPrint() {
  const mileageStr = elements.stickerMileage.value.replace(/,/g, '');
  const currentMileage = parseInt(mileageStr, 10);
  
  if (!currentMileage || currentMileage <= 0) {
    elements.stickerError.textContent = 'Please enter a valid reading';
    elements.stickerError.classList.remove('hidden');
    return;
  }
  
  elements.stickerError.classList.add('hidden');
  elements.stickerLoading.classList.remove('hidden');
  elements.stickerPrintBtn.disabled = true;
  
  try {
    const intervalType = elements.stickerInterval.value;
    const unit = elements.stickerUnit.value;
    
    const body = {
      currentMileage,
      intervalType,
      unit
    };
    
    // Add shop context if available
    if (currentContext && currentContext.shopId) {
      body.smsShopId = currentContext.shopId;
      body.provider = currentContext.provider || '';
    }
    
    // Add customer/vehicle data for auto booking
    if (currentContext) {
      if (currentContext.customerName) body.customerName = currentContext.customerName;
      if (currentContext.customerId) body.customerId = currentContext.customerId;
      if (currentContext.customerPhone) body.customerPhone = currentContext.customerPhone;
      if (currentContext.customerEmail) body.customerEmail = currentContext.customerEmail;
      if (currentContext.vin) body.vin = currentContext.vin;
      if (currentContext.roNumber) body.roNumber = currentContext.roNumber;
      if (currentContext.vehicleId) body.vehicleId = currentContext.vehicleId;
      if (currentContext.vehicle) {
        if (currentContext.vehicle.year) body.vehicleYear = currentContext.vehicle.year;
        if (currentContext.vehicle.make) body.vehicleMake = currentContext.vehicle.make;
        if (currentContext.vehicle.model) body.vehicleModel = currentContext.vehicle.model;
      }
    }
    
    // Add optional tagline
    const tagline = elements.stickerTagline?.value?.trim();
    if (tagline) {
      body.tagline = tagline;
    }
    
    // QR code toggle - only exclude if unchecked
    if (elements.stickerIncludeQR && !elements.stickerIncludeQR.checked) {
      body.excludeQR = true;
    }
    
    if (intervalType === 'custom') {
      body.customMonths = parseInt(elements.customMonths.value, 10) || 6;
      body.customMileage = parseInt(elements.customMileage.value.replace(/,/g, ''), 10) || 5000;
    }
    
    const result = await sendMessage({
      action: 'MOS_API_REQUEST',
      endpoint: '/api/extension/sticker',
      options: {
        method: 'POST',
        body: JSON.stringify(body)
      }
    });
    
    if (result.error) {
      throw new Error(result.error);
    }
    
    if (!result.success || !result.sticker) {
      throw new Error('Failed to generate sticker');
    }
    
    // Print the sticker using an iframe
    printStickerImage(result.sticker);
    
    showNotification('Sticker generated!', 'success');
  } catch (err) {
    console.error('[MOS] Sticker print error:', err);
    elements.stickerError.textContent = err.message || 'Failed to generate sticker';
    elements.stickerError.classList.remove('hidden');
  } finally {
    elements.stickerLoading.classList.add('hidden');
    elements.stickerPrintBtn.disabled = false;
  }
}

function printStickerImage(sticker) {
  console.log('[MOS] Sending sticker to content script for printing');
  
  // Send to content script via background - content script can print from the actual page
  chrome.runtime.sendMessage({
    action: 'PRINT_STICKER_VIA_CONTENT',
    sticker: sticker
  }, (response) => {
    if (response?.success) {
      console.log('[MOS] Print initiated via content script');
    } else {
      console.log('[MOS] Content script print failed, falling back to window.open');
      printStickerViaWindow(sticker);
    }
  });
}

function printStickerViaWindow(sticker) {
  // Fallback: Open a popup window for printing
  const printWindow = window.open('', '_blank', 'width=400,height=500');
  if (!printWindow) {
    console.error('[MOS] Failed to open print window - popup blocked?');
    showNotification('Please allow popups to print', 'error');
    return;
  }
  
  printWindow.document.open();
  printWindow.document.write(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Print Sticker</title>
      <style>
        @page { margin: 0; size: auto; }
        @media print { @page { margin: 0; } }
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
  printWindow.document.close();
  
  const img = printWindow.document.getElementById('sticker');
  if (img) {
    const doPrint = () => {
      console.log('[MOS] Triggering print dialog via window');
      setTimeout(() => {
        printWindow.focus();
        printWindow.print();
      }, 100);
    };
    
    if (img.complete) {
      doPrint();
    } else {
      img.onload = doPrint;
    }
  }
}

// ==================== UTILITIES ====================
// The background worker caps MOS API fetches at MOS_FETCH_TIMEOUT_MS (45s)
// unless a request passes its own options.timeoutMs. The sidepanel-side wait
// must ALWAYS exceed the background's cap, or slow-but-successful writes time
// out here while the background still completes them ("ghost" successes).
// Default: 60s (> 45s background default). If the message carries an explicit
// options.timeoutMs for the background fetch, wait that long plus a buffer.
const SENDMESSAGE_DEFAULT_TIMEOUT_MS = 60000;
const SENDMESSAGE_TIMEOUT_BUFFER_MS = 10000;

// ---- Slow-write "still working…" notice (task #789) ----
// Long background-routed writes (Create RO up to ~130s, canned adds up to
// ~90s) now wait correctly instead of falsely timing out — but the user only
// sees a spinner. After SLOW_NOTICE_DELAY_MS of silence we show a persistent
// in-panel notice so they don't click again or close the panel mid-write.
// The notice is a singleton and is always cleared when the request settles
// (success, error, or timeout).
const SLOW_NOTICE_DELAY_MS = 18000;
const SLOW_NOTICE_DEFAULT_TEXT = 'Still working — big shops can take a minute. Please keep this panel open…';

function showSlowWriteNotice(text) {
  hideSlowWriteNotice();
  const notice = document.createElement('div');
  notice.id = 'mos-slow-write-notice';
  notice.setAttribute('role', 'status');
  Object.assign(notice.style, {
    position: 'fixed',
    bottom: '20px',
    left: '50%',
    transform: 'translateX(-50%)',
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    maxWidth: 'calc(100% - 32px)',
    padding: '12px 20px',
    borderRadius: '8px',
    color: 'white',
    fontSize: '13px',
    fontWeight: '500',
    zIndex: '9999',
    backgroundColor: '#3B82F6',
    boxShadow: '0 4px 12px rgba(0,0,0,0.2)'
  });
  const spinner = document.createElement('span');
  Object.assign(spinner.style, {
    width: '14px',
    height: '14px',
    flex: '0 0 auto',
    border: '2px solid rgba(255,255,255,0.4)',
    borderTopColor: 'white',
    borderRadius: '50%',
    animation: 'mos-slow-notice-spin 0.8s linear infinite'
  });
  if (!document.getElementById('mos-slow-notice-style')) {
    const style = document.createElement('style');
    style.id = 'mos-slow-notice-style';
    style.textContent = '@keyframes mos-slow-notice-spin { to { transform: rotate(360deg); } }';
    document.head.appendChild(style);
  }
  const label = document.createElement('span');
  label.textContent = text || SLOW_NOTICE_DEFAULT_TEXT;
  notice.appendChild(spinner);
  notice.appendChild(label);
  document.body.appendChild(notice);
}

function hideSlowWriteNotice() {
  document.getElementById('mos-slow-write-notice')?.remove();
}

// slowNoticeText: pass a string (or `true` for the default wording) on
// long-running write requests to show the persistent "still working…" notice
// after SLOW_NOTICE_DELAY_MS. It is removed as soon as the request settles.
function sendMessage(message, timeoutMs, slowNoticeText) {
  let limitMs = (typeof timeoutMs === 'number' && timeoutMs > 0)
    ? timeoutMs
    : SENDMESSAGE_DEFAULT_TIMEOUT_MS;
  const fetchTimeoutMs = message?.options?.timeoutMs;
  if (typeof fetchTimeoutMs === 'number' && fetchTimeoutMs > 0) {
    // Always outlast the background's own fetch timeout so the background is
    // the one to report a timeout (a real one), not us guessing prematurely.
    limitMs = Math.max(limitMs, fetchTimeoutMs + SENDMESSAGE_TIMEOUT_BUFFER_MS);
  }
  let slowNoticeTimer = null;
  if (slowNoticeText) {
    const noticeText = slowNoticeText === true ? SLOW_NOTICE_DEFAULT_TEXT : slowNoticeText;
    slowNoticeTimer = setTimeout(() => {
      slowNoticeTimer = null;
      showSlowWriteNotice(noticeText);
    }, SLOW_NOTICE_DELAY_MS);
  }
  const settleNotice = () => {
    if (slowNoticeTimer) { clearTimeout(slowNoticeTimer); slowNoticeTimer = null; }
    if (slowNoticeText) hideSlowWriteNotice();
  };
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      settleNotice();
      resolve({ error: 'Request timed out. Please try again.' });
    }, limitMs);
    
    chrome.runtime.sendMessage(message, (response) => {
      clearTimeout(timeout);
      settleNotice();
      if (chrome.runtime.lastError) {
        console.error('[MOS] Message error:', chrome.runtime.lastError);
        resolve({ error: chrome.runtime.lastError.message || 'Extension error' });
      } else {
        resolve(response || {});
      }
    });
  });
}

// Keep service worker alive while sidepanel is open
let keepAliveInterval = null;
function startKeepAlive() {
  if (keepAliveInterval) return;
  keepAliveInterval = setInterval(() => {
    chrome.runtime.sendMessage({ action: 'PING' }).catch(() => {});
  }, 20000); // Ping every 20 seconds to prevent sleep
}

function stopKeepAlive() {
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
}

// Start keepalive when panel loads
startKeepAlive();

// Stop when panel closes
window.addEventListener('unload', stopKeepAlive);

function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function showNotification(message, type = 'info') {
  const notification = document.createElement('div');
  notification.className = `notification notification-${type}`;
  notification.textContent = message;
  
  Object.assign(notification.style, {
    position: 'fixed',
    bottom: '20px',
    left: '50%',
    transform: 'translateX(-50%)',
    padding: '12px 24px',
    borderRadius: '8px',
    color: 'white',
    fontWeight: '500',
    zIndex: '9999',
    backgroundColor: type === 'success' ? '#10B981' : type === 'error' ? '#EF4444' : '#3B82F6'
  });
  
  document.body.appendChild(notification);
  
  setTimeout(() => {
    notification.style.opacity = '0';
    notification.style.transition = 'opacity 0.3s';
    setTimeout(() => notification.remove(), 300);
  }, 3000);
}

// ==================== VEHICLE SPECS ====================
let specsCache = {};

// Mirror of lib/unit-format.ts so the extension renders dual imperial/metric
// values consistently with the dashboard Specs tab (task #321 / #491).
const GAL_TO_L = 3.785411784;
const LBS_TO_KG = 0.45359237;
const IN_TO_CM = 2.54;
const CUFT_TO_L = 28.316846592;

function _toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function _fmtDec(n, d) {
  return Number(n.toFixed(d)).toLocaleString(undefined, { maximumFractionDigits: d });
}

// `mode` is "imperial" | "metric" | "both". Defaults to "both" so unspecified
// callers preserve the legacy dual-rendering behavior. Task #491 wires the
// server-supplied `unitDisplay` through here so a metric shop never sees `"`
// or `cu ft` on the Specs tab.
function formatGallonsDual(value, mode = 'both') {
  const n = _toNum(value);
  if (n === null) return '';
  const liters = n * GAL_TO_L;
  if (mode === 'imperial') return `${_fmtDec(n, 1)} gal`;
  if (mode === 'metric') return `${_fmtDec(liters, 1)} L`;
  return `${_fmtDec(n, 1)} gal / ${_fmtDec(liters, 1)} L`;
}

function formatPoundsDual(value, mode = 'both') {
  const n = _toNum(value);
  if (n === null) return '';
  const kg = n * LBS_TO_KG;
  if (mode === 'imperial') return `${Math.round(n).toLocaleString()} lbs`;
  if (mode === 'metric') return `${Math.round(kg).toLocaleString()} kg`;
  return `${Math.round(n).toLocaleString()} lbs / ${Math.round(kg).toLocaleString()} kg`;
}

function formatInchesDual(value, mode = 'both') {
  const n = _toNum(value);
  if (n === null) return '';
  const cm = n * IN_TO_CM;
  if (mode === 'imperial') return `${_fmtDec(n, 1)}"`;
  if (mode === 'metric') return `${_fmtDec(cm, 1)} cm`;
  return `${_fmtDec(n, 1)}" / ${_fmtDec(cm, 1)} cm`;
}

function formatCuFtDual(value, mode = 'both') {
  const n = _toNum(value);
  if (n === null) return '';
  const liters = n * CUFT_TO_L;
  if (mode === 'imperial') return `${_fmtDec(n, 1)} cu ft`;
  if (mode === 'metric') return `${Math.round(liters).toLocaleString()} L`;
  return `${_fmtDec(n, 1)} cu ft / ${Math.round(liters).toLocaleString()} L`;
}

async function loadVehicleSpecs() {
  const specsLoading = document.getElementById('specs-loading');
  const specsEmpty = document.getElementById('specs-empty');
  const specsContent = document.getElementById('specs-content');

  let vin = currentContext?.vin;
  if (!vin && currentContext?.roId && currentContext?.shopId) {
    specsLoading.classList.remove('hidden');
    specsEmpty.classList.add('hidden');
    specsContent.classList.add('hidden');
    try {
      const params = new URLSearchParams({
        shopId: currentContext.shopId,
        roId: currentContext.roId,
        provider: currentContext.provider || ''
      });
      // Task #645: keep the shared plan-cache key consistent with loadPlan.
      if (currentContext.scrapedOdometer) params.set('odometer', String(currentContext.scrapedOdometer));
      const result = await sendMessage({
        action: 'MOS_API_REQUEST',
        endpoint: `/api/extension/plan?${params}`
      });
      if (result?.vehicle?.vin) {
        currentContext.vin = result.vehicle.vin.toUpperCase();
        vin = currentContext.vin;
        console.log('[MOS] Specs: fetched VIN from plan API:', vin);
        if (result.vehicle.year && result.vehicle.make && result.vehicle.model) {
          currentContext.vehicle = {
            year: result.vehicle.year,
            make: result.vehicle.make,
            model: result.vehicle.model,
            engine: result.vehicle.engine || null
          };
          currentContext.vehicleDisplay = `${result.vehicle.year} ${result.vehicle.make} ${result.vehicle.model}`;
          elements.vehicleDisplay.textContent = currentContext.vehicleDisplay;
        }
      }
    } catch (err) {
      console.error('[MOS] Specs: failed to fetch VIN:', err);
    }
  }
  if (!vin) {
    try {
      const freshContext = await sendMessage({ action: 'GET_SMS_CONTEXT' });
      if (freshContext?.context?.vin) {
        vin = freshContext.context.vin.toUpperCase();
        currentContext.vin = vin;
        console.log('[MOS] Specs: got VIN from refreshed context:', vin);
      }
    } catch (err) {
      console.error('[MOS] Specs: failed to refresh context for VIN:', err);
    }
  }
  if (!vin) {
    specsLoading.classList.add('hidden');
    specsContent.classList.add('hidden');
    specsEmpty.classList.remove('hidden');
    specsEmpty.querySelector('p').textContent = 'VIN not available for this vehicle.';
    return;
  }

  if (specsCache[vin]) {
    renderSpecs(specsCache[vin]);
    return;
  }

  specsLoading.classList.remove('hidden');
  specsEmpty.classList.add('hidden');
  specsContent.classList.add('hidden');

  try {
    // Pass available disambiguation hints so DataOne can pick the right
    // variant for VIN squishes that match multiple trims/engines
    // (e.g. 2020 INFINITI Q50 Pure vs Red Sport 400 share JN1EV7AR_L).
    // The /api/extension/specs route accepts engine/trim/subModel/transmission
    // and falls back to "VIN matches multiple vehicle variants" without them.
    const specsParams = new URLSearchParams({ vin });
    const v = currentContext?.vehicle || {};
    if (v.engine) specsParams.set('engine', v.engine);
    if (v.trim) specsParams.set('trim', v.trim);
    if (v.subModel) specsParams.set('subModel', v.subModel);
    if (v.transmission) specsParams.set('transmission', v.transmission);
    if (v.transmissionType) specsParams.set('transmissionType', v.transmissionType);
    const result = await sendMessage({
      action: 'MOS_API_REQUEST',
      endpoint: `/api/extension/specs?${specsParams.toString()}`
    });

    specsLoading.classList.add('hidden');

    if (result && result.ok) {
      specsCache[vin] = result;
      renderSpecs(result);
    } else {
      specsEmpty.classList.remove('hidden');
      specsEmpty.querySelector('p').textContent = result?.error || 'No specifications found for this vehicle.';
    }
  } catch (err) {
    console.error('[MOS] Error loading specs:', err);
    specsLoading.classList.add('hidden');
    specsEmpty.classList.remove('hidden');
    specsEmpty.querySelector('p').textContent = 'Failed to load specifications.';
  }
}

function renderSpecs(data) {
  const specsContent = document.getElementById('specs-content');
  const headerEl = document.getElementById('specs-vehicle-header');
  const sectionsEl = document.getElementById('specs-sections');

  specsContent.classList.remove('hidden');
  document.getElementById('specs-empty').classList.add('hidden');

  if (data.vehicleInfo) {
    const vi = data.vehicleInfo;
    headerEl.innerHTML = `
      <div class="specs-title">${vi.year} ${vi.make} ${vi.model}</div>
      <div class="specs-subtitle">${vi.trim || ''} ${vi.style || ''}</div>
      <div class="specs-vin">VIN: ${data.vin}</div>
    `;
  } else {
    headerEl.innerHTML = `<div class="specs-vin">VIN: ${data.vin}</div>`;
  }

  let html = '';

  if (data.vehicleInfo) {
    const vi = data.vehicleInfo;
    const powertrain = [];
    if (vi.engine) powertrain.push({ label: 'Engine', value: vi.engine });
    if (vi.engineSize) powertrain.push({ label: 'Displacement', value: `${vi.engineSize}L` });
    if (vi.engineCylinders) powertrain.push({ label: 'Cylinders', value: vi.engineCylinders });
    if (vi.transmission) powertrain.push({ label: 'Transmission', value: vi.transmission });
    if (vi.transType) powertrain.push({ label: 'Trans Type', value: vi.transType });
    if (vi.driveType) powertrain.push({ label: 'Drive Type', value: vi.driveType });
    if (vi.fuelType) powertrain.push({ label: 'Fuel Type', value: vi.fuelType });
    if (vi.brakeSystem) powertrain.push({ label: 'Brake System', value: vi.brakeSystem });
    if (powertrain.length > 0) {
      html += renderSpecsSection('Powertrain', powertrain, 'engine');
    }
  }

  const g = data.grouped || {};
  // Task #491: server now tells us which unit system the shop prefers.
  // Default to "both" if absent (older server, in-flight upgrade) so we
  // never silently strip metric values from a shop that needs them.
  const unitMode = (data.unitDisplay === 'imperial' || data.unitDisplay === 'metric' || data.unitDisplay === 'both')
    ? data.unitDisplay
    : 'both';

  if (g.wheelsAndTires && Object.keys(g.wheelsAndTires).length > 0) {
    const items = [];
    if (g.wheelsAndTires.frontTireDescription) items.push({ label: 'Front Tires', value: g.wheelsAndTires.frontTireDescription });
    if (g.wheelsAndTires.rearTireDescription) items.push({ label: 'Rear Tires', value: g.wheelsAndTires.rearTireDescription });
    if (g.wheelsAndTires.frontWheelDiameter) items.push({ label: 'Front Wheel', value: formatInchesDual(g.wheelsAndTires.frontWheelDiameter, unitMode) });
    if (g.wheelsAndTires.rearWheelDiameter) items.push({ label: 'Rear Wheel', value: formatInchesDual(g.wheelsAndTires.rearWheelDiameter, unitMode) });
    if (g.wheelsAndTires.frontWheelSize) items.push({ label: 'Front Wheel Size', value: g.wheelsAndTires.frontWheelSize });
    if (g.wheelsAndTires.rearWheelSize) items.push({ label: 'Rear Wheel Size', value: g.wheelsAndTires.rearWheelSize });
    if (g.wheelsAndTires.tireType) items.push({ label: 'Tire Type', value: g.wheelsAndTires.tireType });
    if (items.length > 0) html += renderSpecsSection('Wheels & Tires', items, 'wheel');
  }

  if (g.brakes && Object.keys(g.brakes).length > 0) {
    const items = [];
    if (g.brakes.frontBrakeDiameter) items.push({ label: 'Front Brake', value: formatInchesDual(g.brakes.frontBrakeDiameter, unitMode) });
    if (g.brakes.rearBrakeDiameter) items.push({ label: 'Rear Brake', value: formatInchesDual(g.brakes.rearBrakeDiameter, unitMode) });
    if (items.length > 0) html += renderSpecsSection('Brakes', items, 'brake');
  }

  if (g.dimensions && Object.keys(g.dimensions).length > 0) {
    const items = [];
    if (g.dimensions.wheelbase) items.push({ label: 'Wheelbase', value: formatInchesDual(g.dimensions.wheelbase, unitMode) });
    if (g.dimensions.length) items.push({ label: 'Length', value: formatInchesDual(g.dimensions.length, unitMode) });
    if (g.dimensions.width) items.push({ label: 'Width', value: formatInchesDual(g.dimensions.width, unitMode) });
    if (g.dimensions.height) items.push({ label: 'Height', value: formatInchesDual(g.dimensions.height, unitMode) });
    if (g.dimensions.groundClearance) items.push({ label: 'Ground Clearance', value: formatInchesDual(g.dimensions.groundClearance, unitMode) });
    if (g.dimensions.frontTrackWidth) items.push({ label: 'Front Track', value: formatInchesDual(g.dimensions.frontTrackWidth, unitMode) });
    if (g.dimensions.rearTrackWidth) items.push({ label: 'Rear Track', value: formatInchesDual(g.dimensions.rearTrackWidth, unitMode) });
    if (items.length > 0) html += renderSpecsSection('Dimensions', items, 'ruler');
  }

  if (g.weightsAndCapacities && Object.keys(g.weightsAndCapacities).length > 0) {
    const items = [];
    if (g.weightsAndCapacities.fuelTankCapacity) items.push({ label: 'Fuel Tank', value: formatGallonsDual(g.weightsAndCapacities.fuelTankCapacity, unitMode) });
    if (g.weightsAndCapacities.curbWeight) items.push({ label: 'Curb Weight', value: formatPoundsDual(g.weightsAndCapacities.curbWeight, unitMode) });
    if (g.weightsAndCapacities.gvwr) items.push({ label: 'GVWR', value: formatPoundsDual(g.weightsAndCapacities.gvwr, unitMode) });
    if (g.weightsAndCapacities.gcwr) items.push({ label: 'GCWR', value: formatPoundsDual(g.weightsAndCapacities.gcwr, unitMode) });
    if (g.weightsAndCapacities.baseTowingCapacity) items.push({ label: 'Base Towing', value: formatPoundsDual(g.weightsAndCapacities.baseTowingCapacity, unitMode) });
    if (g.weightsAndCapacities.maxTowingCapacity) items.push({ label: 'Max Towing', value: formatPoundsDual(g.weightsAndCapacities.maxTowingCapacity, unitMode) });
    if (g.weightsAndCapacities.maxPayload) items.push({ label: 'Max Payload', value: formatPoundsDual(g.weightsAndCapacities.maxPayload, unitMode) });
    if (g.weightsAndCapacities.tonnage) items.push({ label: 'Tonnage', value: g.weightsAndCapacities.tonnage });
    if (items.length > 0) html += renderSpecsSection('Weights & Capacities', items, 'weight');
  }

  if (g.truckSpecs && Object.keys(g.truckSpecs).length > 0) {
    const items = [];
    if (g.truckSpecs.bedLength) items.push({ label: 'Bed Length', value: g.truckSpecs.bedLength });
    if (items.length > 0) html += renderSpecsSection('Truck Specs', items, 'truck');
  }

  if (g.seating && Object.keys(g.seating).length > 0) {
    const items = [];
    if (g.seating.maxSeating) items.push({ label: 'Max Seating', value: g.seating.maxSeating });
    if (g.seating.standardSeating) items.push({ label: 'Standard Seating', value: g.seating.standardSeating });
    if (items.length > 0) html += renderSpecsSection('Seating', items, 'seat');
  }

  if (g.interior && Object.keys(g.interior).length > 0) {
    const items = [];
    if (g.interior.cargoVolume) items.push({ label: 'Cargo Volume', value: formatCuFtDual(g.interior.cargoVolume, unitMode) });
    if (g.interior.passengerVolume) items.push({ label: 'Passenger Volume', value: formatCuFtDual(g.interior.passengerVolume, unitMode) });
    if (items.length > 0) html += renderSpecsSection('Interior', items, 'interior');
  }

  if (data.vehicleInfo) {
    const vi = data.vehicleInfo;
    const general = [];
    if (vi.bodyType) general.push({ label: 'Body Type', value: vi.bodyType });
    if (vi.doors) general.push({ label: 'Doors', value: vi.doors });
    if (vi.countryOfMfr) general.push({ label: 'Country', value: vi.countryOfMfr });
    if (general.length > 0) html += renderSpecsSection('General', general, 'info');
  }

  if (!html) {
    html = '<div class="specs-no-data">No detailed specifications available for this vehicle.</div>';
  }

  sectionsEl.innerHTML = html;
}

function renderSpecsSection(title, items, iconType) {
  const icons = {
    engine: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 2v4m0 12v4M2 12h4m12 0h4"/><circle cx="12" cy="12" r="9"/></svg>',
    wheel: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg>',
    brake: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>',
    ruler: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12h20M7 8v8M12 6v12M17 8v8"/></svg>',
    weight: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3a4 4 0 0 0-4 4c0 2 4 5 4 5s4-3 4-5a4 4 0 0 0-4-4z"/><path d="M5 21h14l-2-8H7l-2 8z"/></svg>',
    truck: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 3h15v13H1z"/><path d="M16 8h4l3 3v5h-7V8z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>',
    seat: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 18v-4a4 4 0 0 1 4-4h2a4 4 0 0 1 4 4v4"/><circle cx="12" cy="6" r="3"/></svg>',
    interior: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>',
    info: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>'
  };
  const icon = icons[iconType] || icons.info;

  let rows = items.map(item =>
    `<div class="specs-row"><span class="specs-label">${item.label}</span><span class="specs-value">${item.value}</span></div>`
  ).join('');

  return `
    <div class="specs-section">
      <div class="specs-section-header">
        ${icon}
        <span>${title}</span>
      </div>
      <div class="specs-section-body">${rows}</div>
    </div>
  `;
}

// ==================== SUPPORT CHAT ====================
let supportChatOpen = false;
let supportMessages = [];
let supportSessionId = null;
let supportLoading = false;
let supportShowEscalate = false;

const supportElements = {
  fab: document.getElementById('support-chat-fab'),
  panel: document.getElementById('support-chat-panel'),
  closeBtn: document.getElementById('support-close-btn'),
  ticketBtn: document.getElementById('support-ticket-btn'),
  messagesContainer: document.getElementById('support-messages'),
  emptyState: document.getElementById('support-empty'),
  escalateBar: document.getElementById('support-escalate-bar'),
  escalateBtn: document.getElementById('support-escalate-btn'),
  actionsBar: document.getElementById('support-actions-bar'),
  resolveBtn: document.getElementById('support-resolve-btn'),
  humanBtn: document.getElementById('support-human-btn'),
  input: document.getElementById('support-input'),
  sendBtn: document.getElementById('support-send-btn'),
  chatView: document.getElementById('support-chat-view'),
  ticketView: document.getElementById('support-ticket-view'),
  ticketBackBtn: document.getElementById('support-ticket-back-btn'),
  ticketSubject: document.getElementById('ticket-subject'),
  ticketCategory: document.getElementById('ticket-category'),
  ticketPriority: document.getElementById('ticket-priority'),
  ticketDescription: document.getElementById('ticket-description'),
  ticketSubmitBtn: document.getElementById('ticket-submit-btn'),
  ticketError: document.getElementById('ticket-error'),
  ticketSuccess: document.getElementById('ticket-success')
};

function initSupportChat() {
  if (!supportElements.fab) return;

  supportElements.fab.addEventListener('click', openSupportChat);
  supportElements.closeBtn.addEventListener('click', closeSupportChat);
  supportElements.sendBtn.addEventListener('click', sendSupportMessage);
  supportElements.input.addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendSupportMessage();
    }
  });
  supportElements.input.addEventListener('input', () => {
    supportElements.sendBtn.disabled = !supportElements.input.value.trim();
  });

  supportElements.escalateBtn.addEventListener('click', escalateSupportChat);
  supportElements.resolveBtn.addEventListener('click', resolveSupportChat);
  supportElements.humanBtn.addEventListener('click', escalateSupportChat);
  supportElements.ticketBtn.addEventListener('click', showTicketForm);
  supportElements.ticketBackBtn.addEventListener('click', hideTicketForm);
  supportElements.ticketSubmitBtn.addEventListener('click', submitSupportTicket);
}

function showSupportFab() {
  if (supportElements.fab && isAuthenticated) {
    supportElements.fab.classList.remove('hidden');
  }
}

function hideSupportFab() {
  if (supportElements.fab) {
    supportElements.fab.classList.add('hidden');
  }
}

async function openSupportChat() {
  supportChatOpen = true;
  supportElements.fab.classList.add('hidden');
  supportElements.panel.classList.remove('hidden');

  if (supportMessages.length === 0) {
    await fetchSupportSession();
  }
}

function closeSupportChat() {
  supportChatOpen = false;
  supportElements.panel.classList.add('hidden');
  showSupportFab();
}

async function fetchSupportSession() {
  try {
    const result = await sendMessage({
      action: 'MOS_API_REQUEST',
      endpoint: '/api/extension/support'
    });

    if (result && result.ok && result.session) {
      supportSessionId = result.session.sessionId;
      supportMessages = result.session.messages || [];
      renderSupportMessages();
    }
  } catch (err) {
    console.error('[MOS] Failed to fetch support session:', err);
  }
}

async function sendSupportMessage() {
  const text = supportElements.input.value.trim();
  if (!text || supportLoading) return;

  supportElements.input.value = '';
  supportElements.sendBtn.disabled = true;
  supportLoading = true;

  supportMessages.push({ role: 'user', content: text, timestamp: new Date().toISOString() });
  renderSupportMessages();
  showSupportLoading();

  try {
    const result = await sendMessage({
      action: 'MOS_API_REQUEST',
      endpoint: '/api/extension/support',
      options: {
        method: 'POST',
        body: JSON.stringify({ action: 'chat', message: text })
      }
    });

    hideSupportLoading();

    if (result && result.ok) {
      supportSessionId = result.sessionId;
      supportMessages.push({
        role: 'assistant',
        content: result.response,
        timestamp: new Date().toISOString()
      });

      if (supportMessages.filter(m => m.role === 'user').length >= 3) {
        supportShowEscalate = true;
      }
    } else {
      supportMessages.push({
        role: 'assistant',
        content: "I'm having trouble connecting. Would you like to create a support ticket?",
        timestamp: new Date().toISOString()
      });
      supportShowEscalate = true;
    }
  } catch (err) {
    hideSupportLoading();
    supportMessages.push({
      role: 'assistant',
      content: "I'm having trouble connecting. Would you like to create a support ticket?",
      timestamp: new Date().toISOString()
    });
    supportShowEscalate = true;
  } finally {
    supportLoading = false;
    renderSupportMessages();
  }
}

async function escalateSupportChat() {
  if (!supportSessionId || supportLoading) return;
  supportLoading = true;

  try {
    const result = await sendMessage({
      action: 'MOS_API_REQUEST',
      endpoint: '/api/extension/support',
      options: {
        method: 'POST',
        body: JSON.stringify({
          action: 'escalate',
          sessionId: supportSessionId,
          subject: 'Escalated from AI Chat Support (Extension)'
        })
      }
    });

    if (result && result.ok) {
      supportMessages.push({
        role: 'assistant',
        content: `I've created support ticket ${result.ticketNumber} for you. Our team will review your conversation and get back to you soon.`,
        timestamp: new Date().toISOString()
      });
      supportShowEscalate = false;
      showSupportAlert(`Ticket ${result.ticketNumber} created successfully!`, 'success');
    }
  } catch (err) {
    console.error('[MOS] Failed to escalate:', err);
    showSupportAlert('Failed to create ticket. Please try again.', 'error');
  } finally {
    supportLoading = false;
    renderSupportMessages();
  }
}

async function resolveSupportChat() {
  if (!supportSessionId) return;

  try {
    await sendMessage({
      action: 'MOS_API_REQUEST',
      endpoint: '/api/extension/support',
      options: {
        method: 'POST',
        body: JSON.stringify({ action: 'resolve', sessionId: supportSessionId })
      }
    });

    supportMessages = [];
    supportSessionId = null;
    supportShowEscalate = false;
    renderSupportMessages();
    closeSupportChat();
    showSupportAlert('Chat resolved. Thanks for your feedback!', 'success');
  } catch (err) {
    console.error('[MOS] Failed to resolve:', err);
  }
}

function renderSupportMessages() {
  const container = supportElements.messagesContainer;

  if (supportMessages.length === 0) {
    supportElements.emptyState.classList.remove('hidden');
    supportElements.actionsBar.classList.add('hidden');
  } else {
    supportElements.emptyState.classList.add('hidden');
    supportElements.actionsBar.classList.remove('hidden');
  }

  const existingBubbles = container.querySelectorAll('.support-msg, .support-msg-loading');
  existingBubbles.forEach(el => el.remove());

  supportMessages.forEach(msg => {
    const bubble = document.createElement('div');
    bubble.className = `support-msg ${msg.role}`;
    bubble.textContent = msg.content;
    container.appendChild(bubble);
  });

  supportElements.escalateBar.classList.toggle('hidden', !supportShowEscalate);

  requestAnimationFrame(() => {
    container.scrollTop = container.scrollHeight;
  });
}

function showSupportLoading() {
  const loader = document.createElement('div');
  loader.className = 'support-msg-loading';
  loader.id = 'support-loading-indicator';
  loader.innerHTML = '<div class="support-typing-dots"><span></span><span></span><span></span></div>';
  supportElements.messagesContainer.appendChild(loader);
  supportElements.messagesContainer.scrollTop = supportElements.messagesContainer.scrollHeight;
}

function hideSupportLoading() {
  const loader = document.getElementById('support-loading-indicator');
  if (loader) loader.remove();
}

function showTicketForm() {
  supportElements.chatView.classList.add('hidden');
  supportElements.ticketView.classList.remove('hidden');
  supportElements.ticketError.classList.add('hidden');
  supportElements.ticketSuccess.classList.add('hidden');
  supportElements.ticketSubject.value = '';
  supportElements.ticketDescription.value = '';
  supportElements.ticketCategory.value = 'general';
  supportElements.ticketPriority.value = 'medium';
}

function hideTicketForm() {
  supportElements.ticketView.classList.add('hidden');
  supportElements.chatView.classList.remove('hidden');
}

async function submitSupportTicket() {
  const subject = supportElements.ticketSubject.value.trim();
  const description = supportElements.ticketDescription.value.trim();
  const category = supportElements.ticketCategory.value;
  const priority = supportElements.ticketPriority.value;

  supportElements.ticketError.classList.add('hidden');
  supportElements.ticketSuccess.classList.add('hidden');

  if (!subject) {
    supportElements.ticketError.textContent = 'Please enter a subject';
    supportElements.ticketError.classList.remove('hidden');
    return;
  }
  if (!description) {
    supportElements.ticketError.textContent = 'Please enter a description';
    supportElements.ticketError.classList.remove('hidden');
    return;
  }

  supportElements.ticketSubmitBtn.disabled = true;
  supportElements.ticketSubmitBtn.textContent = 'Submitting...';

  try {
    const result = await sendMessage({
      action: 'MOS_API_REQUEST',
      endpoint: '/api/extension/support',
      options: {
        method: 'POST',
        body: JSON.stringify({ action: 'ticket', subject, description, category, priority })
      }
    });

    if (result && result.ok) {
      const ticketNum = result.ticketNumber || result.ticket?.ticketNumber || '';
      supportElements.ticketSuccess.textContent = `Ticket ${ticketNum} created successfully! Our team will get back to you soon.`;
      supportElements.ticketSuccess.classList.remove('hidden');
      showSupportAlert(`Ticket ${ticketNum} submitted!`, 'success');

      supportElements.ticketSubject.value = '';
      supportElements.ticketDescription.value = '';

      setTimeout(() => {
        hideTicketForm();
      }, 3000);
    } else {
      throw new Error(result.error || 'Failed to submit ticket');
    }
  } catch (err) {
    console.error('[MOS] Ticket submission error:', err);
    supportElements.ticketError.textContent = err.message || 'Failed to submit ticket. Please try again.';
    supportElements.ticketError.classList.remove('hidden');
  } finally {
    supportElements.ticketSubmitBtn.disabled = false;
    supportElements.ticketSubmitBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
      Submit Ticket
    `;
  }
}

function showSupportAlert(message, type = 'info') {
  const existing = document.querySelector('.support-alert');
  if (existing) existing.remove();

  const alert = document.createElement('div');
  alert.className = `support-alert alert-${type}`;

  const icon = type === 'success'
    ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>'
    : type === 'error'
    ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>'
    : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>';

  alert.innerHTML = `${icon}<span>${escapeHtml(message)}</span>`;
  document.body.appendChild(alert);

  setTimeout(() => {
    alert.style.opacity = '0';
    alert.style.transition = 'opacity 0.3s';
    setTimeout(() => alert.remove(), 300);
  }, 4000);
}

// ==================== CONCERN ASSISTANT ====================
async function handleConcernSubmit() {
  const concern = elements.concernInput?.value?.trim();
  if (!concern) {
    showConcernError('Please describe the customer concern first.');
    return;
  }

  hideConcernError();
  elements.concernLoading.classList.remove('hidden');
  elements.concernStart.classList.add('hidden');
  elements.concernSubmitBtn.disabled = true;

  try {
    const response = await sendMessage({
      action: 'MOS_API_REQUEST',
      endpoint: '/api/extension/concern-assistant',
      options: {
        method: 'POST',
        body: JSON.stringify({
          action: 'followup',
          concern,
          shopId: currentContext?.shopId || null,
          vin: currentContext?.vin || null,
          vehicleDisplay: currentContext?.vehicleDisplay || null
        })
      }
    });

    if (!response.ok) throw new Error(response.error || 'Failed to generate questions');

    concernState.concern = concern;
    concernState.conversationId = response.conversationId;
    concernState.questions = response.questions || [];
    concernState.askedQuestions = [...(response.questions || [])];
    concernState.noMoreQuestions = false;
    concernState.exchanges = [];

    renderConcernQuestions(concernState.questions);
    elements.concernOriginalText.textContent = concern;
    elements.concernLoading.classList.add('hidden');
    elements.concernConversation.classList.remove('hidden');
  } catch (err) {
    elements.concernLoading.classList.add('hidden');
    elements.concernStart.classList.remove('hidden');
    elements.concernSubmitBtn.disabled = false;
    showConcernError(err.message || 'Failed to generate follow-up questions');
  }
}

function renderConcernQuestions(questions) {
  const container = elements.concernQuestions;
  container.innerHTML = '';

  // Any fresh round means "More Questions" is usable again.
  if (elements.concernReviewBtn) {
    elements.concernReviewBtn.disabled = false;
    elements.concernReviewBtn.title = '';
  }

  questions.forEach((q, i) => {
    const existingExchange = concernState.exchanges.find(e => e.question === q);
    const div = document.createElement('div');
    div.className = 'concern-question-item';
    div.innerHTML = `
      <label class="concern-question-label">Q${i + 1}: ${escapeHtml(q)}</label>
      <textarea class="concern-answer-input" data-question="${escapeHtml(q)}" rows="2" placeholder="Customer's response...">${existingExchange ? escapeHtml(existingExchange.response) : ''}</textarea>
    `;
    container.appendChild(div);
  });

  // Drop the cursor straight into the first unanswered box so the advisor can
  // start typing immediately without clicking (Brandon feedback 2026-06-27).
  // Deferred to the next frame because on the first round the conversation pane
  // is still hidden at this point, and focus() is a no-op on hidden elements.
  const allInputs = container.querySelectorAll('.concern-answer-input');
  const firstEmpty = Array.from(allInputs).find(el => !el.value.trim()) || allInputs[0];
  if (firstEmpty) requestAnimationFrame(() => firstEmpty.focus());
}

// Render the "no further questions" state in the conversation pane (Task #682).
// Keeps any already-answered questions visible so the advisor can still review
// and Finish, and disables the "More Questions" button.
function renderConcernNoMoreQuestions() {
  const container = elements.concernQuestions;
  container.innerHTML = '';

  // Re-show answered questions (read-only context) so the advisor keeps the
  // conversation in view.
  concernState.exchanges.forEach((e, i) => {
    const div = document.createElement('div');
    div.className = 'concern-question-item';
    div.innerHTML = `
      <label class="concern-question-label">Q${i + 1}: ${escapeHtml(e.question)}</label>
      <textarea class="concern-answer-input" data-question="${escapeHtml(e.question)}" rows="2" placeholder="Customer's response...">${escapeHtml(e.response)}</textarea>
    `;
    container.appendChild(div);
  });

  const notice = document.createElement('div');
  notice.className = 'concern-no-more-questions';
  notice.textContent = "No further questions — you've covered everything in the guide. Click Finish to generate the write-up.";
  container.appendChild(notice);

  if (elements.concernReviewBtn) {
    elements.concernReviewBtn.disabled = true;
    elements.concernReviewBtn.title = 'No further questions to ask';
  }
}

function gatherAnsweredQuestions() {
  const inputs = elements.concernQuestions.querySelectorAll('.concern-answer-input');
  const answered = [];
  inputs.forEach(input => {
    const response = input.value.trim();
    if (response) {
      answered.push({
        question: input.dataset.question,
        response
      });
    }
  });
  return answered;
}

function gatherCurrentRoundResults() {
  const inputs = elements.concernQuestions.querySelectorAll('.concern-answer-input');
  const results = [];
  inputs.forEach(input => {
    results.push({
      question: input.dataset.question,
      answered: input.value.trim().length > 0,
    });
  });
  return results;
}

async function handleConcernReview() {
  const answered = gatherAnsweredQuestions();
  if (answered.length === 0) {
    showConcernError('Please answer at least one follow-up question before requesting more.');
    return;
  }

  hideConcernError();
  const roundResults = gatherCurrentRoundResults();
  concernState.exchanges = [...concernState.exchanges, ...answered.filter(a =>
    !concernState.exchanges.some(e => e.question === a.question)
  )];

  elements.concernLoading.classList.remove('hidden');
  elements.concernConversation.classList.add('hidden');

  try {
    const response = await sendMessage({
      action: 'MOS_API_REQUEST',
      endpoint: '/api/extension/concern-assistant',
      options: {
        method: 'POST',
        body: JSON.stringify({
          action: 'review',
          concern: concernState.concern,
          answeredQuestions: concernState.exchanges,
          conversationId: concernState.conversationId,
          shopId: currentContext?.shopId || null,
          roundResults
        })
      }
    });

    if (!response.ok) throw new Error(response.error || 'Failed to get more questions');

    // Client-side safety net on top of the server-side dedup (Task #682):
    // filter the fresh set against every question ever shown so far so a
    // reworded re-ask can never slip through.
    const priorAsked = [
      ...(concernState.askedQuestions || []),
      ...concernState.exchanges.map(e => e.question),
    ];
    const newQuestions = dedupeConcernQuestions(response.questions || [], priorAsked);

    if (response.noMoreQuestions || newQuestions.length === 0) {
      concernState.noMoreQuestions = true;
      renderConcernNoMoreQuestions();
      showNotification('No additional questions — ready to finish.', 'info');
    } else {
      concernState.noMoreQuestions = false;
      concernState.questions = [...concernState.questions, ...newQuestions];
      concernState.askedQuestions = [...(concernState.askedQuestions || []), ...newQuestions];
      // Show only questions not yet answered, plus the fresh deduped set.
      renderConcernQuestions([
        ...concernState.questions.filter(q =>
          !concernState.exchanges.some(e => e.question === q) && !newQuestions.includes(q)
        ),
        ...newQuestions,
      ]);
    }

    elements.concernLoading.classList.add('hidden');
    elements.concernConversation.classList.remove('hidden');
  } catch (err) {
    elements.concernLoading.classList.add('hidden');
    elements.concernConversation.classList.remove('hidden');
    showConcernError(err.message || 'Failed to get more questions');
  }
}

async function handleConcernFinish() {
  const answered = gatherAnsweredQuestions();
  concernState.exchanges = [...concernState.exchanges, ...answered.filter(a =>
    !concernState.exchanges.some(e => e.question === a.question)
  )];

  if (concernState.exchanges.length === 0) {
    showConcernError('Please answer at least one follow-up question before finishing.');
    return;
  }

  hideConcernError();
  const roundResults = gatherCurrentRoundResults();
  elements.concernLoading.classList.remove('hidden');
  elements.concernConversation.classList.add('hidden');

  const conversationLines = [`Customer Concern: ${concernState.concern}`];
  concernState.exchanges.forEach(e => {
    conversationLines.push(`Service Advisor asks: ${e.question}`);
    conversationLines.push(`Customer responds: ${e.response}`);
  });

  try {
    const response = await sendMessage({
      action: 'MOS_API_REQUEST',
      endpoint: '/api/extension/concern-assistant',
      options: {
        method: 'POST',
        body: JSON.stringify({
          action: 'cleanup',
          conversationText: conversationLines.join('\n'),
          conversationId: concernState.conversationId,
          concern: concernState.concern,
          exchanges: concernState.exchanges,
          shopId: currentContext?.shopId || null,
          roundResults
        })
      }
    });

    if (!response.ok) throw new Error(response.error || 'Failed to clean up conversation');

    concernState.cleanedText = response.cleanedText;
    elements.concernCleanedText.textContent = response.cleanedText;

    // In Create RO mode, hand the write-up back to the new RO instead of
    // injecting it into an already-open repair order.
    if (elements.concernUseForRoBtn) {
      elements.concernUseForRoBtn.classList.toggle('hidden', !concernReturnToCro);
    }
    if (elements.concernInjectBtn) {
      elements.concernInjectBtn.classList.toggle('hidden', concernReturnToCro);
    }

    elements.concernLoading.classList.add('hidden');
    elements.concernResult.classList.remove('hidden');
  } catch (err) {
    elements.concernLoading.classList.add('hidden');
    elements.concernConversation.classList.remove('hidden');
    showConcernError(err.message || 'Failed to clean up conversation');
  }
}

function handleConcernCopy() {
  const text = concernState.cleanedText;
  if (!text) return;

  navigator.clipboard.writeText(text).then(() => {
    showNotification('Copied to clipboard!', 'success');
  }).catch(() => {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    showNotification('Copied to clipboard!', 'success');
  });
}

async function handleConcernInject() {
  const text = concernState.cleanedText;
  if (!text) return;

  const isProtractor = currentContext?.provider === 'protractor';
  const orderLabel = isProtractor ? 'work order' : 'repair order';

  try {
    const result = await sendMessage({
      action: 'INSERT_CONCERN',
      text
    });
    if (result && result.success === false) {
      showConcernError(result.error || `Failed to send concern to ${orderLabel}.`);
      return;
    }
    showNotification(`Concern sent to ${orderLabel}!`, 'success');
  } catch (err) {
    showConcernError(`Failed to inject concern. Make sure you have a ${orderLabel} open.`);
  }
}

function handleConcernNew() {
  concernState = {
    concern: '',
    conversationId: null,
    questions: [],
    askedQuestions: [],
    noMoreQuestions: false,
    exchanges: [],
    cleanedText: ''
  };

  elements.concernInput.value = '';
  elements.concernQuestions.innerHTML = '';
  elements.concernCleanedText.textContent = '';
  elements.concernSubmitBtn.disabled = false;
  if (elements.concernReviewBtn) {
    elements.concernReviewBtn.disabled = false;
    elements.concernReviewBtn.title = '';
  }

  // Back to the standalone behaviour (inject into an open RO) until the Create
  // RO flow re-launches the assistant.
  concernReturnToCro = false;
  if (elements.concernUseForRoBtn) elements.concernUseForRoBtn.classList.add('hidden');
  if (elements.concernInjectBtn) elements.concernInjectBtn.classList.remove('hidden');

  elements.concernStart.classList.remove('hidden');
  elements.concernConversation.classList.add('hidden');
  elements.concernResult.classList.add('hidden');
  elements.concernLoading.classList.add('hidden');
  hideConcernError();
}

// ==================== CREATE RO ↔ CONCERN ASSISTANT BRIDGE ====================
// Launch the AI Concern Assistant from the Create RO "Details" step. Reuses the
// exact same assistant the Concern tab (and dashboard) use; the only difference
// is that the finished write-up flows back into the new repair order.
function handleCroConcernAi() {
  if (!shopFeatures.concern_assistant) return;
  // Reset to a clean assistant session, then seed it with whatever the advisor
  // has already typed into the Create RO concern box.
  handleConcernNew();
  const seed = (getCroEl('cro-concern')?.value || '').trim();
  if (seed && elements.concernInput) elements.concernInput.value = seed;
  concernReturnToCro = true;
  switchTab('concern');
  // If the advisor already typed a concern in Create RO, generate the
  // follow-up questions immediately instead of making them press Enter again
  // after the tab switch. With no seed text, just focus so they can type.
  if (seed) {
    handleConcernSubmit();
  } else {
    elements.concernInput?.focus();
  }
}

function handleConcernUseForRo() {
  const text = concernState.cleanedText;
  if (!text) return;
  concernReturnToCro = false;
  if (elements.concernUseForRoBtn) elements.concernUseForRoBtn.classList.add('hidden');
  if (elements.concernInjectBtn) elements.concernInjectBtn.classList.remove('hidden');
  // Re-enter the Create RO tab WITHOUT resetting the in-progress wizard, then
  // write the cleaned write-up into the concern box (after the switch, so the
  // reset path can never wipe it).
  croPreserveStateOnInit = true;
  switchTab('create-ro');
  const concernBox = getCroEl('cro-concern');
  if (concernBox) concernBox.value = text;
  // Concern is step 1 (cro-concern-section, always visible) in the redesigned
  // flow, so no section needs to be revealed here.
  concernBox?.focus();
  showNotification('Concern added to the repair order.', 'success');
}

function showConcernError(msg) {
  if (elements.concernError) {
    elements.concernError.textContent = msg;
    elements.concernError.classList.remove('hidden');
  }
}

function hideConcernError() {
  if (elements.concernError) {
    elements.concernError.textContent = '';
    elements.concernError.classList.add('hidden');
  }
}

// ==================== ESTIMATE ASSIST ====================
let estimateLanguageMode = 'customer';

function escEstimate(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function initEstimateAssist() {
  const jobSearchInput = document.getElementById('estimate-job-search');
  const buildBtn = document.getElementById('estimate-build-btn');
  const langCustomerBtn = document.getElementById('estimate-lang-customer');
  const langTechnicalBtn = document.getElementById('estimate-lang-technical');
  const auditBtn = document.getElementById('estimate-audit-btn');
  const subtabs = document.querySelectorAll('.estimate-subtab');

  subtabs.forEach(btn => {
    btn.addEventListener('click', () => {
      subtabs.forEach(b => {
        b.classList.remove('active');
        b.style.borderBottomColor = 'transparent';
        b.style.color = 'var(--gray-500)';
      });
      btn.classList.add('active');
      btn.style.borderBottomColor = 'var(--primary)';
      btn.style.color = 'var(--primary)';

      const subtab = btn.dataset.subtab;
      document.getElementById('estimate-builder-panel').classList.toggle('hidden', subtab !== 'builder');
      document.getElementById('estimate-audit-panel').classList.toggle('hidden', subtab !== 'audit');
    });
  });

  const activeSubtab = document.querySelector('.estimate-subtab.active');
  if (activeSubtab) {
    activeSubtab.style.borderBottomColor = 'var(--primary)';
    activeSubtab.style.color = 'var(--primary)';
  }

  langCustomerBtn.addEventListener('click', () => {
    estimateLanguageMode = 'customer';
    langCustomerBtn.style.background = 'var(--primary)';
    langCustomerBtn.style.color = 'white';
    langCustomerBtn.style.borderColor = 'var(--primary)';
    langTechnicalBtn.style.background = '';
    langTechnicalBtn.style.color = '';
    langTechnicalBtn.style.borderColor = '';
  });

  langTechnicalBtn.addEventListener('click', () => {
    estimateLanguageMode = 'technical';
    langTechnicalBtn.style.background = 'var(--primary)';
    langTechnicalBtn.style.color = 'white';
    langTechnicalBtn.style.borderColor = 'var(--primary)';
    langCustomerBtn.style.background = '';
    langCustomerBtn.style.color = '';
    langCustomerBtn.style.borderColor = '';
  });

  buildBtn.addEventListener('click', () => runEstimateBuilder());
  jobSearchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runEstimateBuilder();
  });

  auditBtn.addEventListener('click', () => runEstimateAudit());
}

// One-click add for a related/upsell job row (Task #854). Fetches the job's
// full knowledge-base details (description, labor hours, parts) via the same
// job-builder endpoint, then reuses handleAddJob. If the detail fetch fails,
// falls back to adding with just the title and the row's typical labor hours
// so the add still goes through. Returns true on success, false on failure,
// and drives the row button's Adding…/Added!/Failed states.
async function addCompanionJobToRo(btn) {
  const title = btn.dataset.jobTitle || '';
  if (!title) return false;
  if (btn.disabled) return false;
  const typicalHours = parseFloat(btn.dataset.laborHours) || 1;

  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = 'Adding…';
  btn.style.background = '#2563eb';

  let job = null;
  try {
    const vin = currentContext?.vehicle?.vin || undefined;
    const result = await sendMessage({
      action: 'MOS_API_REQUEST',
      endpoint: '/api/estimate-assist/job-builder',
      options: {
        method: 'POST',
        body: JSON.stringify({
          jobNameOrId: title,
          vin: vin,
          languageMode: estimateLanguageMode
        })
      }
    });
    if (!result.error && result.ok && result.estimate) {
      const est = result.estimate;
      const desc = (estimateLanguageMode === 'customer' ? est.customerDescription : est.technicalDescription) || '';
      job = {
        title: est.title || title,
        name: est.title || title,
        description: desc,
        note: desc,
        laborItems: [{ name: est.title || title, hours: est.laborHours?.recommended || est.laborHours?.typical || typicalHours }],
        parts: (est.requiredParts || []).map(p => ({ name: p, quantity: 1 }))
      };
    }
  } catch (err) {
    console.warn('[MOS] Companion job detail fetch failed, adding with basics:', err);
  }

  // Fallback: detail fetch failed — add with the title + row's typical hours.
  if (!job) {
    job = {
      title: title,
      name: title,
      description: '',
      note: '',
      laborItems: [{ name: title, hours: typicalHours }],
      parts: []
    };
  }

  const ok = await handleAddJob(job);
  if (ok) {
    btn.textContent = 'Added!';
    btn.style.background = '#16a34a';
  } else {
    btn.textContent = 'Failed';
    btn.style.background = '#dc2626';
  }
  setTimeout(() => {
    btn.textContent = originalText;
    btn.style.background = '#2563eb';
    btn.disabled = false;
  }, 2000);
  return ok;
}

async function runEstimateBuilder() {
  const query = document.getElementById('estimate-job-search').value.trim();
  if (!query) return;

  const loadingEl = document.getElementById('estimate-builder-loading');
  const resultEl = document.getElementById('estimate-builder-result');
  
  loadingEl.classList.remove('hidden');
  resultEl.classList.add('hidden');
  resultEl.innerHTML = '';

  try {
    const vin = currentContext?.vehicle?.vin || undefined;
    const result = await sendMessage({
      action: 'MOS_API_REQUEST',
      endpoint: '/api/estimate-assist/job-builder',
      options: {
        method: 'POST',
        body: JSON.stringify({
          jobNameOrId: query,
          vin: vin,
          languageMode: estimateLanguageMode
        })
      }
    });

    loadingEl.classList.add('hidden');

    if (result.error) throw new Error(result.error);
    if (!result.ok || !result.estimate) throw new Error('No estimate returned');

    const est = result.estimate;
    const desc = estimateLanguageMode === 'customer' ? est.customerDescription : est.technicalDescription;
    
    let html = `
      <div style="background:white; border:1px solid var(--gray-200); border-radius:8px; padding:12px; margin-bottom:8px;">
        <div style="display:flex; align-items:center; gap:4px; margin-bottom:6px; flex-wrap:wrap;">
          <span style="font-size:10px; padding:2px 6px; background:var(--gray-100); border-radius:10px; color:var(--gray-600);">${escEstimate(est.category)}</span>
          ${est.safetyRelated ? '<span style="font-size:10px; padding:2px 6px; background:#fef2f2; border-radius:10px; color:#dc2626;">Safety</span>' : ''}
          ${est.aiEnhanced ? '<span style="font-size:10px; padding:2px 6px; background:#f5f3ff; border-radius:10px; color:#7c3aed;">AI</span>' : ''}
        </div>
        <h4 style="font-size:14px; font-weight:700; margin:0 0 6px 0; color:var(--gray-900);">${escEstimate(est.title)}</h4>
        <p style="font-size:12px; color:var(--gray-600); margin:0 0 10px 0; line-height:1.4;">${escEstimate(desc)}</p>
        
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px; margin-bottom:10px;">
          <div style="background:${est.laborHours.recommendedSource && est.laborHours.recommendedSource !== 'typical' ? '#ecfdf5' : 'var(--gray-50)'}; border-radius:6px; padding:8px;">
            <div style="font-size:10px; color:var(--gray-500);">Labor (recommended)</div>
            <div style="font-size:16px; font-weight:700; color:var(--gray-900);">${escEstimate(est.laborHours.recommended ?? est.laborHours.typical)}h</div>
            <div style="font-size:10px; color:var(--gray-400);" title="${escEstimate(est.laborHours.aiVehicleRationale || '')}">${
              est.laborHours.recommendedSource === 'shop_vehicle_history' ? 'Shop history (this vehicle)'
              : est.laborHours.recommendedSource === 'ai_vehicle' ? 'AI-adjusted for vehicle'
              : est.laborHours.recommendedSource === 'shop_history' ? 'Shop history'
              : `${escEstimate(est.laborHours.min)}-${escEstimate(est.laborHours.max)}h range`}</div>
          </div>
          ${est.laborHours.shopAverage ? `
          <div style="background:#f0fdf4; border-radius:6px; padding:8px;">
            <div style="font-size:10px; color:var(--gray-500);">Shop Avg</div>
            <div style="font-size:16px; font-weight:700; color:#16a34a;">${escEstimate(est.laborHours.shopAverage)}h</div>
          </div>` : `
          <div style="background:var(--gray-50); border-radius:6px; padding:8px;">
            <div style="font-size:10px; color:var(--gray-500);">Shop Avg</div>
            <div style="font-size:12px; color:var(--gray-400);">No data</div>
          </div>`}
        </div>`;

    if (est.requiredParts && est.requiredParts.length > 0) {
      html += `
        <div style="margin-bottom:10px;">
          <div style="font-size:11px; font-weight:600; color:var(--gray-500); text-transform:uppercase; margin-bottom:4px;">Parts</div>
          <div style="display:flex; flex-wrap:wrap; gap:4px;">
            ${est.requiredParts.map(p => `<span style="font-size:11px; padding:2px 8px; background:var(--gray-100); border-radius:10px; color:var(--gray-700);">${escEstimate(p)}</span>`).join('')}
          </div>
        </div>`;
    }

    if (est.vehicleContext?.vinAdjustments) {
      html += `
        <div style="background:#fffbeb; border:1px solid #fde68a; border-radius:6px; padding:8px; margin-bottom:10px;">
          <div style="font-size:11px; font-weight:600; color:#92400e;">VIN Adjustments</div>
          <div style="font-size:11px; color:#78350f;">+${escEstimate(est.vehicleContext.vinAdjustments.laborHoursAdded)}h labor${est.vehicleContext.vinAdjustments.additionalParts.length > 0 ? ' | Extra: ' + escEstimate(est.vehicleContext.vinAdjustments.additionalParts.join(', ')) : ''}</div>
        </div>`;
    }

    html += `
        <button class="estimate-send-to-ro-btn" data-job-title="${escEstimate(est.title)}" data-job-desc="${escEstimate(desc)}" data-labor-hours="${escEstimate(est.laborHours.recommended ?? est.laborHours.typical)}" data-parts="${escEstimate(JSON.stringify(est.requiredParts || []))}" style="width:100%; margin-top:6px; padding:8px; background:#2563eb; color:white; border:none; border-radius:6px; font-size:12px; font-weight:600; cursor:pointer;">Send to RO</button>
      </div>`;

    if (est.companionJobs && est.companionJobs.length > 0) {
      html += `
        <div style="margin-bottom:8px;">
          <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:4px;">
            <div style="font-size:11px; font-weight:600; color:var(--gray-500); text-transform:uppercase;">Related Jobs</div>
            <button id="estimate-add-all-related-btn" style="font-size:10px; padding:3px 8px; background:#2563eb; color:white; border:none; border-radius:4px; font-weight:600; cursor:pointer;">Add all</button>
          </div>
          ${est.companionJobs.map(j => `
            <div class="estimate-companion-job" data-job-title="${escEstimate(j.title)}" style="display:flex; align-items:center; justify-content:space-between; gap:6px; padding:6px 8px; background:var(--gray-50); border-radius:6px; margin-bottom:3px; cursor:pointer;">
              <div style="flex:1; min-width:0;">
                <span style="font-size:12px; font-weight:600; color:var(--gray-800);">${escEstimate(j.title)}</span>
                ${j.safetyRelated ? '<span style="font-size:9px; color:#dc2626; margin-left:4px;">Safety</span>' : ''}
              </div>
              <span style="font-size:11px; color:var(--gray-500);">${escEstimate(j.laborHoursTypical)}h</span>
              <button class="estimate-companion-add-btn" data-companion-group="related" data-job-title="${escEstimate(j.title)}" data-labor-hours="${escEstimate(j.laborHoursTypical)}" style="font-size:10px; padding:3px 8px; background:#2563eb; color:white; border:none; border-radius:4px; font-weight:600; cursor:pointer; white-space:nowrap; flex-shrink:0;">+ Add</button>
            </div>
          `).join('')}
        </div>`;
    }

    if (est.upsellJobs && est.upsellJobs.length > 0) {
      html += `
        <div style="margin-bottom:8px;">
          <div style="font-size:11px; font-weight:600; color:var(--gray-500); text-transform:uppercase; margin-bottom:4px;">Upsell Opportunities</div>
          ${est.upsellJobs.map(j => `
            <div class="estimate-companion-job" data-job-title="${escEstimate(j.title)}" style="display:flex; align-items:center; justify-content:space-between; gap:6px; padding:6px 8px; background:#f0fdf4; border:1px solid #bbf7d0; border-radius:6px; margin-bottom:3px; cursor:pointer;">
              <span style="font-size:12px; font-weight:600; color:var(--gray-800); flex:1; min-width:0;">${escEstimate(j.title)}</span>
              <span style="font-size:11px; color:var(--gray-500);">${escEstimate(j.laborHoursTypical)}h</span>
              <button class="estimate-companion-add-btn" data-companion-group="upsell" data-job-title="${escEstimate(j.title)}" data-labor-hours="${escEstimate(j.laborHoursTypical)}" style="font-size:10px; padding:3px 8px; background:#2563eb; color:white; border:none; border-radius:4px; font-weight:600; cursor:pointer; white-space:nowrap; flex-shrink:0;">+ Add</button>
            </div>
          `).join('')}
        </div>`;
    }

    resultEl.innerHTML = html;
    resultEl.classList.remove('hidden');

    resultEl.querySelectorAll('.estimate-companion-job').forEach(el => {
      el.addEventListener('click', () => {
        const title = el.dataset.jobTitle;
        if (title) {
          document.getElementById('estimate-job-search').value = title;
          runEstimateBuilder();
        }
      });
    });

    // Per-row one-click add for related/upsell jobs. stopPropagation keeps the
    // row-click (rebuild the card for that job) working independently.
    resultEl.querySelectorAll('.estimate-companion-add-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await addCompanionJobToRo(btn);
      });
    });

    const addAllBtn = resultEl.querySelector('#estimate-add-all-related-btn');
    if (addAllBtn) {
      addAllBtn.addEventListener('click', async () => {
        // Skip rows already mid-add (disabled) so an in-flight manual add
        // isn't double-fired or miscounted as a failure.
        const rowBtns = Array.from(resultEl.querySelectorAll('.estimate-companion-add-btn[data-companion-group="related"]'))
          .filter(b => !b.disabled);
        if (rowBtns.length === 0) return;
        addAllBtn.disabled = true;
        addAllBtn.textContent = 'Adding…';
        let added = 0;
        const failed = [];
        // Sequential on purpose: the add-job endpoints run slow upstream calls
        // and parallel adds risk rate limits / duplicate open-WO resolution.
        for (const rowBtn of rowBtns) {
          const ok = await addCompanionJobToRo(rowBtn);
          if (ok) added++;
          else failed.push(rowBtn.dataset.jobTitle || 'Unknown job');
        }
        if (failed.length === 0) {
          showNotification(`Added all ${added} related job${added === 1 ? '' : 's'}`, 'success');
          addAllBtn.textContent = 'All added!';
          addAllBtn.style.background = '#16a34a';
        } else {
          showNotification(`Added ${added} of ${rowBtns.length} related jobs — failed: ${failed.join(', ')}`, 'error');
          addAllBtn.textContent = `${failed.length} failed`;
          addAllBtn.style.background = '#dc2626';
        }
        setTimeout(() => {
          addAllBtn.textContent = 'Add all';
          addAllBtn.style.background = '#2563eb';
          addAllBtn.disabled = false;
        }, 3000);
      });
    }

    resultEl.querySelectorAll('.estimate-send-to-ro-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const title = btn.dataset.jobTitle || '';
        const desc = btn.dataset.jobDesc || '';
        const laborHours = parseFloat(btn.dataset.laborHours) || 1;
        let parts = [];
        try { parts = JSON.parse(btn.dataset.parts || '[]'); } catch (e) { console.warn('[MOS] Failed to parse parts data', e); }

        const job = {
          title: title,
          name: title,
          description: desc,
          note: desc,
          laborItems: [{ name: title, hours: laborHours }],
          parts: parts.map(p => ({ name: p, quantity: 1 }))
        };

        btn.disabled = true;
        btn.textContent = 'Sending...';
        // handleAddJob reports failures via its return value (it notifies and
        // swallows errors internally), so check the boolean — the old
        // try/catch here could never actually reach its Failed state.
        const ok = await handleAddJob(job);
        if (ok) {
          btn.textContent = 'Sent!';
          btn.style.background = '#16a34a';
        } else {
          btn.textContent = 'Failed';
          btn.style.background = '#dc2626';
        }
        setTimeout(() => {
          btn.textContent = 'Send to RO';
          btn.style.background = '#2563eb';
          btn.disabled = false;
        }, 2000);
      });
    });

  } catch (err) {
    loadingEl.classList.add('hidden');
    resultEl.innerHTML = `<p style="color:#dc2626; font-size:12px; padding:8px;">${escEstimate(err.message || 'Failed to build estimate')}</p>`;
    resultEl.classList.remove('hidden');
  }
}

async function runEstimateAudit() {
  const loadingEl = document.getElementById('estimate-audit-loading');
  const resultEl = document.getElementById('estimate-audit-result');

  if (!currentContext?.roId) {
    resultEl.innerHTML = '<p style="color:#dc2626; font-size:12px; padding:8px;">Navigate to a repair order first to run an audit.</p>';
    resultEl.classList.remove('hidden');
    return;
  }

  loadingEl.classList.remove('hidden');
  resultEl.classList.add('hidden');
  resultEl.innerHTML = '';

  try {
    // Prefer the jobs currently on screen: fetch them live from the
    // Tekmetric page session (same path the labor-rate flow uses). This
    // makes the audit work even when the RO hasn't synced to the MOS DB
    // yet (open/in-progress ROs, freshly added estimate lines). If the
    // live fetch fails or yields nothing, fall back to the server-side
    // lookup by RO id — exactly the old behavior.
    const auditBody = { workOrderId: String(currentContext.roId) };
    if (currentContext.provider === 'tekmetric') {
      try {
        const liveJobs = await sendMessage({
          action: 'GET_RO_AUDIT_LINE_ITEMS',
          shopId: currentContext.shopId,
          roId: currentContext.roId
        });
        if (liveJobs?.success && Array.isArray(liveJobs.lineItems) && liveJobs.lineItems.length > 0) {
          auditBody.lineItems = liveJobs.lineItems;
        } else if (liveJobs?.error) {
          console.warn('[MOS] Audit live-jobs fetch unavailable, using server lookup:', liveJobs.error);
        }
      } catch (liveErr) {
        console.warn('[MOS] Audit live-jobs fetch failed, using server lookup:', liveErr?.message || liveErr);
      }
    }
    if (currentContext.vehicle && (currentContext.vehicle.year || currentContext.vehicle.make)) {
      auditBody.vehicleInfo = {
        year: currentContext.vehicle.year,
        make: currentContext.vehicle.make,
        model: currentContext.vehicle.model,
        mileage: currentContext.scrapedOdometer || currentContext.mileage || undefined
      };
    }

    const result = await sendMessage({
      action: 'MOS_API_REQUEST',
      endpoint: '/api/estimate-assist/audit',
      options: {
        method: 'POST',
        body: JSON.stringify(auditBody)
      }
    });

    loadingEl.classList.add('hidden');

    if (result.error) {
      // Surface the server's specific error codes as friendly messages
      // instead of the generic "no line items" string.
      if (result.code === 'RO_NOT_SYNCED') {
        throw new Error("This repair order hasn't synced to MOS yet and we couldn't read the estimate from the page. Try again in a few minutes.");
      }
      if (result.code === 'RO_NO_LINE_ITEMS') {
        throw new Error('No jobs found on this estimate yet. Add jobs to the estimate first, then run the audit.');
      }
      throw new Error(result.error);
    }
    if (!result.ok || !result.report) throw new Error('No audit report returned');

    const report = result.report;
    const scoreColor = report.summary.score >= 85 ? '#16a34a' : report.summary.score >= 60 ? '#d97706' : '#dc2626';
    const scoreBg = report.summary.score >= 85 ? '#f0fdf4' : report.summary.score >= 60 ? '#fffbeb' : '#fef2f2';

    let html = `
      <div style="display:grid; grid-template-columns:1fr 1fr 1fr 1fr; gap:4px; margin-bottom:10px;">
        <div style="background:${scoreBg}; border-radius:6px; padding:6px; text-align:center;">
          <div style="font-size:9px; color:var(--gray-500);">Score</div>
          <div style="font-size:18px; font-weight:700; color:${scoreColor};">${report.summary.score}</div>
        </div>
        <div style="background:#fef2f2; border-radius:6px; padding:6px; text-align:center;">
          <div style="font-size:9px; color:var(--gray-500);">Critical</div>
          <div style="font-size:18px; font-weight:700; color:#dc2626;">${report.summary.critical}</div>
        </div>
        <div style="background:#fffbeb; border-radius:6px; padding:6px; text-align:center;">
          <div style="font-size:9px; color:var(--gray-500);">Warn</div>
          <div style="font-size:18px; font-weight:700; color:#d97706;">${report.summary.warnings}</div>
        </div>
        <div style="background:#eff6ff; border-radius:6px; padding:6px; text-align:center;">
          <div style="font-size:9px; color:var(--gray-500);">Info</div>
          <div style="font-size:18px; font-weight:700; color:#2563eb;">${report.summary.info}</div>
        </div>
      </div>`;

    if (report.vehicleDisplay) {
      html += `<p style="font-size:11px; color:var(--gray-500); margin-bottom:8px;">${escEstimate(report.vehicleDisplay)}${report.workOrderNumber ? ' &middot; WO# ' + escEstimate(report.workOrderNumber) : ''}</p>`;
    }

    if (report.findings.length === 0) {
      html += '<p style="font-size:12px; color:#16a34a; text-align:center; padding:16px;">No issues found - this estimate looks complete!</p>';
    } else {
      const severityStyles = {
        critical: { bg: '#fef2f2', border: '#fecaca', badge: '#dc2626', badgeBg: '#fee2e2' },
        warning: { bg: '#fffbeb', border: '#fde68a', badge: '#d97706', badgeBg: '#fef3c7' },
        info: { bg: '#eff6ff', border: '#bfdbfe', badge: '#2563eb', badgeBg: '#dbeafe' }
      };

      for (const finding of report.findings) {
        const s = severityStyles[finding.severity] || severityStyles.info;
        html += `
          <div style="background:${s.bg}; border:1px solid ${s.border}; border-radius:6px; padding:8px; margin-bottom:6px;">
            <div style="display:flex; align-items:center; gap:4px; margin-bottom:3px; flex-wrap:wrap;">
              <span style="font-size:9px; font-weight:700; padding:1px 5px; background:${s.badgeBg}; color:${s.badge}; border-radius:8px; text-transform:uppercase;">${escEstimate(finding.severity)}</span>
              <span style="font-size:10px; color:var(--gray-500);">${escEstimate(finding.category)}</span>
              <span style="font-size:10px; color:var(--gray-400);">${Math.round(finding.confidence * 100)}%</span>
            </div>
            <div style="font-size:12px; font-weight:600; color:var(--gray-800); margin-bottom:2px;">${escEstimate(finding.title)}</div>
            <div style="font-size:11px; color:var(--gray-600); line-height:1.3;">${escEstimate(finding.description)}</div>
            ${finding.suggestedAction ? `<div style="font-size:11px; color:var(--gray-500); margin-top:4px; font-style:italic;">${escEstimate(finding.suggestedAction)}</div>` : ''}
            ${finding.suggestedJobTitle ? `
              <div style="display:flex; gap:4px; margin-top:4px;">
                <button class="estimate-audit-build-btn" data-job-title="${escEstimate(finding.suggestedJobTitle)}" style="font-size:10px; padding:3px 8px; background:white; border:1px solid var(--gray-300); border-radius:4px; cursor:pointer;">+ Build Estimate</button>
                <button class="estimate-audit-add-to-ro-btn" data-job-title="${escEstimate(finding.suggestedJobTitle)}" data-finding-desc="${escEstimate(finding.description)}" style="font-size:10px; padding:3px 8px; background:#2563eb; color:white; border:none; border-radius:4px; cursor:pointer;">+ Add to RO</button>
              </div>` : ''}
          </div>`;
      }
    }

    resultEl.innerHTML = html;
    resultEl.classList.remove('hidden');

    resultEl.querySelectorAll('.estimate-audit-build-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const title = btn.dataset.jobTitle;
        if (title) {
          document.getElementById('estimate-job-search').value = title;
          document.querySelector('.estimate-subtab[data-subtab="builder"]').click();
          runEstimateBuilder();
        }
      });
    });

    resultEl.querySelectorAll('.estimate-audit-add-to-ro-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const title = btn.dataset.jobTitle || '';
        const desc = btn.dataset.findingDesc || '';

        const job = {
          title: title,
          name: title,
          description: desc,
          note: desc,
          laborItems: [{ name: title, hours: 1 }],
          parts: []
        };

        btn.disabled = true;
        btn.textContent = 'Adding...';
        // handleAddJob reports failures via its return value (it notifies and
        // swallows errors internally), so check the boolean.
        const ok = await handleAddJob(job);
        if (ok) {
          btn.textContent = 'Added!';
          btn.style.background = '#16a34a';
        } else {
          btn.textContent = 'Failed';
          btn.style.background = '#dc2626';
        }
        setTimeout(() => {
          btn.textContent = '+ Add to RO';
          btn.style.background = '#2563eb';
          btn.disabled = false;
        }, 2000);
      });
    });

  } catch (err) {
    loadingEl.classList.add('hidden');
    resultEl.innerHTML = `<p style="color:#dc2626; font-size:12px; padding:8px;">${escEstimate(err.message || 'Audit failed')}</p>`;
    resultEl.classList.remove('hidden');
  }
}

// ==================== START ====================
init();
initSupportChat();
initEstimateAssist();

// ==================== Detect Dog: Shop Migration Wizard ====================
// Platform-admin-only sidepanel UI that drives the server-side

// ==================== CREATE RO (Protractor) — Task #348 ====================
// Redesigned for full parity with the dashboard Create RO modal
// (components/NewWorkOrderModal.tsx): concern-first flow with the AI assistant +
// multi-concern, customer, vehicle (photo scan / VIN decode / plate lookup),
// notes & mileage, jobs (Canned / Deferred / History tabs), confirm.
// Maps a freshly-created RO's vehicle VIN -> { guid, number, at } so an
// immediate "add job" (VHI Coach or Create RO panel) can target the new
// Protractor work order directly by GUID. Protractor's OData WorkOrderNumber
// search does not return open WOs, and the VIN->cached-WO fallback lags right
// after creation, so without this hint a brand-new RO 404s on add-job.
const recentlyCreatedWoByVin = {};

function getRecentlyCreatedWoGuid(vin, roNumber) {
  if (!vin) return undefined;
  const entry = recentlyCreatedWoByVin[String(vin).toUpperCase()];
  if (!entry || !entry.guid) return undefined;
  // Only trust the hint briefly; after the cache/webhook catches up the normal
  // VIN lookup is authoritative and the RO may have changed state.
  if (Date.now() - (entry.at || 0) > 30 * 60 * 1000) return undefined;
  // Guard against same-VIN, multiple-open-RO mix-ups: if we know which RO is on
  // screen, the captured RO number must match it before we target by GUID.
  // Otherwise the hint is ambiguous, so fall back to the normal lookup.
  if (roNumber != null && String(roNumber).trim() && entry.number != null) {
    if (String(entry.number) !== String(roNumber).trim()) return undefined;
  }
  return entry.guid;
}

const createRoState = {
  initialized: false,
  customer: null,
  vehicle: null, // {id, display, vin, year, make, model}
  submitting: false,
  concerns: [], // saved concern strings (multi-concern)
  cannedJobs: [],
  cannedJobsLoaded: false,
  cannedJobsLoading: false,
  deferred: [],
  deferredLoaded: false,
  deferredLoading: false,
  history: [],
  historySearching: false,
  activeJobsTab: 'canned',
  selectedJobs: [], // [{key, source, title, description?, code?, chapter?, originalWorkOrderId?, deferredId?, lines?}]
};

function escCro(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function getCroEl(id) { return document.getElementById(id); }

// The extension job-search route returns `vehicle` as an object
// ({year,make,model}); older shapes return a plain string. Normalize both to a
// readable label so the UI never prints "[object Object]".
function croVehicleLabel(vehicle) {
  if (!vehicle) return '';
  if (typeof vehicle === 'string') return vehicle;
  if (typeof vehicle === 'object') {
    return [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' ');
  }
  return '';
}

function setCroError(elId, msg) {
  const el = getCroEl(elId);
  if (!el) return;
  if (msg) {
    el.textContent = msg;
    el.classList.remove('hidden');
  } else {
    el.textContent = '';
    el.classList.add('hidden');
  }
}


function mosTelemetry(event, props) {
  // Lightweight structured-log telemetry. Centralized so we can swap in a
  // real analytics push later without changing call sites.
  try {
    console.log('[MOS Telemetry]', event, props || {});
  } catch (_) { /* no-op */ }
}

// A customer-less RO often scrapes a UI button label (e.g. Protractor's
// "Add Customer") instead of a real name. Treat those as "no name" so we don't
// prefill the search box with junk the advisor must erase (Brandon 2026-06-27).
function isPlaceholderCustomerName(name) {
  // Strip leading CTA glyphs/punctuation so "+ Add Customer" matches too.
  const n = String(name || '').trim().replace(/^[\s+\-•·*]+/, '').toLowerCase();
  if (!n) return true;
  return /^(add|select|choose|new)\s+(a\s+)?customer$/.test(n) ||
    n === 'no customer' || n === 'customer';
}

function resetCroState() {
  createRoState.customer = null;
  createRoState.vehicle = null;
  createRoState.submitting = false;
  createRoState.concerns = [];
  createRoState.cannedJobs = [];
  createRoState.cannedJobsLoaded = false;
  createRoState.cannedJobsLoading = false;
  createRoState.deferred = [];
  createRoState.deferredLoaded = false;
  createRoState.deferredLoading = false;
  createRoState.history = [];
  createRoState.historySearching = false;
  createRoState.activeJobsTab = 'canned';
  createRoState.selectedJobs = [];

  ['cro-jobs-search', 'cro-history-search'].forEach(id => {
    const el = getCroEl(id); if (el) el.value = '';
  });
  getCroEl('cro-vehicle-section')?.classList.add('hidden');
  getCroEl('cro-details-section')?.classList.add('hidden');
  getCroEl('cro-jobs-section')?.classList.add('hidden');
  getCroEl('cro-confirm-section')?.classList.add('hidden');
  getCroEl('cro-result-section')?.classList.add('hidden');
  getCroEl('cro-concern-section')?.classList.remove('hidden');
  getCroEl('cro-customer-section')?.classList.remove('hidden');
  getCroEl('cro-customer-search-wrap')?.classList.remove('hidden');

  // Reset jobs tabs + panes.
  setCroJobsTab('canned');
  ['cro-jobs-list', 'cro-jobs-empty', 'cro-jobs-loading', 'cro-jobs-error',
   'cro-deferred-list', 'cro-deferred-empty', 'cro-deferred-loading', 'cro-deferred-error',
   'cro-history-list', 'cro-history-loading', 'cro-history-error'].forEach(id => {
    getCroEl(id)?.classList.add('hidden');
  });

  // Scan/decode status.
  const scanStatus = getCroEl('cro-vehicle-scan-status');
  if (scanStatus) { scanStatus.textContent = ''; scanStatus.classList.add('hidden'); scanStatus.classList.remove('is-error'); }

  const sel = getCroEl('cro-jobs-selected');
  if (sel) { sel.innerHTML = ''; sel.classList.add('hidden'); }
  const concernList = getCroEl('cro-concern-list');
  if (concernList) { concernList.innerHTML = ''; concernList.classList.add('hidden'); }

  ['cro-customer-results', 'cro-vehicle-results'].forEach(id => {
    const el = getCroEl(id);
    if (el) { el.innerHTML = ''; el.classList.add('hidden'); }
  });
  ['cro-customer-empty', 'cro-vehicle-empty', 'cro-customer-error',
   'cro-vehicle-error', 'cro-submit-error'].forEach(id => {
    const el = getCroEl(id); if (el) el.classList.add('hidden');
  });
  ['cro-customer-search', 'cro-new-customer-first', 'cro-new-customer-last',
   'cro-new-customer-phone', 'cro-new-customer-email', 'cro-new-vehicle-vin',
   'cro-new-vehicle-year', 'cro-new-vehicle-make', 'cro-new-vehicle-model',
   'cro-new-vehicle-plate', 'cro-new-vehicle-state', 'cro-concern',
   'cro-mileage', 'cro-note'].forEach(id => {
    const el = getCroEl(id); if (el) el.value = '';
  });
  ['cro-customer-new-form', 'cro-vehicle-new-form'].forEach(id => {
    const el = getCroEl(id); if (el) el.classList.add('hidden');
  });
  getCroEl('cro-customer-picked')?.classList.add('hidden');
  getCroEl('cro-vehicle-picked')?.classList.add('hidden');
}

function initCreateRoTab() {
  if (!createRoState.initialized) {
    bindCreateRoListeners();
    createRoState.initialized = true;
  }
  // Returning from the Concern Assistant: keep the in-progress wizard intact
  // (the cleaned write-up was just placed in cro-concern) and skip the reset +
  // context prefill below.
  if (croPreserveStateOnInit) {
    croPreserveStateOnInit = false;
    return;
  }
  resetCroState();
  mosTelemetry('create_ro_panel_opened_sidepanel', {
    shopId: getCroShopId(),
    sourceProvider: currentContext?.provider || null,
    writeProvider: currentContext?.writeProvider || resolvedWriteProvider || null,
  });
  // Pre-populate from current SMS context if present.
  if (currentContext) {
    if (currentContext.concern) {
      const c = getCroEl('cro-concern');
      if (c) c.value = currentContext.concern;
    }
    // Only prefill an ACTUAL odometer (scraped/entered on the page). A CARFAX
    // estimate (mileageEstimated) must NOT be written into "Mileage in" — that
    // field becomes the RO's official odometer, so leave it blank and let the
    // advisor type the real number rather than committing a guess.
    if (currentContext.mileage && !currentContext.mileageEstimated) {
      const m = getCroEl('cro-mileage');
      if (m) m.value = String(currentContext.mileage).replace(/[^\d]/g, '');
    }
    // Prefill the customer search box with the detected name so advisors don't
    // retype it. They still have to confirm the match.
    const customerName = currentContext.customerName ||
      (currentContext.customer && currentContext.customer.name) || '';
    // Skip placeholder labels scraped from a customer-less RO (e.g. Protractor
    // renders an "Add Customer" button when none is assigned). Pre-filling that
    // forces the advisor to erase junk before typing (Brandon feedback 2026-06-27).
    if (customerName && !isPlaceholderCustomerName(customerName)) {
      const search = getCroEl('cro-customer-search');
      if (search) search.value = customerName;
    }
    // Prefill the new-vehicle VIN field so a one-click "Create new vehicle"
    // doesn't lose the VIN we already detected on the source page.
    const vin = currentContext.vin || currentContext.vehicle?.vin || '';
    if (vin) {
      const vinEl = getCroEl('cro-new-vehicle-vin');
      if (vinEl) vinEl.value = vin;
    }
  }
}

function bindCreateRoListeners() {
  // ---- Concern (multi-concern + AI assistant) ----
  getCroEl('cro-concern-add-btn')?.addEventListener('click', handleCroAddConcern);
  // cro-concern-ai-btn is wired in the main element-binding pass (handleCroConcernAi).

  // ---- Customer ----
  getCroEl('cro-customer-search-btn')?.addEventListener('click', handleCroCustomerSearch);
  getCroEl('cro-customer-search')?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleCroCustomerSearch();
  });
  getCroEl('cro-customer-new-toggle')?.addEventListener('click', () => {
    getCroEl('cro-customer-new-form')?.classList.toggle('hidden');
  });
  getCroEl('cro-new-customer-save')?.addEventListener('click', handleCroCreateCustomer);
  getCroEl('cro-customer-change')?.addEventListener('click', () => {
    createRoState.customer = null;
    createRoState.vehicle = null;
    createRoState.selectedJobs = [];
    renderCroSelectedJobs();
    getCroEl('cro-customer-picked')?.classList.add('hidden');
    getCroEl('cro-customer-search-wrap')?.classList.remove('hidden');
    getCroEl('cro-vehicle-section')?.classList.add('hidden');
    getCroEl('cro-details-section')?.classList.add('hidden');
    getCroEl('cro-jobs-section')?.classList.add('hidden');
    getCroEl('cro-confirm-section')?.classList.add('hidden');
  });

  // ---- Vehicle ----
  getCroEl('cro-vehicle-new-toggle')?.addEventListener('click', () => {
    getCroEl('cro-vehicle-new-form')?.classList.toggle('hidden');
  });
  getCroEl('cro-new-vehicle-save')?.addEventListener('click', handleCroCreateVehicle);
  getCroEl('cro-vehicle-change')?.addEventListener('click', () => {
    createRoState.vehicle = null;
    getCroEl('cro-vehicle-picked')?.classList.add('hidden');
    getCroEl('cro-vehicle-pick-wrap')?.classList.remove('hidden');
    getCroEl('cro-details-section')?.classList.add('hidden');
    getCroEl('cro-jobs-section')?.classList.add('hidden');
    getCroEl('cro-confirm-section')?.classList.add('hidden');
    if (createRoState.customer) loadCroVehicles(createRoState.customer.id);
  });
  getCroEl('cro-vehicle-scan-btn')?.addEventListener('click', () => {
    getCroEl('cro-vehicle-scan-input')?.click();
  });
  getCroEl('cro-vehicle-scan-input')?.addEventListener('change', handleCroScan);
  getCroEl('cro-vehicle-decode-btn')?.addEventListener('click', () => handleCroVinDecode());
  getCroEl('cro-new-vehicle-vin')?.addEventListener('input', (e) => {
    const v = (e.target.value || '').trim();
    if (v.length === 17) handleCroVinDecode();
  });
  getCroEl('cro-vehicle-plate-btn')?.addEventListener('click', handleCroPlateLookup);

  // ---- Jobs tabs ----
  document.querySelectorAll('.cro-jobs-tab').forEach(tab => {
    tab.addEventListener('click', () => setCroJobsTab(tab.dataset.jobsTab));
  });
  const jobsSearchEl = getCroEl('cro-jobs-search');
  if (jobsSearchEl) {
    jobsSearchEl.addEventListener('input', () => {
      renderCroCannedJobs(filterCroCannedJobs(jobsSearchEl.value));
    });
  }
  const historySearchEl = getCroEl('cro-history-search');
  if (historySearchEl) {
    let histTimer = null;
    historySearchEl.addEventListener('input', () => {
      clearTimeout(histTimer);
      histTimer = setTimeout(() => handleCroHistorySearch(historySearchEl.value), 350);
    });
    historySearchEl.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') { clearTimeout(histTimer); handleCroHistorySearch(historySearchEl.value); }
    });
  }

  // ---- Confirm ----
  getCroEl('cro-submit')?.addEventListener('click', handleCroSubmit);
  getCroEl('cro-result-new')?.addEventListener('click', () => initCreateRoTab());
}

function getCroShopId() {
  return currentContext?.shopId || resolvedMosShopId || null;
}

// ==================== CRO: Concern (multi-concern) ====================
function handleCroAddConcern() {
  const box = getCroEl('cro-concern');
  const text = (box?.value || '').trim();
  if (!text) return;
  createRoState.concerns.push(text);
  if (box) box.value = '';
  renderCroConcerns();
  box?.focus();
}

function removeCroConcern(idx) {
  createRoState.concerns.splice(idx, 1);
  renderCroConcerns();
}

function renderCroConcerns() {
  const list = getCroEl('cro-concern-list');
  if (!list) return;
  if (createRoState.concerns.length === 0) {
    list.innerHTML = '';
    list.classList.add('hidden');
    return;
  }
  list.classList.remove('hidden');
  list.innerHTML = createRoState.concerns.map((c, i) => `
    <li>
      <span>${escCro(c)}</span>
      <button class="create-ro-link-btn cro-concern-remove-btn" data-idx="${i}" type="button">Remove</button>
    </li>
  `).join('');
  list.querySelectorAll('.cro-concern-remove-btn').forEach(btn => {
    btn.addEventListener('click', () => removeCroConcern(Number(btn.dataset.idx)));
  });
}

function gatherCroConcerns() {
  const current = (getCroEl('cro-concern')?.value || '').trim();
  const all = [...createRoState.concerns];
  if (current) all.push(current);
  return all;
}

// ==================== CRO: Customer ====================
async function handleCroCustomerSearch() {
  setCroError('cro-customer-error', '');
  const q = (getCroEl('cro-customer-search')?.value || '').trim();
  if (q.length < 2) {
    setCroError('cro-customer-error', 'Type at least 2 characters.');
    return;
  }
  const shopId = getCroShopId();
  if (!shopId) {
    setCroError('cro-customer-error', 'No shop context available.');
    return;
  }
  const listEl = getCroEl('cro-customer-results');
  const emptyEl = getCroEl('cro-customer-empty');
  listEl.innerHTML = '<li>Searching…</li>';
  listEl.classList.remove('hidden');
  emptyEl?.classList.add('hidden');
  try {
    const result = await sendMessage({
      action: 'MOS_API_REQUEST',
      endpoint: `/api/extension/protractor/contacts?shopId=${encodeURIComponent(shopId)}&q=${encodeURIComponent(q)}`
    });
    if (result?.error) throw new Error(result.error);
    const contacts = result?.contacts || [];
    if (!contacts.length) {
      listEl.classList.add('hidden');
      emptyEl?.classList.remove('hidden');
      return;
    }
    listEl.innerHTML = contacts.slice(0, 30).map(c => {
      const name = c.fileAs || `${c.firstName} ${c.lastName}`.trim() || '(no name)';
      const meta = [c.phone, c.email].filter(Boolean).join(' · ');
      return `<li data-cid="${escCro(c.id)}" data-name="${escCro(name)}">
        <strong>${escCro(name)}</strong>
        ${meta ? `<span class="ro-list-meta">${escCro(meta)}</span>` : ''}
      </li>`;
    }).join('');
    listEl.querySelectorAll('li').forEach(li => {
      li.addEventListener('click', () => {
        selectCroCustomer({ id: li.dataset.cid, name: li.dataset.name });
      });
    });
  } catch (err) {
    console.error('[MOS] CRO customer search error:', err);
    listEl.innerHTML = '';
    listEl.classList.add('hidden');
    setCroError('cro-customer-error', err.message || 'Search failed.');
  }
}

async function handleCroCreateCustomer() {
  setCroError('cro-customer-error', '');
  const firstName = (getCroEl('cro-new-customer-first')?.value || '').trim();
  const lastName = (getCroEl('cro-new-customer-last')?.value || '').trim();
  const phone1 = (getCroEl('cro-new-customer-phone')?.value || '').trim();
  const email = (getCroEl('cro-new-customer-email')?.value || '').trim();
  if (!firstName || !lastName) {
    setCroError('cro-customer-error', 'First and last name are required.');
    return;
  }
  const shopId = getCroShopId();
  if (!shopId) { setCroError('cro-customer-error', 'No shop context.'); return; }
  const btn = getCroEl('cro-new-customer-save');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    const result = await sendMessage({
      action: 'MOS_API_REQUEST',
      endpoint: '/api/extension/protractor/create-contact',
      options: {
        method: 'POST',
        body: JSON.stringify({ shopId, firstName, lastName, phone1, email }),
      }
    });
    if (!result?.success) throw new Error(result?.error || 'Create failed');
    selectCroCustomer({
      id: result.contactId,
      name: `${firstName} ${lastName}`.trim(),
    });
  } catch (err) {
    setCroError('cro-customer-error', err.message || 'Could not create customer.');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Save customer'; }
  }
}

function selectCroCustomer(customer) {
  createRoState.customer = customer;
  createRoState.vehicle = null;
  const picked = getCroEl('cro-customer-picked');
  const label = getCroEl('cro-customer-picked-label');
  if (label) label.textContent = '✓ ' + customer.name;
  picked?.classList.remove('hidden');
  getCroEl('cro-customer-search-wrap')?.classList.add('hidden');
  getCroEl('cro-vehicle-section')?.classList.remove('hidden');
  getCroEl('cro-vehicle-picked')?.classList.add('hidden');
  getCroEl('cro-vehicle-pick-wrap')?.classList.remove('hidden');
  loadCroVehicles(customer.id);
}

// ==================== CRO: Vehicle ====================
async function loadCroVehicles(ownerId) {
  setCroError('cro-vehicle-error', '');
  const loadingEl = getCroEl('cro-vehicle-loading');
  const listEl = getCroEl('cro-vehicle-results');
  const emptyEl = getCroEl('cro-vehicle-empty');
  loadingEl?.classList.remove('hidden');
  listEl?.classList.add('hidden');
  emptyEl?.classList.add('hidden');
  const shopId = getCroShopId();
  try {
    const result = await sendMessage({
      action: 'MOS_API_REQUEST',
      endpoint: `/api/extension/protractor/vehicles?shopId=${encodeURIComponent(shopId)}&ownerId=${encodeURIComponent(ownerId)}`
    });
    if (result?.error) throw new Error(result.error);
    const vehicles = result?.vehicles || [];
    loadingEl?.classList.add('hidden');
    if (!vehicles.length) {
      emptyEl?.classList.remove('hidden');
      // Auto-open new-vehicle form to reduce clicks.
      getCroEl('cro-vehicle-new-form')?.classList.remove('hidden');
      return;
    }
    listEl.innerHTML = vehicles.map((v, idx) => {
      const display = [v.year, v.make, v.model].filter(Boolean).join(' ') || v.vin || '(vehicle)';
      const meta = [v.vin && ('VIN ' + v.vin), v.plate].filter(Boolean).join(' · ');
      return `<li data-vidx="${idx}">
        <strong>${escCro(display)}</strong>
        ${meta ? `<span class="ro-list-meta">${escCro(meta)}</span>` : ''}
      </li>`;
    }).join('');
    listEl.classList.remove('hidden');
    listEl.querySelectorAll('li').forEach(li => {
      li.addEventListener('click', () => {
        const v = vehicles[Number(li.dataset.vidx)];
        if (!v) return;
        const display = [v.year, v.make, v.model].filter(Boolean).join(' ') || v.vin || '(vehicle)';
        selectCroVehicle({
          id: v.id, display, vin: v.vin || '',
          year: v.year || '', make: v.make || '', model: v.model || '',
        });
      });
    });
  } catch (err) {
    console.error('[MOS] CRO vehicle load error:', err);
    loadingEl?.classList.add('hidden');
    setCroError('cro-vehicle-error', err.message || 'Could not load vehicles.');
  }
}

function setCroScanStatus(msg, isError) {
  const el = getCroEl('cro-vehicle-scan-status');
  if (!el) return;
  if (!msg) { el.textContent = ''; el.classList.add('hidden'); el.classList.remove('is-error'); return; }
  el.textContent = msg;
  el.classList.remove('hidden');
  el.classList.toggle('is-error', !!isError);
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error('Could not read image file.'));
    reader.readAsDataURL(file);
  });
}

async function handleCroScan(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = ''; // allow re-selecting the same file
  if (!file) return;
  const shopId = getCroShopId();
  if (!shopId) { setCroScanStatus('No shop context.', true); return; }
  setCroScanStatus('Reading photo…');
  try {
    const imageBase64 = await readFileAsBase64(file);
    setCroScanStatus('Scanning VIN / plate…');
    const result = await sendMessage({
      action: 'MOS_API_REQUEST',
      endpoint: '/api/extension/protractor/vin-plate-ocr',
      options: {
        method: 'POST',
        body: JSON.stringify({ shopId, imageBase64, mimeType: file.type || 'image/jpeg', type: 'auto' }),
      }
    });
    if (result?.error) throw new Error(result.error);
    // The OCR route returns { success, result: { type, vin, plate, state, ... } }.
    const ocr = result?.result || result || {};
    const vin = (ocr.vin || '').trim().toUpperCase();
    const plate = (ocr.plate || '').trim().toUpperCase();
    const state = (ocr.state || '').trim().toUpperCase();
    if (vin) {
      const vinEl = getCroEl('cro-new-vehicle-vin');
      if (vinEl) vinEl.value = vin;
      setCroScanStatus('VIN detected — decoding…');
      await handleCroVinDecode();
      return;
    }
    if (plate) {
      const plateEl = getCroEl('cro-new-vehicle-plate');
      if (plateEl) plateEl.value = plate;
      if (state) { const sEl = getCroEl('cro-new-vehicle-state'); if (sEl) sEl.value = state; }
      setCroScanStatus('Plate detected — looking up…');
      await handleCroPlateLookup();
      return;
    }
    setCroScanStatus('No VIN or plate found in the photo.', true);
  } catch (err) {
    console.error('[MOS] CRO scan error:', err);
    setCroScanStatus(err.message || 'Scan failed.', true);
  }
}

async function handleCroVinDecode() {
  const vin = (getCroEl('cro-new-vehicle-vin')?.value || '').trim().toUpperCase();
  if (vin.length !== 17) { setCroScanStatus('Enter a full 17-character VIN to decode.', true); return; }
  const shopId = getCroShopId();
  if (!shopId) { setCroScanStatus('No shop context.', true); return; }
  const btn = getCroEl('cro-vehicle-decode-btn');
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  setCroScanStatus('Decoding VIN…');
  try {
    const result = await sendMessage({
      action: 'MOS_API_REQUEST',
      endpoint: `/api/extension/protractor/vin-decode?shopId=${encodeURIComponent(shopId)}&vin=${encodeURIComponent(vin)}`
    });
    if (result?.error) throw new Error(result.error);
    const v = result?.vehicle || result || {};
    const year = v.year || '';
    const make = v.make || '';
    const model = v.model || '';
    if (year) { const el = getCroEl('cro-new-vehicle-year'); if (el) el.value = year; }
    if (make) { const el = getCroEl('cro-new-vehicle-make'); if (el) el.value = make; }
    if (model) { const el = getCroEl('cro-new-vehicle-model'); if (el) el.value = model; }
    if (year || make || model) {
      setCroScanStatus(`Decoded: ${[year, make, model].filter(Boolean).join(' ')}`);
    } else {
      setCroScanStatus('VIN could not be decoded. Enter details manually.', true);
    }
  } catch (err) {
    console.error('[MOS] CRO VIN decode error:', err);
    setCroScanStatus(err.message || 'VIN decode failed.', true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Decode'; }
  }
}

async function handleCroPlateLookup() {
  const plate = (getCroEl('cro-new-vehicle-plate')?.value || '').trim().toUpperCase();
  const state = (getCroEl('cro-new-vehicle-state')?.value || '').trim().toUpperCase();
  if (!plate) { setCroScanStatus('Enter a license plate first.', true); return; }
  if (!state) { setCroScanStatus('Enter the 2-letter state for the plate.', true); return; }
  const shopId = getCroShopId();
  if (!shopId) { setCroScanStatus('No shop context.', true); return; }
  const btn = getCroEl('cro-vehicle-plate-btn');
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  setCroScanStatus('Looking up plate…');
  try {
    const result = await sendMessage({
      action: 'MOS_API_REQUEST',
      endpoint: '/api/extension/protractor/plate-lookup',
      options: { method: 'POST', body: JSON.stringify({ shopId, plate, state }) }
    });
    if (result?.error) throw new Error(result.error);
    const v = result?.vehicle || result || {};
    const vin = (v.vin || '').toUpperCase();
    if (vin) { const el = getCroEl('cro-new-vehicle-vin'); if (el) el.value = vin; }
    if (v.year) { const el = getCroEl('cro-new-vehicle-year'); if (el) el.value = v.year; }
    if (v.make) { const el = getCroEl('cro-new-vehicle-make'); if (el) el.value = v.make; }
    if (v.model) { const el = getCroEl('cro-new-vehicle-model'); if (el) el.value = v.model; }
    if (vin || v.year || v.make || v.model) {
      setCroScanStatus(`Found: ${[v.year, v.make, v.model].filter(Boolean).join(' ') || vin}`);
    } else {
      setCroScanStatus('No vehicle found for that plate.', true);
    }
  } catch (err) {
    console.error('[MOS] CRO plate lookup error:', err);
    setCroScanStatus(err.message || 'Plate lookup failed.', true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Look up'; }
  }
}

async function handleCroCreateVehicle() {
  setCroError('cro-vehicle-error', '');
  if (!createRoState.customer) {
    setCroError('cro-vehicle-error', 'Pick a customer first.');
    return;
  }
  const vin = (getCroEl('cro-new-vehicle-vin')?.value || '').trim();
  const yearStr = (getCroEl('cro-new-vehicle-year')?.value || '').trim();
  const make = (getCroEl('cro-new-vehicle-make')?.value || '').trim();
  const model = (getCroEl('cro-new-vehicle-model')?.value || '').trim();
  const plate = (getCroEl('cro-new-vehicle-plate')?.value || '').trim();
  if (!vin && !(yearStr && make && model)) {
    setCroError('cro-vehicle-error', 'Enter a VIN or year/make/model.');
    return;
  }
  const shopId = getCroShopId();
  const btn = getCroEl('cro-new-vehicle-save');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    const result = await sendMessage({
      action: 'MOS_API_REQUEST',
      endpoint: '/api/extension/protractor/create-vehicle',
      options: {
        method: 'POST',
        body: JSON.stringify({
          shopId,
          ownerId: createRoState.customer.id,
          vin: vin || undefined,
          year: yearStr ? Number(yearStr) : undefined,
          make: make || undefined,
          model: model || undefined,
          licensePlate: plate || undefined,
        }),
      }
    });
    if (!result?.success) throw new Error(result?.error || 'Create failed');
    const display = [yearStr, make, model].filter(Boolean).join(' ') || vin || 'New vehicle';
    selectCroVehicle({ id: result.vehicleId, display, vin, year: yearStr, make, model });
  } catch (err) {
    setCroError('cro-vehicle-error', err.message || 'Could not create vehicle.');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Save vehicle'; }
  }
}

function selectCroVehicle(vehicle) {
  createRoState.vehicle = vehicle;
  // A new vehicle invalidates the vehicle-scoped deferred-work cache.
  createRoState.deferred = [];
  createRoState.deferredLoaded = false;
  const picked = getCroEl('cro-vehicle-picked');
  const label = getCroEl('cro-vehicle-picked-label');
  if (label) label.textContent = '✓ ' + vehicle.display;
  picked?.classList.remove('hidden');
  getCroEl('cro-vehicle-pick-wrap')?.classList.add('hidden');
  getCroEl('cro-details-section')?.classList.remove('hidden');
  getCroEl('cro-jobs-section')?.classList.remove('hidden');
  getCroEl('cro-confirm-section')?.classList.remove('hidden');
  setCroScanStatus('');
  renderCroConfirmSummary();
  // Default to the canned tab and lazy-load it.
  setCroJobsTab('canned');
}

// ==================== CRO: Jobs (Canned / Deferred / History) ====================
function setCroJobsTab(tab) {
  createRoState.activeJobsTab = tab;
  document.querySelectorAll('.cro-jobs-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.jobsTab === tab);
  });
  getCroEl('cro-jobs-pane-canned')?.classList.toggle('hidden', tab !== 'canned');
  getCroEl('cro-jobs-pane-deferred')?.classList.toggle('hidden', tab !== 'deferred');
  getCroEl('cro-jobs-pane-history')?.classList.toggle('hidden', tab !== 'history');
  if (tab === 'canned') loadCroCannedJobs();
  else if (tab === 'deferred') loadCroDeferredWork();
  else if (tab === 'history') {
    const empty = getCroEl('cro-history-empty');
    if (!createRoState.history.length && !createRoState.historySearching) empty?.classList.remove('hidden');
  }
}

// ---- selected-jobs model (cross-source) ----
function croJobKey(source, ident) {
  return `${source}:${String(ident || '')}`;
}

function isCroJobSelected(key) {
  return createRoState.selectedJobs.some(j => j.key === key);
}

function addCroSelectedJob(job) {
  if (!job.key || isCroJobSelected(job.key)) return;
  createRoState.selectedJobs.push(job);
  renderCroSelectedJobs();
  renderCroConfirmSummary();
  refreshActiveCroJobsList();
}

function removeCroJob(key) {
  createRoState.selectedJobs = createRoState.selectedJobs.filter(j => j.key !== key);
  renderCroSelectedJobs();
  renderCroConfirmSummary();
  refreshActiveCroJobsList();
}

function refreshActiveCroJobsList() {
  if (createRoState.activeJobsTab === 'canned') {
    renderCroCannedJobs(filterCroCannedJobs(getCroEl('cro-jobs-search')?.value || ''));
  } else if (createRoState.activeJobsTab === 'deferred') {
    renderCroDeferred();
  } else if (createRoState.activeJobsTab === 'history') {
    renderCroHistory();
  }
}

function renderCroSelectedJobs() {
  const sel = getCroEl('cro-jobs-selected');
  if (!sel) return;
  if (createRoState.selectedJobs.length === 0) {
    sel.innerHTML = '';
    sel.classList.add('hidden');
    return;
  }
  sel.classList.remove('hidden');
  sel.innerHTML = `
    <div class="create-ro-jobs-selected-head">Selected jobs (${createRoState.selectedJobs.length})</div>
    <ul class="create-ro-jobs-selected-list">
      ${createRoState.selectedJobs.map(j => `
        <li>
          <span>${escCro(j.title)}</span>
          <button class="create-ro-link-btn cro-job-remove-btn" data-key="${escCro(j.key)}" type="button">Remove</button>
        </li>
      `).join('')}
    </ul>
  `;
  sel.querySelectorAll('.cro-job-remove-btn').forEach(btn => {
    btn.addEventListener('click', () => removeCroJob(btn.dataset.key));
  });
}

// ---- Canned tab ----
async function loadCroCannedJobs() {
  if (createRoState.cannedJobsLoaded || createRoState.cannedJobsLoading) {
    renderCroCannedJobs(filterCroCannedJobs(getCroEl('cro-jobs-search')?.value || ''));
    return;
  }
  const shopId = getCroShopId();
  if (!shopId) return;
  setCroError('cro-jobs-error', '');
  createRoState.cannedJobsLoading = true;
  getCroEl('cro-jobs-loading')?.classList.remove('hidden');
  getCroEl('cro-jobs-empty')?.classList.add('hidden');
  getCroEl('cro-jobs-list')?.classList.add('hidden');
  try {
    const result = await sendMessage({
      action: 'MOS_API_REQUEST',
      endpoint: `/api/extension/canned-jobs?shopId=${encodeURIComponent(shopId)}&provider=protractor`,
    });
    if (result?.error || result?.success === false) {
      throw new Error(result?.error || 'Failed to load canned jobs');
    }
    createRoState.cannedJobs = result?.jobs || [];
    createRoState.cannedJobsLoaded = true;
    renderCroCannedJobs(filterCroCannedJobs(getCroEl('cro-jobs-search')?.value || ''));
  } catch (err) {
    console.error('[MOS] CRO canned jobs load error:', err);
    setCroError('cro-jobs-error', err.message || 'Could not load canned jobs.');
  } finally {
    createRoState.cannedJobsLoading = false;
    getCroEl('cro-jobs-loading')?.classList.add('hidden');
  }
}

function filterCroCannedJobs(term) {
  const t = (term || '').toLowerCase().trim();
  if (!t) return createRoState.cannedJobs;
  const words = t.split(/\s+/).filter(w => w.length > 1);
  return createRoState.cannedJobs.filter(j => {
    const name = (j.name || '').toLowerCase();
    const desc = (j.description || '').toLowerCase();
    const combined = name + ' ' + desc;
    if (name.includes(t) || desc.includes(t)) return true;
    return words.length > 0 && words.every(w => combined.includes(w));
  });
}

function cannedJobKey(job) {
  return String(job.id || job.tekmetricId || job.code || job.name || '');
}

function renderCroCannedJobs(jobs) {
  const listEl = getCroEl('cro-jobs-list');
  const emptyEl = getCroEl('cro-jobs-empty');
  if (!listEl) return;
  if (!jobs || jobs.length === 0) {
    listEl.classList.add('hidden');
    listEl.innerHTML = '';
    emptyEl?.classList.remove('hidden');
    return;
  }
  emptyEl?.classList.add('hidden');
  listEl.classList.remove('hidden');
  listEl.innerHTML = jobs.slice(0, 100).map((job, idx) => {
    const added = isCroJobSelected(croJobKey('canned', cannedJobKey(job)));
    return `
      <li class="job-item">
        <div class="job-header" style="cursor: default;">
          <div>
            <div class="job-title">${escCro(job.name || '(unnamed job)')}</div>
            ${job.description ? `<div class="job-meta">${escCro(job.description)}</div>` : ''}
          </div>
          <button class="btn-add cro-canned-add-btn" data-job-idx="${idx}" ${added ? 'disabled' : ''}>${added ? 'Added' : '+ Add'}</button>
        </div>
      </li>
    `;
  }).join('');
  listEl.querySelectorAll('.cro-canned-add-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const job = jobs[Number(btn.dataset.jobIdx)];
      if (!job) return;
      addCroSelectedJob({
        key: croJobKey('canned', cannedJobKey(job)),
        source: 'canned',
        title: job.name || job.title || 'Job',
        code: job.code ? String(job.code) : undefined,
        deferredId: job.id ? String(job.id) : undefined,
      });
    });
  });
}

// ---- Deferred tab ----
async function loadCroDeferredWork() {
  if (createRoState.deferredLoaded || createRoState.deferredLoading) {
    renderCroDeferred();
    return;
  }
  const shopId = getCroShopId();
  const vehicle = createRoState.vehicle;
  if (!shopId || !vehicle) return;
  if (!vehicle.vin || !vehicle.id) {
    setCroError('cro-deferred-error', 'Deferred work needs a vehicle VIN on file.');
    getCroEl('cro-deferred-list')?.classList.add('hidden');
    getCroEl('cro-deferred-empty')?.classList.add('hidden');
    return;
  }
  setCroError('cro-deferred-error', '');
  createRoState.deferredLoading = true;
  getCroEl('cro-deferred-loading')?.classList.remove('hidden');
  getCroEl('cro-deferred-empty')?.classList.add('hidden');
  getCroEl('cro-deferred-list')?.classList.add('hidden');
  try {
    const result = await sendMessage({
      action: 'MOS_API_REQUEST',
      endpoint: `/api/extension/protractor/deferred-work?shopId=${encodeURIComponent(shopId)}&vin=${encodeURIComponent(vehicle.vin)}&serviceItemId=${encodeURIComponent(vehicle.id)}`,
    });
    if (result?.error) throw new Error(result.error);
    createRoState.deferred = result?.items || [];
    createRoState.deferredLoaded = true;
    renderCroDeferred();
  } catch (err) {
    console.error('[MOS] CRO deferred work load error:', err);
    setCroError('cro-deferred-error', err.message || 'Could not load deferred work.');
  } finally {
    createRoState.deferredLoading = false;
    getCroEl('cro-deferred-loading')?.classList.add('hidden');
  }
}

function renderCroDeferred() {
  const listEl = getCroEl('cro-deferred-list');
  const emptyEl = getCroEl('cro-deferred-empty');
  if (!listEl) return;
  const items = createRoState.deferred;
  if (!items || items.length === 0) {
    listEl.classList.add('hidden');
    listEl.innerHTML = '';
    emptyEl?.classList.remove('hidden');
    return;
  }
  emptyEl?.classList.add('hidden');
  listEl.classList.remove('hidden');
  listEl.innerHTML = items.map((item, idx) => {
    const added = isCroJobSelected(croJobKey('deferred', item.id || item.title));
    const meta = [
      item.date ? new Date(item.date).toLocaleDateString() : '',
      item.lines && item.lines.length ? `${item.lines.length} line${item.lines.length !== 1 ? 's' : ''}` : '',
    ].filter(Boolean).join(' · ');
    return `
      <li class="job-item">
        <div class="job-header" style="cursor: default;">
          <div>
            <div class="job-title">${escCro(item.title || 'Deferred job')}</div>
            ${meta ? `<div class="job-meta">${escCro(meta)}</div>` : ''}
          </div>
          <button class="btn-add cro-deferred-add-btn" data-idx="${idx}" ${added ? 'disabled' : ''}>${added ? 'Added' : '+ Add'}</button>
        </div>
      </li>
    `;
  }).join('');
  listEl.querySelectorAll('.cro-deferred-add-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = items[Number(btn.dataset.idx)];
      if (!item) return;
      addCroSelectedJob({
        key: croJobKey('deferred', item.id || item.title),
        source: 'deferred',
        title: item.title || 'Deferred job',
        description: item.description || undefined,
        code: item.code || undefined,
        chapter: item.chapter || 'Service',
        originalWorkOrderId: item.originalWorkOrderId || undefined,
        deferredId: item.id || undefined,
        lines: item.lines && item.lines.length ? item.lines : undefined,
      });
    });
  });
}

// ---- History tab ----
async function handleCroHistorySearch(term) {
  const q = (term || '').trim();
  const listEl = getCroEl('cro-history-list');
  const emptyEl = getCroEl('cro-history-empty');
  const loadingEl = getCroEl('cro-history-loading');
  setCroError('cro-history-error', '');
  if (q.length < 2) {
    createRoState.history = [];
    listEl?.classList.add('hidden');
    if (listEl) listEl.innerHTML = '';
    emptyEl?.classList.remove('hidden');
    return;
  }
  const shopId = getCroShopId();
  if (!shopId) { setCroError('cro-history-error', 'No shop context.'); return; }
  createRoState.historySearching = true;
  loadingEl?.classList.remove('hidden');
  emptyEl?.classList.add('hidden');
  listEl?.classList.add('hidden');
  try {
    const vehicle = createRoState.vehicle || {};
    const params = new URLSearchParams({ shopId: String(shopId), q });
    if (vehicle.vin) params.set('vin', vehicle.vin);
    if (vehicle.year) params.set('year', String(vehicle.year));
    if (vehicle.make) params.set('make', vehicle.make);
    if (vehicle.model) params.set('model', vehicle.model);
    const result = await sendMessage({
      action: 'MOS_API_REQUEST',
      endpoint: `/api/extension/jobs/search?${params.toString()}`,
    }, 48000);
    if (result?.error) throw new Error(result.error);
    createRoState.history = result?.jobs || [];
    renderCroHistory();
  } catch (err) {
    console.error('[MOS] CRO history search error:', err);
    setCroError('cro-history-error', err.message || 'History search failed.');
  } finally {
    createRoState.historySearching = false;
    loadingEl?.classList.add('hidden');
  }
}

function croHistoryDetailHtml(job) {
  const rows = [];
  if (job.matchReason) rows.push(`<div class="cro-detail-row"><span class="cro-detail-k">Match:</span> ${escCro(job.matchReason)}</div>`);
  const veh = croVehicleLabel(job.vehicle);
  if (veh) rows.push(`<div class="cro-detail-row"><span class="cro-detail-k">Vehicle:</span> ${escCro(veh)}</div>`);
  if (job.workOrderNumber) rows.push(`<div class="cro-detail-row"><span class="cro-detail-k">RO #:</span> ${escCro(String(job.workOrderNumber))}</div>`);
  const labor = Array.isArray(job.laborItems) ? job.laborItems : [];
  if (labor.length) {
    rows.push('<div class="cro-detail-sub">Labor</div>');
    labor.forEach((l) => {
      const hrs = l.hours ? ` — ${l.hours} hr` : '';
      rows.push(`<div class="cro-detail-line">${escCro(l.name || 'Labor')}${escCro(hrs)}</div>`);
    });
  }
  const parts = Array.isArray(job.parts) ? job.parts : [];
  if (parts.length) {
    rows.push('<div class="cro-detail-sub">Parts</div>');
    parts.forEach((p) => {
      const qty = p.quantity ? `${p.quantity}× ` : '';
      const brand = p.brand ? ` (${p.brand})` : '';
      const price = p.retail ? ` — $${Number(p.retail).toFixed(2)}` : '';
      rows.push(`<div class="cro-detail-line">${escCro(qty)}${escCro(p.name || 'Part')}${escCro(brand)}${escCro(price)}</div>`);
    });
  }
  const t = job.totals || {};
  if (t.totalAmount) rows.push(`<div class="cro-detail-row" style="margin-top:4px;"><span class="cro-detail-k">Total:</span> $${Number(t.totalAmount).toFixed(2)}</div>`);
  if (!rows.length) return '<div class="cro-detail-row" style="color:#6b7280;">No additional detail available.</div>';
  return rows.join('');
}

function renderCroHistory() {
  const listEl = getCroEl('cro-history-list');
  const emptyEl = getCroEl('cro-history-empty');
  if (!listEl) return;
  const jobs = createRoState.history;
  if (!jobs || jobs.length === 0) {
    listEl.classList.add('hidden');
    listEl.innerHTML = '';
    if (emptyEl) { emptyEl.textContent = 'No matching past jobs.'; emptyEl.classList.remove('hidden'); }
    return;
  }
  emptyEl?.classList.add('hidden');
  listEl.classList.remove('hidden');
  listEl.innerHTML = jobs.slice(0, 50).map((job, idx) => {
    const title = job.title || job.description || 'Job';
    const added = isCroJobSelected(croJobKey('history', title));
    const band = job.matchBand || 'poor';
    const bandLabel = job.matchBandLabel || '';
    const score = typeof job.matchScore === 'number' ? job.matchScore : null;
    const vehLabel = croVehicleLabel(job.vehicle);
    const loc = job.location ? `📍 ${job.location}` : '';
    return `
      <li class="job-item">
        <div class="job-header cro-history-header" data-idx="${idx}">
          <div class="cro-history-headleft">
            <span class="cro-history-caret" data-idx="${idx}">▸</span>
            <div style="min-width:0;">
              <div class="job-title">${escCro(title)}</div>
              <div class="cro-history-badges">
                ${bandLabel ? `<span class="match-badge ${getBandStyle(band)}">${escCro(bandLabel)}</span>` : ''}
                ${score !== null ? `<span class="match-score">${score}%</span>` : ''}
              </div>
              ${vehLabel ? `<div class="job-meta">${escCro(vehLabel)}</div>` : ''}
              ${loc ? `<div class="job-location">${escCro(loc)}</div>` : ''}
            </div>
          </div>
          <button class="btn-add cro-history-add-btn" data-idx="${idx}" ${added ? 'disabled' : ''}>${added ? 'Added' : '+ Add'}</button>
        </div>
        <div class="cro-history-detail hidden" data-detail="${idx}">${croHistoryDetailHtml(job)}</div>
      </li>
    `;
  }).join('');
  listEl.querySelectorAll('.cro-history-header').forEach(h => {
    h.addEventListener('click', (e) => {
      if (e.target.closest('.cro-history-add-btn')) return;
      const idx = h.dataset.idx;
      const detail = listEl.querySelector(`[data-detail="${idx}"]`);
      const caret = h.querySelector('.cro-history-caret');
      if (!detail) return;
      const nowHidden = detail.classList.toggle('hidden');
      if (caret) caret.textContent = nowHidden ? '▸' : '▾';
    });
  });
  listEl.querySelectorAll('.cro-history-add-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const job = jobs[Number(btn.dataset.idx)];
      if (!job) return;
      const title = job.title || job.description || 'Job';
      addCroSelectedJob({
        key: croJobKey('history', title),
        source: 'history',
        title,
        description: job.description || undefined,
        code: job.code ? String(job.code) : undefined,
        chapter: 'Service',
        lines: Array.isArray(job.lines) && job.lines.length ? job.lines : undefined,
      });
    });
  });
}

// ==================== CRO: Confirm + submit ====================
function renderCroConfirmSummary() {
  const host = getCroEl('cro-confirm-summary');
  if (!host) return;
  const concerns = gatherCroConcerns();
  const rows = [];
  rows.push(`<div class="cro-confirm-row"><strong>Customer:</strong> ${escCro(createRoState.customer?.name || '—')}</div>`);
  rows.push(`<div class="cro-confirm-row"><strong>Vehicle:</strong> ${escCro(createRoState.vehicle?.display || '—')}</div>`);
  rows.push(`<div class="cro-confirm-row"><strong>Concerns:</strong> ${concerns.length}</div>`);
  rows.push(`<div class="cro-confirm-row"><strong>Jobs:</strong> ${createRoState.selectedJobs.length}</div>`);
  host.innerHTML = rows.join('');
}

function renderCroSuccessLinks(result) {
  const host = getCroEl('cro-result-section');
  if (!host) return;
  let linksRow = host.querySelector('.create-ro-success-links');
  if (linksRow) linksRow.remove();
  linksRow = document.createElement('div');
  linksRow.className = 'create-ro-success-links';
  linksRow.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;justify-content:center;margin-top:6px;';

  // We intentionally do NOT add an "Open in Protractor" deep link here. The
  // Protractor portal URL lands on a sign-in screen and can't reliably open the
  // specific work order, so the link was misleading. The RO number is shown in
  // the success detail instead.
  const autoflowUrl = currentContext?.url || currentContext?.ticketUrl || null;
  const isAutoflow = currentContext?.provider === 'autoflow' && autoflowUrl;
  if (isAutoflow) {
    const afLink = document.createElement('a');
    afLink.href = autoflowUrl;
    afLink.target = '_blank';
    afLink.rel = 'noopener noreferrer';
    afLink.textContent = 'Back to AutoFlow';
    afLink.style.cssText = 'font-size:12px;color:#2563eb;text-decoration:underline;';
    linksRow.appendChild(afLink);
  }

  const successBox = host.querySelector('.create-ro-success');
  const detail = getCroEl('cro-result-detail');
  if (successBox && detail) {
    detail.insertAdjacentElement('afterend', linksRow);
  } else if (successBox) {
    successBox.appendChild(linksRow);
  }
}

async function handleCroSubmit() {
  if (createRoState.submitting) return;
  setCroError('cro-submit-error', '');
  if (!createRoState.customer || !createRoState.vehicle) {
    setCroError('cro-submit-error', 'Pick a customer and vehicle first.');
    return;
  }
  const shopId = getCroShopId();
  if (!shopId) { setCroError('cro-submit-error', 'No shop context.'); return; }
  const concerns = gatherCroConcerns();
  const note = (getCroEl('cro-note')?.value || '').trim();
  const mileageStr = (getCroEl('cro-mileage')?.value || '').trim();
  const mileage = mileageStr ? Number(mileageStr.replace(/[^\d]/g, '')) : undefined;

  const btn = getCroEl('cro-submit');
  createRoState.submitting = true;
  if (btn) { btn.disabled = true; btn.textContent = 'Creating…'; }
  mosTelemetry('create_ro_submit_started', {
    shopId,
    sourceProvider: currentContext?.provider || null,
    concernCount: concerns.length,
    hasMileage: !!mileage,
    jobCount: createRoState.selectedJobs.length,
  });
  try {
    const result = await sendMessage({
      action: 'MOS_API_REQUEST',
      endpoint: '/api/extension/protractor/create-work-order',
      options: {
        method: 'POST',
        // Creating the RO runs several slow upstream calls server-side
        // (open-WO lookup, vehicle-by-VIN, line resolution from job_index,
        // then the Protractor write). The default 45s proxy cap can trip on
        // big shops, so give this write a wider 120s window.
        timeoutMs: 120000,
        body: JSON.stringify({
          shopId,
          contactId: createRoState.customer.id,
          vehicleId: createRoState.vehicle.id,
          vin: createRoState.vehicle.vin || undefined,
          concerns: concerns.length ? concerns : undefined,
          note: note || undefined,
          mileage,
          servicePackages: createRoState.selectedJobs.length > 0
            ? createRoState.selectedJobs.map(j => ({
                title: j.title,
                source: j.source,
                description: j.description || undefined,
                code: j.code || undefined,
                chapter: j.chapter || undefined,
                originalWorkOrderId: j.originalWorkOrderId || undefined,
                deferredId: j.deferredId || undefined,
                lines: j.lines || undefined,
              }))
            : undefined,
        }),
      }
    }, 125000, 'Still creating the repair order — big shops can take a minute or two. Please keep this panel open…');
    if (!result?.ok && !result?.success) throw new Error(result?.error || 'Create failed');
    try {
      const createdVin = (createRoState.vehicle?.vin || '').toUpperCase();
      if (createdVin && result.workOrderId) {
        recentlyCreatedWoByVin[createdVin] = {
          guid: result.workOrderId,
          number: result.workOrderNumber || null,
          at: Date.now(),
        };
      }
    } catch (_) {}
    const detail = getCroEl('cro-result-detail');
    if (detail) {
      const num = result.workOrderNumber || result.workOrderId;
      const created = num ? `RO #${num} created in Protractor.` : 'Work order created in Protractor.';
      detail.textContent = `${created} It may take a moment to appear in the MOS dashboard.`;
    }
    renderCroSuccessLinks(result);
    getCroEl('cro-concern-section')?.classList.add('hidden');
    getCroEl('cro-customer-section')?.classList.add('hidden');
    getCroEl('cro-vehicle-section')?.classList.add('hidden');
    getCroEl('cro-details-section')?.classList.add('hidden');
    getCroEl('cro-jobs-section')?.classList.add('hidden');
    getCroEl('cro-confirm-section')?.classList.add('hidden');
    getCroEl('cro-result-section')?.classList.remove('hidden');
    mosTelemetry('create_ro_succeeded', {
      shopId,
      workOrderId: result.workOrderId || null,
      workOrderNumber: result.workOrderNumber || null,
    });
  } catch (err) {
    console.error('[MOS] CRO submit error:', err);
    setCroError('cro-submit-error', err.message || 'Could not create RO.');
    mosTelemetry('create_ro_failed', {
      shopId,
      error: err?.message || 'unknown',
    });
  } finally {
    createRoState.submitting = false;
    if (btn) { btn.disabled = false; btn.textContent = 'Create Repair Order'; }
  }
}
