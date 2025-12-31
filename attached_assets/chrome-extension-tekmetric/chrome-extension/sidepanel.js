// HEART Helper Side Panel
// Provides Incoming Caller flow and AI Sales Script generation

let appUrl = '';
let phoneScript = 'Thank you for calling HEART Certified Auto Care, this is [Name], how may I help you?';
let currentTab = 'incoming';
let currentShopId = null;

// User Authentication State
let currentUser = null;
let isAuthenticated = false;
let sessionCookie = null;

// Helper to get session cookie using Chrome cookies API
async function getSessionCookie() {
  if (!appUrl) return null;
  try {
    // Debug: List all cookies for the domain
    const allCookies = await chrome.cookies.getAll({ url: appUrl });
    console.log('All cookies for', appUrl, ':', allCookies.map(c => c.name));
    
    const cookie = await chrome.cookies.get({
      url: appUrl,
      name: 'connect.sid'
    });
    if (cookie) {
      console.log('Session cookie found:', cookie.name, 'value length:', cookie.value.length);
      sessionCookie = cookie.value;
      return cookie.value;
    } else {
      console.log('No connect.sid cookie found for', appUrl);
      console.log('Make sure you are logged in at:', appUrl);
      return null;
    }
  } catch (error) {
    console.error('Error getting session cookie:', error);
    return null;
  }
}

// Wrapper for fetch that includes session cookie in header
async function authenticatedFetch(url, options = {}) {
  // Try to get cookie if we don't have it
  if (!sessionCookie) {
    await getSessionCookie();
  }
  
  const headers = {
    ...options.headers,
    'Accept': 'application/json',
  };
  
  // Add cookie header if we have a session
  if (sessionCookie) {
    headers['Cookie'] = `connect.sid=${sessionCookie}`;
  }
  
  return fetch(url, {
    ...options,
    credentials: 'include',
    headers,
  });
}

// Incoming Caller State
let customerName = '';
let referralSource = '';
let symptoms = [];
let vehicleInfo = { year: '', make: '', model: '' };
let followUpQuestions = [];
let answeredQuestions = [];
let currentQuestionIndex = 0;
let cleanedConversation = '';

// Sales Script State
let currentRO = null;
let lastGeneratedScript = null;

// Search State
let searchResults = [];
let selectedJobResult = null;

// ==================== INITIALIZATION ====================

document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  setupEventListeners();
  // Get session cookie first before checking auth
  await getSessionCookie();
  await checkAuthStatus();
  await syncSettingsFromApp();
  setupMessageListeners();
  requestCurrentROInfo();
});

// ==================== AUTHENTICATION ====================

async function checkAuthStatus() {
  if (!appUrl) {
    updateUserDisplay(null);
    return;
  }
  
  // Refresh cookie before checking
  await getSessionCookie();
  
  try {
    const response = await authenticatedFetch(`${appUrl}/api/auth/user`, {
      method: 'GET',
    });
    
    if (response.ok) {
      currentUser = await response.json();
      isAuthenticated = true;
      updateUserDisplay(currentUser);
      console.log('Auth check successful:', currentUser.email);
      
      // Sync labor rates on successful auth check
      await syncLaborRateGroups();
      await syncJobLaborRates();
    } else {
      console.log('Auth check failed:', response.status);
      currentUser = null;
      isAuthenticated = false;
      updateUserDisplay(null);
    }
  } catch (error) {
    console.log('Could not check auth status:', error);
    currentUser = null;
    isAuthenticated = false;
    updateUserDisplay(null);
  }
}

function updateUserDisplay(user) {
  const userSection = document.getElementById('userSection');
  const loginSection = document.getElementById('loginSection');
  const tabNav = document.querySelector('.tab-nav');
  const tabContents = document.querySelectorAll('.tab-content');
  
  if (!userSection || !loginSection) return;
  
  if (user) {
    // Show user section, hide login
    const initials = (user.firstName?.[0] || '') + (user.lastName?.[0] || '');
    const displayName = user.firstName ? `${user.firstName} ${user.lastName || ''}`.trim() : user.email;
    userSection.innerHTML = `
      <div class="user-info">
        <div class="user-avatar">${initials || '?'}</div>
        <div class="user-details">
          <div class="user-name">${displayName}</div>
          <div class="user-email">${user.email || ''}</div>
        </div>
        <button class="logout-btn" id="logoutBtn">Sign out</button>
      </div>
    `;
    userSection.style.display = 'flex';
    loginSection.style.display = 'none';
    
    // Show tabs and restore active tab content
    if (tabNav) tabNav.style.display = 'flex';
    
    // Show the current tab content (or default to incoming)
    const activeTab = currentTab || 'incoming';
    document.getElementById('incomingTab').style.display = activeTab === 'incoming' ? 'flex' : 'none';
    document.getElementById('searchTab').style.display = activeTab === 'search' ? 'flex' : 'none';
    document.getElementById('salesTab').style.display = activeTab === 'sales' ? 'flex' : 'none';
    document.getElementById('tipsTab').style.display = activeTab === 'tips' ? 'flex' : 'none';
    document.getElementById('ratesTab').style.display = activeTab === 'rates' ? 'flex' : 'none';
    
    // Add logout handler
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', handleLogout);
    }
  } else {
    // Show login section, hide user section and tabs
    userSection.style.display = 'none';
    loginSection.style.display = 'flex';
    
    // Hide tabs when not logged in
    if (tabNav) tabNav.style.display = 'none';
    tabContents.forEach(content => content.style.display = 'none');
  }
}

// Handle login form submission
async function handleLogin(e) {
  e.preventDefault();
  
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  const errorDiv = document.getElementById('loginError');
  const submitBtn = document.getElementById('loginBtn');
  
  if (!email || !password) {
    showLoginError('Please enter email and password');
    return;
  }
  
  if (!appUrl) {
    showLoginError('App not configured. Click the gear icon to set up.');
    return;
  }
  
  // Disable button during login
  submitBtn.disabled = true;
  submitBtn.textContent = 'Signing in...';
  
  try {
    const response = await fetch(`${appUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      credentials: 'include',
      body: JSON.stringify({ email, password }),
    });
    
    const data = await response.json();
    
    if (response.ok) {
      // Login successful
      hideLoginError();
      currentUser = data.user;
      isAuthenticated = true;
      
      // Refresh session cookie
      await getSessionCookie();
      
      // Update display
      updateUserDisplay(currentUser);
      
      // Sync labor rates after login
      await syncLaborRateGroups();
      await syncJobLaborRates();
      
      // Show default tab
      switchTab('incoming');
      
      console.log('Login successful:', currentUser.email);
    } else {
      showLoginError(data.message || 'Login failed');
    }
  } catch (error) {
    console.error('Login error:', error);
    showLoginError('Could not connect to server');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Sign In';
  }
}

// Handle registration form submission
async function handleRegister(e) {
  e.preventDefault();
  
  const email = document.getElementById('registerEmail').value.trim();
  const firstName = document.getElementById('registerFirstName').value.trim();
  const lastName = document.getElementById('registerLastName').value.trim();
  const password = document.getElementById('registerPassword').value;
  const errorDiv = document.getElementById('registerError');
  const submitBtn = document.getElementById('registerBtn');
  
  if (!email || !password) {
    showRegisterError('Please enter email and password');
    return;
  }
  
  if (password.length < 8) {
    showRegisterError('Password must be at least 8 characters');
    return;
  }
  
  if (!appUrl) {
    showRegisterError('App not configured. Click the gear icon to set up.');
    return;
  }
  
  // Disable button during registration
  submitBtn.disabled = true;
  submitBtn.textContent = 'Creating account...';
  
  try {
    const response = await fetch(`${appUrl}/api/auth/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      credentials: 'include',
      body: JSON.stringify({ email, password, firstName, lastName }),
    });
    
    const data = await response.json();
    
    if (response.ok) {
      // Registration successful
      hideRegisterError();
      currentUser = data.user;
      isAuthenticated = true;
      
      // Refresh session cookie
      await getSessionCookie();
      
      // Update display
      updateUserDisplay(currentUser);
      
      // Sync labor rates after login
      await syncLaborRateGroups();
      await syncJobLaborRates();
      
      // Show default tab
      switchTab('incoming');
      
      console.log('Registration successful:', currentUser.email);
    } else {
      showRegisterError(data.message || 'Registration failed');
    }
  } catch (error) {
    console.error('Registration error:', error);
    showRegisterError('Could not connect to server');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Create Account';
  }
}

// Handle logout
async function handleLogout() {
  try {
    await authenticatedFetch(`${appUrl}/api/auth/logout`, {
      method: 'POST',
    });
  } catch (error) {
    console.error('Logout error:', error);
  }
  
  // Clear state regardless of server response
  currentUser = null;
  isAuthenticated = false;
  sessionCookie = null;
  
  // Update display
  updateUserDisplay(null);
  
  console.log('Logged out');
}

// Sync labor rate groups from server to local storage
async function syncLaborRateGroups() {
  if (!appUrl || !isAuthenticated) return;
  
  try {
    const response = await authenticatedFetch(`${appUrl}/api/labor-rate-groups`);
    if (response.ok) {
      const groups = await response.json();
      // Store in chrome.storage.local for background.js to use
      chrome.storage.local.set({ laborRateGroups: groups });
      console.log('Labor rate groups synced:', groups.length, 'groups');
    }
  } catch (error) {
    console.error('Failed to sync labor rate groups:', error);
  }
}

// Sync job-based labor rates from server to local storage
async function syncJobLaborRates() {
  if (!appUrl || !isAuthenticated) return;
  
  try {
    const response = await authenticatedFetch(`${appUrl}/api/job-labor-rates`);
    if (response.ok) {
      const rates = await response.json();
      // Store in chrome.storage.local for background.js to use
      chrome.storage.local.set({ jobLaborRates: rates });
      console.log('Job labor rates synced:', rates.length, 'rates');
    }
  } catch (error) {
    console.error('Failed to sync job labor rates:', error);
  }
}

function showLoginError(message) {
  const errorDiv = document.getElementById('loginError');
  if (errorDiv) {
    errorDiv.textContent = message;
    errorDiv.style.display = 'block';
  }
}

function hideLoginError() {
  const errorDiv = document.getElementById('loginError');
  if (errorDiv) {
    errorDiv.style.display = 'none';
  }
}

function showRegisterError(message) {
  const errorDiv = document.getElementById('registerError');
  if (errorDiv) {
    errorDiv.textContent = message;
    errorDiv.style.display = 'block';
  }
}

function hideRegisterError() {
  const errorDiv = document.getElementById('registerError');
  if (errorDiv) {
    errorDiv.style.display = 'none';
  }
}

function toggleLoginRegister(showRegister) {
  const loginCard = document.querySelector('#loginSection .login-card:not(#registerCard)');
  const registerCard = document.getElementById('registerCard');
  
  if (showRegister) {
    if (loginCard) loginCard.style.display = 'none';
    if (registerCard) registerCard.style.display = 'block';
  } else {
    if (loginCard) loginCard.style.display = 'block';
    if (registerCard) registerCard.style.display = 'none';
  }
}

// Normalize URL to just origin (strips any path like /settings)
function normalizeUrl(url) {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    return parsed.origin;
  } catch {
    return url;
  }
}

// Production URL for Chrome Web Store version
const PRODUCTION_URL = 'https://heart-helper.onrender.com';

