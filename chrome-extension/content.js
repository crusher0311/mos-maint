(() => {
  let lastProcessedUrl = '';
  let isProcessing = false;
  let capturedVehicles = [];
  let networkCaptureTimeout = null;

  console.log('[MOS AutoVitals] Content script loaded');

  function injectNetworkInterceptor() {
    if (document.getElementById('mos-autovitals-inject')) return;
    
    const script = document.createElement('script');
    script.id = 'mos-autovitals-inject';
    script.src = chrome.runtime.getURL('inject.js');
    script.onload = function() {
      console.log('[MOS AutoVitals] Network interceptor injected');
    };
    (document.head || document.documentElement).appendChild(script);
  }

  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    if (event.data?.type !== 'MOS_AUTOVITALS_NETWORK_DATA') return;

    const payload = event.data.payload;
    console.log('[MOS AutoVitals] Received network data:', payload);

    if (payload.type === 'vehicles' && payload.vehicles?.length > 0) {
      const seenVINs = new Set(capturedVehicles.map(v => v.vin));
      payload.vehicles.forEach(v => {
        if (v.vin && !seenVINs.has(v.vin)) {
          capturedVehicles.push(v);
          seenVINs.add(v.vin);
        }
      });
      
      console.log(`[MOS AutoVitals] Total captured vehicles: ${capturedVehicles.length}`);
      
      if (networkCaptureTimeout) clearTimeout(networkCaptureTimeout);
      networkCaptureTimeout = setTimeout(async () => {
        if (capturedVehicles.length > 0) {
          console.log('[MOS AutoVitals] Syncing captured vehicles:', capturedVehicles.length);
          await syncData({
            vehicles: capturedVehicles,
            source: 'autovitals-network',
            pageUrl: window.location.href,
            extractedAt: new Date().toISOString(),
          }, '/api/autovitals/extension/sync-vehicles');
          capturedVehicles = [];
        }
      }, 2000);
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectNetworkInterceptor);
  } else {
    injectNetworkInterceptor();
  }

  function detectCurrentVIN() {
    const vinSelectors = [
      '[data-vin]',
      '[data-vehicle-vin]',
      '.vin-display',
      '.vin-number',
      '.vehicle-vin',
      '[class*="vin"]',
      'input[name*="vin"]',
    ];
    
    for (const selector of vinSelectors) {
      try {
        const elements = document.querySelectorAll(selector);
        for (const el of elements) {
          const vin = el.dataset?.vin || el.dataset?.vehicleVin || el.value || el.textContent;
          if (vin && /^[A-HJ-NPR-Z0-9]{17}$/i.test(vin.trim())) {
            return vin.trim().toUpperCase();
          }
        }
      } catch (e) {}
    }
    
    const pageType = getPageType();
    
    if (pageType === 'inspection') {
      const headerAreas = document.querySelectorAll(
        'header, .header, [class*="header"], [class*="vehicle-info"], ' +
        '[class*="inspection-header"], .top-section, .vehicle-details'
      );
      
      for (const area of headerAreas) {
        const areaText = area.innerText || '';
        const vinMatch = areaText.match(/\b[A-HJ-NPR-Z0-9]{17}\b/i);
        if (vinMatch) {
          return vinMatch[0].toUpperCase();
        }
      }
      
      const titleArea = document.querySelector('h1, h2, .title, [class*="title"]');
      if (titleArea) {
        const text = titleArea.innerText || '';
        const vinMatch = text.match(/\b[A-HJ-NPR-Z0-9]{17}\b/i);
        if (vinMatch) {
          return vinMatch[0].toUpperCase();
        }
      }
    }
    
    const activeRow = document.querySelector(
      'tr.selected, tr.active, [class*="selected"], [class*="active-row"], ' +
      '[aria-selected="true"], [class*="highlighted"]'
    );
    if (activeRow) {
      const rowText = activeRow.innerText || '';
      const vinMatch = rowText.match(/\b[A-HJ-NPR-Z0-9]{17}\b/i);
      if (vinMatch) {
        return vinMatch[0].toUpperCase();
      }
    }
    
    const pageText = document.body.innerText || '';
    const allVINs = pageText.match(/\b[A-HJ-NPR-Z0-9]{17}\b/gi) || [];
    
    if (allVINs.length === 1) {
      return allVINs[0].toUpperCase();
    }
    
    if (allVINs.length > 1) {
      const mainContent = document.querySelector('main, .main, [class*="content"], article');
      if (mainContent) {
        const contentText = mainContent.innerText || '';
        const contentVINs = contentText.match(/\b[A-HJ-NPR-Z0-9]{17}\b/gi) || [];
        if (contentVINs.length === 1) {
          return contentVINs[0].toUpperCase();
        }
      }
    }
    
    return null;
  }

  function extractVINFromText(text) {
    const vinPattern = /\b[A-HJ-NPR-Z0-9]{17}\b/gi;
    const matches = text.match(vinPattern);
    if (matches) {
      return matches[0].toUpperCase();
    }
    return null;
  }

  function extractMileageFromText(text) {
    const mileagePatterns = [
      /(\d{1,3}(?:,\d{3})*)\s*(?:mi|miles|odometer)/i,
      /(?:mi|miles|odometer|mileage)[:\s]*(\d{1,3}(?:,\d{3})*)/i,
      /(\d{1,3}(?:,\d{3})*)\s*k?\s*miles/i,
    ];
    for (const pattern of mileagePatterns) {
      const match = text.match(pattern);
      if (match) {
        return parseInt(match[1].replace(/,/g, ''), 10);
      }
    }
    return null;
  }

  function extractVehicleFromRow(row) {
    const vehicle = {
      vin: null,
      year: null,
      make: null,
      model: null,
      mileage: null,
      licensePlate: null,
      customerName: null,
      customerPhone: null,
      customerEmail: null,
      lastServiceDate: null,
    };

    const rowText = row.innerText || row.textContent || '';
    
    vehicle.vin = extractVINFromText(rowText);
    vehicle.mileage = extractMileageFromText(rowText);

    const cells = row.querySelectorAll('td, .cell, .column, [class*="cell"], [class*="col"]');
    
    cells.forEach(cell => {
      const text = (cell.innerText || cell.textContent || '').trim();
      const lowerText = text.toLowerCase();
      const cellClass = (cell.className || '').toLowerCase();
      const cellData = Object.keys(cell.dataset || {}).join(' ').toLowerCase();
      
      if (!vehicle.vin && /^[A-HJ-NPR-Z0-9]{17}$/i.test(text)) {
        vehicle.vin = text.toUpperCase();
      }
      
      if (!vehicle.year && /^(19|20)\d{2}$/.test(text)) {
        vehicle.year = parseInt(text, 10);
      }
      
      if (cellClass.includes('make') || cellData.includes('make')) {
        vehicle.make = text;
      }
      if (cellClass.includes('model') || cellData.includes('model')) {
        vehicle.model = text;
      }
      
      if (cellClass.includes('customer') || cellClass.includes('name') || cellClass.includes('owner')) {
        if (!vehicle.customerName && text.length > 2 && text.includes(' ')) {
          vehicle.customerName = text;
        }
      }
      
      if (cellClass.includes('phone') || cellData.includes('phone')) {
        vehicle.customerPhone = text;
      }
      if (cellClass.includes('email') || cellData.includes('email')) {
        vehicle.customerEmail = text;
      }
      
      if (cellClass.includes('plate') || cellClass.includes('license') || cellData.includes('plate')) {
        vehicle.licensePlate = text;
      }
      
      if (cellClass.includes('date') || cellClass.includes('service')) {
        const dateMatch = text.match(/\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/);
        if (dateMatch) {
          vehicle.lastServiceDate = dateMatch[0];
        }
      }
    });

    const ymm = rowText.match(/\b(19|20)\d{2}\s+([A-Za-z]+)\s+([A-Za-z0-9]+)/);
    if (ymm) {
      if (!vehicle.year) vehicle.year = parseInt(ymm[1] + ymm[2].slice(0, 2), 10);
      if (!vehicle.make) vehicle.make = ymm[2];
      if (!vehicle.model) vehicle.model = ymm[3];
    }

    return vehicle;
  }

  function extractVehiclesFromDashboard() {
    const vehicles = [];
    const seenVINs = new Set();
    
    const cardSelectors = [
      '[class*="card"]',
      '[class*="tile"]',
      '[class*="panel"]',
      '[class*="vehicle-card"]',
      '[class*="customer-card"]',
      '[class*="appointment"]',
      '.card',
      '.tile',
      '.panel',
      '[data-vehicle]',
      '[data-customer]',
      '[data-appointment]',
    ];
    
    for (const selector of cardSelectors) {
      try {
        const cards = document.querySelectorAll(selector);
        if (cards.length > 0) {
          console.log(`[MOS AutoVitals] Checking ${cards.length} cards with selector: ${selector}`);
          
          cards.forEach((card) => {
            const cardText = card.innerText || card.textContent || '';
            const vin = extractVINFromText(cardText);
            
            if (vin && !seenVINs.has(vin)) {
              seenVINs.add(vin);
              
              const vehicle = {
                vin,
                year: null,
                make: null,
                model: null,
                mileage: extractMileageFromText(cardText),
                customerName: null,
                licensePlate: null,
              };
              
              const ymm = cardText.match(/\b(19|20)\d{2}\s+([A-Za-z]+)\s+([A-Za-z0-9]+)/);
              if (ymm) {
                vehicle.year = parseInt(ymm[0].substring(0, 4), 10);
                vehicle.make = ymm[2];
                vehicle.model = ymm[3];
              }
              
              const nameMatch = cardText.match(/([A-Z][a-z]+\s+[A-Z][a-z]+)/);
              if (nameMatch) {
                vehicle.customerName = nameMatch[1];
              }
              
              vehicles.push(vehicle);
            }
          });
        }
      } catch (err) {
        console.log(`[MOS AutoVitals] Error with card selector ${selector}:`, err);
      }
    }
    
    if (vehicles.length > 0) {
      console.log(`[MOS AutoVitals] Found ${vehicles.length} vehicles from cards`);
      return vehicles;
    }
    
    const tableSelectors = [
      'table tbody tr',
      '[role="row"]',
      '[role="gridcell"]',
      '.vehicle-row',
      '.customer-row',
      '.data-row',
      '[class*="vehicle-list"] > div',
      '[class*="customer-list"] > div',
      '.list-item',
      '[class*="ag-row"]',
      '[class*="row-"]',
      '[data-row]',
      '[data-index]',
    ];

    for (const selector of tableSelectors) {
      try {
        const rows = document.querySelectorAll(selector);
        if (rows.length > 0) {
          console.log(`[MOS AutoVitals] Checking ${rows.length} elements with selector: ${selector}`);
          
          rows.forEach((row, index) => {
            if (row.querySelector('th') || row.classList.contains('header') || 
                row.getAttribute('role') === 'columnheader') {
              return;
            }
            
            const vehicle = extractVehicleFromRow(row);
            
            if (vehicle.vin && !seenVINs.has(vehicle.vin)) {
              seenVINs.add(vehicle.vin);
              vehicles.push(vehicle);
            } else if (!vehicle.vin && vehicle.customerName && (vehicle.make || vehicle.model)) {
              vehicles.push(vehicle);
            }
          });
        }
      } catch (err) {
        console.log(`[MOS AutoVitals] Error with selector ${selector}:`, err);
      }
    }

    if (vehicles.length === 0) {
      console.log('[MOS AutoVitals] Trying text-based VIN extraction...');
      const pageText = document.body.innerText || '';
      const vinPattern = /\b[A-HJ-NPR-Z0-9]{17}\b/gi;
      const allVINs = pageText.match(vinPattern) || [];
      const uniqueVINs = [...new Set(allVINs.map(v => v.toUpperCase()))];
      
      uniqueVINs.forEach(vin => {
        if (!seenVINs.has(vin)) {
          vehicles.push({ vin });
        }
      });
    }

    console.log(`[MOS AutoVitals] Extracted ${vehicles.length} vehicles from dashboard`);
    return vehicles;
  }

  function extractSingleVehicleInfo() {
    const info = {};
    
    const pageText = document.body.innerText || '';
    info.vin = extractVINFromText(pageText);
    info.mileage = extractMileageFromText(pageText);
    
    const selectors = {
      customerName: [
        '[data-field="customer-name"]',
        '.customer-name',
        '.client-name',
        '#customerName',
        '[class*="customer"] [class*="name"]',
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
      licensePlate: [
        '[data-field="license-plate"]',
        '.license-plate',
        '#licensePlate',
      ],
      customerPhone: [
        '[data-field="phone"]',
        '.customer-phone',
        '.phone',
      ],
      customerEmail: [
        '[data-field="email"]',
        '.customer-email',
        '.email',
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
      '[class*="inspection"] [class*="item"]',
      '[class*="dvi"] [class*="line"]',
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
          
          const descEl = item.querySelector('.description, .item-name, .check-description, td:first-child, [class*="desc"]');
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
            'ok': 'good',
            'danger': 'immediate',
            'warning': 'caution',
          };
          
          const classNames = item.className.toLowerCase();
          for (const [className, status] of Object.entries(statusClasses)) {
            if (classNames.includes(className)) {
              result.status = status;
              break;
            }
          }
          
          const statusEl = item.querySelector('.status, .result, .condition, [class*="status"]');
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
          
          const notesEl = item.querySelector('.notes, .comments, .technician-notes, [class*="note"]');
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

  function getPageType() {
    const url = window.location.href.toLowerCase();
    
    if (url.includes('inspection') || url.includes('dvi')) {
      return 'inspection';
    }
    
    const inspectionIndicators = document.querySelectorAll(
      '.inspection-container, .dvi-container, .vehicle-inspection, ' +
      '[class*="inspection-detail"], [class*="dvi-detail"], ' +
      '[data-inspection], [data-dvi]'
    );
    if (inspectionIndicators.length > 0) {
      return 'inspection';
    }

    const dashboardIndicators = document.querySelectorAll(
      'table, [role="grid"], [role="table"], ' +
      '[class*="grid"], [class*="list"], [class*="table"], ' +
      '[data-grid], [data-list], .ag-root, .ag-body, ' +
      '[class*="row"]:not(tr), [class*="item"]'
    );
    
    if (dashboardIndicators.length > 0) {
      return 'dashboard';
    }
    
    const hasMultipleVINs = (document.body.innerText?.match(/\b[A-HJ-NPR-Z0-9]{17}\b/gi) || []).length > 1;
    if (hasMultipleVINs) {
      return 'dashboard';
    }
    
    const hasSingleVIN = (document.body.innerText?.match(/\b[A-HJ-NPR-Z0-9]{17}\b/gi) || []).length === 1;
    if (hasSingleVIN) {
      return 'inspection';
    }
    
    return 'dashboard';
  }

  async function syncData(data, endpoint) {
    try {
      const state = await chrome.storage.local.get(['connected', 'serverUrl', 'apiKey']);
      
      if (!state.connected || !state.serverUrl || !state.apiKey) {
        console.log('[MOS AutoVitals] Not connected, skipping sync');
        return { success: false, reason: 'not_connected' };
      }
      
      console.log(`[MOS AutoVitals] Syncing to ${endpoint}:`, data);
      
      const response = await fetch(`${state.serverUrl}${endpoint}`, {
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
        
        const currentState = await chrome.storage.local.get(['syncCount', 'vehicleCount']);
        const newVehicleCount = result.vehiclesImported || result.itemsCount || 1;
        await chrome.storage.local.set({
          syncCount: (currentState.syncCount || 0) + 1,
          vehicleCount: (currentState.vehicleCount || 0) + newVehicleCount,
          lastSync: new Date().toLocaleTimeString()
        });
        
        chrome.runtime.sendMessage({
          type: 'SYNC_SUCCESS',
          data: result
        });
        return { success: true, result };
      } else {
        const error = await response.json();
        console.error('[MOS AutoVitals] Sync failed:', error);
        return { success: false, error };
      }
    } catch (error) {
      console.error('[MOS AutoVitals] Sync error:', error);
      return { success: false, error: error.message };
    }
  }

  let retryCount = 0;
  const MAX_RETRIES = 5;
  const RETRY_DELAYS = [2000, 4000, 6000, 8000, 10000];

  async function processPage() {
    if (isProcessing) return;
    
    const pageType = getPageType();
    
    if (pageType === 'unknown') {
      console.log('[MOS AutoVitals] Unknown page type, skipping');
      return;
    }
    
    if (window.location.href === lastProcessedUrl && retryCount >= MAX_RETRIES) {
      return;
    }
    
    isProcessing = true;
    
    console.log(`[MOS AutoVitals] Processing ${pageType} page (attempt ${retryCount + 1})`);
    
    const delay = RETRY_DELAYS[retryCount] || 2000;
    await new Promise(resolve => setTimeout(resolve, delay));
    
    let syncResult;
    
    if (pageType === 'dashboard') {
      const vehicles = extractVehiclesFromDashboard();
      if (vehicles.length > 0) {
        syncResult = await syncData({
          vehicles,
          source: 'autovitals',
          pageUrl: window.location.href,
          extractedAt: new Date().toISOString(),
        }, '/api/autovitals/extension/sync-vehicles');
      } else {
        console.log('[MOS AutoVitals] No vehicles found on dashboard');
        syncResult = { success: false, reason: 'no_vehicles' };
      }
    } else if (pageType === 'inspection') {
      const vehicleInfo = extractSingleVehicleInfo();
      const inspectionResults = extractInspectionResults();
      
      if (vehicleInfo.vin || inspectionResults.length > 0) {
        syncResult = await syncData({
          vehicle: vehicleInfo,
          inspection: {
            date: new Date().toISOString(),
            url: window.location.href,
            results: inspectionResults,
          },
          source: 'autovitals',
          extractedAt: new Date().toISOString(),
        }, '/api/autovitals/extension/sync');
      } else {
        console.log('[MOS AutoVitals] No VIN or inspection data found');
        syncResult = { success: false, reason: 'no_data' };
      }
    }
    
    if (syncResult?.success) {
      lastProcessedUrl = window.location.href;
      retryCount = 0;
      console.log('[MOS AutoVitals] Successfully synced, marking URL as processed');
    } else if (retryCount < MAX_RETRIES && syncResult?.reason !== 'not_connected') {
      retryCount++;
      console.log(`[MOS AutoVitals] Will retry (${retryCount}/${MAX_RETRIES})`);
    }
    
    isProcessing = false;
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'MANUAL_SYNC') {
      console.log('[MOS AutoVitals] Manual sync requested');
      lastProcessedUrl = '';
      retryCount = 0;
      processPage().then(() => {
        sendResponse({ success: true });
      });
      return true;
    }
    
    if (message.type === 'GET_PAGE_INFO') {
      const pageType = getPageType();
      let vehicleCount = capturedVehicles.length;
      
      if (vehicleCount === 0 && pageType === 'dashboard') {
        const vehicles = extractVehiclesFromDashboard();
        vehicleCount = vehicles.length;
      }
      
      sendResponse({
        pageType,
        vehicleCount,
        capturedFromNetwork: capturedVehicles.length,
        url: window.location.href,
      });
      return true;
    }
    
    if (message.type === 'GET_CURRENT_VIN') {
      const vin = detectCurrentVIN();
      console.log('[MOS AutoVitals] Current VIN:', vin);
      sendResponse({ vin });
      return true;
    }
  });

  function initObservers() {
    if (!document.body) {
      setTimeout(initObservers, 100);
      return;
    }
    
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
          processPage();
          break;
        }
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    processPage();

    let lastUrl = location.href;
    new MutationObserver(() => {
      const url = location.href;
      if (url !== lastUrl) {
        lastUrl = url;
        lastProcessedUrl = '';
        retryCount = 0;
        processPage();
      }
    }).observe(document, { subtree: true, childList: true });

    console.log('[MOS AutoVitals] Content script initialized');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initObservers);
  } else {
    initObservers();
  }
})();
