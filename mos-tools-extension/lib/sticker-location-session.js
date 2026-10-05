// One immutable credential/context per operation. Never installs a scoped token
// as the global login; never persists one across worker restarts.
export async function createStickerLocationRequest(context, deps) {
  const snapshot = { ...context };
  const identity = deps.identity();
  const revision = deps.revision?.(snapshot._tabId);
  async function assertCurrent() {
    const current = deps.identity();
    if (revision !== deps.revision?.(snapshot._tabId)) throw new Error('Tekmetric page changed. Please try again.');
    if (current.token !== identity.token || current.epoch !== identity.epoch ||
        current.apiUrl !== identity.apiUrl) throw new Error('MOS login changed. Please try again.');
    const tab = await deps.getTab(snapshot._tabId);
    const url = new URL(tab.url);
    const shop = url.pathname.match(/\/(?:admin\/)?shop\/(\d+)(?:\/|$)/)?.[1];
    if (!/(^|\.)tekmetric\.com$/.test(url.hostname) || String(shop) !== String(snapshot.shopId)) {
      throw new Error('Tekmetric location changed. Please print again from the current location.');
    }
    if (snapshot.roId) {
      const ro = url.pathname.match(/\/repair-orders\/(\d+)/)?.[1];
      if (String(ro) !== String(snapshot.roId)) throw new Error('Repair order changed. Please print again.');
    }
  }
  await assertCurrent();
  const send = async (path, options, token) => {
    const response = await deps.fetch(`${identity.apiUrl}${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(options.method === 'POST' && path.includes('/sticker') ? 45000 : 8000),
    });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error || 'Tekmetric location request failed. Please try again.'), { code: data.code });
    return data;
  };
  const scope = await send('/api/extension/auth/switch-location', {
    method: 'POST', body: JSON.stringify({ provider: 'tekmetric', smsShopId: String(snapshot.shopId) }),
  }, identity.token);
  if (!scope.token || scope.provider !== 'tekmetric' || String(scope.smsShopId) !== String(snapshot.shopId)) {
    throw new Error('Tekmetric location could not be confirmed. Nothing was printed.');
  }
  await assertCurrent();
  return {
    assertCurrent,
    async request(path, options = {}) {
      await assertCurrent();
      const data = await send(path, options, scope.token);
      await assertCurrent();
      if (data.sticker) data.sticker.mosPrintContext = snapshot;
      return data;
    },
  };
}