async function loadSettings() {
  return new Promise((resolve) => {
    // Check sync storage first (user-configured), then local storage (auto-detected from app visit)
    chrome.storage.sync.get(['heartHelperUrl'], (syncData) => {
      if (syncData.heartHelperUrl) {
        appUrl = normalizeUrl(syncData.heartHelperUrl);
        updateConnectionStatus();
        resolve();
      } else {
        // Fallback to local storage (set by inject.js when visiting the app)
        chrome.storage.local.get(['appUrl'], (localData) => {
          if (localData.appUrl) {
            appUrl = normalizeUrl(localData.appUrl);
          } else {
            // Default to production URL for Chrome Web Store installs
            appUrl = PRODUCTION_URL;
            // Save it so it persists
            chrome.storage.sync.set({ heartHelperUrl: PRODUCTION_URL });
            chrome.storage.local.set({ appUrl: PRODUCTION_URL });
          }
          updateConnectionStatus();
          resolve();
        });
      }
    });
  });
}

async function syncSettingsFromApp() {
  if (!appUrl) {
    document.getElementById('phoneScript').textContent = phoneScript;
    return;
  }
  
  try {
    new URL(appUrl);
  } catch {
    document.getElementById('phoneScript').textContent = phoneScript;
    return;
  }
  
  try {
    const response = await fetch(`${appUrl}/api/settings`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    });
    
    if (response.ok) {
      const settings = await response.json();
      if (settings.phoneAnswerScript) {
        phoneScript = settings.phoneAnswerScript;
        chrome.storage.local.set({ cachedPhoneScript: phoneScript });
      }
    } else {
      // Try cached
      const cached = await new Promise(r => chrome.storage.local.get(['cachedPhoneScript'], r));
      if (cached.cachedPhoneScript) phoneScript = cached.cachedPhoneScript;
    }
  } catch (error) {
    console.log('Could not sync settings:', error);
    const cached = await new Promise(r => chrome.storage.local.get(['cachedPhoneScript'], r));
    if (cached.cachedPhoneScript) phoneScript = cached.cachedPhoneScript;
  }
  
  document.getElementById('phoneScript').textContent = phoneScript;
}

function setupMessageListeners() {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'VEHICLE_INFO') {
      // Update Incoming Caller tab vehicle fields
      document.getElementById('vehicleYear').value = message.vehicleInfo.year || '';
      document.getElementById('vehicleMake').value = message.vehicleInfo.make || '';
      document.getElementById('vehicleModel').value = message.vehicleInfo.model || '';
      // Also update Search tab vehicle fields
      document.getElementById('searchYear').value = message.vehicleInfo.year || '';
      document.getElementById('searchMake').value = message.vehicleInfo.make || '';
      document.getElementById('searchModel').value = message.vehicleInfo.model || '';
    }
    if (message.type === 'RO_INFO') {
      currentRO = message.roInfo;
      updateRODisplay();
      // Also update Search tab vehicle fields from RO
      if (currentRO && currentRO.vehicle) {
        document.getElementById('searchYear').value = currentRO.vehicle.year || '';
        document.getElementById('searchMake').value = currentRO.vehicle.make || '';
        document.getElementById('searchModel').value = currentRO.vehicle.model || '';
      }
    }
  });
}

function requestCurrentROInfo() {
  console.log('[SidePanel] requestCurrentROInfo called');
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    console.log('[SidePanel] Active tab:', tabs[0]?.url);
    if (tabs[0] && tabs[0].url && tabs[0].url.includes('tekmetric.com')) {
      const url = tabs[0].url;
      
      // Extract shopId and roId from URL (same pattern as labor rate tool)
      // Matches both /shop/123/repair-orders/456 and /admin/shop/123/repair-orders/456
      const shopMatch = url.match(/\/shop\/(\d+)/);
      const roMatch = url.match(/repair-orders?\/(\d+)/);
      
      const shopId = shopMatch ? shopMatch[1] : null;
      const roId = roMatch ? roMatch[1] : null;
      
      console.log('[SidePanel] Extracted from URL:', { shopId, roId });
      
      // Send to BACKGROUND SCRIPT (not content script) - uses proven API fetch like labor rate tool
      console.log('[SidePanel] Sending GET_VEHICLE_INFO to background');
      chrome.runtime.sendMessage({ 
        action: 'GET_VEHICLE_INFO',
        shopId: shopId,
        roId: roId
      }, (response) => {
        console.log('[SidePanel] GET_VEHICLE_INFO response:', JSON.stringify(response));
        if (chrome.runtime.lastError) {
          console.log('[SidePanel] Could not get vehicle info:', chrome.runtime.lastError.message);
          return;
        }
        if (response && (response.year || response.make || response.model)) {
          console.log('[SidePanel] Updating fields with:', JSON.stringify(response));
          // Update Incoming Caller tab vehicle fields
          document.getElementById('vehicleYear').value = response.year || '';
          document.getElementById('vehicleMake').value = response.make || '';
          document.getElementById('vehicleModel').value = response.model || '';
          // Also update Search tab vehicle fields
          document.getElementById('searchYear').value = response.year || '';
          document.getElementById('searchMake').value = response.make || '';
          document.getElementById('searchModel').value = response.model || '';
          
          // Store shop ID for API calls
          if (response.shopId) {
            currentShopId = response.shopId;
          }
          
          // Store VIN and mileage for History tab auto-fill
          if (response.vin) {
            cachedVehicleVin = response.vin;
            const historyVinInput = document.getElementById('historyVin');
            if (historyVinInput) historyVinInput.value = response.vin;
          }
          if (response.mileageIn) {
            cachedVehicleMileage = response.mileageIn;
            const historyMileageInput = document.getElementById('historyMileage');
            if (historyMileageInput) historyMileageInput.value = response.mileageIn;
          }
        } else {
          console.log('[SidePanel] No vehicle info in response:', response?.error || 'unknown');
        }
      });
      
      // Get RO info for sales script (still from content script for now)
      chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_RO_INFO' }, (response) => {
        if (chrome.runtime.lastError) {
          console.log('Could not get RO info:', chrome.runtime.lastError.message);
          return;
        }
        if (response && response.roInfo) {
          currentRO = response.roInfo;
          updateRODisplay();
          // Also update Search tab vehicle fields from RO
          if (currentRO && currentRO.vehicle) {
            document.getElementById('searchYear').value = currentRO.vehicle.year || '';
            document.getElementById('searchMake').value = currentRO.vehicle.make || '';
            document.getElementById('searchModel').value = currentRO.vehicle.model || '';
          }
        }
      });
    } else {
      console.log('Not on a Tekmetric page');
    }
  });
}

// ==================== EVENT LISTENERS ====================

function setupEventListeners() {
  // Login/Register forms
  const loginForm = document.getElementById('loginForm');
  if (loginForm) {
    loginForm.addEventListener('submit', handleLogin);
  }
  
  const registerForm = document.getElementById('registerForm');
  if (registerForm) {
    registerForm.addEventListener('submit', handleRegister);
  }
  
  const showRegisterBtn = document.getElementById('showRegisterBtn');
  if (showRegisterBtn) {
    showRegisterBtn.addEventListener('click', () => toggleLoginRegister(true));
  }
  
  const showLoginBtn = document.getElementById('showLoginBtn');
  if (showLoginBtn) {
    showLoginBtn.addEventListener('click', () => toggleLoginRegister(false));
  }
  
  // Tab switching
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
  
  // Open full app button
  document.getElementById('openAppBtn').addEventListener('click', () => {
    // Use the global appUrl that was loaded from settings, or fallback to production
    const url = appUrl || PRODUCTION_URL;
    chrome.tabs.create({ url: url });
  });
  
  // Settings button
  document.getElementById('settingsBtn').addEventListener('click', openSettings);
  
  // Refresh button
  document.getElementById('refreshBtn').addEventListener('click', () => {
    syncSettingsFromApp();
    requestCurrentROInfo();
    showToast('Refreshed!');
  });
  
  // Copy phone script
  document.getElementById('copyScriptBtn').addEventListener('click', () => {
    navigator.clipboard.writeText(phoneScript);
    showToast('Phone script copied!');
  });
  
  // Add symptom
  document.getElementById('addSymptomBtn').addEventListener('click', addSymptomField);
  
  // Start conversation
  document.getElementById('startConversationBtn').addEventListener('click', startConversation);
  
  // Question navigation
  document.getElementById('nextQuestionBtn').addEventListener('click', nextQuestion);
  document.getElementById('skipQuestionBtn').addEventListener('click', skipQuestion);
  document.getElementById('finalizeEarlyBtn').addEventListener('click', finalizeConversation);
  
  // Summary actions
  document.getElementById('copyBtn').addEventListener('click', copySummary);
  document.getElementById('sendToTekmetricBtn').addEventListener('click', sendToTekmetric);
  document.getElementById('restartBtn').addEventListener('click', restart);
  
  // Sales script
  document.getElementById('generateSalesScriptBtn').addEventListener('click', generateSalesScript);
  document.getElementById('copySalesScriptBtn').addEventListener('click', copySalesScript);
  document.getElementById('regenerateBtn').addEventListener('click', generateSalesScript);
  document.getElementById('feedbackSuccess').addEventListener('click', () => submitFeedback('positive'));
  document.getElementById('feedbackFail').addEventListener('click', () => submitFeedback('negative'));
  
  // Objection handling buttons
  document.querySelectorAll('.objection-btn').forEach(btn => {
    btn.addEventListener('click', (e) => handleObjectionClick(e.target.dataset.objection));
  });
  document.getElementById('copyObjectionBtn').addEventListener('click', copyObjectionResponse);
  
  // Search
  document.getElementById('searchBtn').addEventListener('click', performSearch);
  document.getElementById('clearSearchBtn').addEventListener('click', clearSearch);
  document.getElementById('backToResultsBtn').addEventListener('click', backToResults);
  document.getElementById('searchRepairType').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') performSearch();
  });
  
  // Settings
  document.getElementById('settingsBtn').addEventListener('click', openSettings);
  document.getElementById('closeSettingsBtn').addEventListener('click', closeSettings);
  document.getElementById('saveSettingsBtn').addEventListener('click', saveSettings);
  document.getElementById('settingsModal').addEventListener('click', (e) => {
    if (e.target.id === 'settingsModal') closeSettings();
  });
  
  // Vehicle History
  document.getElementById('fetchHistoryBtn').addEventListener('click', fetchVehicleHistory);
  document.getElementById('refreshHistoryBtn').addEventListener('click', fetchVehicleHistory);
  document.getElementById('retryHistoryBtn').addEventListener('click', fetchVehicleHistory);
}

// ==================== TAB SWITCHING ====================

function switchTab(tab) {
  currentTab = tab;
  
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  
  document.getElementById('incomingTab').style.display = tab === 'incoming' ? 'flex' : 'none';
  document.getElementById('searchTab').style.display = tab === 'search' ? 'flex' : 'none';
  document.getElementById('salesTab').style.display = tab === 'sales' ? 'flex' : 'none';
  document.getElementById('tipsTab').style.display = tab === 'tips' ? 'flex' : 'none';
  document.getElementById('ratesTab').style.display = tab === 'rates' ? 'flex' : 'none';
  document.getElementById('historyTab').style.display = tab === 'history' ? 'flex' : 'none';
  
  // Auto-fill vehicle info when switching to search tab
  if (tab === 'search') {
    autoFillSearchVehicle();
  }
  
  // Load labor rate groups and job rates when switching to rates tab
  if (tab === 'rates') {
    loadLaborRateGroups();
    loadJobLaborRates();
  }
  
  // Load coaching tips when switching to tips tab
  if (tab === 'tips') {
    loadCoachingTips();
  }
  
  // Auto-generate sales script when switching to sales tab
  if (tab === 'sales' && currentRO && currentRO.jobs && currentRO.jobs.length > 0 && appUrl) {
    // Only auto-generate if we haven't already generated
    const scriptSection = document.getElementById('salesScriptSection');
    if (scriptSection.style.display === 'none') {
      generateSalesScript();
    }
  }
  
  // Auto-fill VIN and load history when switching to history tab
  if (tab === 'history') {
    autoFillHistoryVehicle();
  }
}

