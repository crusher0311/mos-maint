// This popup relay opens the side panel from an extension page context
// User gesture is preserved because this is an extension page, not a content script

(async () => {
  try {
    // Get tabId from URL params (passed by background.js)
    const params = new URLSearchParams(window.location.search);
    const tabId = parseInt(params.get('tabId'), 10);
    
    console.log('Popup relay: Opening side panel for tab', tabId);
    
    if (tabId) {
      // Open the side panel - this works because we're in an extension page
      await chrome.sidePanel.open({ tabId });
      console.log('Popup relay: Side panel opened successfully');
    } else {
      // Fallback: get current active tab
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      await chrome.sidePanel.open({ tabId: tab.id });
      console.log('Popup relay: Side panel opened for active tab');
    }
    
    // Close this popup immediately
    window.close();
  } catch (error) {
    console.error('Popup relay: Failed to open side panel:', error);
    document.body.innerHTML = '<div style="color: #ff6b6b; padding: 10px;">Failed. Use extension icon.</div>';
    setTimeout(() => window.close(), 1500);
  }
})();
