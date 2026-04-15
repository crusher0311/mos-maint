const app = document.getElementById('app');
const notAdmin = document.getElementById('not-admin');
const toggleBtn = document.getElementById('toggle-btn');
const clearBtn = document.getElementById('clear-btn');
const exportBtn = document.getElementById('export-btn');
const uploadBtn = document.getElementById('upload-btn');
const uploadStatus = document.getElementById('upload-status');
const statusDot = document.getElementById('status-dot');
const capturesList = document.getElementById('captures-list');
const emptyState = document.getElementById('empty-state');
const captureCount = document.getElementById('capture-count');
const filterPlatform = document.getElementById('filter-platform');
const filterCategory = document.getElementById('filter-category');
const filterMethod = document.getElementById('filter-method');
const filterSearch = document.getElementById('filter-search');

let isActive = false;
let refreshInterval = null;

async function init() {
  const authStatus = await chrome.runtime.sendMessage({ action: 'GET_MOS_AUTH' });

  if (!authStatus.isAuthenticated || (authStatus.user?.role !== 'platform_admin' && authStatus.user?.isPlatformAdmin !== true)) {
    notAdmin.style.display = 'block';
    app.style.display = 'none';
    return;
  }

  app.style.display = 'block';
  notAdmin.style.display = 'none';

  const result = await chrome.runtime.sendMessage({ action: 'SNIFFER_STATUS' });
  isActive = result?.active || false;
  updateToggleUI();

  toggleBtn.addEventListener('click', toggleSniffer);
  clearBtn.addEventListener('click', clearCaptures);
  exportBtn.addEventListener('click', exportCaptures);
  uploadBtn.addEventListener('click', uploadCaptures);
  filterPlatform.addEventListener('change', refreshCaptures);
  filterCategory.addEventListener('change', refreshCaptures);
  filterMethod.addEventListener('change', refreshCaptures);

  let searchTimeout;
  filterSearch.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(refreshCaptures, 300);
  });

  refreshCaptures();
  refreshInterval = setInterval(refreshCaptures, 2000);
}

async function toggleSniffer() {
  isActive = !isActive;
  await chrome.runtime.sendMessage({
    action: 'SNIFFER_TOGGLE',
    active: isActive
  });
  updateToggleUI();
}

function updateToggleUI() {
  toggleBtn.textContent = isActive ? 'Stop Capture' : 'Start Capture';
  toggleBtn.className = isActive ? 'toolbar-btn danger' : 'toolbar-btn primary';
  statusDot.className = isActive ? 'status-dot active' : 'status-dot inactive';
}

async function refreshCaptures() {
  const filters = {};
  if (filterPlatform.value) filters.platform = filterPlatform.value;
  if (filterCategory.value) filters.category = filterCategory.value;
  if (filterMethod.value) filters.method = filterMethod.value;
  if (filterSearch.value) filters.search = filterSearch.value;

  const result = await chrome.runtime.sendMessage({
    action: 'SNIFFER_GET_CAPTURES',
    filters
  });

  const captures = result?.captures || [];
  captureCount.textContent = `${captures.length} capture${captures.length !== 1 ? 's' : ''}`;

  if (captures.length === 0) {
    emptyState.style.display = 'block';
    capturesList.innerHTML = '';
    return;
  }

  emptyState.style.display = 'none';

  const existingIds = new Set();
  capturesList.querySelectorAll('.capture-item').forEach(el => {
    existingIds.add(el.dataset.id);
  });

  const newIds = new Set(captures.map(c => c.id));

  capturesList.querySelectorAll('.capture-item').forEach(el => {
    if (!newIds.has(el.dataset.id)) el.remove();
  });

  const reversed = [...captures].reverse();
  let insertBefore = capturesList.firstChild;

  reversed.forEach(capture => {
    if (existingIds.has(capture.id)) return;
    const el = createCaptureElement(capture);
    if (insertBefore) {
      capturesList.insertBefore(el, insertBefore);
    } else {
      capturesList.appendChild(el);
    }
    insertBefore = el.nextSibling;
  });
}