// ==================== INCOMING CALLER FLOW ====================

function addSymptomField() {
  const list = document.getElementById('symptomsList');
  const row = document.createElement('div');
  row.className = 'symptom-input-row';
  row.innerHTML = `
    <input type="text" class="symptom-input" placeholder="Describe another issue..." />
    <button class="remove-symptom-btn">×</button>
  `;
  list.appendChild(row);
  
  // Add event listener (CSP doesn't allow inline onclick)
  row.querySelector('.remove-symptom-btn').addEventListener('click', function() {
    this.parentElement.remove();
  });
  
  row.querySelector('input').focus();
}

function collectSymptoms() {
  symptoms = [];
  document.querySelectorAll('.symptom-input').forEach(input => {
    const val = input.value.trim();
    if (val) symptoms.push(val);
  });
  return symptoms;
}

async function startConversation() {
  customerName = document.getElementById('customerName').value.trim();
  referralSource = document.getElementById('referralSource').value.trim();
  collectSymptoms();
  vehicleInfo = {
    year: document.getElementById('vehicleYear').value.trim(),
    make: document.getElementById('vehicleMake').value.trim(),
    model: document.getElementById('vehicleModel').value.trim()
  };
  
  if (symptoms.length === 0) {
    showToast('Please enter at least one symptom/issue');
    return;
  }
  
  if (!appUrl) {
    showToast('Please configure app URL in settings');
    return;
  }
  
  // Show questions step
  document.getElementById('customerInfoStep').style.display = 'none';
  document.getElementById('questionsStep').style.display = 'block';
  
  // Show customer summary
  let summaryHtml = '';
  if (customerName) summaryHtml += `<strong>${customerName}</strong>`;
  if (vehicleInfo.year || vehicleInfo.make || vehicleInfo.model) {
    summaryHtml += ` - ${vehicleInfo.year} ${vehicleInfo.make} ${vehicleInfo.model}`.trim();
  }
  summaryHtml += `<br>Issues: ${symptoms.join(', ')}`;
  document.getElementById('customerSummary').innerHTML = summaryHtml;
  
  // Generate questions
  await generateQuestions();
}

async function generateQuestions() {
  const loadingOverlay = document.getElementById('loadingOverlay');
  loadingOverlay.style.display = 'flex';
  
  try {
    const concernText = symptoms.join('. ');
    const response = await authenticatedFetch(`${appUrl}/api/concerns/generate-questions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerConcern: concernText,
        vehicleInfo: vehicleInfo
      })
    });
    
    if (!response.ok) throw new Error('Failed to generate questions');
    
    const data = await response.json();
    followUpQuestions = data.questions || [];
    
    if (followUpQuestions.length === 0) {
      // No questions, go straight to summary
      finalizeConversation();
      return;
    }
    
    currentQuestionIndex = 0;
    answeredQuestions = [];
    displayCurrentQuestion();
    
  } catch (error) {
    console.error('Error generating questions:', error);
    showToast('Could not generate questions. Finalizing...');
    finalizeConversation();
  } finally {
    loadingOverlay.style.display = 'none';
  }
}

function displayCurrentQuestion() {
  document.getElementById('questionNum').textContent = currentQuestionIndex + 1;
  document.getElementById('totalQuestions').textContent = followUpQuestions.length;
  document.getElementById('currentQuestion').textContent = followUpQuestions[currentQuestionIndex];
  document.getElementById('customerAnswer').value = '';
  document.getElementById('customerAnswer').focus();
  
  // Update step indicators
  document.querySelectorAll('.step-indicator .step').forEach((el, i) => {
    el.classList.toggle('active', i === 0);
    el.classList.remove('completed');
  });
}

function nextQuestion() {
  const answer = document.getElementById('customerAnswer').value.trim();
  if (!answer) {
    showToast('Please enter the customer\'s answer');
    return;
  }
  
  answeredQuestions.push({
    question: followUpQuestions[currentQuestionIndex],
    answer: answer
  });
  
  updateAnsweredList();
  
  if (currentQuestionIndex < followUpQuestions.length - 1) {
    currentQuestionIndex++;
    displayCurrentQuestion();
  } else {
    finalizeConversation();
  }
}

function skipQuestion() {
  if (currentQuestionIndex < followUpQuestions.length - 1) {
    currentQuestionIndex++;
    displayCurrentQuestion();
  } else {
    finalizeConversation();
  }
}

function updateAnsweredList() {
  const container = document.getElementById('answeredQuestions');
  const list = document.getElementById('answeredList');
  
  if (answeredQuestions.length > 0) {
    container.style.display = 'block';
    list.innerHTML = answeredQuestions.map(qa => `
      <div class="answered-item">
        <div class="question">${qa.question}</div>
        <div class="answer">${qa.answer}</div>
      </div>
    `).join('');
  }
}

async function finalizeConversation() {
  const loadingOverlay = document.getElementById('loadingOverlay');
  loadingOverlay.style.display = 'flex';
  loadingOverlay.querySelector('.loading-text').textContent = 'Finalizing...';
  
  try {
    const concernText = symptoms.join('. ');
    const response = await authenticatedFetch(`${appUrl}/api/concerns/clean-conversation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerConcern: concernText,
        answeredQuestions: answeredQuestions,
        conversationNotes: `Customer: ${customerName || 'Unknown'}. Referral: ${referralSource || 'Not specified'}. Vehicle: ${vehicleInfo.year} ${vehicleInfo.make} ${vehicleInfo.model}`.trim()
      })
    });
    
    if (!response.ok) throw new Error('Failed to finalize');
    
    const data = await response.json();
    cleanedConversation = data.cleanedText || symptoms.join('. ');
    
  } catch (error) {
    console.error('Error finalizing:', error);
    // Fallback to basic format
    cleanedConversation = `Customer reports: ${symptoms.join('. ')}`;
    if (answeredQuestions.length > 0) {
      cleanedConversation += '\n\n' + answeredQuestions.map(qa => `${qa.question}: ${qa.answer}`).join('\n');
    }
  } finally {
    loadingOverlay.style.display = 'none';
  }
  
  // Show summary section
  document.getElementById('questionSection').style.display = 'none';
  document.getElementById('summarySection').style.display = 'block';
  document.getElementById('summaryText').textContent = cleanedConversation;
  
  // Update step indicators
  document.querySelectorAll('.step-indicator .step').forEach((el, i) => {
    if (i === 0) el.classList.add('completed');
    el.classList.toggle('active', i === 1);
  });
}

function copySummary() {
  navigator.clipboard.writeText(cleanedConversation);
  showToast('Copied to clipboard!');
}

function sendToTekmetric() {
  if (!cleanedConversation) {
    showToast('No conversation to send');
    return;
  }
  
  // Send cleaned conversation to content script to paste into Tekmetric
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0] && tabs[0].url && tabs[0].url.includes('tekmetric.com')) {
      console.log('Sending to Tekmetric tab:', tabs[0].id);
      chrome.tabs.sendMessage(tabs[0].id, { 
        type: 'PASTE_CONCERN', 
        text: cleanedConversation 
      }, (response) => {
        if (chrome.runtime.lastError) {
          console.log('Error sending to Tekmetric:', chrome.runtime.lastError);
          navigator.clipboard.writeText(cleanedConversation);
          showToast('Could not insert - copied to clipboard instead');
          return;
        }
        
        if (response && response.success) {
          showToast('Added to Tekmetric!');
        } else {
          // Field not found - copy to clipboard as fallback
          navigator.clipboard.writeText(cleanedConversation);
          showToast(response?.error || 'Open concern dialog in Tekmetric first. Copied to clipboard.');
        }
      });
    } else {
      // Not on Tekmetric - copy to clipboard
      navigator.clipboard.writeText(cleanedConversation);
      showToast('Copied! Open Tekmetric to paste.');
    }
  });
}

function restart() {
  // Reset state
  customerName = '';
  referralSource = '';
  symptoms = [];
  vehicleInfo = { year: '', make: '', model: '' };
  followUpQuestions = [];
  answeredQuestions = [];
  currentQuestionIndex = 0;
  cleanedConversation = '';
  
  // Reset UI
  document.getElementById('customerName').value = '';
  document.getElementById('referralSource').value = '';
  document.getElementById('vehicleYear').value = '';
  document.getElementById('vehicleMake').value = '';
  document.getElementById('vehicleModel').value = '';
  
  // Reset symptoms list to single input
  const symptomsList = document.getElementById('symptomsList');
  symptomsList.innerHTML = `
    <div class="symptom-input-row">
      <input type="text" class="symptom-input" placeholder="Describe the issue..." />
      <button class="add-symptom-btn" id="addSymptomBtn">+</button>
    </div>
  `;
  document.getElementById('addSymptomBtn').addEventListener('click', addSymptomField);
  
  // Reset sections
  document.getElementById('questionSection').style.display = 'block';
  document.getElementById('summarySection').style.display = 'none';
  document.getElementById('answeredQuestions').style.display = 'none';
  document.getElementById('answeredList').innerHTML = '';
  
  // Show customer info step
  document.getElementById('questionsStep').style.display = 'none';
  document.getElementById('customerInfoStep').style.display = 'block';
  
  // Refresh vehicle info from current page
  requestCurrentROInfo();
}

// ==================== SALES SCRIPT ====================

function updateRODisplay() {
  const details = document.getElementById('roDetails');
  const noRoMessage = document.getElementById('noRoMessage');
  const scriptSection = document.getElementById('salesScriptSection');
  const jobsSection = document.getElementById('roJobsSection');
  
  if (!currentRO || !currentRO.jobs || currentRO.jobs.length === 0) {
    details.innerHTML = '';
    noRoMessage.style.display = 'block';
    scriptSection.style.display = 'none';
    if (jobsSection) jobsSection.style.display = 'none';
    return;
  }
  
  noRoMessage.style.display = 'none';
  
  let html = '';
  if (currentRO.vehicle) {
    const vehicleStr = `${currentRO.vehicle.year || ''} ${currentRO.vehicle.make || ''} ${currentRO.vehicle.model || ''}`.trim();
    if (vehicleStr) {
      html += `<div class="ro-vehicle">${vehicleStr}</div>`;
    }
  }
  
  details.innerHTML = html;
  
  // Display jobs list with warranty status
  displayROJobs(currentRO.jobs);
  
  // Fetch warranty status for jobs if we have VIN
  if (currentRO.vehicle && currentRO.vehicle.vin && appUrl) {
    fetchJobsWarrantyStatus();
  }
  
  // Auto-generate sales script when RO is loaded and we're on the sales tab
  if (currentTab === 'sales' && appUrl) {
    generateSalesScript();
  }
}

// Cache for job warranty status (keyed by index to avoid name collision issues)
let jobWarrantyCache = [];  // Array indexed by job position
let lastWarrantyCacheVin = null;

