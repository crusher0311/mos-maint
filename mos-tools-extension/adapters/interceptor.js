(function() {
  var origFetch = window.fetch;
  window.fetch = function() {
    var url = typeof arguments[0] === 'string' ? arguments[0] : (arguments[0] && arguments[0].url) || '';
    var opts = arguments[1] || {};
    var method = opts.method || 'GET';
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
    return origFetch.apply(this, arguments);
  };

  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url) {
    this._mosUrl = url;
    this._mosMethod = method;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function(body) {
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
    return origSend.apply(this, arguments);
  };

  console.log('[MOS Intercept] Main world interceptor active');
})();
