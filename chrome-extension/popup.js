document.addEventListener('DOMContentLoaded', async () => {
  const loadingEl = document.getElementById('loading');
  const loginSection = document.getElementById('login-section');
  const connectedSection = document.getElementById('connected-section');
  const serverUrlInput = document.getElementById('serverUrl');
  const apiKeyInput = document.getElementById('apiKey');
  const connectBtn = document.getElementById('connectBtn');
  const disconnectBtn = document.getElementById('disconnectBtn');
  const loginMessage = document.getElementById('loginMessage');
  const connectedShop = document.getElementById('connectedShop');
  const syncCount = document.getElementById('syncCount');
  const lastSync = document.getElementById('lastSync');

  async function loadState() {
    const state = await chrome.storage.local.get(['connected', 'serverUrl', 'apiKey', 'shopName', 'syncCount', 'lastSync']);
    
    loadingEl.classList.add('hidden');
    
    if (state.connected && state.serverUrl && state.apiKey) {
      loginSection.classList.add('hidden');
      connectedSection.classList.remove('hidden');
      connectedShop.textContent = `Shop: ${state.shopName || 'Connected'}`;
      syncCount.textContent = state.syncCount || '0';
      lastSync.textContent = state.lastSync || '--';
    } else {
      loginSection.classList.remove('hidden');
      connectedSection.classList.add('hidden');
      if (state.serverUrl) {
        serverUrlInput.value = state.serverUrl;
      }
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

  disconnectBtn.addEventListener('click', async () => {
    if (confirm('Are you sure you want to disconnect?')) {
      await chrome.storage.local.remove(['connected', 'apiKey', 'shopName']);
      await loadState();
    }
  });

  await loadState();
});