function displayROJobs(jobs) {
  const jobsSection = document.getElementById('roJobsSection');
  const jobsList = document.getElementById('roJobsList');
  const jobsCount = document.getElementById('roJobsCount');
  
  if (!jobsSection || !jobs || jobs.length === 0) {
    if (jobsSection) jobsSection.style.display = 'none';
    return;
  }
  
  jobsSection.style.display = 'block';
  jobsCount.textContent = jobs.length;
  
  const html = jobs.map((job, index) => {
    const jobName = job.name || job.jobName || 'Unknown Service';
    const price = job.totalAmount || job.total || 0;
    const priceDisplay = price > 0 ? `$${(price / 100).toFixed(2)}` : '';
    
    // Check cache for warranty status by index
    const warrantyInfo = jobWarrantyCache[index] || null;
    
    let badgesHtml = '';
    if (warrantyInfo) {
      badgesHtml = renderWarrantyBadges(warrantyInfo);
    }
    
    return `
      <div class="ro-job-item" data-job-index="${index}" data-job-name="${escapeHtml(jobName)}">
        <div class="ro-job-info">
          <div class="ro-job-name">${escapeHtml(jobName)}</div>
          ${priceDisplay ? `<div class="ro-job-price">${priceDisplay}</div>` : ''}
        </div>
        <div class="ro-job-badges" id="job-badges-${index}">
          ${badgesHtml}
        </div>
      </div>
    `;
  }).join('');
  
  jobsList.innerHTML = html;
}

function renderWarrantyBadges(warrantyInfo) {
  let badges = [];
  
  if (warrantyInfo.underWarranty) {
    badges.push('<span class="ro-job-badge under-warranty">Under Warranty</span>');
  }
  if (warrantyInfo.recentlyServiced) {
    badges.push('<span class="ro-job-badge recently-serviced">Recently Serviced</span>');
  }
  if (warrantyInfo.servicedElsewhere) {
    badges.push('<span class="ro-job-badge serviced-elsewhere">Done Elsewhere</span>');
  }
  if (warrantyInfo.dueForService) {
    badges.push('<span class="ro-job-badge due-for-service">Due</span>');
  }
  
  return badges.join('');
}

async function fetchJobsWarrantyStatus() {
  if (!currentRO || !currentRO.vehicle || !currentRO.vehicle.vin || !appUrl) return;
  if (!currentRO.jobs || currentRO.jobs.length === 0) return;
  
  const vin = currentRO.vehicle.vin;
  
  // Clear cache if VIN changed to avoid cross-RO contamination
  if (lastWarrantyCacheVin !== vin) {
    jobWarrantyCache = [];
    lastWarrantyCacheVin = vin;
  }
  
  const loadingEl = document.getElementById('roJobsLoading');
  if (loadingEl) loadingEl.style.display = 'flex';
  
  try {
    const mileage = currentRO.mileage || currentRO.mileageIn || (currentRO.rawData && currentRO.rawData.mileageIn);
    const recommendedJobs = currentRO.jobs.map(j => j.name || j.jobName).filter(Boolean);
    
    if (recommendedJobs.length === 0) {
      if (loadingEl) loadingEl.style.display = 'none';
      return;
    }
    
    const response = await fetch(`${appUrl}/api/vehicle-history/check-recommendations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        vin,
        currentMileage: mileage ? parseInt(mileage) : undefined,
        recommendedJobs,
        shopId: currentShopId
      })
    });
    
    if (!response.ok) {
      console.error('Failed to fetch warranty status:', response.status);
      showToast('Could not check warranty status');
      return;
    }
    
    const data = await response.json();
    
    // Update cache with results (index-based to match job order)
    if (data.recommendations && Array.isArray(data.recommendations)) {
      // API returns recommendations in same order as sent
      data.recommendations.forEach((result, index) => {
        jobWarrantyCache[index] = {
          underWarranty: result.status === 'under_warranty',
          recentlyServiced: result.status === 'recently_serviced',
          servicedElsewhere: result.status === 'serviced_elsewhere',
          dueForService: result.status === 'due_for_service',
          source: result.source,
          lastServiceDate: result.lastServiceDate,
          lastServiceMileage: result.lastServiceMileage,
          daysRemaining: result.daysRemaining,
          milesRemaining: result.milesRemaining
        };
      });
      
      // Re-render job badges with warranty info
      updateJobBadges();
    }
    
  } catch (error) {
    console.error('Error fetching warranty status:', error);
    showToast('Could not check warranty status');
  } finally {
    if (loadingEl) loadingEl.style.display = 'none';
  }
}

function updateJobBadges() {
  const jobs = currentRO?.jobs || [];
  
  jobs.forEach((job, index) => {
    const warrantyInfo = jobWarrantyCache[index];
    
    const badgesEl = document.getElementById(`job-badges-${index}`);
    if (badgesEl && warrantyInfo) {
      badgesEl.innerHTML = renderWarrantyBadges(warrantyInfo);
    }
  });
}

async function generateSalesScript() {
  if (!currentRO || !currentRO.jobs) {
    showToast('No repair order data available');
    return;
  }
  
  if (!appUrl) {
    showToast('Please configure app URL in settings');
    return;
  }
  
  const loadingOverlay = document.getElementById('salesLoadingOverlay');
  loadingOverlay.style.display = 'flex';
  
  try {
    // Include credentials to send session cookie for personalized training data
    const response = await authenticatedFetch(`${appUrl}/api/sales/generate-script`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vehicle: currentRO.vehicle,
        jobs: currentRO.jobs,
        customer: currentRO.customer,
        totalAmount: currentRO.totalAmount,
        isInShop: currentRO.isInShop
      })
    });
    
    if (!response.ok) throw new Error('Failed to generate sales script');
    
    const data = await response.json();
    displaySalesScript(data.script);
    
    // Show personalization indicator only when personal training was actually used
    const section = document.getElementById('salesScriptSection');
    const existingBadge = section.querySelector('.personalized-badge');
    
    if (data.usedPersonalTraining) {
      if (!existingBadge) {
        const badge = document.createElement('span');
        badge.className = 'personalized-badge';
        badge.title = 'Script personalized using your training data';
        badge.textContent = 'Personalized';
        const header = section.querySelector('.script-header');
        if (header) {
          // Insert before the refresh button
          const refreshBtn = header.querySelector('.refresh-script-btn');
          if (refreshBtn) {
            header.insertBefore(badge, refreshBtn);
          } else {
            header.appendChild(badge);
          }
        }
      }
    } else if (existingBadge) {
      // Remove badge if not using personal training
      existingBadge.remove();
    }
    
  } catch (error) {
    console.error('Error generating sales script:', error);
    showToast('Could not generate sales script');
  } finally {
    loadingOverlay.style.display = 'none';
  }
}

function displaySalesScript(script) {
  const section = document.getElementById('salesScriptSection');
  const content = document.getElementById('salesScriptContent');
  const noRoMessage = document.getElementById('noRoMessage');
  
  // Convert markdown bold headers to HTML for the 9-point format
  // First escape any HTML, then convert **text** to bold spans
  const escaped = script
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  
  // Convert **HEADER:** format to styled spans
  const formatted = escaped
    .replace(/\*\*([A-Z][A-Z0-9\s\-\/]+):\*\*/g, '<strong class="script-header-label">$1:</strong>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br>');
  
  content.innerHTML = '<p>' + formatted + '</p>';
  section.style.display = 'block';
  noRoMessage.style.display = 'none';
}

function copySalesScript() {
  const content = document.getElementById('salesScriptContent').innerText;
  navigator.clipboard.writeText(content);
  showToast('Sales script copied!');
}

async function submitFeedback(sentiment) {
  const scriptContent = document.getElementById('salesScriptContent').innerText;
  
  if (!appUrl) {
    showToast(sentiment === 'positive' ? 'Great! Thanks for the feedback.' : 'Thanks for the feedback!');
    return;
  }
  
  // Visual feedback immediately
  const successBtn = document.getElementById('feedbackSuccess');
  const failBtn = document.getElementById('feedbackFail');
  
  if (sentiment === 'positive') {
    successBtn.classList.add('selected');
    failBtn.classList.remove('selected');
  } else {
    failBtn.classList.add('selected');
    successBtn.classList.remove('selected');
  }
  
  if (!isAuthenticated) {
    showToast(sentiment === 'positive' ? 'Great! Sign in to save feedback.' : 'Thanks! Sign in to save feedback.');
    return;
  }
  
  try {
    // Build vehicle info string if available
    const vehicleStr = currentRO?.vehicle ? 
      `${currentRO.vehicle.year || ''} ${currentRO.vehicle.make || ''} ${currentRO.vehicle.model || ''}`.trim() : null;
    
    // Build repair type string from jobs
    const repairStr = currentRO?.jobs?.length > 0 ? 
      currentRO.jobs.map(j => j.name || j.jobName).filter(Boolean).join(', ') : null;
    
    const response = await authenticatedFetch(`${appUrl}/api/scripts/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scriptType: 'sales',
        repairOrderId: currentRO?.repairOrderId || null,
        sentiment: sentiment,
        outcome: sentiment === 'positive' ? 'approved' : 'declined',
        scriptContent: scriptContent || null,
        vehicleInfo: vehicleStr,
        repairType: repairStr
      })
    });
    
    if (response.ok) {
      showToast(sentiment === 'positive' ? 'Great! Feedback saved.' : 'Thanks! Feedback saved.');
    } else if (response.status === 401) {
      isAuthenticated = false;
      currentUser = null;
      updateUserDisplay(null);
      showToast('Session expired. Please sign in again.');
    } else {
      const errorData = await response.json().catch(() => ({}));
      console.error('Feedback error:', errorData);
      throw new Error('Failed to save feedback');
    }
  } catch (error) {
    console.error('Error submitting feedback:', error);
    showToast(sentiment === 'positive' ? 'Great! Thanks for the feedback.' : 'Thanks for the feedback!');
  }
}

// ==================== OBJECTION HANDLING ====================

