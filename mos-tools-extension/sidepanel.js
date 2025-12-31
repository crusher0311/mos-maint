// MOS Tools Side Panel Application

// ==================== STATE ====================
let isAuthenticated = false;
let currentContext = null;
let currentTab = 'plan';
let cannedJobSource = 'sms';

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
  cannedTabBtns: document.querySelectorAll('.canned-tab-btn'),
  cannedLoading: document.getElementById('canned-loading'),
  cannedEmpty: document.getElementById('canned-empty'),
  cannedList: document.getElementById('canned-list')
};

// ==================== INITIALIZATION ====================
async function init() {
  // Check auth status
  const authStatus = await sendMessage({ action: 'GET_MOS_AUTH' });
  
  if (authStatus.isAuthenticated) {
    isAuthenticated = true;
    showMainState();
    
    // Get initial context
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
  
  // Tab navigation
  elements.tabBtns.forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
  
  // Canned job source tabs
  elements.cannedTabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      cannedJobSource = btn.dataset.source;
      elements.cannedTabBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      loadCannedJobs();
    });
  });
  
  // Job search
  elements.jobSearchBtn.addEventListener('click', handleJobSearch);
  elements.jobSearch.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleJobSearch();
  });
  
  // Listen for context changes from background
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'SMS_CONTEXT_CHANGED') {
      updateContext(message.context);
    }
  });
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
}

function switchTab(tab) {
  currentTab = tab;
  
  elements.tabBtns.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  
  elements.tabPanels.forEach(panel => {
    panel.classList.toggle('hidden', panel.id !== `tab-${tab}`);
    panel.classList.toggle('active', panel.id === `tab-${tab}`);
  });
  
  // Load tab data
  if (tab === 'plan' && currentContext) {
    loadPlan();
  } else if (tab === 'canned' && currentContext) {
    loadCannedJobs();
  }
}

function updateContext(context) {
  currentContext = context;
  
  if (context && context.roId) {
    elements.noContext.classList.add('hidden');
    elements.hasContext.classList.remove('hidden');
    
    // Display vehicle info
    if (context.vehicle) {
      elements.vehicleDisplay.textContent = 
        `${context.vehicle.year} ${context.vehicle.make} ${context.vehicle.model}`;
    } else {
      elements.vehicleDisplay.textContent = 'Vehicle';
    }
    
    elements.roDisplay.textContent = `RO #${context.roId}`;
    
    if (context.mileage) {
      elements.mileageDisplay.textContent = `${context.mileage.toLocaleString()} mi`;
      elements.mileageDisplay.classList.remove('hidden');
    } else {
      elements.mileageDisplay.classList.add('hidden');
    }
    
    // Load plan data
    if (currentTab === 'plan') {
      loadPlan();
    } else if (currentTab === 'canned') {
      loadCannedJobs();
    }
  } else {
    elements.noContext.classList.remove('hidden');
    elements.hasContext.classList.add('hidden');
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
      showMainState();
      
      // Get context after login
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
    
    const result = await sendMessage({
      action: 'MOS_API_REQUEST',
      endpoint: `/api/extension/plan?${params}`
    });
    
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
  
  // Add click handlers for add buttons
  document.querySelectorAll('.btn-add[data-service]').forEach(btn => {
    btn.addEventListener('click', () => handleAddService(JSON.parse(btn.dataset.service)));
  });
}

function createServiceItemHTML(item, type) {
  const detail = item.dueAt ? `Due at ${item.dueAt.toLocaleString()} mi` : 
                 item.interval ? `Every ${item.interval.toLocaleString()} mi` : '';
  
  return `
    <li class="service-item">
      <div class="service-info">
        <div class="service-name">${escapeHtml(item.name)}</div>
        ${detail ? `<div class="service-detail">${detail}</div>` : ''}
      </div>
      <button class="btn-add" data-service='${JSON.stringify(item)}'>
        + Add
      </button>
    </li>
  `;
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
    params.set('provider', currentContext?.provider || 'tekmetric');
    if (currentContext?.vehicle) {
      if (currentContext.vehicle.year) params.set('year', currentContext.vehicle.year);
      if (currentContext.vehicle.make) params.set('make', currentContext.vehicle.make);
      if (currentContext.vehicle.model) params.set('model', currentContext.vehicle.model);
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
  
  elements.lookupResults.classList.remove('hidden');
  elements.lookupResults.innerHTML = jobs.map(job => createJobItemHTML(job)).join('');
  
  // Add toggle and action handlers
  setupJobItemHandlers();
}

function createJobItemHTML(job) {
  const vehicle = job.vehicle ? 
    `${job.vehicle.year || ''} ${job.vehicle.make || ''} ${job.vehicle.model || ''}`.trim() : '';
  
  const totalAmount = job.totals?.totalAmount || 0;
  
  return `
    <li class="job-item" data-job-id="${job._id}">
      <div class="job-header">
        <div>
          <div class="job-title">${escapeHtml(job.title || job.name)}</div>
          <div class="job-meta">${vehicle} ${job.workOrderNumber ? `• RO #${job.workOrderNumber}` : ''}</div>
        </div>
        <div class="job-price">$${totalAmount.toFixed(2)}</div>
      </div>
      <div class="job-details hidden">
        ${job.laborItems?.length ? `
          <div class="job-section">
            <div class="job-section-title">Labor</div>
            ${job.laborItems.map(item => `
              <div class="line-item">
                <span>${escapeHtml(item.name || item.description)}</span>
                <span>${item.hours}h</span>
              </div>
            `).join('')}
          </div>
        ` : ''}
        ${job.parts?.length ? `
          <div class="job-section">
            <div class="job-section-title">Parts</div>
            ${job.parts.map(part => `
              <div class="line-item">
                <span>${escapeHtml(part.name || part.description)} ${part.partNumber ? `(${part.partNumber})` : ''}</span>
                <span>x${part.quantity}</span>
              </div>
            `).join('')}
          </div>
        ` : ''}
        <div class="job-actions">
          <button class="btn-add btn-add-job" data-job='${JSON.stringify(job)}'>
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
      const job = JSON.parse(btn.dataset.job);
      handleAddJob(job);
    });
  });
}

