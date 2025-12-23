chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'SYNC_SUCCESS') {
    console.log('[MOS AutoVitals] Background received sync success:', message.data);
    
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#22c55e' });
    
    setTimeout(() => {
      chrome.action.setBadgeText({ text: '' });
    }, 3000);
  }
  
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  console.log('[MOS AutoVitals] Extension installed');
  
  chrome.storage.local.set({
    connected: false,
    serverUrl: '',
    apiKey: '',
    shopName: '',
    syncCount: 0,
    vehicleCount: 0,
    lastSync: null
  });
  
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
});

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (!tab.url) return;
  
  const isAutoVitals = tab.url.includes('autovitals');
  
  await chrome.sidePanel.setOptions({
    tabId,
    path: 'sidepanel.html',
    enabled: isAutoVitals
  });
  
  if (isAutoVitals) {
    chrome.action.setBadgeText({ tabId, text: 'MOS' });
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#3b82f6' });
  } else {
    chrome.action.setBadgeText({ tabId, text: '' });
  }
});

chrome.action.onClicked.addListener((tab) => {
});