// Objection response templates with placeholders for work order context
const objectionTemplates = {
  price_high: {
    label: "Price Too High",
    template: (ctx) => `I totally get it—car repairs never seem to come at the right time. Just to understand—is there a price you had in mind, or is it just more than you were expecting?

I'll be honest with you—we're not the cheapest facility in town, and we don't hide from that. We've built this business by providing a premium service, and it just costs more to do things the right way.

You're paying for:
• ASE Master Certified techs who are paid like professionals
• A 3-year/36,000-mile nationwide warranty
• A team that's here 7 days a week if something goes wrong

${ctx.totalAmount ? `Your investment of $${ctx.totalAmount.toFixed(2)} for the ${ctx.jobsList || 'recommended services'}` : 'This investment'} isn't just for parts—it's for peace of mind and a repair done right the first time.

Have you ever paid less for something because it felt like a good deal, and then regretted it later?`
  },
  
  no_money: {
    label: "No Money Right Now",
    template: (ctx) => `I totally get it. Car repair never seems to come at a good time—it always finds us on the wrong week, right before payday, or right after something else goes sideways.

Something a ton of our customers love using is our payment options. You can take care of what ${ctx.vehicleDesc || 'your vehicle'} needs today, but spread the cost out over time—without paying for it all up front.

We have programs that can break the cost into smaller payments—some even with 0% for six months.

${ctx.totalAmount ? `So instead of $${ctx.totalAmount.toFixed(2)} all at once, you could handle it in manageable monthly payments.` : ''}

It's the same quality repair, same team, same warranty—you're just not taking the hit all at once. Would that be something you're interested in?`
  },
  
  spouse: {
    label: "Talk to Spouse",
    template: (ctx) => `Hey, I totally understand—I've got to run everything by my wife too before I go spending all of our money!

Let me make this easier for you: What I can do is take this off your plate and offer to make that call for you. Sometimes there are technical questions about ${ctx.jobsList || 'the repairs'} that are easier for me to answer—stuff that gets lost in translation.

We can also hop on a quick 3-way call together if that's easier. That way nobody's guessing or relaying information. I'm here to help however you need.

Would you feel more comfortable if I spoke with them directly? Or would you prefer to tag them in on a quick call?`
  },
  
  waiting: {
    label: "I'll Wait",
    template: (ctx) => {
      const isSafety = ctx.hasSafetyItems;
      if (isSafety) {
        return `I understand completely. Just so I'm being totally upfront with you—this one falls into a true safety category.

${ctx.jobsList ? `With the ${ctx.jobsList}` : 'With these repairs'}, we're beyond the point of normal wear and into items that directly affect your safety on the road. At this stage, it's not just going to cost more later—it's putting you and your passengers at risk if you're driving ${ctx.vehicleDesc || 'the vehicle'} regularly.

I'm not saying that to scare you—I just don't want to see you stuck on the side of the road or unable to stop when it counts.

If it helps, we've got some flexible payment options we can look at, so you don't have to absorb the full cost today. Want me to walk you through those real quick?`;
      } else {
        return `Totally understand—${ctx.jobsList || 'these services'} aren't safety-critical, but they're definitely longevity-critical.

The reason we recommend doing them now is because you're already here, we already have ${ctx.vehicleDesc || 'the vehicle'} in the air, and doing it now actually saves you money and time long-term.

A lot of what we're seeing in these systems is buildup that doesn't show symptoms until it causes real damage. If you're planning to hang on to ${ctx.vehicleDesc || 'the vehicle'}, it's a great time to knock these out now while we've got access and can protect those systems under our warranty.

And again—we can space out the cost if that helps. I'm here to make it work for you either way.`;
      }
    }
  },
  
  selling_car: {
    label: "Selling the Car",
    template: (ctx) => `I totally get where you're coming from. Unexpected repairs can be frustrating.

But here's what I tell all my customers—selling the car rarely saves money, it just moves the cost somewhere else. Let's do the math for a second:

The average new car is $48,000 right now. Put 10% down, and that's nearly $5,000 out of pocket. Drive it off the lot—you immediately lose another 10% in depreciation. Now you're paying $800 a month, plus taxes, plus maintenance, and a year later you're down $15,000 plus.

Even used cars today average $28,000—and you're inheriting someone else's wear and tear. You don't know how they maintained it. You don't really know what's coming next.

We only recommend services on vehicles that are truly good investments. And based on our inspection, ${ctx.vehicleDesc || 'this vehicle'} is in excellent condition overall. The overwhelming majority of the systems we checked are in great shape.

Let me ask you this—if you could walk onto a car lot today and buy ${ctx.vehicleDesc || 'this exact car'} for ${ctx.totalAmount ? `$${ctx.totalAmount.toFixed(2)}` : 'this repair cost'}, knowing that so many of the key components have already been inspected and are in good shape—would you buy it?

Because that's exactly what you're doing. You're not just throwing money at an old car—you're making a smart, measured investment in a vehicle that still has a lot of life left.`
  },
  
  need_car: {
    label: "Need Car Today",
    template: (ctx) => `Totally understand—and let me start by saying: we've got options.

We have loaner vehicles available, and we offer shuttle rides and pickup/drop-off services too—whatever makes your day easier. Let me take that stress off your plate.

Would a loaner or shuttle ride help take care of that for you today?

Once we get ${ctx.vehicleDesc || 'your vehicle'} in and get started on ${ctx.jobsList || 'the repairs'}, I'll keep you posted on progress. ${ctx.totalAmount ? `Your total investment is $${ctx.totalAmount.toFixed(2)}, and` : ''} I'll have an update for you by end of day, around 4:30 or 5.

Is this still the best number for updates later today?`
  },
  
  always_selling: {
    label: "Always Selling Me",
    template: (ctx) => `I totally understand, ${ctx.customerName || 'and I appreciate you being honest with me'}. And I want to start by saying this: That is never my intention—to make you feel sold. If that's how it came across, then I must've dropped the ball.

You are never obligated to do any of the work we recommend—but it is my professional obligation to look over ${ctx.vehicleDesc || 'your vehicle'} and tell you what I see.

Let me ask you something: What's worse—a quick phone call about a maintenance item today… or a phone call two weeks from now when there's oil leaking all over your driveway and no one warned you? Or worse yet—you and your family are broken down on the side of the road, 5 hours outside of town, calling AAA for something that could have been prevented.

That's the call I never want to get.

Every time your vehicle comes in, we're going to do a complimentary, bumper-to-bumper inspection. We check underhood, mid-rise, and full-rise—front to back, top to bottom.

Again—you're not obligated to fix any of it with us, but as your service advisor, it's my professional obligation to help you make smart decisions about ${ctx.vehicleDesc || 'your vehicle'}.

Would you like me to walk you through the results of the inspection today?`
  }
};

// Generate context object from current RO data
function getObjectionContext() {
  if (!currentRO) return {};
  
  const vehicle = currentRO.vehicle || {};
  const vehicleDesc = `${vehicle.year || ''} ${vehicle.make || ''} ${vehicle.model || ''}`.trim() || 'your vehicle';
  
  const jobs = currentRO.jobs || [];
  const jobNames = jobs.map(j => j.name || j.jobName).filter(Boolean);
  const jobsList = jobNames.slice(0, 3).join(', ') || null;
  
  // Detect safety items (brakes, steering, suspension, etc.)
  const safetyKeywords = /brake|steering|suspension|tire|axle|ball joint|tie rod|wheel bearing|control arm|strut|shock|rotor|caliper|hub/i;
  const hasSafetyItems = jobNames.some(name => safetyKeywords.test(name));
  
  // Get total from currentRO
  const totalAmount = currentRO.totalAmount || currentRO.total || null;
  
  // Customer name
  const customerName = currentRO.customer?.name?.split(' ')[0] || null;
  
  return {
    vehicleDesc,
    jobsList,
    hasSafetyItems,
    totalAmount: totalAmount ? parseFloat(totalAmount) : null,
    customerName
  };
}

// Handle objection button click
function handleObjectionClick(objectionKey) {
  const template = objectionTemplates[objectionKey];
  if (!template) return;
  
  // Update active button state
  document.querySelectorAll('.objection-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.objection === objectionKey);
  });
  
  // Generate response using context
  const context = getObjectionContext();
  const response = template.template(context);
  
  // Display response
  const responseSection = document.getElementById('objectionResponse');
  const responseLabel = document.getElementById('objectionResponseLabel');
  const responseContent = document.getElementById('objectionResponseContent');
  
  responseLabel.textContent = template.label;
  responseContent.textContent = response;
  responseSection.style.display = 'block';
}

// Copy objection response
function copyObjectionResponse() {
  const content = document.getElementById('objectionResponseContent').innerText;
  navigator.clipboard.writeText(content);
  showToast('Response copied!');
}

// ==================== SEARCH ====================

const SHOP_NAMES = {
  ALL: 'All Locations',
  NB: 'Northbrook',
  WM: 'Wilmette',
  EV: 'Evanston'
};

function autoFillSearchVehicle() {
  const searchYear = document.getElementById('searchYear');
  const searchMake = document.getElementById('searchMake');
  const searchModel = document.getElementById('searchModel');
  
  // First try to fill from current RO vehicle info
  if (currentRO && currentRO.vehicle) {
    if (!searchYear.value && currentRO.vehicle.year) {
      searchYear.value = currentRO.vehicle.year;
    }
    if (!searchMake.value && currentRO.vehicle.make) {
      searchMake.value = currentRO.vehicle.make;
    }
    if (!searchModel.value && currentRO.vehicle.model) {
      searchModel.value = currentRO.vehicle.model;
    }
  }
  
  // Fallback: try to fill from Incoming Caller tab vehicle fields
  const incomingYear = document.getElementById('vehicleYear').value;
  const incomingMake = document.getElementById('vehicleMake').value;
  const incomingModel = document.getElementById('vehicleModel').value;
  
  if (!searchYear.value && incomingYear) {
    searchYear.value = incomingYear;
  }
  if (!searchMake.value && incomingMake) {
    searchMake.value = incomingMake;
  }
  if (!searchModel.value && incomingModel) {
    searchModel.value = incomingModel;
  }
}

