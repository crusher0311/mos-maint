// Read before a click, never await a network lookup in the browser gesture.
// Unknown settings block printing rather than risking an unwanted print.
(function (root) {
  let state = null;
  let pendingKey = null;
  let sequence = 0;
  const keyOf = c => JSON.stringify([c?.provider, c?.shopId, c?.swShopId, c?.roId]);
  function refresh(context) {
    const key = keyOf(context);
    if (!context?.shopId || !context?.roId || pendingKey === key) return;
    if (state?.key === key && Date.now() - state.at < 30000) return;
    pendingKey = key;
    const request = ++sequence;
    chrome.runtime.sendMessage({
      action: 'GET_STICKER_CONFIG', shopId: context.shopId,
      provider: context.provider, context, forceRefresh: true,
    }, result => {
      if (pendingKey !== key || request !== sequence) return;
      pendingKey = null;
      state = result?.config && !result.error && !result.stale
        ? { key, open: result.config.openPrintTabFirst === true, at: Date.now() } : null;
    });
  }
  function start(getContext) {
    const update = () => {
      const context = getContext();
      refresh(context);
      for (const button of document.querySelectorAll('#mos-print-button, #mos-print-btn-sw, #mos-print-btn-af')) {
        button.disabled = state?.key !== keyOf(context);
        if (button.disabled) button.title = 'Loading sticker settings…';
        else button.title = state.open ? 'Open Print tab' : 'Print oil sticker';
      }
    };
    setTimeout(update, 0);
    setInterval(update, 1000);
    window.addEventListener('focus', () => { state = null; refresh(getContext()); });
  }
  function route(context, notify) {
    if (state?.key !== keyOf(context)) {
      refresh(context);
      notify('Loading sticker settings. Please click Print again in a moment.', 'info');
      return true;
    }
    if (!state.open) return false;
    chrome.runtime.sendMessage({ action: 'OPEN_STICKER_PANEL', context }, result => {
      if (!result?.success) notify(result?.error || 'Could not open Print tab. Please try again.', 'error');
    });
    return true;
  }
  function isCurrent(sticker, context) {
    return !sticker?.mosPrintContext || keyOf(sticker.mosPrintContext) === keyOf(context);
  }
  root.MosStickerButtonPreference = Object.freeze({ start, route, refresh, isCurrent });
})(globalThis);
