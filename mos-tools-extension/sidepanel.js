// MOS Tools Side Panel Application

// ==================== STATE ====================
let isAuthenticated = false;
let currentContext = null;
let currentTab = 'plan';
let userDefaultTab = null;
let shopwareAddMode = 'finding-published';
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
  concern_assistant: false
};
let concernState = {
  concern: '',
  conversationId: null,
  questions: [],
  exchanges: [],
  cleanedText: ''
};

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
  apiUrlInput: document.getElementById('api-url'),
  loginError: document.getElementById('login-error'),
  
  // Header
  logoutBtn: document.getElementById('logout-btn'),
  
  // Context
  noContext: document.getElementById('no-context'),
  hasContext: document.getElementById('has-context'),
  vehicleDisplay: document.getElementById('vehicle-display'),
  roDisplay: document.getElementById('ro-display'),
  mileageDisplay: document.getElementById('mileage-display'),
  
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
  concernError: document.getElementById('concern-error')
};

// ==================== INITIALIZATION ====================
async function init() {
  const authStatus = await sendMessage({ action: 'GET_MOS_AUTH' });
  
  if (authStatus.isAuthenticated) {
    isAuthenticated = true;

    if (authStatus.defaultExtensionTab) {
      userDefaultTab = authStatus.defaultExtensionTab;
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

function setupEventListeners() {
  // Login form
  elements.loginForm.addEventListener('submit', handleLogin);
  
  // Logout
  elements.logoutBtn.addEventListener('click', handleLogout);
  
  // Tab navigation - allow clicking locked tabs to show upgrade overlay
  elements.tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      switchTab(btn.dataset.tab);
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
}

function showMainState() {
  elements.loadingState.classList.add('hidden');
  elements.loginState.classList.add('hidden');
  elements.mainState.classList.remove('hidden');
  showSupportFab();
}

const RO_INDEPENDENT_TABS = ['rates', 'concern'];

function switchTab(tab) {
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
    'lookup': 'job_lookup',
    'canned': null,
    'rates': 'labor_rates',
    'concern': 'concern_assistant',
    'sticker': 'oil_sticker',
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
          'plan': 'Maintenance Recommendations',
          'failures': 'Common Failures Advisor',
          'lookup': 'Job Lookup / History Writer',
          'rates': 'Labor Rate Rules',
          'concern': 'Customer Concern Assistant',
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
            <p class="upgrade-message">This feature is not included in your current plan.</p>
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
          <p class="upgrade-message">Open a repair order in Tekmetric to use this feature.</p>
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
  } else if (tab === 'canned' && currentContext?.roId) {
    loadCannedJobs();
  } else if (tab === 'rates') {
    loadLaborRates();
  } else if (tab === 'sticker' && currentContext?.roId) {
    loadKeytagSection();
    loadStickerConfig();
  } else if (tab === 'specs') {
    loadVehicleSpecs();
  }
}

function updateContext(context) {
  const prevContext = currentContext;
  currentContext = context;
  
  if (prevContext && context && prevContext.roId === context.roId && prevContext.shopId === context.shopId) {
    if (prevContext.vehicle && !context.vehicle) currentContext.vehicle = prevContext.vehicle;
    if (prevContext.vehicleDisplay && !context.vehicleDisplay) currentContext.vehicleDisplay = prevContext.vehicleDisplay;
    if (prevContext.vin && !context.vin) currentContext.vin = prevContext.vin;
    if (prevContext.mileage && !context.mileage) currentContext.mileage = prevContext.mileage;
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
      const roLabel = context.provider === 'protractor' ? 'WO' : 'RO';
      elements.roDisplay.textContent = `${roLabel} #${context.roNumber || context.roId}`;
      
      if (context.mileage) {
        elements.mileageDisplay.textContent = `${context.mileage.toLocaleString()} mi`;
        elements.mileageDisplay.classList.remove('hidden');
        if (context.mileageEstimated) {
          elements.mileageDisplay.classList.add('mileage-estimated');
          const details = context.mileageEstimateDetails;
          elements.mileageDisplay.title = details
            ? `Estimated from CARFAX (${details.dataPoints} data points)\nLast recorded: ${details.lastRecordedMileage.toLocaleString()} mi on ${details.lastRecordedDate}\nAvg: ${details.milesPerDay} mi/day`
            : 'Estimated from CARFAX service history';
        } else {
          elements.mileageDisplay.classList.remove('mileage-estimated');
          elements.mileageDisplay.title = '';
        }
      } else {
        elements.mileageDisplay.classList.add('hidden');
      }
    } else {
      elements.vehicleDisplay.textContent = '';
      elements.roDisplay.textContent = '';
      elements.mileageDisplay.classList.add('hidden');
    }
    
    fetchShopFeatures();
    
    if (context.roId) {
      if (currentTab === 'plan') {
        loadPlan();
      } else if (currentTab === 'failures') {
        loadCommonFailures();
      } else if (currentTab === 'canned') {
        loadCannedJobs();
      } else if (currentTab === 'specs') {
        loadVehicleSpecs();
      }
    } else if (RO_INDEPENDENT_TABS.includes(currentTab)) {
      switchTab(currentTab);
    } else {
      switchTab(RO_INDEPENDENT_TABS[0]);
    }
  } else {
    elements.noContext.classList.remove('hidden');
    elements.hasContext.classList.add('hidden');
  }
}

async function fetchShopFeatures() {
  if (!currentContext || !currentContext.shopId) return;
  
  try {
    const result = await sendMessage({
      action: 'MOS_API_REQUEST',
      endpoint: `/api/extension/features?shopId=${currentContext.shopId}&provider=${currentContext.provider || 'tekmetric'}`
    });
    
    if (result && result.features) {
      shopFeatures = result.features;
      updateTabAccessibility();
    } else if (result && result.error) {
      console.error('[MOS] Features API error:', result.error);
    }
  } catch (err) {
    console.error('[MOS] Error fetching features:', err);
  }
}

function updateTabAccessibility() {
  const featureMap = {
    'plan': 'maintenance',
    'failures': 'common_failures',
    'lookup': 'job_lookup',
    'canned': null,
    'rates': 'labor_rates',
    'concern': 'concern_assistant',
    'sticker': 'oil_sticker',
    'specs': null
  };
  
  let firstAvailableTab = null;
  
  elements.tabBtns.forEach(btn => {
    const tab = btn.dataset.tab;
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
  
  elements.loginError.classList.add('hidden');
  elements.loginForm.querySelector('button').disabled = true;
  elements.loginForm.querySelector('button').textContent = 'Signing in...';
  
  try {
    const result = await sendMessage({
      action: 'MOS_LOGIN',
      email,
      password,
      apiUrl
    });
    
    if (result.success) {
      isAuthenticated = true;

      if (result.user?.defaultExtensionTab) {
        userDefaultTab = result.user.defaultExtensionTab;
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
async function loadPlan() {
  if (!currentContext || !currentContext.roId) {
    elements.planLoading.classList.add('hidden');
    elements.planEmpty.classList.remove('hidden');
    elements.planContent.classList.add('hidden');
    return;
  }
  
  elements.planLoading.classList.remove('hidden');
  elements.planEmpty.classList.add('hidden');
  elements.planContent.classList.add('hidden');
  
  try {
    const params = new URLSearchParams({
      shopId: currentContext.shopId,
      roId: currentContext.roId,
      provider: currentContext.provider || 'tekmetric'
    });
    if (currentContext.vin) params.set('vin', currentContext.vin);
    
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
    
    renderPlan(result);
  } catch (err) {
    console.error('[MOS] Error loading plan:', err);
    elements.planLoading.classList.add('hidden');
    elements.planEmpty.classList.remove('hidden');
    elements.planEmpty.querySelector('p').textContent = err.message;
  }
}

function renderPlan(data) {
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
  if (data.mileage) {
    elements.mileageDisplay.textContent = `${data.mileage.toLocaleString()} mi`;
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
        ? `Estimated from CARFAX (${details.dataPoints} data points)\nLast recorded: ${details.lastRecordedMileage.toLocaleString()} mi on ${details.lastRecordedDate}\nAvg: ${details.milesPerDay} mi/day`
        : 'Estimated from CARFAX service history';
    } else {
      elements.mileageDisplay.classList.remove('mileage-estimated');
      elements.mileageDisplay.title = '';
    }
  }
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
  
  // Update keytag fields with the new context data
  if (typeof updateKeytagFields === 'function') {
    updateKeytagFields();
  }
  
  const hasOverdue = data.overdue && data.overdue.length > 0;
  const hasDueSoon = data.dueSoon && data.dueSoon.length > 0;
  const hasRecommended = data.recommended && data.recommended.length > 0;
  
  if (!hasOverdue && !hasDueSoon && !hasRecommended) {
    elements.planEmpty.classList.remove('hidden');
    return;
  }
  
  elements.planContent.classList.remove('hidden');
  
  // Render overdue
  elements.overdueSection.classList.toggle('hidden', !hasOverdue);
  if (hasOverdue) {
    elements.overdueList.innerHTML = data.overdue.map(item => 
      createServiceItemHTML(item, 'overdue')
    ).join('');
  }
  
  // Render due soon
  elements.dueSoonSection.classList.toggle('hidden', !hasDueSoon);
  if (hasDueSoon) {
    elements.dueSoonList.innerHTML = data.dueSoon.map(item => 
      createServiceItemHTML(item, 'due-soon')
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

let dropdownClickHandlerRegistered = false;

function setupAddDropdowns() {
  // Toggle dropdown on button click
  document.querySelectorAll('.btn-add-toggle').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const dropdownId = btn.dataset.dropdown;
      const dropdown = document.getElementById(dropdownId);
      
      // Close all other dropdowns
      document.querySelectorAll('.add-dropdown-menu').forEach(menu => {
        if (menu.id !== dropdownId) menu.classList.add('hidden');
      });
      
      // Toggle this dropdown
      dropdown.classList.toggle('hidden');
    });
  });

  // Handle dropdown item clicks
  document.querySelectorAll('.add-dropdown-item').forEach(item => {
    item.addEventListener('click', async (e) => {
      e.stopPropagation();
      const action = item.dataset.action;
      const service = JSON.parse(item.dataset.service);
      
      // Close dropdown
      item.closest('.add-dropdown-menu').classList.add('hidden');
      
      // Get the service name from various possible field names
      const serviceName = service.service || service.name || service.title || service.repair || service.jobTitle || 'Unknown Service';
      
      if (action === 'search-history') {
        switchTab('lookup');
        elements.jobSearch.value = serviceName;
        await handleJobSearch();
      } else if (action === 'search-canned') {
        switchTab('canned');
        elements.cannedSearch.value = serviceName;
        filterCannedJobs(serviceName);
      } else if (action === 'add-generic') {
        await handleAddService(service);
      } else if (action === 'sw-finding-publish' || action === 'sw-finding-draft') {
        const isDraft = action === 'sw-finding-draft';
        await handleSwAddFinding(service, isDraft);
      } else if (action === 'sw-add-service') {
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

function formatLastDone(last) {
  if (!last || (!last.miles && !last.date)) return null;
  
  let text = 'Last done';
  if (last.miles) {
    text += ` at ${last.miles.toLocaleString()} mi`;
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
    // Shop icon
    logo = `<span class="source-logo shop-logo" title="From Shop">
      <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
        <path d="M12 2L4 6v12l8 4 8-4V6l-8-4zm0 2.18l6 3v9.64l-6 3-6-3V7.18l6-3z"/>
        <path d="M12 6a3 3 0 100 6 3 3 0 000-6z"/>
      </svg>
    </span>`;
  }
  
  return { text, logo };
}

function getOverdueText(item, type) {
  if (type === 'overdue' && item.milesToGo != null && item.milesToGo < 0) {
    const overdue = Math.abs(item.milesToGo);
    return `<span class="overdue-amount">${overdue.toLocaleString()} mi overdue</span>`;
  }
  return '';
}

function createServiceItemHTML(item, type) {
  const itemId = `service-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  
  // Get service name from various possible field names
  // API sends 'service', some places use 'name' or 'title'
  const serviceName = item.service || item.name || item.title || item.serviceKey || 'Unknown Service';
  
  // Status badge color based on type (recommended = upcoming in display)
  const badgeClass = type === 'overdue' ? 'badge-overdue' : 
                     type === 'due-soon' ? 'badge-due-soon' : 'badge-upcoming';
  const badgeText = type === 'overdue' ? 'OVERDUE' : 
                    type === 'due-soon' ? 'DUE SOON' : '';
  
  // Category badge
  const categoryBadge = item.category ? 
    `<span class="category-badge">${escapeHtml(item.category)}</span>` : '';
  
  // Interval info (OEM or Shop)
  const intervalText = item.intervalText || 
    (item.interval ? `OEM: ${item.interval.toLocaleString()} mi` : '');
  const isShopInterval = item.intervalSource === 'shop' || item.usingShopInterval;
  
  // Due at and overdue info
  const dueAtText = item.dueAt ? `Due at ${item.dueAt.toLocaleString()} mi` : '';
  const overdueText = getOverdueText(item, type);
  
  // Last done info with logo
  const lastDone = formatLastDone(item.last);
  const lastDoneHtml = lastDone ? 
    `<div class="last-done">${lastDone.text} ${lastDone.logo}</div>` : '';
  
  // Check if we have full job details from canned job match
  const hasFullDetails = item.laborItems && item.laborItems.length > 0;
  const addLabel = hasFullDetails ? 'Add with Labor/Parts' : 'Add Generic Job';
  const addIcon = hasFullDetails 
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22,4 12,14.01 9,11.01"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
  
  return `
    <li class="service-item ${type}">
      <div class="service-header">
        <div class="service-name">${escapeHtml(serviceName)}</div>
        <div class="add-dropdown">
          <button class="btn-add btn-add-toggle" data-dropdown="${itemId}" data-service='${JSON.stringify(item)}'>
            + Add
          </button>
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
        <span class="interval-badge ${isShopInterval ? 'shop' : 'oem'}">${intervalText}</span>
      </div>
      <div class="service-details">
        ${dueAtText ? `<div class="due-info">${dueAtText}${overdueText ? ' • ' + overdueText : ''}</div>` : ''}
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
        provider: currentContext.provider || 'tekmetric'
      });
      if (currentContext.vin) params.set('vin', currentContext.vin);
      
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
      endpoint: `/api/vehicle/common-failures?${params}`
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
      switchTab('lookup');
      elements.jobSearch.value = jobTitle;
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
    params.set('provider', currentContext?.provider || 'tekmetric');
    if (currentContext?.vehicle) {
      if (currentContext.vehicle.year) params.set('year', currentContext.vehicle.year);
      if (currentContext.vehicle.make) params.set('make', currentContext.vehicle.make);
      if (currentContext.vehicle.model) params.set('model', currentContext.vehicle.model);
      if (currentContext.vehicle.engine) params.set('engine', currentContext.vehicle.engine);
    }
    
    const result = await sendMessage({
      action: 'MOS_API_REQUEST',
      endpoint: `/api/extension/jobs/search?${params}`
    });
    
    if (result.error) throw new Error(result.error);
    
    renderJobResults(result.jobs || []);
  } catch (err) {
    console.error('[MOS] Error searching jobs:', err);
    elements.lookupLoading.classList.add('hidden');
    elements.lookupEmpty.classList.remove('hidden');
    elements.lookupEmpty.querySelector('p').textContent = err.message;
  }
}

function renderJobResults(jobs) {
  elements.lookupLoading.classList.add('hidden');
  
  if (jobs.length === 0) {
    elements.lookupEmpty.classList.remove('hidden');
    elements.lookupEmpty.querySelector('p').textContent = 'No matching jobs found.';
    return;
  }
  
  // Clear previous data and build new list with Map storage
  lookupJobsDataMap.clear();
  elements.lookupResults.classList.remove('hidden');
  elements.lookupResults.innerHTML = jobs.map((job, index) => {
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
  
  return `
    <li class="job-item" data-job-id="${job._id}">
      <div class="job-header">
        <div class="job-header-left">
          <div class="job-title-row">
            <span class="job-title">${escapeHtml(job.title || job.name)}</span>
            <span class="match-badge ${getBandStyle(matchBand)}">${matchLabel}</span>
            <span class="match-score">${matchScore}%</span>
          </div>
          <div class="job-vehicle">${vehicle}${engine}</div>
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
    // Fetch from MOS enriched library (always)
    const result = await sendMessage({
      action: 'MOS_API_REQUEST',
      endpoint: `/api/extension/canned-jobs?shopId=${currentContext.shopId}&provider=${currentContext.provider || 'tekmetric'}`
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
    // Show all jobs if no search term
    renderCannedJobs(allCannedJobs);
    return;
  }
  
  // Filter jobs by name or description
  const filtered = allCannedJobs.filter(job => {
    const name = (job.name || '').toLowerCase();
    const description = (job.description || '').toLowerCase();
    return name.includes(term) || description.includes(term);
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
  const details = [];
  if (service.laborHours) details.push(`${service.laborHours} hrs labor`);
  if (service.parts?.length) details.push(`${service.parts.length} part(s)`);
  const findingText = details.length > 0 
    ? `${serviceName} — ${details.join(', ')}`
    : serviceName;

  try {
    const result = await sendMessage({
      action: 'SW_ADD_FINDING',
      text: findingText,
      workOrderId: currentContext.roId,
      isDraft
    });
    if (result.success) {
      const status = isDraft ? 'Draft' : 'Published';
      showNotification(`Finding added (${status}): ${serviceName}`, 'success');
    } else {
      throw new Error(result.error || 'Failed to add finding');
    }
  } catch (err) {
    console.error('[MOS] Error adding Shop-Ware finding:', err);
    showNotification(err.message, 'error');
  }
}

async function handleAddJob(job) {
  if (!currentContext) {
    alert('No repair order context. Please navigate to a repair order.');
    return;
  }

  if (currentContext.provider === 'shopware') {
    const serviceName = job.title || job.name;
    try {
      const result = await sendMessage({
        action: 'SW_ADD_SERVICE',
        serviceName,
        workOrderId: currentContext.roId,
        vehicle: currentContext.vehicle || null
      });
      if (result.success) {
        showNotification(`Added: ${result.jobName || serviceName}`, 'success');
      } else {
        throw new Error(result.error || 'Failed to add service');
      }
    } catch (err) {
      console.error('[MOS] Error adding Shop-Ware service:', err);
      showNotification(err.message, 'error');
    }
    return;
  }

  // Transform job data for Tekmetric
  const jobData = {
    name: job.title || job.name,
    laborItems: (job.laborItems || job.lines?.filter(l => l.lineType === 'labor') || []).map(item => ({
      name: item.name || item.description,
      hours: item.hours || item.quantity || 1
    })),
    parts: (job.parts || job.lines?.filter(l => l.lineType === 'part') || []).map(part => ({
      name: part.name || part.description,
      partNumber: part.partNumber || '',
      brand: part.brand || part.manufacturer || '',
      quantity: part.quantity || 1,
      cost: part.cost || part.unitPrice || 0,
      retail: part.retail || part.price || part.extendedPrice || 0
    })),
    note: job.note || job.description || ''
  };
  
  try {
    const result = await sendMessage({
      action: 'CREATE_TEKMETRIC_JOB',
      shopId: currentContext.shopId,
      roId: currentContext.roId,
      jobData
    });
    
    if (result.success) {
      showNotification(`Added: ${result.jobName}`, 'success');
    } else {
      throw new Error(result.error || 'Failed to add job');
    }
  } catch (err) {
    console.error('[MOS] Error adding job:', err);
    showNotification(err.message, 'error');
  }
}

async function handleAddCannedJob(job) {
  console.log('[MOS] handleAddCannedJob called:', job);
  
  if (!currentContext) {
    alert('No repair order context. Please navigate to a repair order.');
    return;
  }

  if (currentContext.provider === 'shopware') {
    const serviceName = job.name || job.title;
    try {
      const result = await sendMessage({
        action: 'SW_ADD_SERVICE',
        serviceName,
        workOrderId: currentContext.roId,
        vehicle: currentContext.vehicle || null
      });
      if (result.success) {
        showNotification(`Added: ${result.jobName || serviceName}`, 'success');
      } else {
        throw new Error(result.error || 'Failed to add service');
      }
    } catch (err) {
      console.error('[MOS] Error adding Shop-Ware canned job:', err);
      showNotification(err.message, 'error');
    }
    return;
  }

  // Get the tekmetric ID - could be in different fields
  const tekmetricId = job.tekmetricId || job.id;
  
  console.log('[MOS] Adding canned job:', { name: job.name, tekmetricId, source: job.source, roId: currentContext.roId });
  
  if (job.source === 'tekmetric' && tekmetricId) {
    // Use MOS backend to add canned job via Tekmetric API
    try {
      const result = await sendMessage({
        action: 'MOS_API_REQUEST',
        endpoint: `/api/tekmetric/apply-canned-job?shopId=${currentContext.shopId}&provider=tekmetric`,
        options: {
          method: 'POST',
          body: JSON.stringify({ 
            repairOrderId: currentContext.roId,
            cannedJobId: String(tekmetricId),
            cannedJobTitle: job.name
          })
        }
      });
      
      console.log('[MOS] Tekmetric canned job add result:', result);
      
      if (result.error) {
        throw new Error(result.error);
      }
      
      showNotification(`Added: ${job.name}`, 'success');
      
      // Trigger page refresh
      chrome.tabs.query({ url: "*://*.tekmetric.com/*" }, (tabs) => {
        for (const tab of tabs) {
          chrome.tabs.sendMessage(tab.id, { action: 'JOB_CREATED', jobName: job.name }).catch(() => {});
        }
      });
    } catch (err) {
      console.error('[MOS] Error adding canned job:', err);
      showNotification(err.message || 'Failed to add canned job', 'error');
    }
  } else {
    // MOS enriched job - convert to custom job
    console.log('[MOS] Adding as generic job (no tekmetricId)');
    await handleAddJob(job);
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

async function loadStickerConfig() {
  try {
    // Build endpoint with shop context if available
    let endpoint = '/api/extension/sticker';
    if (currentContext && currentContext.shopId) {
      const provider = currentContext.provider || 'tekmetric';
      endpoint += `?shopId=${currentContext.shopId}&provider=${provider}`;
    }
    
    const result = await sendMessage({
      action: 'MOS_API_REQUEST',
      endpoint
    });
    
    if (result.error) {
      console.error('[MOS] Sticker config error:', result.error);
      if (elements.stickerSection) elements.stickerSection.classList.add('hidden');
      elements.stickerDisabled.classList.remove('hidden');
      return;
    }
    
    stickerConfig = result.config;
    
    if (!result.enabled) {
      if (elements.stickerSection) elements.stickerSection.classList.add('hidden');
      elements.stickerDisabled.classList.remove('hidden');
      return;
    }
    
    // Show sticker section
    if (elements.stickerSection) elements.stickerSection.classList.remove('hidden');
    elements.stickerDisabled.classList.add('hidden');
    
    // Set default unit based on config
    if (stickerConfig.useKilometers) {
      elements.stickerUnit.value = 'km';
    }
    
    // Pre-fill mileage from current context if available
    if (currentContext && currentContext.mileage) {
      elements.stickerMileage.value = currentContext.mileage.toLocaleString();
    }
    
    // Check if keytags feature is enabled and load keytag section (no await needed)
    loadKeytagSection();
    
  } catch (err) {
    console.error('[MOS] Failed to load sticker config:', err);
  }
}

function loadKeytagSection() {
  // Check if keytags feature is enabled for this shop
  keytagEnabled = shopFeatures.keytags === true;
  
  if (!keytagEnabled || !elements.keytagSection) {
    if (elements.keytagSection) elements.keytagSection.classList.add('hidden');
    return;
  }
  
  // Show keytag section immediately
  elements.keytagSection.classList.remove('hidden');
  
  // Pre-fill keytag fields from current context
  updateKeytagFields();
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
      body.provider = currentContext.provider || 'tekmetric';
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
    if (elements.keytagPrintBtn) elements.keytagPrintBtn.disabled = false;
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
      body.provider = currentContext.provider || 'tekmetric';
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
function sendMessage(message, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      resolve({ error: 'Request timed out. Please try again.' });
    }, timeoutMs);
    
    chrome.runtime.sendMessage(message, (response) => {
      clearTimeout(timeout);
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
        provider: currentContext.provider || 'tekmetric'
      });
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
    const result = await sendMessage({
      action: 'MOS_API_REQUEST',
      endpoint: `/api/extension/specs?vin=${encodeURIComponent(vin)}`
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

  if (g.wheelsAndTires && Object.keys(g.wheelsAndTires).length > 0) {
    const items = [];
    if (g.wheelsAndTires.frontTireDescription) items.push({ label: 'Front Tires', value: g.wheelsAndTires.frontTireDescription });
    if (g.wheelsAndTires.rearTireDescription) items.push({ label: 'Rear Tires', value: g.wheelsAndTires.rearTireDescription });
    if (g.wheelsAndTires.frontWheelDiameter) items.push({ label: 'Front Wheel', value: g.wheelsAndTires.frontWheelDiameter + '"' });
    if (g.wheelsAndTires.rearWheelDiameter) items.push({ label: 'Rear Wheel', value: g.wheelsAndTires.rearWheelDiameter + '"' });
    if (g.wheelsAndTires.frontWheelSize) items.push({ label: 'Front Wheel Size', value: g.wheelsAndTires.frontWheelSize });
    if (g.wheelsAndTires.rearWheelSize) items.push({ label: 'Rear Wheel Size', value: g.wheelsAndTires.rearWheelSize });
    if (g.wheelsAndTires.tireType) items.push({ label: 'Tire Type', value: g.wheelsAndTires.tireType });
    if (items.length > 0) html += renderSpecsSection('Wheels & Tires', items, 'wheel');
  }

  if (g.brakes && Object.keys(g.brakes).length > 0) {
    const items = [];
    if (g.brakes.frontBrakeDiameter) items.push({ label: 'Front Brake', value: g.brakes.frontBrakeDiameter + '"' });
    if (g.brakes.rearBrakeDiameter) items.push({ label: 'Rear Brake', value: g.brakes.rearBrakeDiameter + '"' });
    if (items.length > 0) html += renderSpecsSection('Brakes', items, 'brake');
  }

  if (g.dimensions && Object.keys(g.dimensions).length > 0) {
    const items = [];
    if (g.dimensions.wheelbase) items.push({ label: 'Wheelbase', value: g.dimensions.wheelbase + '"' });
    if (g.dimensions.length) items.push({ label: 'Length', value: g.dimensions.length + '"' });
    if (g.dimensions.width) items.push({ label: 'Width', value: g.dimensions.width + '"' });
    if (g.dimensions.height) items.push({ label: 'Height', value: g.dimensions.height + '"' });
    if (g.dimensions.groundClearance) items.push({ label: 'Ground Clearance', value: g.dimensions.groundClearance + '"' });
    if (g.dimensions.frontTrackWidth) items.push({ label: 'Front Track', value: g.dimensions.frontTrackWidth + '"' });
    if (g.dimensions.rearTrackWidth) items.push({ label: 'Rear Track', value: g.dimensions.rearTrackWidth + '"' });
    if (items.length > 0) html += renderSpecsSection('Dimensions', items, 'ruler');
  }

  if (g.weightsAndCapacities && Object.keys(g.weightsAndCapacities).length > 0) {
    const items = [];
    if (g.weightsAndCapacities.fuelTankCapacity) items.push({ label: 'Fuel Tank', value: g.weightsAndCapacities.fuelTankCapacity + ' gal' });
    if (g.weightsAndCapacities.curbWeight) items.push({ label: 'Curb Weight', value: g.weightsAndCapacities.curbWeight + ' lbs' });
    if (g.weightsAndCapacities.gvwr) items.push({ label: 'GVWR', value: g.weightsAndCapacities.gvwr + ' lbs' });
    if (g.weightsAndCapacities.gcwr) items.push({ label: 'GCWR', value: g.weightsAndCapacities.gcwr + ' lbs' });
    if (g.weightsAndCapacities.baseTowingCapacity) items.push({ label: 'Base Towing', value: g.weightsAndCapacities.baseTowingCapacity + ' lbs' });
    if (g.weightsAndCapacities.maxTowingCapacity) items.push({ label: 'Max Towing', value: g.weightsAndCapacities.maxTowingCapacity + ' lbs' });
    if (g.weightsAndCapacities.maxPayload) items.push({ label: 'Max Payload', value: g.weightsAndCapacities.maxPayload + ' lbs' });
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
    if (g.interior.cargoVolume) items.push({ label: 'Cargo Volume', value: g.interior.cargoVolume + ' cu ft' });
    if (g.interior.passengerVolume) items.push({ label: 'Passenger Volume', value: g.interior.passengerVolume + ' cu ft' });
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

async function handleConcernReview() {
  const answered = gatherAnsweredQuestions();
  if (answered.length === 0) {
    showConcernError('Please answer at least one follow-up question before requesting more.');
    return;
  }

  hideConcernError();
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
          conversationId: concernState.conversationId
        })
      }
    });

    if (!response.ok) throw new Error(response.error || 'Failed to get more questions');

    const newQuestions = response.questions || [];
    if (newQuestions.length === 0) {
      showNotification('No additional questions needed. Ready to finish.', 'info');
    } else {
      concernState.questions = [...concernState.questions, ...newQuestions];
    }

    renderConcernQuestions([...concernState.questions.filter(q =>
      !concernState.exchanges.some(e => e.question === q)
    ), ...newQuestions]);

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
          exchanges: concernState.exchanges
        })
      }
    });

    if (!response.ok) throw new Error(response.error || 'Failed to clean up conversation');

    concernState.cleanedText = response.cleanedText;
    elements.concernCleanedText.textContent = response.cleanedText;

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
    exchanges: [],
    cleanedText: ''
  };

  elements.concernInput.value = '';
  elements.concernQuestions.innerHTML = '';
  elements.concernCleanedText.textContent = '';
  elements.concernSubmitBtn.disabled = false;

  elements.concernStart.classList.remove('hidden');
  elements.concernConversation.classList.add('hidden');
  elements.concernResult.classList.add('hidden');
  elements.concernLoading.classList.add('hidden');
  hideConcernError();
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

// ==================== START ====================
init();
initSupportChat();
