let currentVIN = null;
let vehicleData = null;
let isConnected = false;

async function init() {
  const state = await chrome.storage.local.get(['connected', 'serverUrl', 'apiKey']);
  isConnected = state.connected && state.serverUrl && state.apiKey;
  
  if (!isConnected) {
    document.getElementById('not-connected').style.display = 'block';
    document.getElementById('main-content').style.display = 'none';
    return;
  }
  
  document.getElementById('not-connected').style.display = 'none';
  document.getElementById('main-content').style.display = 'block';
  
  setupTabs();
  setupRefreshButton();
  await detectVehicle();
  
  setInterval(detectVehicle, 5000);
}

function setupTabs() {
  const tabs = document.querySelectorAll('.tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      document.getElementById(`panel-${tab.dataset.tab}`).classList.add('active');
    });
  });
}

function setupRefreshButton() {
  document.getElementById('refresh-btn').addEventListener('click', () => {
    if (currentVIN) {
      fetchVehicleData(currentVIN, true);
    } else {
      detectVehicle();
    }
  });
}

async function detectVehicle() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (!tab?.url?.includes('autovitals')) {
      showNoVehicle();
      return;
    }
    
    chrome.tabs.sendMessage(tab.id, { type: 'GET_CURRENT_VIN' }, async (response) => {
      if (chrome.runtime.lastError || !response?.vin) {
        showNoVehicle();
        return;
      }
      
      if (response.vin !== currentVIN) {
        currentVIN = response.vin;
        document.getElementById('current-vin').textContent = currentVIN;
        await fetchVehicleData(currentVIN);
      }
    });
  } catch (err) {
    console.error('Error detecting vehicle:', err);
    showNoVehicle();
  }
}

function showNoVehicle() {
  currentVIN = null;
  document.getElementById('current-vin').textContent = 'No vehicle detected';
  document.getElementById('vehicle-info').style.display = 'none';
  document.getElementById('loading').style.display = 'none';
  document.getElementById('no-vehicle').style.display = 'block';
  document.querySelectorAll('.panel').forEach(p => p.innerHTML = '');
}

async function fetchVehicleData(vin, forceRefresh = false) {
  const state = await chrome.storage.local.get(['serverUrl', 'apiKey']);
  
  document.getElementById('loading').style.display = 'block';
  document.getElementById('no-vehicle').style.display = 'none';
  document.getElementById('error').style.display = 'none';
  
  try {
    const response = await fetch(`${state.serverUrl}/api/autovitals/extension/vehicle-data?vin=${vin}${forceRefresh ? '&refresh=true' : ''}`, {
      headers: {
        'X-API-Key': state.apiKey
      }
    });
    
    if (!response.ok) {
      throw new Error('Failed to fetch vehicle data');
    }
    
    vehicleData = await response.json();
    
    document.getElementById('loading').style.display = 'none';
    
    if (vehicleData.vehicle) {
      const v = vehicleData.vehicle;
      document.getElementById('vehicle-info').style.display = 'block';
      document.getElementById('vehicle-ymm').textContent = 
        `${v.year || ''} ${v.make || ''} ${v.model || ''}`.trim() || 'Unknown Vehicle';
    }
    
    renderPlanPanel();
    renderOEMPanel();
    renderCarfaxPanel();
    renderDVIPanel();
    
  } catch (err) {
    console.error('Error fetching vehicle data:', err);
    document.getElementById('loading').style.display = 'none';
    document.getElementById('error').style.display = 'block';
    document.getElementById('error').textContent = `Error: ${err.message}`;
  }
}

