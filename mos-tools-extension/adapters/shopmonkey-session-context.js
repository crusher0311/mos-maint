// MAIN-world, passive context only. Never exports credentials or grants access.
(function () {
  if (location.origin !== 'https://app.shopmonkey.cloud') return;
  let latest = null;
  let observed = false;
  const id = value => typeof value === 'string' &&
    /^(?:[a-f0-9]{24}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(value);
  function emit() {
    const valid = latest && latest.path === location.pathname &&
      latest.expiresAt > Date.now();
    window.postMessage({ type: 'MOS_SHOPMONKEY_SESSION_CONTEXT',
      observed, context: valid ? latest : null }, location.origin);
  }
  window.MosShopmonkeySessionContext = {
    observe(url, headers) {
      try {
        const target = new URL(url, location.origin);
        if (target.origin !== location.origin || !target.pathname.startsWith('/api/v3/')) return;
        const authorization = new Headers(headers || {}).get('authorization');
        if (!authorization) return;
        observed = true;
        latest = null;
        const token = authorization.match(/^Bearer ([^\s]+)$/i)?.[1];
        const part = token?.split('.')[1];
        if (!part || part.length > 16384) { emit(); return; }
        const claims = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
        if (claims.iss !== 'https://api.shopmonkey.cloud' || claims.aud !== 'shop' ||
          !id(claims.cid) || !id(claims.lid) || !Number.isFinite(claims.exp) ||
          claims.exp * 1000 <= Date.now()) { emit(); return; }
        // Decoded claims are advisory context, NOT authentication. The MOS
        // server must still resolve canonical ownership and account access.
        latest = { companyId: claims.cid, locationId: claims.lid,
          path: location.pathname, expiresAt: Math.min(claims.exp * 1000, Date.now() + 60000) };
        emit();
      } catch (_) { latest = null; emit(); }
    },
  };
  window.addEventListener('message', event => {
    if (event.source === window && event.origin === location.origin &&
      event.data?.type === 'MOS_REQUEST_SHOPMONKEY_CONTEXT') emit();
  });
})();
