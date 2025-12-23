document.addEventListener('DOMContentLoaded', async () => {
  const loadingEl = document.getElementById('loading');
  const loginSection = document.getElementById('login-section');
  const connectedSection = document.getElementById('connected-section');
  const serverUrlInput = document.getElementById('serverUrl');
  const apiKeyInput = document.getElementById('apiKey');
  const connectBtn = document.getElementById('connectBtn');
  const disconnectBtn = document.getElementById('disconnectBtn');
  const syncNowBtn = document.getElementById('syncNowBtn');
  const syncNowText = document.getElementById('syncNowText');
  const syncNowSpinner = document.getElementById('syncNowSpinner');
  const loginMessage = document.getElementById('loginMessage');
  const syncMessage = document.getElementById('syncMessage');
  const connectedShop = document.getElementById('connectedShop');
  const vehicleCount = document.getElementById('vehicleCount');
  const syncCount = document.getElementById('syncCount');
  const lastSync = document.getElementById('lastSync');
  const pageInfo = document.getElementById('pageInfo');
  const pageInfoTitle = document.getElementById('pageInfoTitle');
  const pageInfoText = document.getElementById('pageInfoText');

  async function loadState() {
    const state = await chrome.storage.local.get(['connected', 'serverUrl', 'apiKey', 'shopName', 'syncCount', 'vehicleCount', 'lastSync']);
    
    loadingEl.classList.add('hidden');
    
    if (state.connected && state.serverUrl && state.apiKey) {
      loginSection.classList.add('hidden');
      connectedSection.classList.remove('hidden');
      connectedShop.textContent = `Shop: ${state.shopName || 'Connected'}`;
      vehicleCount.textContent = state.vehicleCount || '0';
      syncCount.textContent = state.syncCount || '0';
      lastSync.textContent = state.lastSync || '--';
      
      checkCurrentPage();
    } else {
      loginSection.classList.remove('hidden');
      connectedSection.classList.add('hidden');
      if (state.serverUrl) {
        serverUrlInput.value = state.serverUrl;
      }
    }
  }

  async function checkCurrentPage() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      
      if (!tab?.url?.includes('autovitals')) {
        pageInfo.classList.remove('hidden');
        pageInfo.classList.add('no-data');
        pageInfoTitle.textContent = 'Not on AutoVitals';
        pageInfoText.textContent = 'Navigate to AutoVitals to sync vehicle data';
        syncNowBtn.disabled = true;
        return;
      }
      
      chrome.tabs.sendMessage(tab.id, { type: 'GET_PAGE_INFO' }, (response) => {
        if (chrome.runtime.lastError) {
          pageInfo.classList.remove('hidden');
          pageInfo.classList.add('no-data');
          pageInfoTitle.textContent = 'Page Loading';
          pageInfoText.textContent = 'Refresh the page if this persists';
          syncNowBtn.disabled = true;
          return;
        }
        
        if (response) {
          pageInfo.classList.remove('hidden');
          
          if (response.pageType === 'dashboard' && response.vehicleCount > 0) {
            pageInfo.classList.remove('no-data');
            pageInfoTitle.textContent = `${response.vehicleCount} Vehicles Found`;
            pageInfoText.textContent = 'Click "Sync This Page" to import to MOS';
            syncNowBtn.disabled = false;
          } else if (response.pageType === 'inspection') {
            pageInfo.classList.remove('no-data');
            pageInfoTitle.textContent = 'Inspection Page Detected';
            pageInfoText.textContent = 'DVI data will be synced automatically';
            syncNowBtn.disabled = false;
          } else if (response.pageType === 'dashboard') {
            pageInfo.classList.add('no-data');
            pageInfoTitle.textContent = 'No Vehicles Found';
            pageInfoText.textContent = 'Try navigating to a customer or vehicle list';
            syncNowBtn.disabled = true;
          } else {
            pageInfo.classList.add('no-data');
            pageInfoTitle.textContent = 'Unknown Page Type';
            pageInfoText.textContent = 'Navigate to a vehicle list or inspection';
            syncNowBtn.disabled = true;
          }
        }
      });
    } catch (err) {
      console.error('Error checking page:', err);
    }
  }

  function showMessage(element, type, text) {
    element.textContent = text;
    element.className = `message ${type}`;
    element.classList.remove('hidden');
    setTimeout(() => {
      element.classList.add('hidden');
    }, 5000);
  }

  connectBtn.addEventListener('click', async () => {
    const serverUrl = serverUrlInput.value.trim();
    const apiKey = apiKeyInput.value.trim();
    
    if (!serverUrl || !apiKey) {
      showMessage(loginMessage, 'error', 'Please enter both server URL and API key');
      return;
    }
    
    connectBtn.disabled = true;
    connectBtn.textContent = 'Connecting...';
    
    try {
      const response = await fetch(`${serverUrl}/api/autovitals/extension/connect`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiKey
        },
        body: JSON.stringify({ action: 'connect' })
      });
      
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Connection failed');
      }
      
      const data = await response.json();
      
      await chrome.storage.local.set({
        connected: true,
        serverUrl,
        apiKey,
        shopName: data.shopName || 'Connected',
        syncCount: 0,
        vehicleCount: 0,
        lastSync: null
      });
      
      await loadState();
      showMessage(loginMessage, 'success', 'Connected successfully!');
    } catch (error) {
      showMessage(loginMessage, 'error', error.message || 'Connection failed');
    } finally {
      connectBtn.disabled = false;
      connectBtn.textContent = 'Connect';
    }
  });

  syncNowBtn.addEventListener('click', async () => {
    syncNowBtn.disabled = true;
    syncNowText.textContent = 'Syncing...';
    syncNowSpinner.classList.remove('hidden');
    
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      
      if (tab?.id) {
        chrome.tabs.sendMessage(tab.id, { type: 'MANUAL_SYNC' }, async (response) => {
          if (chrome.runtime.lastError) {
            showMessage(syncMessage, 'error', 'Could not sync - refresh the page and try again');
          } else {
            showMessage(syncMessage, 'success', 'Sync triggered! Check the stats above.');
            
            setTimeout(async () => {
              const state = await chrome.storage.local.get(['syncCount', 'vehicleCount', 'lastSync']);
              vehicleCount.textContent = state.vehicleCount || '0';
              syncCount.textContent = state.syncCount || '0';
              lastSync.textContent = state.lastSync || '--';
            }, 2000);
          }
          
          syncNowBtn.disabled = false;
          syncNowText.textContent = 'Sync This Page';
          syncNowSpinner.classList.add('hidden');
        });
      }
    } catch (err) {
      showMessage(syncMessage, 'error', 'Sync failed: ' + err.message);
      syncNowBtn.disabled = false;
      syncNowText.textContent = 'Sync This Page';
      syncNowSpinner.classList.add('hidden');
    }
  });

  disconnectBtn.addEventListener('click', async () => {
    if (confirm('Are you sure you want to disconnect?')) {
      await chrome.storage.local.remove(['connected', 'apiKey', 'shopName', 'syncCount', 'vehicleCount']);
      await loadState();
    }
  });

  await loadState();
});