function renderPlanPanel() {
  const panel = document.getElementById('panel-plan');
  const recs = vehicleData?.recommendations || [];
  
  if (recs.length === 0) {
    panel.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">✓</div>
        <div class="empty-state-title">No Recommendations</div>
        <div class="empty-state-text">This vehicle has no pending maintenance items</div>
      </div>
    `;
    return;
  }
  
  const immediate = recs.filter(r => r.priority === 'immediate');
  const dueSoon = recs.filter(r => r.priority === 'due-soon');
  const upcoming = recs.filter(r => r.priority === 'upcoming' || !r.priority);
  
  let html = '';
  
  if (immediate.length > 0) {
    html += `<div class="card"><div class="card-title">⚠️ Immediate Attention (${immediate.length})</div>`;
    immediate.forEach(rec => {
      html += renderRecommendation(rec, 'immediate');
    });
    html += '</div>';
  }
  
  if (dueSoon.length > 0) {
    html += `<div class="card"><div class="card-title">⏰ Due Soon (${dueSoon.length})</div>`;
    dueSoon.forEach(rec => {
      html += renderRecommendation(rec, 'due-soon');
    });
    html += '</div>';
  }
  
  if (upcoming.length > 0) {
    html += `<div class="card"><div class="card-title">📅 Upcoming (${upcoming.length})</div>`;
    upcoming.forEach(rec => {
      html += renderRecommendation(rec, 'upcoming');
    });
    html += '</div>';
  }
  
  panel.innerHTML = html;
}

function renderRecommendation(rec, priority) {
  const sourceClass = (rec.source || 'oem').toLowerCase();
  return `
    <div class="recommendation ${priority}">
      <div class="recommendation-title">
        ${rec.name || rec.description}
        <span class="badge ${sourceClass}">${(rec.source || 'OEM').toUpperCase()}</span>
      </div>
      <div class="recommendation-detail">
        ${rec.dueDate ? `Due: ${rec.dueDate}` : ''}
        ${rec.dueMileage ? ` | ${rec.dueMileage.toLocaleString()} mi` : ''}
        ${rec.notes ? ` - ${rec.notes}` : ''}
      </div>
    </div>
  `;
}

function renderOEMPanel() {
  const panel = document.getElementById('panel-oem');
  const schedule = vehicleData?.oemSchedule || [];
  
  if (schedule.length === 0) {
    panel.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">📋</div>
        <div class="empty-state-title">No OEM Schedule</div>
        <div class="empty-state-text">OEM maintenance schedule not available for this vehicle</div>
      </div>
    `;
    return;
  }
  
  let html = '<div class="card"><div class="card-title">📋 OEM Maintenance Schedule</div>';
  
  schedule.forEach(item => {
    const status = item.overdue ? 'immediate' : (item.dueSoon ? 'due-soon' : 'upcoming');
    html += `
      <div class="recommendation ${status}">
        <div class="recommendation-title">${item.name}</div>
        <div class="recommendation-detail">
          Every ${item.intervalMiles?.toLocaleString() || '?'} miles / ${item.intervalMonths || '?'} months
          ${item.lastPerformed ? ` | Last: ${item.lastPerformed}` : ''}
        </div>
      </div>
    `;
  });
  
  html += '</div>';
  panel.innerHTML = html;
}

function renderCarfaxPanel() {
  const panel = document.getElementById('panel-carfax');
  const history = vehicleData?.carfaxHistory || [];
  
  if (history.length === 0) {
    panel.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">📜</div>
        <div class="empty-state-title">No CARFAX History</div>
        <div class="empty-state-text">No service history found for this vehicle</div>
      </div>
    `;
    return;
  }
  
  let html = '<div class="card"><div class="card-title">📜 CARFAX Service History</div>';
  
  history.slice(0, 10).forEach(record => {
    html += `
      <div class="history-item">
        <div class="history-date">${record.date || 'Unknown date'}</div>
        <div class="history-mileage">${record.mileage?.toLocaleString() || '?'} miles</div>
        <div class="history-services">${record.services?.join(', ') || record.description || 'Service performed'}</div>
      </div>
    `;
  });
  
  if (history.length > 10) {
    html += `<div class="history-item" style="color: #64748b; text-align: center;">+ ${history.length - 10} more records</div>`;
  }
  
  html += '</div>';
  panel.innerHTML = html;
}

function renderDVIPanel() {
  const panel = document.getElementById('panel-dvi');
  const dvi = vehicleData?.dviResults || [];
  
  if (dvi.length === 0) {
    panel.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">🔍</div>
        <div class="empty-state-title">No DVI Results</div>
        <div class="empty-state-text">No digital inspection results found</div>
      </div>
    `;
    return;
  }
  
  const immediate = dvi.filter(r => r.status === 'immediate');
  const caution = dvi.filter(r => r.status === 'caution');
  const good = dvi.filter(r => r.status === 'good');
  
  let html = '';
  
  if (immediate.length > 0) {
    html += `<div class="card"><div class="card-title">🔴 Needs Attention (${immediate.length})</div>`;
    immediate.forEach(item => {
      html += `
        <div class="recommendation immediate">
          <div class="recommendation-title">${item.description}</div>
          ${item.notes ? `<div class="recommendation-detail">${item.notes}</div>` : ''}
        </div>
      `;
    });
    html += '</div>';
  }
  
  if (caution.length > 0) {
    html += `<div class="card"><div class="card-title">🟡 Caution (${caution.length})</div>`;
    caution.forEach(item => {
      html += `
        <div class="recommendation due-soon">
          <div class="recommendation-title">${item.description}</div>
          ${item.notes ? `<div class="recommendation-detail">${item.notes}</div>` : ''}
        </div>
      `;
    });
    html += '</div>';
  }
  
  if (good.length > 0) {
    html += `<div class="card"><div class="card-title">🟢 Good Condition (${good.length})</div>`;
    good.forEach(item => {
      html += `
        <div class="recommendation upcoming">
          <div class="recommendation-title">${item.description}</div>
        </div>
      `;
    });
    html += '</div>';
  }
  
  panel.innerHTML = html;
}

chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'local' && (changes.connected || changes.serverUrl || changes.apiKey)) {
    init();
  }
});

init();
