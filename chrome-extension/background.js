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
    lastSync: null
  });
});

chrome.action.onClicked.addListener((tab) => {
});
