(() => {
  const AUTOVITALS_ENDPOINTS = [
    '/api/',
    '/appointment',
    '/vehicle',
    '/customer',
    '/inspection',
    '/dashboard',
    '/workorder',
    '/dvi',
  ];

  function shouldCapture(url) {
    const urlLower = url.toLowerCase();
    return AUTOVITALS_ENDPOINTS.some(endpoint => urlLower.includes(endpoint));
  }

  function postToExtension(data) {
    window.postMessage({
      type: 'MOS_AUTOVITALS_NETWORK_DATA',
      payload: data
    }, '*');
  }

  function extractVehicleData(data, url) {
    const vehicles = [];
    
    function processObject(obj, source = 'unknown') {
      if (!obj || typeof obj !== 'object') return;
      
      if (obj.vin && typeof obj.vin === 'string' && obj.vin.length === 17) {
        vehicles.push({
          vin: obj.vin.toUpperCase(),
          year: obj.year || obj.vehicleYear || obj.modelYear || null,
          make: obj.make || obj.vehicleMake || null,
          model: obj.model || obj.vehicleModel || null,
          mileage: obj.mileage || obj.odometer || obj.currentMileage || null,
          licensePlate: obj.licensePlate || obj.plateNumber || obj.plate || null,
          customerName: obj.customerName || obj.customer?.name || obj.ownerName || null,
          customerPhone: obj.customerPhone || obj.customer?.phone || obj.phone || null,
          customerEmail: obj.customerEmail || obj.customer?.email || obj.email || null,
          appointmentId: obj.appointmentId || obj.id || null,
          source: source
        });
      }
      
      if (obj.vehicle && typeof obj.vehicle === 'object') {
        const v = obj.vehicle;
        if (v.vin && v.vin.length === 17) {
          vehicles.push({
            vin: v.vin.toUpperCase(),
            year: v.year || v.modelYear || null,
            make: v.make || null,
            model: v.model || null,
            mileage: v.mileage || v.odometer || null,
            licensePlate: v.licensePlate || v.plate || null,
            customerName: obj.customerName || obj.customer?.name || null,
            customerPhone: obj.customerPhone || obj.customer?.phone || null,
            appointmentId: obj.appointmentId || obj.id || null,
            source: source
          });
        }
      }
    }
    
    if (Array.isArray(data)) {
      data.forEach(item => processObject(item, url));
    } else if (data && typeof data === 'object') {
      processObject(data, url);
      
      const arrayKeys = ['appointments', 'vehicles', 'customers', 'data', 'items', 'results', 'records'];
      for (const key of arrayKeys) {
        if (Array.isArray(data[key])) {
          data[key].forEach(item => processObject(item, url));
        }
      }
    }
    
    return vehicles;
  }

  const originalFetch = window.fetch;
  window.fetch = async function(...args) {
    const response = await originalFetch.apply(this, args);
    
    try {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
      
      if (shouldCapture(url)) {
        const clonedResponse = response.clone();
        const contentType = clonedResponse.headers.get('content-type') || '';
        
        if (contentType.includes('application/json')) {
          clonedResponse.json().then(data => {
            console.log('[MOS] Captured fetch:', url);
            const vehicles = extractVehicleData(data, url);
            if (vehicles.length > 0) {
              console.log('[MOS] Extracted vehicles from fetch:', vehicles.length);
              postToExtension({ type: 'vehicles', vehicles, url, source: 'fetch' });
            }
          }).catch(() => {});
        }
      }
    } catch (e) {
      console.log('[MOS] Fetch capture error:', e);
    }
    
    return response;
  };

  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;
  
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this._mosUrl = url;
    return originalXHROpen.apply(this, [method, url, ...rest]);
  };
  
  XMLHttpRequest.prototype.send = function(...args) {
    if (this._mosUrl && shouldCapture(this._mosUrl)) {
      this.addEventListener('load', function() {
        try {
          const contentType = this.getResponseHeader('content-type') || '';
          if (contentType.includes('application/json') && this.responseText) {
            const data = JSON.parse(this.responseText);
            console.log('[MOS] Captured XHR:', this._mosUrl);
            const vehicles = extractVehicleData(data, this._mosUrl);
            if (vehicles.length > 0) {
              console.log('[MOS] Extracted vehicles from XHR:', vehicles.length);
              postToExtension({ type: 'vehicles', vehicles, url: this._mosUrl, source: 'xhr' });
            }
          }
        } catch (e) {
          console.log('[MOS] XHR capture error:', e);
        }
      });
    }
    return originalXHRSend.apply(this, args);
  };

  console.log('[MOS AutoVitals] Network interceptor installed');
})();