function createCaptureElement(capture) {
  const item = document.createElement('div');
  item.className = 'capture-item';
  item.dataset.id = capture.id;

  const time = new Date(capture.timestamp);
  const timeStr = time.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const statusClass = capture.responseStatus
    ? (capture.responseStatus < 300 ? 's2xx' : capture.responseStatus < 400 ? 's3xx' : capture.responseStatus < 500 ? 's4xx' : 's5xx')
    : '';

  const categoriesHTML = capture.categories
    .map(c => `<span class="category-tag ${c}">${c}</span>`)
    .join(' ');

  const header = document.createElement('div');
  header.className = 'capture-header';
  header.innerHTML = `
    <span class="expand-arrow">&#9654;</span>
    <span class="method-badge ${capture.method}">${capture.method}</span>
    <span class="capture-path" title="${escapeHtml(capture.url)}">${escapeHtml(capture.path)}</span>
    ${categoriesHTML}
    <span class="platform-badge ${capture.platform}">${capture.platform}</span>
    ${capture.responseStatus ? `<span class="capture-status ${statusClass}">${capture.responseStatus}</span>` : ''}
    <span class="capture-time">${timeStr}</span>
  `;

  const body = document.createElement('div');
  body.className = 'capture-body';

  let bodyHTML = '';

  bodyHTML += `<div class="body-section"><div class="body-section-title">Full URL</div><div class="body-content">${escapeHtml(capture.url)}</div></div>`;

  if (capture.requestHeaders) {
    bodyHTML += `<div class="body-section"><div class="body-section-title">Request Headers</div><div class="body-content">${escapeHtml(formatJSON(capture.requestHeaders))}</div></div>`;
  }
  if (capture.requestBody) {
    bodyHTML += `<div class="body-section"><div class="body-section-title">Request Body</div><div class="body-content">${escapeHtml(formatJSON(capture.requestBody))}</div></div>`;
  }
  if (capture.responseBody) {
    bodyHTML += `<div class="body-section"><div class="body-section-title">Response Body</div><div class="body-content">${escapeHtml(formatJSON(capture.responseBody))}</div></div>`;
  }

  body.innerHTML = bodyHTML;

  header.addEventListener('click', () => {
    item.classList.toggle('expanded');
    body.classList.toggle('open');
  });

  item.appendChild(header);
  item.appendChild(body);
  return item;
}

function formatJSON(data) {
  if (!data) return '';
  if (typeof data === 'string') {
    try {
      return JSON.stringify(JSON.parse(data), null, 2);
    } catch {
      return data;
    }
  }
  return JSON.stringify(data, null, 2);
}

function escapeHtml(str) {
  if (!str) return '';
  const s = typeof str === 'string' ? str : JSON.stringify(str);
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function clearCaptures() {
  if (!confirm('Clear all captured requests?')) return;
  await chrome.runtime.sendMessage({ action: 'SNIFFER_CLEAR' });
  capturesList.innerHTML = '';
  emptyState.style.display = 'block';
  captureCount.textContent = '0 captures';
}

async function exportCaptures() {
  const filters = {};
  if (filterPlatform.value) filters.platform = filterPlatform.value;
  if (filterCategory.value) filters.category = filterCategory.value;
  if (filterMethod.value) filters.method = filterMethod.value;
  if (filterSearch.value) filters.search = filterSearch.value;

  const result = await chrome.runtime.sendMessage({
    action: 'SNIFFER_EXPORT',
    filters
  });

  if (!result?.data) return;

  const blob = new Blob([JSON.stringify(result.data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `mos-api-sniffer-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function uploadCaptures() {
  const result = await chrome.runtime.sendMessage({
    action: 'SNIFFER_GET_CAPTURES',
    filters: {}
  });
  const captures = result?.captures || [];
  if (captures.length === 0) {
    alert('No captures to upload.');
    return;
  }

  const label = prompt('Optional label for this upload session:', '') || '';

  uploadBtn.disabled = true;
  uploadBtn.textContent = '\u2B06 Uploading...';
  uploadStatus.style.display = 'inline';
  uploadStatus.textContent = `Uploading ${captures.length} captures...`;
  uploadStatus.style.color = '#d29922';

  try {
    const { mosApiUrl, mosApiToken } = await new Promise(resolve => {
      chrome.storage.local.get(['mosApiUrl', 'mosApiToken'], resolve);
    });

    if (!mosApiUrl || !mosApiToken) {
      throw new Error('Not authenticated with MOS. Please log in via the extension.');
    }

    const platforms = [...new Set(captures.map(c => c.platform).filter(Boolean))];
    const platformStr = platforms.length === 1 ? platforms[0] : platforms.join(',') || null;

    const res = await fetch(`${mosApiUrl}/api/extension/sniffer-upload`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${mosApiToken}`
      },
      body: JSON.stringify({
        captures,
        label: label || undefined,
        platform: platformStr
      })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');

    uploadStatus.textContent = `Uploaded ${data.captureCount} captures (session #${data.sessionId})`;
    uploadStatus.style.color = '#3fb950';
  } catch (err) {
    uploadStatus.textContent = `Upload failed: ${err.message}`;
    uploadStatus.style.color = '#f85149';
  } finally {
    uploadBtn.disabled = false;
    uploadBtn.textContent = '\u2B06 Upload';
    setTimeout(() => { uploadStatus.style.display = 'none'; }, 5000);
  }
}

init();
