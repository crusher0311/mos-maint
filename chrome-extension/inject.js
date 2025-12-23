(() => {
  const AUTOVITALS_ENDPOINTS = [
    'TvpxService.asmx/GetData',
    'TvpxService.asmx/GetAuthByCookie',
    '/api/',
    '/appointment',
    '/vehicle',
    '/customer',
    '/inspection',
    '/workorder',
  ];

  function shouldCapture(url) {
    return AUTOVITALS_ENDPOINTS.some(endpoint => url.includes(endpoint));
  }

  function postToExtension(data) {
    window.postMessage({
      type: 'MOS_AUTOVITALS_NETWORK_DATA',
      payload: data
    }, '*');
  }

  function extractVehicleData(data, url) {
    const vehicles = [];
    const seenVINs = new Set();
    
    if (data && data.d !== undefined) {
      console.log('[MOS] Unwrapping ASP.NET "d" wrapper, d type:', typeof data.d);
      if (typeof data.d === 'string') {
        try {
          data = JSON.parse(data.d);
          console.log('[MOS] Parsed JSON from string d');
        } catch (e) {
          data = data.d;
        }
      } else {
        data = data.d;
      }
      
      if (Array.isArray(data)) {
        console.log('[MOS] Unwrapped to array with', data.length, 'items');
        if (data.length > 0) {
          console.log('[MOS] First item keys:', Object.keys(data[0] || {}));
          console.log('[MOS] First item sample:', JSON.stringify(data[0]).substring(0, 500));
        }
      } else if (typeof data === 'object' && data !== null) {
        console.log('[MOS] Unwrapped to object with keys:', Object.keys(data));
        const firstKey = Object.keys(data)[0];
        if (firstKey && data[firstKey]) {
          console.log('[MOS] First value type:', typeof data[firstKey], Array.isArray(data[firstKey]) ? `array[${data[firstKey].length}]` : '');
          if (Array.isArray(data[firstKey]) && data[firstKey].length > 0) {
            console.log('[MOS] First Table item keys:', Object.keys(data[firstKey][0] || {}));
            console.log('[MOS] First Table item sample:', JSON.stringify(data[firstKey][0]).substring(0, 1000));
          }
        }
      } else {
        console.log('[MOS] Unwrapped to:', typeof data);
      }
    }
    
    function addVehicle(vehicle) {
      if (vehicle.vin && !seenVINs.has(vehicle.vin)) {
        seenVINs.add(vehicle.vin);
        vehicles.push(vehicle);
      }
    }
    
    // Extract vehicle from AutoVitals appointment record
    function extractFromAppointment(record) {
      // Look for VIN in various field names
      const vinFields = ['VIN', 'Vin', 'vin', 'VehicleVin', 'vehicleVin', 'VVIN'];
      let vin = null;
      for (const field of vinFields) {
        if (record[field] && typeof record[field] === 'string' && record[field].length === 17) {
          vin = record[field].toUpperCase();
          break;
        }
      }
      
      // Parse YMM (Year Make Model) field like "2020 RAM 1500 Classic"
      let year = null, make = null, model = null;
      if (record.YMM && typeof record.YMM === 'string') {
        const ymmMatch = record.YMM.match(/^(\d{4})\s+(\S+)\s+(.+)$/);
        if (ymmMatch) {
          year = parseInt(ymmMatch[1]);
          make = ymmMatch[2];
          model = ymmMatch[3];
        }
      }
      
      // Also check individual fields
      year = year || record.Year || record.year || record.VY;
      make = make || record.Make || record.make || record.VM;
      model = model || record.Model || record.model;
      
      const customerName = record.CN || record.CustomerName || record.customerName;
      const vehicleId = record.VID || record.VehicleId || record.vehicleId;
      
      // Log first record's full keys for debugging
      if (!window._mosLoggedKeys) {
        window._mosLoggedKeys = true;
        console.log('[MOS] Full appointment record keys:', Object.keys(record));
        console.log('[MOS] Checking for VIN in record:', JSON.stringify(record).substring(0, 2000));
      }
      
      return { vin, year, make, model, customerName, vehicleId, source: 'autovitals_network' };
    }
    
    function findVINInString(str) {
      if (typeof str !== 'string') return null;
      const match = str.match(/\b[A-HJ-NPR-Z0-9]{17}\b/i);
      return match ? match[0].toUpperCase() : null;
    }
    
    function processObject(obj, source = 'unknown') {
      if (!obj || typeof obj !== 'object') return;
      
      const vinFields = ['vin', 'VIN', 'Vin', 'vehicleVin', 'VehicleVin'];
      let vin = null;
      for (const field of vinFields) {
        if (obj[field] && typeof obj[field] === 'string') {
          const found = findVINInString(obj[field]);
          if (found) { vin = found; break; }
        }
      }
      
      if (!vin) {
        for (const key of Object.keys(obj)) {
          if (typeof obj[key] === 'string') {
            const found = findVINInString(obj[key]);
            if (found) { vin = found; break; }
          }
        }
      }
      
      if (vin) {
        addVehicle({
          vin,
          year: obj.year || obj.Year || obj.vehicleYear || obj.VehicleYear || obj.modelYear || obj.ModelYear || null,
          make: obj.make || obj.Make || obj.vehicleMake || obj.VehicleMake || null,
          model: obj.model || obj.Model || obj.vehicleModel || obj.VehicleModel || null,
          mileage: obj.mileage || obj.Mileage || obj.odometer || obj.Odometer || obj.currentMileage || null,
          licensePlate: obj.licensePlate || obj.LicensePlate || obj.plateNumber || obj.plate || obj.Plate || null,
          customerName: obj.customerName || obj.CustomerName || obj.customer?.name || obj.ownerName || obj.OwnerName || obj.name || obj.Name || null,
          customerPhone: obj.customerPhone || obj.CustomerPhone || obj.customer?.phone || obj.phone || obj.Phone || null,
          customerEmail: obj.customerEmail || obj.CustomerEmail || obj.customer?.email || obj.email || obj.Email || null,
          appointmentId: obj.appointmentId || obj.AppointmentId || obj.id || obj.Id || obj.ID || null,
          source: source
        });
      }
      
      if (obj.vehicle && typeof obj.vehicle === 'object') {
        processObject(obj.vehicle, source);
      }
      if (obj.Vehicle && typeof obj.Vehicle === 'object') {
        processObject(obj.Vehicle, source);
      }
    }
    
    function processDeep(obj, depth = 0) {
      if (depth > 5 || !obj) return;
      
      if (Array.isArray(obj)) {
        obj.forEach(item => processDeep(item, depth + 1));
      } else if (typeof obj === 'object') {
        processObject(obj, url);
        
        for (const key of Object.keys(obj)) {
          if (Array.isArray(obj[key]) || (typeof obj[key] === 'object' && obj[key] !== null)) {
            processDeep(obj[key], depth + 1);
          }
        }
      }
    }
    
    // Special handling for AutoVitals Table structure
    if (data && typeof data === 'object' && data.Table && Array.isArray(data.Table)) {
      console.log('[MOS] Processing AutoVitals Table structure with', data.Table.length, 'records');
      
      // Process each appointment record
      for (const record of data.Table) {
        const vehicle = extractFromAppointment(record);
        if (vehicle.vin) {
          addVehicle(vehicle);
        } else if (vehicle.vehicleId) {
          // Even without VIN, we can store the vehicle with its AV ID
          console.log('[MOS] Vehicle without VIN - VID:', vehicle.vehicleId, 'YMM:', record.YMM);
        }
      }
    }
    
    processDeep(data);
    
    return vehicles;
  }

  function parseXMLToJSON(xmlText) {
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(xmlText, 'text/xml');
      
      const stringContent = doc.querySelector('string');
      if (stringContent && stringContent.textContent) {
        try {
          return JSON.parse(stringContent.textContent);
        } catch (e) {}
      }
      
      function xmlToObj(node) {
        const obj = {};
        if (node.nodeType === Node.TEXT_NODE) {
          return node.textContent.trim();
        }
        for (const child of node.childNodes) {
          if (child.nodeType === Node.ELEMENT_NODE) {
            const key = child.nodeName;
            const value = child.childNodes.length === 1 && child.firstChild?.nodeType === Node.TEXT_NODE
              ? child.textContent.trim()
              : xmlToObj(child);
            if (obj[key]) {
              if (!Array.isArray(obj[key])) obj[key] = [obj[key]];
              obj[key].push(value);
            } else {
              obj[key] = value;
            }
          }
        }
        return obj;
      }
      
      return xmlToObj(doc.documentElement);
    } catch (e) {
      console.log('[MOS] XML parse error:', e);
      return null;
    }
  }

  const originalFetch = window.fetch;
  window.fetch = async function(...args) {
    const response = await originalFetch.apply(this, args);
    
    try {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
      
      if (shouldCapture(url)) {
        const clonedResponse = response.clone();
        const contentType = clonedResponse.headers.get('content-type') || '';
        
        clonedResponse.text().then(text => {
          let data = null;
          
          if (contentType.includes('application/json')) {
            try { data = JSON.parse(text); } catch (e) {}
          } else if (contentType.includes('xml') || text.trim().startsWith('<?xml') || text.trim().startsWith('<')) {
            data = parseXMLToJSON(text);
          } else {
            try { data = JSON.parse(text); } catch (e) {}
          }
          
          if (data) {
            console.log('[MOS] Captured fetch:', url, 'type:', contentType);
            const vehicles = extractVehicleData(data, url);
            if (vehicles.length > 0) {
              console.log('[MOS] Extracted vehicles from fetch:', vehicles.length);
              postToExtension({ type: 'vehicles', vehicles, url, source: 'fetch' });
            } else {
              console.log('[MOS] No vehicles found in response, keys:', Object.keys(data || {}));
            }
          }
        }).catch(e => console.log('[MOS] Response parse error:', e));
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
          const text = this.responseText || '';
          let data = null;
          
          if (contentType.includes('application/json')) {
            try { data = JSON.parse(text); } catch (e) {}
          } else if (contentType.includes('xml') || text.trim().startsWith('<?xml') || text.trim().startsWith('<')) {
            data = parseXMLToJSON(text);
          } else {
            try { data = JSON.parse(text); } catch (e) {}
          }
          
          if (data) {
            console.log('[MOS] Captured XHR:', this._mosUrl, 'type:', contentType);
            const vehicles = extractVehicleData(data, this._mosUrl);
            if (vehicles.length > 0) {
              console.log('[MOS] Extracted vehicles from XHR:', vehicles.length);
              postToExtension({ type: 'vehicles', vehicles, url: this._mosUrl, source: 'xhr' });
            } else {
              console.log('[MOS] No vehicles found in XHR response, keys:', Object.keys(data || {}));
            }
          }
        } catch (e) {
          console.log('[MOS] XHR capture error:', e);
        }
      });
    }
    return originalXHRSend.apply(this, args);
  };

  console.log('[MOS AutoVitals] Network interceptor v1.4.0 installed');
})();