// ==================== CANNED JOBS ====================
async function loadCannedJobs() {
  if (!currentContext || !currentContext.roId) {
    elements.cannedLoading.classList.add('hidden');
    elements.cannedEmpty.classList.remove('hidden');
    elements.cannedList.classList.add('hidden');
    return;
  }
  
  elements.cannedLoading.classList.remove('hidden');
  elements.cannedEmpty.classList.add('hidden');
  elements.cannedList.classList.add('hidden');
  
  try {
    let jobs = [];
    
    if (cannedJobSource === 'sms') {
      // Fetch from Tekmetric via captured session
      const tekState = await sendMessage({ action: 'GET_TEKMETRIC_STATE' });
      
      if (!tekState.hasToken) {
        throw new Error('No Tekmetric session. Please navigate to a repair order.');
      }
      
      const result = await sendMessage({
        action: 'TEKMETRIC_API_REQUEST',
        endpoint: `/api/shop/${tekState.shopId}/canned-job?size=100`
      });
      
      jobs = (result.content || result || []).map(job => ({
        id: job.id,
        name: job.name,
        description: job.description,
        amount: job.totalAmount || 0,
        source: 'tekmetric'
      }));
    } else {
      // Fetch from MOS enriched library
      const result = await sendMessage({
        action: 'MOS_API_REQUEST',
        endpoint: `/api/extension/canned-jobs?shopId=${currentContext.shopId}&provider=${currentContext.provider || 'tekmetric'}`
      });
      
      jobs = result.jobs || [];
    }
    
    renderCannedJobs(jobs);
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
  
  elements.cannedList.classList.remove('hidden');
  elements.cannedList.innerHTML = jobs.map(job => `
    <li class="job-item">
      <div class="job-header" style="cursor: default;">
        <div>
          <div class="job-title">${escapeHtml(job.name)}</div>
          ${job.description ? `<div class="job-meta">${escapeHtml(job.description)}</div>` : ''}
        </div>
        <button class="btn-add" data-canned='${JSON.stringify(job)}'>+ Add</button>
      </div>
    </li>
  `).join('');
  
  // Add click handlers
  document.querySelectorAll('.btn-add[data-canned]').forEach(btn => {
    btn.addEventListener('click', () => {
      const job = JSON.parse(btn.dataset.canned);
      handleAddCannedJob(job);
    });
  });
}

// ==================== JOB ACTIONS ====================
async function handleAddService(service) {
  // Convert service recommendation to a job and add
  const jobData = {
    name: service.name,
    laborItems: [{
      name: service.name,
      hours: service.laborHours || 1
    }],
    parts: service.parts || []
  };
  
  await handleAddJob(jobData);
}

async function handleAddJob(job) {
  if (!currentContext) {
    alert('No repair order context. Please navigate to a repair order.');
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
  if (!currentContext) {
    alert('No repair order context. Please navigate to a repair order.');
    return;
  }
  
  if (job.source === 'tekmetric') {
    // Use Tekmetric's canned job API
    try {
      const result = await sendMessage({
        action: 'TEKMETRIC_API_REQUEST',
        endpoint: `/api/repair-order/${currentContext.roId}/canned-job`,
        options: {
          method: 'POST',
          body: JSON.stringify({ cannedJobIds: [job.id] })
        }
      });
      
      showNotification(`Added: ${job.name}`, 'success');
      
      // Trigger page refresh
      chrome.tabs.query({ url: "*://*.tekmetric.com/*" }, (tabs) => {
        for (const tab of tabs) {
          chrome.tabs.sendMessage(tab.id, { action: 'JOB_CREATED', jobName: job.name }).catch(() => {});
        }
      });
    } catch (err) {
      console.error('[MOS] Error adding canned job:', err);
      showNotification(err.message, 'error');
    }
  } else {
    // MOS enriched job - convert to custom job
    await handleAddJob(job);
  }
}

// ==================== UTILITIES ====================
function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      resolve(response || {});
    });
  });
}

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

// ==================== START ====================
init();
