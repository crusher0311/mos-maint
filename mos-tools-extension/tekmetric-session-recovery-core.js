(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.MosTekmetricSessionRecoveryCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  const ALLOWED_ORIGINS = new Set([
    'https://shop.tekmetric.com',
    'https://sandbox.tekmetric.com',
    'https://cba.tekmetric.com',
  ]);

  function isAllowedOrigin(origin) {
    return ALLOWED_ORIGINS.has(String(origin || ''));
  }

  function contextsMatch(expected, current) {
    if (!expected || !current) return false;
    if (expected.provider && expected.provider !== 'tekmetric') return false;
    if (current.provider !== 'tekmetric') return false;
    return String(expected.shopId || '') === String(current.shopId || '') &&
      String(expected.roId || '') === String(current.roId || '');
  }

  async function recover(options) {
    const {
      tabId,
      expectedContext,
      getActiveTabId,
      getCurrentContext,
      getSession,
      trigger,
      wait,
      timeoutMs = 1800,
      pollMs = 50,
    } = options;

    const stillCurrent = () =>
      tabId != null &&
      tabId === getActiveTabId() &&
      contextsMatch(expectedContext, getCurrentContext(tabId));

    if (!stillCurrent()) return null;
    const existing = getSession();
    if (existing) return existing;
    try {
      await trigger();
    } catch (_) {
      return null;
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!stillCurrent()) return null;
      const session = getSession();
      if (session) return session;
      await wait(pollMs);
    }
    return null;
  }

  async function requestStillCurrent(options) {
    const {
      tabId,
      expectedContext,
      session,
      getActiveTabId,
      getLiveContext,
      getTabState,
    } = options;
    if (tabId == null || tabId !== getActiveTabId()) return false;
    const liveContext = await getLiveContext(tabId);
    if (tabId !== getActiveTabId()) return false;
    if (!contextsMatch(expectedContext, liveContext)) return false;
    const tabState = await getTabState(tabId);
    if (tabId !== getActiveTabId()) return false;
    return isAllowedOrigin(tabState?.origin) &&
      tabState.origin === session?.origin &&
      (!liveContext?._pageUrl || liveContext._pageUrl === tabState.url);
  }

  return { isAllowedOrigin, contextsMatch, recover, requestStillCurrent };
});