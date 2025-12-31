function formatCurrency(value) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD'
  }).format(value);
}

function formatDate(timestamp) {
  if (!timestamp) return 'Unknown';
  const date = new Date(timestamp);
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

function displayJobInfo(jobData, elementId) {
  const element = document.getElementById(elementId);
  if (!element || !jobData) return;

  const vehicle = jobData.vehicle 
    ? `${jobData.vehicle.year} ${jobData.vehicle.make} ${jobData.vehicle.model}`
    : 'No vehicle info';

  element.innerHTML = `
    <div class="job-detail">
      <span class="job-detail-label">Job:</span>
      <span class="job-detail-value">${jobData.jobName}</span>
    </div>
    <div class="job-detail">
      <span class="job-detail-label">Vehicle:</span>
      <span class="job-detail-value">${vehicle}</span>
    </div>
    <div class="job-detail">
      <span class="job-detail-label">Labor Items:</span>
      <span class="job-detail-value">${jobData.laborItems?.length || 0}</span>
    </div>
    <div class="job-detail">
      <span class="job-detail-label">Parts:</span>
      <span class="job-detail-value">${jobData.parts?.length || 0}</span>
    </div>
    <div class="job-detail">
      <span class="job-detail-label">Total:</span>
      <span class="job-detail-value">${formatCurrency(jobData.totals?.total || 0)}</span>
    </div>
  `;
}

function updatePopup() {
  // Display version number
  const manifest = chrome.runtime.getManifest();
  const versionEl = document.getElementById('version');
  if (versionEl) {
    versionEl.textContent = `v${manifest.version}`;
  }

  chrome.runtime.sendMessage({ action: "GET_PENDING_JOB" }, (pendingResponse) => {
    if (pendingResponse && pendingResponse.jobData) {
      document.getElementById('no-job').style.display = 'none';
      document.getElementById('job-ready').style.display = 'block';
      displayJobInfo(pendingResponse.jobData, 'job-info');
    } else {
      document.getElementById('no-job').style.display = 'block';
      document.getElementById('job-ready').style.display = 'none';
    }
  });

  chrome.runtime.sendMessage({ action: "GET_LAST_JOB" }, (lastResponse) => {
    if (lastResponse && lastResponse.jobData) {
      document.getElementById('last-job-section').style.display = 'block';
      const lastJobInfo = document.getElementById('last-job-info');
      
      const vehicle = lastResponse.jobData.vehicle
        ? `${lastResponse.jobData.vehicle.year} ${lastResponse.jobData.vehicle.make} ${lastResponse.jobData.vehicle.model}`
        : 'No vehicle info';
      
      lastJobInfo.innerHTML = `
        <div style="margin-bottom: 8px;">
          <strong>${lastResponse.jobData.jobName}</strong>
        </div>
        <div style="color: #6b7280; margin-bottom: 4px;">${vehicle}</div>
        <div style="color: #9ca3af; font-size: 11px;">
          ${formatDate(lastResponse.timestamp)}
        </div>
      `;
    }
  });
}

function loadAppUrl() {
  chrome.storage.local.get(['appUrl'], (result) => {
    const appUrlInput = document.getElementById('app-url');
    const urlStatus = document.getElementById('url-status');
    
    if (result.appUrl) {
      appUrlInput.value = result.appUrl;
      urlStatus.textContent = 'Current URL configured';
      urlStatus.style.color = '#10b981';
    } else {
      urlStatus.textContent = 'No URL configured - please set your app URL';
      urlStatus.style.color = '#ef4444';
    }
  });
}

function saveAppUrl() {
  const appUrlInput = document.getElementById('app-url');
  const urlStatus = document.getElementById('url-status');
  const url = appUrlInput.value.trim();
  
  if (!url) {
    urlStatus.textContent = 'Please enter a valid URL';
    urlStatus.style.color = '#ef4444';
    return;
  }
  
  try {
    new URL(url);
    
    chrome.storage.local.set({ appUrl: url }, () => {
      urlStatus.textContent = '✓ URL saved successfully';
      urlStatus.style.color = '#10b981';
      setTimeout(() => {
        urlStatus.textContent = 'Current URL configured';
      }, 2000);
    });
  } catch (e) {
    urlStatus.textContent = 'Invalid URL format';
    urlStatus.style.color = '#ef4444';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  updatePopup();
  loadAppUrl();
  
  document.getElementById('save-url').addEventListener('click', saveAppUrl);
});

setInterval(updatePopup, 2000);