async function performSearch() {
  const repairType = document.getElementById('searchRepairType').value.trim();
  
  if (!repairType) {
    showToast('Please enter a repair type');
    return;
  }
  
  if (!appUrl) {
    console.error('Search error: appUrl not configured');
    showToast('Please configure app URL in settings (gear icon)');
    openSettings();
    return;
  }
  
  const loadingOverlay = document.getElementById('searchLoadingOverlay');
  loadingOverlay.style.display = 'flex';
  
  try {
    const yearValue = document.getElementById('searchYear').value.trim();
    const params = {
      repairType: repairType,
      vehicleYear: yearValue ? parseInt(yearValue, 10) : undefined,
      vehicleMake: document.getElementById('searchMake').value.trim() || undefined,
      vehicleModel: document.getElementById('searchModel').value.trim() || undefined,
      vehicleEngine: document.getElementById('searchEngine').value.trim() || undefined,
      limit: 20
    };
    
    // Remove undefined values
    Object.keys(params).forEach(key => params[key] === undefined && delete params[key]);
    
    console.log('Search params:', params);
    console.log('Fetching from:', `${appUrl}/api/search`);
    
    // Refresh cookie before searching
    await getSessionCookie();
    
    const response = await authenticatedFetch(`${appUrl}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    });
    
    console.log('Search response status:', response.status);
    
    if (!response.ok) {
      if (response.status === 401) {
        showToast('Please sign in to search');
        return;
      }
      if (response.status === 403) {
        showToast('Account pending approval');
        return;
      }
      const errorText = await response.text();
      console.error('Search error response:', errorText);
      throw new Error(`Search failed: ${response.status}`);
    }
    
    const data = await response.json();
    console.log('Search results:', data);
    searchResults = data.results || [];
    displaySearchResults();
    
    if (searchResults.length === 0) {
      showToast('No matching jobs found');
    }
    
  } catch (error) {
    console.error('Search error:', error);
    showToast('Search failed. Check connection.');
  } finally {
    loadingOverlay.style.display = 'none';
  }
}

function displaySearchResults() {
  const emptyState = document.getElementById('searchEmptyState');
  const resultsSection = document.getElementById('searchResultsSection');
  const resultsList = document.getElementById('searchResultsList');
  const resultsCount = document.getElementById('resultsCount');
  const jobDetailSection = document.getElementById('jobDetailSection');
  const formSection = document.querySelector('.search-form-section');
  
  // Hide job detail, show form
  jobDetailSection.style.display = 'none';
  formSection.style.display = 'block';
  
  if (searchResults.length === 0) {
    emptyState.style.display = 'none';
    resultsSection.style.display = 'flex';
    resultsList.innerHTML = `
      <div class="no-results-state">
        <div class="no-results-icon">&#128269;</div>
        <div class="no-results-title">No Matching Jobs Found</div>
        <div class="no-results-desc">Try adjusting your search criteria or broadening your vehicle details.</div>
      </div>
    `;
    resultsCount.textContent = '0 results';
    return;
  }
  
  emptyState.style.display = 'none';
  resultsSection.style.display = 'flex';
  resultsCount.textContent = `${searchResults.length} result${searchResults.length !== 1 ? 's' : ''}`;
  
  resultsList.innerHTML = searchResults.map((result, index) => {
    const { job, matchScore, matchReason } = result;
    const vehicle = job.vehicle;
    const laborHours = job.laborItems.reduce((sum, item) => sum + Number(item.hours || 0), 0);
    const partsCount = job.parts.length;
    const shopId = job.repairOrder?.shopId;
    const shopName = shopId && SHOP_NAMES[shopId] ? SHOP_NAMES[shopId] : null;
    
    const matchClass = matchScore >= 80 ? 'high' : matchScore >= 60 ? 'medium' : 'low';
    const vehicleStr = vehicle ? `${vehicle.year || ''} ${vehicle.make || ''} ${vehicle.model || ''}`.trim() : '';
    
    return `
      <div class="job-result-card" data-index="${index}">
        <div class="job-card-header">
          <div>
            ${vehicleStr ? `<div class="job-card-vehicle">${vehicleStr}</div>` : ''}
            <div class="job-card-name">${job.name}</div>
          </div>
          <span class="match-badge ${matchClass}">${matchScore}%</span>
        </div>
        ${matchReason ? `<div class="job-card-reason">${matchReason}</div>` : ''}
        <div class="job-card-meta">
          <div class="job-card-meta-item">
            <span class="job-card-meta-icon">&#128176;</span>
            ${formatCurrency(job.totalPrice)}
          </div>
          <div class="job-card-meta-item">
            <span class="job-card-meta-icon">&#128338;</span>
            ${laborHours.toFixed(1)} hrs
          </div>
          <div class="job-card-meta-item">
            <span class="job-card-meta-icon">&#128295;</span>
            ${partsCount} parts
          </div>
          ${shopName ? `<div class="job-card-meta-item"><span class="job-card-meta-icon">&#127970;</span>${shopName}</div>` : ''}
          ${job.serviceWriterName ? `<div class="job-card-meta-item"><span class="job-card-meta-icon">&#128100;</span>${job.serviceWriterName}</div>` : ''}
        </div>
      </div>
    `;
  }).join('');
  
  // Add click listeners to cards
  resultsList.querySelectorAll('.job-result-card').forEach(card => {
    card.addEventListener('click', () => {
      const index = parseInt(card.dataset.index);
      showJobDetail(searchResults[index]);
    });
  });
}

function showJobDetail(result) {
  selectedJobResult = result;
  const { job, matchScore, matchReason } = result;
  const vehicle = job.vehicle;
  const formSection = document.querySelector('.search-form-section');
  const resultsSection = document.getElementById('searchResultsSection');
  const jobDetailSection = document.getElementById('jobDetailSection');
  const detailContent = document.getElementById('jobDetailContent');
  
  formSection.style.display = 'none';
  resultsSection.style.display = 'none';
  jobDetailSection.style.display = 'flex';
  
  const vehicleStr = vehicle ? `${vehicle.year || ''} ${vehicle.make || ''} ${vehicle.model || ''}`.trim() : '';
  const shopId = job.repairOrder?.shopId;
  const shopName = shopId && SHOP_NAMES[shopId] ? SHOP_NAMES[shopId] : null;
  
  // Calculate totals
  const laborTotal = job.laborItems.reduce((sum, item) => sum + Number(item.laborTotal || 0), 0);
  const partsTotal = job.parts.reduce((sum, part) => sum + Number(part.total || 0), 0);
  const totalHours = job.laborItems.reduce((sum, item) => sum + Number(item.hours || 0), 0);
  
  let html = `
    <div class="job-detail-header">
      ${vehicleStr ? `<div class="job-detail-vehicle">${vehicleStr}${vehicle?.engine ? ` - ${vehicle.engine}` : ''}</div>` : ''}
      <div class="job-detail-name">${job.name}</div>
      <div class="job-detail-match">&#127942; ${matchScore}% Match</div>
      ${matchReason ? `<div class="job-detail-reason">${matchReason}</div>` : ''}
    </div>
  `;
  
  // Labor items
  if (job.laborItems.length > 0) {
    html += `<div class="job-detail-section-title">Labor (${totalHours.toFixed(1)} hrs)</div>`;
    job.laborItems.forEach(item => {
      html += `
        <div class="job-detail-item">
          <div class="job-detail-item-name">${item.name}</div>
          <div class="job-detail-item-meta">${item.hours} hrs @ ${formatCurrency(item.rate)}/hr = ${formatCurrency(item.laborTotal)}</div>
        </div>
      `;
    });
  }
  
  // Parts
  if (job.parts.length > 0) {
    html += `<div class="job-detail-section-title">Parts (${job.parts.length})</div>`;
    job.parts.forEach(part => {
      html += `
        <div class="job-detail-item">
          <div class="job-detail-item-name">${part.name || 'Part'}</div>
          <div class="job-detail-item-meta">
            ${part.partNumber ? `#${part.partNumber} - ` : ''}
            Qty ${part.quantity} @ ${formatCurrency(part.unitPrice)} = ${formatCurrency(part.total)}
          </div>
        </div>
      `;
    });
  }
  
  // Totals
  html += `
    <div class="job-detail-totals">
      <div class="job-detail-total-row">
        <span>Labor</span>
        <span>${formatCurrency(laborTotal)}</span>
      </div>
      <div class="job-detail-total-row">
        <span>Parts</span>
        <span>${formatCurrency(partsTotal)}</span>
      </div>
      <div class="job-detail-total-row grand">
        <span>Total</span>
        <span>${formatCurrency(job.totalPrice)}</span>
      </div>
    </div>
  `;
  
  // RO info with service advisor
  html += `
    <div class="job-detail-ro">
      RO #${job.repairOrderId}
      ${shopName ? `<span class="job-detail-shop">${shopName}</span>` : ''}
      ${job.serviceWriterName ? `<span class="job-detail-advisor">&#128100; ${job.serviceWriterName}</span>` : ''}
    </div>
  `;
  
  // Create Job in Tekmetric button
  html += `
    <div class="job-detail-actions">
      <button class="create-job-btn" id="createJobBtn" data-testid="button-create-job">
        <span class="btn-icon">&#128203;</span>
        Create Job in Tekmetric
      </button>
    </div>
  `;
  
  detailContent.innerHTML = html;
  
  // Add event listener (CSP doesn't allow inline onclick)
  document.getElementById('createJobBtn').addEventListener('click', createJobInTekmetric);
}

// Create job in Tekmetric from selected job result
// Uses direct API call for speed (1-2 seconds vs 20-30 seconds with UI automation)
async function createJobInTekmetric() {
  console.log('createJobInTekmetric called, selectedJobResult:', selectedJobResult);
  
  if (!selectedJobResult) {
    showToast('No job selected', 'error');
    return;
  }
  
  const job = selectedJobResult.job;
  const vehicle = selectedJobResult.vehicle;
  console.log('Creating job data for:', job.name);
  
  // Build job data for API
  // Note: API returns values in cents, we convert to dollars for the API payload
  const jobData = {
    jobName: job.name,
    name: job.name,
    vehicle: vehicle ? {
      year: vehicle.year,
      make: vehicle.make,
      model: vehicle.model,
      engine: vehicle.engine,
      vin: vehicle.vin,
    } : null,
    laborItems: job.laborItems.map(item => ({
      name: item.name,
      description: item.name,
      hours: Number(item.hours),
      rate: (item.rate || 0) / 100,  // Convert cents to dollars
    })),
    parts: job.parts.map(part => ({
      name: part.name,
      description: part.name,
      brand: part.brand,
      partNumber: part.partNumber,
      quantity: part.quantity,
      cost: (part.cost || 0) / 100,  // Convert cents to dollars
      retail: (part.retail || part.unitPrice || 0) / 100,  // Convert cents to dollars
      price: (part.retail || part.unitPrice || 0) / 100,
    })),
    totals: {
      labor: (job.laborTotal || 0) / 100,
      parts: (job.partsTotal || 0) / 100,
      total: (job.subtotal || job.totalPrice || 0) / 100,
    },
  };
  
  console.log('Job data prepared for API:', jobData);
  
  try {
    // Check if we're on a Tekmetric page first
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    console.log('Current tab:', tab?.url);
    
    if (!tab?.url?.includes('tekmetric.com')) {
      showToast('Navigate to a Tekmetric repair order first', 'error');
      return;
    }
    
    // Extract shop ID and RO ID from the URL
    // Patterns: /shop/469/repair-orders/277382151 or /sandbox/469/repair-orders/277382151
    const urlMatch = tab.url.match(/\/(?:shop|sandbox|cba)\/(\d+)\/repair-orders\/(\d+)/);
    
    if (!urlMatch) {
      showToast('Please open a repair order in Tekmetric first', 'error');
      return;
    }
    
    const shopId = urlMatch[1];
    const roId = urlMatch[2];
    
    console.log('Extracted from URL - Shop ID:', shopId, 'RO ID:', roId);
    
    // Show loading state
    const createBtn = document.getElementById('createJobBtn');
    const originalText = createBtn.innerHTML;
    createBtn.innerHTML = '<span class="btn-icon">&#9203;</span> Creating...';
    createBtn.disabled = true;
    
    // Call the API-based job creation
    console.log('Sending CREATE_JOB_VIA_API to background...');
    chrome.runtime.sendMessage({ 
      action: 'CREATE_JOB_VIA_API',
      shopId,
      roId,
      jobData 
    }, (response) => {
      console.log('CREATE_JOB_VIA_API response:', response);
      
      // Restore button state
      createBtn.innerHTML = originalText;
      createBtn.disabled = false;
      
      if (response?.success) {
        const laborCount = response.laborCount || 0;
        const partsCount = response.partsCount || 0;
        showToast(`Job created! (${laborCount} labor, ${partsCount} parts)`, 'success');
        
        // Refresh the Tekmetric tab to show the new job
        chrome.tabs.reload(tab.id);
      } else {
        const errorMsg = response?.error || 'Unknown error';
        console.error('Job creation failed:', errorMsg);
        showToast(`Failed: ${errorMsg}`, 'error');
      }
    });
  } catch (error) {
    console.error('Error creating job:', error);
    showToast('Failed to create job', 'error');
  }
}

function backToResults() {
  const formSection = document.querySelector('.search-form-section');
  const resultsSection = document.getElementById('searchResultsSection');
  const jobDetailSection = document.getElementById('jobDetailSection');
  
  formSection.style.display = 'block';
  resultsSection.style.display = 'flex';
  jobDetailSection.style.display = 'none';
  selectedJobResult = null;
}

function clearSearch() {
  searchResults = [];
  selectedJobResult = null;
  
  document.getElementById('searchYear').value = '';
  document.getElementById('searchMake').value = '';
  document.getElementById('searchModel').value = '';
  document.getElementById('searchEngine').value = '';
  document.getElementById('searchRepairType').value = '';
  
  document.getElementById('searchResultsSection').style.display = 'none';
  document.getElementById('jobDetailSection').style.display = 'none';
  document.getElementById('searchEmptyState').style.display = 'flex';
  document.querySelector('.search-form-section').style.display = 'block';
}

function formatCurrency(cents) {
  if (cents === null || cents === undefined) return '$0.00';
  return `$${(Number(cents) / 100).toFixed(2)}`;
}

// ==================== SETTINGS ====================

function updateConnectionStatus() {
  const dot = document.querySelector('.status-dot');
  const text = document.getElementById('connectionText');
  
  if (appUrl) {
    dot.className = 'status-dot connected';
    text.textContent = 'Connected';
    text.style.cursor = 'default';
    text.onclick = null;
  } else {
    dot.className = 'status-dot disconnected';
    text.innerHTML = 'Not connected - <u style="cursor:pointer">click to configure</u>';
    text.style.cursor = 'pointer';
    text.onclick = openSettings;
  }
}

function openSettings() {
  document.getElementById('appUrlInput').value = appUrl || '';
  document.getElementById('settingsModal').style.display = 'flex';
}

function closeSettings() {
  document.getElementById('settingsModal').style.display = 'none';
}

async function saveSettings() {
  let newUrl = document.getElementById('appUrlInput').value.trim();
  
  if (newUrl) {
    try {
      // Normalize URL: extract just the origin (protocol + host)
      const parsed = new URL(newUrl);
      newUrl = parsed.origin; // This strips any path like /settings
    } catch {
      showToast('Please enter a valid URL');
      return;
    }
  }
  
  appUrl = newUrl;
  chrome.storage.sync.set({ heartHelperUrl: newUrl });
  chrome.storage.local.set({ appUrl: newUrl });
  
  updateConnectionStatus();
  closeSettings();
  showToast('Settings saved!');
  
  if (newUrl) {
    await syncSettingsFromApp();
  }
}

// ==================== UTILITIES ====================

function showToast(message) {
  const existing = document.querySelector('.copied-toast');
  if (existing) existing.remove();
  
  const toast = document.createElement('div');
  toast.className = 'copied-toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  
  setTimeout(() => toast.remove(), 2000);
}

// ==================== LABOR RATE GROUPS ====================

// Get current Tekmetric shop ID from background or storage
async function getCurrentTekmetricShopId() {
  // Try to get from storage (set by background.js)
  const data = await chrome.storage.local.get(['currentTekmetricShopId']);
  return data.currentTekmetricShopId || null;
}

async function loadLaborRateGroups() {
  const container = document.getElementById("laborRateGroupsList");
  const shopLabel = document.getElementById("ratesShopLabel");
  const adminLink = document.getElementById("ratesAdminLink");
  const openAdminLink = document.getElementById("openLaborRatesAdmin");
  
  if (!container) return;
  
  // Show loading state
  container.innerHTML = '<div class="no-groups-message">Loading labor rate groups...</div>';
  
  if (!appUrl) {
    shopLabel.textContent = 'App not connected';
    container.innerHTML = `
      <div class="no-groups-message">
        Connect to the HEART Helper app to view labor rate groups.
        Click the gear icon below to configure.
      </div>
    `;
    return;
  }
  
  // Get current shop ID
  const shopId = await getCurrentTekmetricShopId();
  
  try {
    // Fetch groups from server (includes both shop-specific and ALL location groups)
    const response = await authenticatedFetch(`${appUrl}/api/labor-rate-groups${shopId ? `?shopId=${shopId}` : ''}`);
    
    if (!response.ok) {
      if (response.status === 401) {
        shopLabel.textContent = 'Not signed in';
        container.innerHTML = `
          <div class="no-groups-message">
            Sign in to the HEART Helper app to view labor rate groups.
          </div>
        `;
        return;
      }
      throw new Error(`Server error: ${response.status}`);
    }
    
    const groups = await response.json();
    
    // Update shop label
    if (shopId && SHOP_NAMES[shopId]) {
      shopLabel.textContent = `Showing rates for: ${SHOP_NAMES[shopId]}`;
    } else if (shopId) {
      shopLabel.textContent = `Shop: ${shopId}`;
    } else {
      shopLabel.textContent = 'All configured rates';
    }
    
    // Show admin link for admin users
    if (currentUser?.isAdmin) {
      adminLink.style.display = 'block';
      openAdminLink.onclick = (e) => {
        e.preventDefault();
        window.open(`${appUrl}/admin/labor-rates`, '_blank');
      };
    } else {
      adminLink.style.display = 'none';
    }
    
    // Store groups locally for background.js to use
    await chrome.storage.local.set({ laborRateGroups: groups });
    
    if (groups.length === 0) {
      container.innerHTML = `
        <div class="no-groups-message">
          No labor rate groups configured for this location.
          ${currentUser?.isAdmin ? '<br><br>Click "Manage Labor Rates" below to add groups.' : '<br><br>Ask your admin to configure labor rate groups.'}
        </div>
      `;
      return;
    }
    
    // Group by shop for display
    const groupsByShop = {};
    groups.forEach(group => {
      const key = group.shopId || 'ALL';
      if (!groupsByShop[key]) groupsByShop[key] = [];
      groupsByShop[key].push(group);
    });
    
    // Render groups
    let html = '';
    
    // Show ALL location groups first if any
    if (groupsByShop['ALL']) {
      html += `<div class="shop-group-section">
        <div class="shop-group-label">All Locations</div>
        ${renderGroups(groupsByShop['ALL'])}
      </div>`;
    }
    
    // Show shop-specific groups
    Object.entries(groupsByShop)
      .filter(([key]) => key !== 'ALL')
      .forEach(([shopKey, shopGroups]) => {
        html += `<div class="shop-group-section">
          <div class="shop-group-label">${SHOP_NAMES[shopKey] || shopKey}</div>
          ${renderGroups(shopGroups)}
        </div>`;
      });
    
    container.innerHTML = html;
    
  } catch (error) {
    console.error('Error loading labor rate groups:', error);
    shopLabel.textContent = 'Error loading groups';
    container.innerHTML = `
      <div class="no-groups-message error">
        Failed to load labor rate groups. Check your connection and try again.
      </div>
    `;
  }
}

function renderGroups(groups) {
  return groups.map(group => `
    <div class="labor-rate-group-card">
      <div class="labor-rate-group-header">
        <span class="labor-rate-group-name">${escapeHtml(group.name)}</span>
        <span class="labor-rate-group-rate">$${(group.laborRate / 100).toFixed(2)}/hr</span>
      </div>
      <div class="labor-rate-group-makes">
        <strong>Makes:</strong> ${group.makes.map(m => escapeHtml(m)).join(", ")}
      </div>
    </div>
  `).join("");
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ==================== JOB-BASED LABOR RATES ====================

async function loadJobLaborRates() {
  const container = document.getElementById("jobLaborRatesList");
  
  if (!container) return;
  
  // Show loading state
  container.innerHTML = '<div class="no-groups-message">Loading job rates...</div>';
  
  if (!appUrl) {
    container.innerHTML = `
      <div class="no-groups-message">
        Connect to the HEART Helper app to view job rates.
      </div>
    `;
    return;
  }
  
  // Get current shop ID
  const shopId = await getCurrentTekmetricShopId();
  
  try {
    // Fetch job rates from server
    const response = await authenticatedFetch(`${appUrl}/api/job-labor-rates${shopId ? `?shopId=${shopId}` : ''}`);
    
    if (!response.ok) {
      if (response.status === 401) {
        container.innerHTML = `
          <div class="no-groups-message">
            Sign in to view job labor rates.
          </div>
        `;
        return;
      }
      throw new Error(`Server error: ${response.status}`);
    }
    
    const rates = await response.json();
    
    // Store in chrome.storage.local for use when creating jobs
    await chrome.storage.local.set({ jobLaborRates: rates });
    
    if (rates.length === 0) {
      container.innerHTML = `
        <div class="no-groups-message">
          No job-based labor rates configured.
          ${currentUser?.isAdmin ? '<br><br>Click "Manage Labor Rates" below to add job rates.' : ''}
        </div>
      `;
      return;
    }
    
    // Render job rates
    container.innerHTML = rates.map(rate => {
      // Determine the effective rate for current shop
      const shopRate = shopId && rate.shopRates && rate.shopRates[shopId];
      const effectiveRate = shopRate !== undefined ? shopRate : rate.defaultRate;
      const isShopSpecific = shopRate !== undefined;
      
      return `
        <div class="labor-rate-group-card">
          <div class="labor-rate-group-header">
            <span class="labor-rate-group-name">${escapeHtml(rate.jobName)}</span>
            <span class="labor-rate-group-rate">${isShopSpecific ? '★ ' : ''}$${(effectiveRate / 100).toFixed(2)}</span>
          </div>
          <div class="labor-rate-group-makes">
            <strong>Keywords:</strong> ${rate.keywords.map(k => escapeHtml(k)).join(", ")}
          </div>
        </div>
      `;
    }).join("");
    
  } catch (error) {
    console.error('Error loading job labor rates:', error);
    container.innerHTML = `
      <div class="no-groups-message error">
        Failed to load job rates. Check your connection.
      </div>
    `;
  }
}

// ==================== LIVE COACHING TIPS ====================

let coachingTips = [];
let currentTipIndex = 0;

async function loadCoachingTips() {
  const tipsList = document.getElementById('tipsList');
  const tipsCount = document.getElementById('tipsCount');
  const highlightedTip = document.getElementById('highlightedTip');
  const currentTipHighlight = document.getElementById('currentTipHighlight');
  const tipsListContainer = document.getElementById('tipsListContainer');
  const noTipsMessage = document.getElementById('noTipsMessage');
  const refreshBtn = document.getElementById('refreshTipsBtn');
  
  if (!tipsList) return;
  
  // Show loading state
  tipsList.innerHTML = '<div class="loading-tips">Loading coaching tips...</div>';
  highlightedTip.textContent = 'Loading...';
  
  if (!appUrl) {
    tipsList.innerHTML = '<div class="loading-tips">Connect to the app to load tips.</div>';
    highlightedTip.textContent = 'Connect to the HEART Helper app to see coaching tips.';
    return;
  }
  
  try {
    // Fetch coaching criteria from server
    const response = await authenticatedFetch(`${appUrl}/api/coaching/criteria`);
    
    if (!response.ok) {
      if (response.status === 401) {
        tipsList.innerHTML = '<div class="loading-tips">Sign in to view coaching tips.</div>';
        highlightedTip.textContent = 'Sign in to the app to see coaching tips.';
        return;
      }
      throw new Error(`Server error: ${response.status}`);
    }
    
    const criteria = await response.json();
    
    if (!criteria || criteria.length === 0) {
      currentTipHighlight.style.display = 'none';
      tipsListContainer.style.display = 'none';
      noTipsMessage.style.display = 'block';
      return;
    }
    
    // Show tips UI
    currentTipHighlight.style.display = 'block';
    tipsListContainer.style.display = 'block';
    noTipsMessage.style.display = 'none';
    
    // Store and shuffle tips
    coachingTips = criteria.map(c => ({
      id: c.id,
      name: c.name,
      description: c.description,
      keywords: c.keywords || [],
      category: c.category || 'general'
    }));
    
    // Shuffle tips for variety
    shuffleTips();
    
    // Update count
    tipsCount.textContent = `${coachingTips.length} tips`;
    
    // Show first highlighted tip
    updateHighlightedTip();
    
    // Render tips list
    renderTipsList();
    
    // Set up refresh button
    if (refreshBtn) {
      refreshBtn.onclick = () => {
        shuffleTips();
        updateHighlightedTip();
        renderTipsList();
      };
    }
    
  } catch (error) {
    console.error('Error loading coaching tips:', error);
    tipsList.innerHTML = '<div class="loading-tips">Failed to load tips. Try again later.</div>';
    highlightedTip.textContent = 'Unable to load coaching tips.';
  }
}

function shuffleTips() {
  for (let i = coachingTips.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [coachingTips[i], coachingTips[j]] = [coachingTips[j], coachingTips[i]];
  }
  currentTipIndex = 0;
}

function updateHighlightedTip() {
  const highlightedTip = document.getElementById('highlightedTip');
  if (coachingTips.length > 0 && highlightedTip) {
    const tip = coachingTips[currentTipIndex];
    highlightedTip.textContent = tip.name;
  }
}

function renderTipsList() {
  const tipsList = document.getElementById('tipsList');
  if (!tipsList || coachingTips.length === 0) return;
  
  const html = coachingTips.map((tip, index) => `
    <div class="tip-item ${index === currentTipIndex ? 'active' : ''}" data-tip-index="${index}">
      <div class="tip-icon">${getCategoryIcon(tip.category)}</div>
      <div class="tip-content">
        <div class="tip-name">${escapeHtml(tip.name)}</div>
        ${tip.description ? `<div class="tip-description">${escapeHtml(tip.description)}</div>` : ''}
      </div>
    </div>
  `).join('');
  
  tipsList.innerHTML = html;
  
  // Add click handlers for selecting tips
  tipsList.querySelectorAll('.tip-item').forEach(item => {
    item.addEventListener('click', () => {
      const index = parseInt(item.dataset.tipIndex);
      currentTipIndex = index;
      updateHighlightedTip();
      
      // Update active state
      tipsList.querySelectorAll('.tip-item').forEach(i => i.classList.remove('active'));
      item.classList.add('active');
    });
  });
}

function getCategoryIcon(category) {
  const icons = {
    greeting: '&#128075;',     // waving hand
    rapport: '&#129309;',      // handshake
    presentation: '&#128172;', // speech bubble
    objection: '&#128170;',    // flexed biceps
    urgency: '&#9200;',        // alarm clock
    value: '&#128176;',        // money bag
    closing: '&#9989;',        // check mark
    retention: '&#128231;',    // envelope
    general: '&#128161;',      // lightbulb
    default: '&#128161;'       // lightbulb
  };
  return icons[category] || icons.default;
}

// ==================== VEHICLE HISTORY TAB ====================

let cachedVehicleHistory = null;
let cachedVehicleVin = null;
let cachedVehicleMileage = null;

function autoFillHistoryVehicle() {
  const vinInput = document.getElementById('historyVin');
  const mileageInput = document.getElementById('historyMileage');
  
  // Try multiple sources for VIN: currentRO, cached API response
  let vin = null;
  if (currentRO && currentRO.vehicle && currentRO.vehicle.vin) {
    vin = currentRO.vehicle.vin;
  } else if (cachedVehicleVin) {
    vin = cachedVehicleVin;
  }
  
  // Auto-fill VIN if available and field is empty
  if (vinInput && !vinInput.value && vin) {
    vinInput.value = vin;
  }
  
  // Try multiple sources for mileage: currentRO, cached API response
  let mileage = null;
  if (currentRO) {
    mileage = currentRO.mileage || currentRO.mileageIn || (currentRO.rawData && currentRO.rawData.mileageIn);
  }
  if (!mileage && cachedVehicleMileage) {
    mileage = cachedVehicleMileage;
  }
  
  // Auto-fill mileage if available and field is empty
  if (mileageInput && !mileageInput.value && mileage) {
    mileageInput.value = mileage;
  }
  
  // Auto-fetch if VIN is present
  if (vinInput && vinInput.value && vinInput.value.length >= 11) {
    fetchVehicleHistory();
  }
}

async function fetchVehicleHistory() {
  if (!appUrl) {
    showHistoryError('Please configure the app URL in settings.');
    return;
  }
  
  const vinInput = document.getElementById('historyVin');
  const mileageInput = document.getElementById('historyMileage');
  const vin = vinInput ? vinInput.value.trim().toUpperCase() : '';
  const mileage = mileageInput ? parseInt(mileageInput.value) || undefined : undefined;
  
  if (!vin || vin.length < 11) {
    showHistoryError('Please enter a valid VIN (at least 11 characters).');
    return;
  }
  
  // Show loading state
  showHistoryLoading();
  
  try {
    // Build query params
    let url = `${appUrl}/api/vehicle-history/${encodeURIComponent(vin)}?includeCarfax=true`;
    if (mileage) url += `&mileage=${mileage}`;
    if (currentShopId) url += `&shopId=${currentShopId}`;
    
    const response = await fetch(url, { credentials: 'include' });
    
    if (!response.ok) {
      throw new Error(`HTTP error ${response.status}`);
    }
    
    const history = await response.json();
    cachedVehicleHistory = history;
    
    // Display results
    displayVehicleHistory(history);
    
  } catch (error) {
    console.error('Error fetching vehicle history:', error);
    showHistoryError('Unable to fetch vehicle history. Please try again.');
  }
}

function showHistoryLoading() {
  document.getElementById('historyVinInput').style.display = 'none';
  document.getElementById('historyVehicleSummary').style.display = 'none';
  document.getElementById('historyLoading').style.display = 'flex';
  document.getElementById('historyResults').style.display = 'none';
  document.getElementById('historyEmpty').style.display = 'none';
  document.getElementById('historyError').style.display = 'none';
}

function showHistoryError(message) {
  document.getElementById('historyVinInput').style.display = 'block';
  document.getElementById('historyVehicleSummary').style.display = 'none';
  document.getElementById('historyLoading').style.display = 'none';
  document.getElementById('historyResults').style.display = 'none';
  document.getElementById('historyEmpty').style.display = 'none';
  document.getElementById('historyError').style.display = 'block';
  document.getElementById('historyErrorMessage').textContent = message;
}

function displayVehicleHistory(history) {
  // Hide loading, show results
  document.getElementById('historyLoading').style.display = 'none';
  document.getElementById('historyVinInput').style.display = 'none';
  document.getElementById('historyError').style.display = 'none';
  
  // Show vehicle summary
  const summary = document.getElementById('historyVehicleSummary');
  summary.style.display = 'block';
  
  if (history.vehicle) {
    document.getElementById('historyVehicleInfo').textContent = 
      `${history.vehicle.year || ''} ${history.vehicle.make || ''} ${history.vehicle.model || ''}`.trim() || 'Unknown Vehicle';
  } else {
    document.getElementById('historyVehicleInfo').textContent = 'Vehicle Info Unavailable';
  }
  document.getElementById('historyVinDisplay').textContent = history.vin;
  
  // Check if we have any history
  const hasHeartHistory = history.heartHistory && history.heartHistory.length > 0;
  const hasCarfaxHistory = history.carfaxHistory && history.carfaxHistory.length > 0;
  
  if (!hasHeartHistory && !hasCarfaxHistory) {
    document.getElementById('historyResults').style.display = 'none';
    document.getElementById('historyEmpty').style.display = 'block';
    return;
  }
  
  // Show results
  document.getElementById('historyResults').style.display = 'block';
  document.getElementById('historyEmpty').style.display = 'none';
  
  // Render warranty summary
  renderWarrantySummary(history.heartHistory);
  
  // Render HEART history
  renderHeartHistory(history.heartHistory);
  
  // Render Carfax history
  renderCarfaxHistory(history.carfaxHistory);
}

function renderWarrantySummary(heartHistory) {
  const container = document.getElementById('warrantyDetails');
  
  if (!heartHistory || heartHistory.length === 0) {
    container.innerHTML = '<p class="warranty-empty">No HEART service history to analyze.</p>';
    return;
  }
  
  // Find items under warranty
  const underWarranty = heartHistory.filter(h => h.warrantyStatus === 'under_warranty');
  const recentlyServiced = heartHistory.filter(h => h.warrantyStatus === 'recently_serviced');
  
  let html = '';
  
  if (underWarranty.length > 0) {
    html += '<div class="warranty-group">';
    html += '<div class="warranty-group-header"><span class="warranty-status-badge under-warranty">Under Warranty</span></div>';
    underWarranty.slice(0, 3).forEach(item => {
      html += renderWarrantyItem(item);
    });
    if (underWarranty.length > 3) {
      html += `<div class="warranty-more">+ ${underWarranty.length - 3} more items under warranty</div>`;
    }
    html += '</div>';
  }
  
  if (recentlyServiced.length > 0) {
    html += '<div class="warranty-group">';
    html += '<div class="warranty-group-header"><span class="warranty-status-badge recently-serviced">Recently Serviced</span></div>';
    recentlyServiced.slice(0, 3).forEach(item => {
      html += renderWarrantyItem(item);
    });
    if (recentlyServiced.length > 3) {
      html += `<div class="warranty-more">+ ${recentlyServiced.length - 3} more recently serviced</div>`;
    }
    html += '</div>';
  }
  
  if (!underWarranty.length && !recentlyServiced.length) {
    html = '<p class="warranty-none">No items currently under warranty.</p>';
  }
  
  container.innerHTML = html;
}

function renderWarrantyItem(item) {
  const date = new Date(item.serviceDate).toLocaleDateString();
  let meta = `${date}`;
  if (item.mileage) meta += ` at ${item.mileage.toLocaleString()} mi`;
  if (item.shopName) meta += ` - ${item.shopName}`;
  
  let expiryInfo = '';
  if (item.warrantyExpiresDate) {
    const expiryDate = new Date(item.warrantyExpiresDate).toLocaleDateString();
    expiryInfo = `Expires: ${expiryDate}`;
    if (item.warrantyExpiresMileage) {
      expiryInfo += ` or ${item.warrantyExpiresMileage.toLocaleString()} mi`;
    }
    if (item.daysRemaining !== undefined) {
      expiryInfo += ` (${item.daysRemaining} days remaining)`;
    }
  }
  
  return `
    <div class="warranty-item">
      <div class="warranty-item-details">
        <div class="warranty-item-name">${escapeHtml(item.jobName)}</div>
        <div class="warranty-item-meta">${meta}</div>
        ${expiryInfo ? `<div class="warranty-item-meta warranty-expiry">${expiryInfo}</div>` : ''}
      </div>
    </div>
  `;
}

function renderHeartHistory(heartHistory) {
  const list = document.getElementById('heartHistoryList');
  const count = document.getElementById('heartHistoryCount');
  
  if (!heartHistory || heartHistory.length === 0) {
    list.innerHTML = '<div class="history-empty-inline">No HEART service records found.</div>';
    count.textContent = '0';
    return;
  }
  
  count.textContent = heartHistory.length;
  
  const html = heartHistory.map(item => {
    const date = new Date(item.serviceDate).toLocaleDateString();
    const statusClass = item.warrantyStatus.replace(/_/g, '-');
    const statusLabel = formatWarrantyStatus(item.warrantyStatus);
    
    return `
      <div class="history-item">
        <div class="history-item-icon heart">&#10084;</div>
        <div class="history-item-content">
          <div class="history-item-title">${escapeHtml(item.jobName)}</div>
          <div class="history-item-info">
            <span>${date}</span>
            ${item.mileage ? `<span>${item.mileage.toLocaleString()} mi</span>` : ''}
            ${item.shopName ? `<span class="history-item-shop">${item.shopName}</span>` : ''}
            ${item.totalCost ? `<span class="history-item-cost">$${(item.totalCost / 100).toFixed(2)}</span>` : ''}
          </div>
        </div>
        <div class="history-item-status">
          <span class="warranty-status-badge ${statusClass}">${statusLabel}</span>
        </div>
      </div>
    `;
  }).join('');
  
  list.innerHTML = html;
}

function renderCarfaxHistory(carfaxHistory) {
  const section = document.getElementById('carfaxSection');
  const list = document.getElementById('carfaxHistoryList');
  const count = document.getElementById('carfaxHistoryCount');
  
  if (!carfaxHistory || carfaxHistory.length === 0) {
    section.style.display = 'none';
    return;
  }
  
  section.style.display = 'block';
  count.textContent = carfaxHistory.length;
  
  const html = carfaxHistory.map(item => {
    const date = item.date ? new Date(item.date).toLocaleDateString() : 'Unknown date';
    
    return `
      <div class="history-item">
        <div class="history-item-icon carfax">&#128663;</div>
        <div class="history-item-content">
          <div class="history-item-title">${escapeHtml(item.description)}</div>
          <div class="history-item-info">
            <span>${date}</span>
            ${item.odometer ? `<span>${item.odometer.toLocaleString()} mi</span>` : ''}
          </div>
        </div>
        <div class="history-item-status">
          <span class="warranty-status-badge serviced-elsewhere">External</span>
        </div>
      </div>
    `;
  }).join('');
  
  list.innerHTML = html;
}

function formatWarrantyStatus(status) {
  const labels = {
    'under_warranty': 'Warranty',
    'recently_serviced': 'Recent',
    'due_for_service': 'Due',
    'serviced_elsewhere': 'External'
  };
  return labels[status] || status;
}
