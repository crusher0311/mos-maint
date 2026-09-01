(function() {
  var snifferActive = false;
  // The service worker deliberately keeps Tekmetric credentials in memory
  // only. Keep the last credential observed by this page in MAIN-world memory
  // as well, so the same tab can hand it back after a worker restart.
  var latestTekmetricProof = null;

  function rememberTekmetricProof(url, headers) {
    try {
      var origin = new URL(url, window.location.origin).origin;
      if (
        origin !== 'https://shop.tekmetric.com' &&
        origin !== 'https://sandbox.tekmetric.com' &&
        origin !== 'https://cba.tekmetric.com'
      ) return;
      var entries = headers instanceof Headers
        ? Array.from(headers.entries())
        : Object.entries(headers || {});
      var tokenEntry = entries.find(function(entry) {
        return String(entry[0]).toLowerCase() === 'x-auth-token';
      });
      if (!tokenEntry || !tokenEntry[1]) return;
      latestTekmetricProof = {
        token: String(tokenEntry[1]),
        origin: origin
      };
    } catch (_) {}
  }

  window.addEventListener('message', function(event) {
    if (event.data && event.data.type === 'MOS_SNIFFER_STATE') {
      snifferActive = !!event.data.active;
      console.log('[MOS Intercept] Sniffer ' + (snifferActive ? 'enabled' : 'disabled'));
    }
    if (event.source === window && event.data && event.data.type === 'MOS_REQUEST_TEKMETRIC_ACTIVITY') {
      if (!latestTekmetricProof) return;
      // Generate one harmless authenticated request. Chrome's webRequest
      // observer re-captures the header for this same tab; the credential is
      // never placed on the page message bus.
      origFetch.call(window, latestTekmetricProof.origin + '/api/profile', {
        method: 'GET',
        headers: { 'x-auth-token': latestTekmetricProof.token },
        credentials: 'include',
      }).catch(function() {});
    }
  });

  var origFetch = window.fetch;
  window.fetch = function() {
    var url = typeof arguments[0] === 'string' ? arguments[0] : (arguments[0] && arguments[0].url) || '';
    var opts = arguments[1] || {};
    var method = opts.method || 'GET';
    var requestHeaders = opts.headers || (arguments[0] && arguments[0].headers);
    rememberTekmetricProof(url, requestHeaders);
    if (method !== 'GET') {
      console.log('[MOS Intercept] ' + method + ' ' + url);
      if (opts.body) {
        try {
          var bodyStr = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
          console.log('[MOS Intercept] Body:', bodyStr.substring(0, 2000));

          if (method === 'PATCH' && url.match(/\/api\/job\/\d+/)) {
            var parsed = JSON.parse(bodyStr);
            if (parsed.jobCategoryCode || parsed.jobCategoryName) {
              console.log('[MOS Intercept] Job category change detected:', parsed.jobCategoryName || parsed.jobCategoryCode);
              var jobIdMatch = url.match(/\/api\/job\/(\d+)/);
              window.postMessage({
                type: 'MOS_CATEGORY_CHANGED',
                jobId: jobIdMatch ? jobIdMatch[1] : null,
                categoryCode: parsed.jobCategoryCode || '',
                categoryName: parsed.jobCategoryName || ''
              }, '*');
            }
          }

          if (url.match(/\/api\/repair-order\/\d+\/authorize/) || url.match(/\/api\/repair-orders\/\d+\/authorize/)) {
            console.log('[MOS Intercept] Job authorization detected');
            window.postMessage({ type: 'MOS_JOBS_AUTHORIZED' }, '*');
          }
        } catch(e) {}
      }
      if (opts.headers) {
        try {
          var h = opts.headers instanceof Headers
            ? Object.fromEntries(opts.headers.entries())
            : opts.headers;
          console.log('[MOS Intercept] Headers:', JSON.stringify(h));
        } catch(e) {}
      }
    }

    // Passive RO load capture: when the Tekmetric SPA fetches a repair order's
    // canonical record, snapshot the response and emit MOS_RO_LOADED so the
    // content script can populate friendly RO #, vehicle, customer, mileage —
    // without any DOM scraping. Computed up front so it fires regardless of
    // whether the sniffer wrapper also runs below.
    var roLoadMatch = typeof url === 'string'
      ? url.match(/\/api\/shop\/(\d+)\/repair-order\/(\d+)(?:\?|$)/)
      : null;
    var roLoadShopId = roLoadMatch ? roLoadMatch[1] : null;
    var roLoadId = roLoadMatch ? roLoadMatch[2] : null;
    var fireRoLoaded = function(response) {
      if (!roLoadId) return;
      if (response.status >= 200 && response.status < 300) {
        try {
          response.clone().json().then(function(data) {
            window.postMessage({ type: 'MOS_RO_LOADED', shopId: roLoadShopId, roId: roLoadId, data: data }, '*');
          }).catch(function() {});
        } catch(e) {}
      }
    };

    if (snifferActive) {
      var reqBody = null;
      try {
        if (opts.body) reqBody = (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)).substring(0, 10000);
      } catch(e) {}

      var reqHeaders = null;
      try {
        if (opts.headers) {
          reqHeaders = opts.headers instanceof Headers
            ? Object.fromEntries(opts.headers.entries())
            : Object.assign({}, opts.headers);
          if (reqHeaders['x-auth-token']) reqHeaders['x-auth-token'] = '[REDACTED]';
          if (reqHeaders['authorization']) reqHeaders['authorization'] = '[REDACTED]';
          if (reqHeaders['Authorization']) reqHeaders['Authorization'] = '[REDACTED]';
        }
      } catch(e) {}

      var capturedUrl = url;
      var capturedMethod = method;

      return origFetch.apply(this, arguments).then(function(response) {
        var cloned = response.clone();
        cloned.text().then(function(responseText) {
          window.postMessage({
            type: 'MOS_SNIFFER_CAPTURE',
            data: {
              method: capturedMethod,
              url: capturedUrl,
              requestHeaders: reqHeaders,
              requestBody: reqBody,
              responseStatus: response.status,
              responseBody: responseText.substring(0, 10000),
              source: 'page_fetch'
            }
          }, '*');
        }).catch(function() {});
        fireRoLoaded(response);
        return response;
      });
    }

    if (roLoadId) {
      return origFetch.apply(this, arguments).then(function(response) {
        fireRoLoaded(response);
        return response;
      });
    }

    return origFetch.apply(this, arguments);
  };

  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;
  var origSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function(method, url) {
    this._mosUrl = url;
    this._mosMethod = method;
    this._mosHeaders = {};
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
    this._mosHeaders[name] = value;
    return origSetRequestHeader.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function(body) {
    rememberTekmetricProof(this._mosUrl, this._mosHeaders);
    if (this._mosMethod && this._mosMethod !== 'GET') {
      console.log('[MOS Intercept XHR] ' + this._mosMethod + ' ' + this._mosUrl);
      if (body) {
        try {
          var bodyStr = (typeof body === 'string' ? body : JSON.stringify(body)).substring(0, 2000);
          console.log('[MOS Intercept XHR] Body:', bodyStr);

          if (this._mosMethod === 'PATCH' && this._mosUrl && this._mosUrl.match(/\/api\/job\/\d+/)) {
            var parsed = JSON.parse(typeof body === 'string' ? body : JSON.stringify(body));
            if (parsed.jobCategoryCode || parsed.jobCategoryName) {
              console.log('[MOS Intercept XHR] Job category change detected:', parsed.jobCategoryName || parsed.jobCategoryCode);
              var jobIdMatch = this._mosUrl.match(/\/api\/job\/(\d+)/);
              window.postMessage({
                type: 'MOS_CATEGORY_CHANGED',
                jobId: jobIdMatch ? jobIdMatch[1] : null,
                categoryCode: parsed.jobCategoryCode || '',
                categoryName: parsed.jobCategoryName || ''
              }, '*');
            }
          }

          if (this._mosUrl && (this._mosUrl.match(/\/api\/repair-order\/\d+\/authorize/) || this._mosUrl.match(/\/api\/repair-orders\/\d+\/authorize/))) {
            console.log('[MOS Intercept XHR] Job authorization detected');
            window.postMessage({ type: 'MOS_JOBS_AUTHORIZED' }, '*');
          }
        } catch(e) {}
      }
    }

    if (snifferActive && this._mosMethod) {
      var xhrRef = this;
      var reqBody = null;
      try {
        if (body) reqBody = (typeof body === 'string' ? body : JSON.stringify(body)).substring(0, 10000);
      } catch(e) {}

      var xhrMethod = this._mosMethod;
      var xhrUrl = this._mosUrl;

      this.addEventListener('load', function() {
        try {
          window.postMessage({
            type: 'MOS_SNIFFER_CAPTURE',
            data: {
              method: xhrMethod,
              url: xhrUrl,
              requestBody: reqBody,
              responseStatus: xhrRef.status,
              responseBody: (xhrRef.responseText || '').substring(0, 10000),
              source: 'page_xhr'
            }
          }, '*');
        } catch(e) {}
      });
    }

    // Passive RO load capture (XHR path) — see fetch hook above for rationale.
    if (this._mosUrl && (!this._mosMethod || this._mosMethod === 'GET')) {
      var roMatchXhr = this._mosUrl.match(/\/api\/shop\/(\d+)\/repair-order\/(\d+)(?:\?|$)/);
      if (roMatchXhr) {
        var roLoadShopIdXhr = roMatchXhr[1];
        var roLoadIdXhr = roMatchXhr[2];
        var xhrSelf = this;
        this.addEventListener('load', function() {
          try {
            if (xhrSelf.status >= 200 && xhrSelf.status < 300 && xhrSelf.responseText) {
              var parsedRo = JSON.parse(xhrSelf.responseText);
              window.postMessage({ type: 'MOS_RO_LOADED', shopId: roLoadShopIdXhr, roId: roLoadIdXhr, data: parsedRo }, '*');
            }
          } catch(e) {}
        });
      }
    }

    return origSend.apply(this, arguments);
  };

  console.log('[MOS Intercept] Main world interceptor active');
})();
