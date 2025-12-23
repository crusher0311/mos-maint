(() => {
  let lastProcessedUrl = '';
  let isProcessing = false;

  console.log('[MOS AutoVitals] Content script loaded');

  function extractVehicleInfo() {
    const info = {};
    
    const vinPatterns = [
      /\b[A-HJ-NPR-Z0-9]{17}\b/i,
    ];
    
    const pageText = document.body.innerText;
    for (const pattern of vinPatterns) {
      const match = pageText.match(pattern);
      if (match) {
        info.vin = match[0].toUpperCase();
        break;
      }
    }
    
    const selectors = {
      customerName: [
        '[data-field="customer-name"]',
        '.customer-name',
        '.client-name',
        '#customerName',
      ],
      vehicleYear: [
        '[data-field="vehicle-year"]',
        '.vehicle-year',
        '#vehicleYear',
      ],
      vehicleMake: [
        '[data-field="vehicle-make"]',
        '.vehicle-make',
        '#vehicleMake',
      ],
      vehicleModel: [
        '[data-field="vehicle-model"]',
        '.vehicle-model',
        '#vehicleModel',
      ],
      mileage: [
        '[data-field="mileage"]',
        '.mileage',
        '#mileage',
        '.odometer',
      ],
      licensePlate: [
        '[data-field="license-plate"]',
        '.license-plate',
        '#licensePlate',
      ],
    };
    
    for (const [field, selectorList] of Object.entries(selectors)) {
      for (const selector of selectorList) {
        const element = document.querySelector(selector);
        if (element) {
          info[field] = element.textContent?.trim() || element.value?.trim();
          break;
        }
      }
    }
    
    return info;
  }

  function extractInspectionResults() {
    const results = [];
    
    const inspectionSelectors = [
      '.inspection-item',
      '.inspection-line',
      '.dvi-item',
      '[data-inspection-item]',
      '.check-item',
      'tr.inspection-row',
    ];
    
    for (const selector of inspectionSelectors) {
      const items = document.querySelectorAll(selector);
      if (items.length > 0) {
        items.forEach((item, index) => {
          const result = {
            id: item.dataset?.id || `item-${index}`,
            description: '',
            status: 'unknown',
            notes: '',
            pictures: [],
          };
          
          const descEl = item.querySelector('.description, .item-name, .check-description, td:first-child');
          if (descEl) {
            result.description = descEl.textContent?.trim() || '';
          }
          
          const statusClasses = {
            'green': 'good',
            'yellow': 'caution',
            'amber': 'caution',
            'red': 'immediate',
            'pass': 'good',
            'fail': 'immediate',
            'warn': 'caution',
          };
          
          const classNames = item.className.toLowerCase();
          for (const [className, status] of Object.entries(statusClasses)) {
            if (classNames.includes(className)) {
              result.status = status;
              break;
            }
          }
          
          const statusEl = item.querySelector('.status, .result, .condition');
          if (statusEl) {
            const statusText = statusEl.textContent?.toLowerCase() || '';
            if (statusText.includes('good') || statusText.includes('pass') || statusText.includes('ok')) {
              result.status = 'good';
            } else if (statusText.includes('caution') || statusText.includes('warn') || statusText.includes('soon')) {
              result.status = 'caution';
            } else if (statusText.includes('immediate') || statusText.includes('fail') || statusText.includes('bad') || statusText.includes('urgent')) {
              result.status = 'immediate';
            }
          }
          
          const notesEl = item.querySelector('.notes, .comments, .technician-notes');
          if (notesEl) {
            result.notes = notesEl.textContent?.trim() || '';
          }
          
          const images = item.querySelectorAll('img[src]');
          images.forEach(img => {
            if (img.src && !img.src.includes('icon') && !img.src.includes('placeholder')) {
              result.pictures.push(img.src);
            }
          });
          
          if (result.description) {
            results.push(result);
          }
        });
        
        break;
      }
    }
    
    return results;
  }

  function extractDVIData() {
    const vehicleInfo = extractVehicleInfo();
    const inspectionResults = extractInspectionResults();
    
    return {
      vehicle: vehicleInfo,
      inspection: {
        date: new Date().toISOString(),
        url: window.location.href,
        results: inspectionResults,
      },
      source: 'autovitals',
      extractedAt: new Date().toISOString(),
    };
  }

  async function syncDVIData(data) {
    try {
      const state = await chrome.storage.local.get(['connected', 'serverUrl', 'apiKey']);
      
      if (!state.connected || !state.serverUrl || !state.apiKey) {
        console.log('[MOS AutoVitals] Not connected, skipping sync');
        return;
      }
      
      if (!data.vehicle.vin && data.inspection.results.length === 0) {
        console.log('[MOS AutoVitals] No VIN or inspection data found, skipping sync');
        return;
      }
      
      console.log('[MOS AutoVitals] Syncing DVI data:', data);
      
      const response = await fetch(`${state.serverUrl}/api/autovitals/extension/sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': state.apiKey
        },
        body: JSON.stringify(data)
      });
      
      if (response.ok) {
        const result = await response.json();
        console.log('[MOS AutoVitals] Sync successful:', result);
        
        const currentState = await chrome.storage.local.get(['syncCount']);
        await chrome.storage.local.set({
          syncCount: (currentState.syncCount || 0) + 1,
          lastSync: new Date().toLocaleTimeString()
        });
        
        chrome.runtime.sendMessage({
          type: 'SYNC_SUCCESS',
          data: result
        });
      } else {
        const error = await response.json();
        console.error('[MOS AutoVitals] Sync failed:', error);
      }
    } catch (error) {
      console.error('[MOS AutoVitals] Sync error:', error);
    }
  }

  function checkAndSync() {
    if (isProcessing) return;
    if (window.location.href === lastProcessedUrl) return;
    
    const isInspectionPage = 
      window.location.href.includes('inspection') ||
      window.location.href.includes('dvi') ||
      window.location.href.includes('vehicle') ||
      document.querySelector('.inspection-container, .dvi-container, .vehicle-inspection');
    
    if (!isInspectionPage) return;
    
    isProcessing = true;
    lastProcessedUrl = window.location.href;
    
    console.log('[MOS AutoVitals] Detected inspection page, extracting data...');
    
    setTimeout(() => {
      const data = extractDVIData();
      syncDVIData(data);
      isProcessing = false;
    }, 2000);
  }

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
        checkAndSync();
        break;
      }
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });

  checkAndSync();

  let lastUrl = location.href;
  new MutationObserver(() => {
    const url = location.href;
    if (url !== lastUrl) {
      lastUrl = url;
      lastProcessedUrl = '';
      checkAndSync();
    }
  }).observe(document, { subtree: true, childList: true });

  console.log('[MOS AutoVitals] Content script initialized');
})();
