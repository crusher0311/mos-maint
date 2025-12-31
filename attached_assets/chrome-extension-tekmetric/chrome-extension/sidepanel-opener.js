// This page opens the side panel for the original tab
// Shows a button for user to click (which provides the user gesture)

const params = new URLSearchParams(window.location.search);
const tabId = parseInt(params.get('tabId'), 10);
const windowId = parseInt(params.get('windowId'), 10);

console.log('Side panel opener: tabId =', tabId, 'windowId =', windowId);

async function openSidePanel() {
  try {
    const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const selfTabId = currentTab?.id;
    
    // Try opening for the window
    if (windowId) {
      await chrome.sidePanel.open({ windowId: windowId });
      console.log('Side panel opened for window:', windowId);
    } else if (tabId) {
      await chrome.sidePanel.open({ tabId: tabId });
      console.log('Side panel opened for tab:', tabId);
    }
    
    // Switch back to original tab and close this one
    if (tabId) {
      await chrome.tabs.update(tabId, { active: true });
    }
    if (selfTabId) {
      await chrome.tabs.remove(selfTabId);
    }
  } catch (error) {
    console.error('Failed to open side panel:', error);
    document.getElementById('error-msg').textContent = error.message;
    document.getElementById('error-section').style.display = 'block';
  }
}

// Auto-click the button after a short delay (doesn't work, but worth trying)
// The actual solution is to show the button for user to click
document.addEventListener('DOMContentLoaded', () => {
  const openBtn = document.getElementById('open-btn');
  const closeBtn = document.getElementById('close-btn');
  
  openBtn.addEventListener('click', openSidePanel);
  closeBtn.addEventListener('click', async () => {
    if (tabId) {
      await chrome.tabs.update(tabId, { active: true });
    }
    window.close();
  });
});
