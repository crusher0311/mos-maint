const SNIFFER_STORAGE_KEY = 'mosSnifferCaptures';
const SNIFFER_STATE_KEY = 'mosSnifferActive';
const SNIFFER_FILTERS_KEY = 'mosSnifferFilters';
const MAX_CAPTURES = 2000;
const MAX_BODY_LENGTH = 50000;

const CATEGORY_PATTERNS = {
  dvi: [
    /inspection/i,
    /dvi/i,
    /digital.?vehicle/i,
    /finding/i,
    /inspection.?task/i,
    /inspection.?rating/i
  ],
  estimates: [
    /estimate/i,
    /job/i,
    /labor/i,
    /part[s]?\b/i,
    /canned.?job/i,
    /service/i
  ],
  scheduling: [
    /appointment/i,
    /schedule/i,
    /calendar/i,
    /booking/i,
    /slot/i
  ],
  customers: [
    /customer/i,
    /contact/i,
    /vehicle.?owner/i,
    /client/i
  ],
  vehicles: [
    /vehicle/i,
    /vin/i,
    /fleet/i
  ],
  communication: [
    /message/i,
    /sms/i,
    /email/i,
    /text/i,
    /notification/i,
    /share/i,
    /send/i
  ],
  authorization: [
    /authorize/i,
    /approval/i,
    /decline/i
  ],
  repair_orders: [
    /repair.?order/i,
    /work.?order/i,
    /\/ro\//i,
    /summary/i
  ]
};

function categorizeRequest(method, url, body) {
  const categories = [];
  const testString = `${method} ${url} ${body || ''}`;

  for (const [category, patterns] of Object.entries(CATEGORY_PATTERNS)) {
    for (const pattern of patterns) {
      if (pattern.test(testString)) {
        categories.push(category);
        break;
      }
    }
  }

  if (categories.length === 0) categories.push('other');
  return categories;
}

function detectPlatform(url) {
  if (/tekmetric\.com/i.test(url)) return 'tekmetric';
  if (/autoflow\.com|autotext\.me/i.test(url)) return 'autoflow';
  if (/shop-ware\.com/i.test(url)) return 'shopware';
  return 'unknown';
}

function truncateBody(body) {
  if (!body) return null;
  const str = typeof body === 'string' ? body : JSON.stringify(body);
  if (str.length > MAX_BODY_LENGTH) {
    return str.substring(0, MAX_BODY_LENGTH) + `\n[TRUNCATED — ${str.length} total chars]`;
  }
  return str;
}

async function captureRequest(entry) {
  const { active } = await chrome.storage.local.get(SNIFFER_STATE_KEY);
  if (!active?.[SNIFFER_STATE_KEY] && !active) {
    const stateCheck = await chrome.storage.local.get(SNIFFER_STATE_KEY);
    if (!stateCheck[SNIFFER_STATE_KEY]) return;
  }

  const platform = detectPlatform(entry.url);
  const categories = categorizeRequest(entry.method, entry.url, entry.requestBody);

  const { [SNIFFER_FILTERS_KEY]: filters } = await chrome.storage.local.get(SNIFFER_FILTERS_KEY);
  if (filters) {
    if (filters.platforms?.length && !filters.platforms.includes(platform)) return;
    if (filters.categories?.length && !categories.some(c => filters.categories.includes(c))) return;
    if (filters.methodsExclude?.includes(entry.method)) return;
  }

  const capture = {
    id: `${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
    timestamp: Date.now(),
    platform,
    categories,
    method: entry.method,
    url: entry.url,
    path: (() => { try { return new URL(entry.url).pathname; } catch { return entry.url; } })(),
    requestHeaders: entry.requestHeaders || null,
    requestBody: truncateBody(entry.requestBody),
    responseStatus: entry.responseStatus || null,
    responseBody: truncateBody(entry.responseBody),
    source: entry.source || 'webRequest'
  };

  const { [SNIFFER_STORAGE_KEY]: existing } = await chrome.storage.local.get(SNIFFER_STORAGE_KEY);
  const captures = existing || [];
  captures.push(capture);

  if (captures.length > MAX_CAPTURES) {
    captures.splice(0, captures.length - MAX_CAPTURES);
  }

  await chrome.storage.local.set({ [SNIFFER_STORAGE_KEY]: captures });
}

async function getCaptures(filters = {}) {
  const { [SNIFFER_STORAGE_KEY]: captures } = await chrome.storage.local.get(SNIFFER_STORAGE_KEY);
  let results = captures || [];

  if (filters.platform) {
    results = results.filter(c => c.platform === filters.platform);
  }
  if (filters.category) {
    results = results.filter(c => c.categories.includes(filters.category));
  }
  if (filters.method) {
    results = results.filter(c => c.method === filters.method);
  }
  if (filters.search) {
    const term = filters.search.toLowerCase();
    results = results.filter(c =>
      c.url.toLowerCase().includes(term) ||
      (c.requestBody && c.requestBody.toLowerCase().includes(term)) ||
      (c.responseBody && c.responseBody.toLowerCase().includes(term))
    );
  }
  if (filters.since) {
    results = results.filter(c => c.timestamp >= filters.since);
  }

  return results;
}

async function clearCaptures() {
  await chrome.storage.local.set({ [SNIFFER_STORAGE_KEY]: [] });
}

async function exportCaptures(filters = {}) {
  const captures = await getCaptures(filters);
  return {
    exportedAt: new Date().toISOString(),
    count: captures.length,
    captures
  };
}

async function isSnifferActive() {
  const { [SNIFFER_STATE_KEY]: active } = await chrome.storage.local.get(SNIFFER_STATE_KEY);
  return !!active;
}

async function setSnifferActive(active) {
  await chrome.storage.local.set({ [SNIFFER_STATE_KEY]: active });
}

async function setSnifferFilters(filters) {
  await chrome.storage.local.set({ [SNIFFER_FILTERS_KEY]: filters });
}

async function getSnifferFilters() {
  const { [SNIFFER_FILTERS_KEY]: filters } = await chrome.storage.local.get(SNIFFER_FILTERS_KEY);
  return filters || {};
}

if (typeof globalThis !== 'undefined') {
  globalThis.MOS_SNIFFER = {
    captureRequest,
    getCaptures,
    clearCaptures,
    exportCaptures,
    isSnifferActive,
    setSnifferActive,
    setSnifferFilters,
    getSnifferFilters,
    SNIFFER_STATE_KEY,
    SNIFFER_STORAGE_KEY,
    SNIFFER_FILTERS_KEY,
    categorizeRequest,
    detectPlatform
  };
}
