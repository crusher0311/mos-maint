// Shared, pure text policy. No customer discovery and no persisted drafts.
(function (root) {
  function customerName(value) {
    if (typeof value !== 'string') return '';
    const name = value.trim();
    if (!name || name.length > 500 || /[\u0000-\u001f\u007f]/.test(name) ||
        /^(unknown|n\/a|null|undefined|name|customer|customer name)$/i.test(name)) return '';
    return name;
  }
  function tagline(config, context, manual) {
    if (typeof manual === 'string' && manual.trim()) return manual.trim();
    const name = context?.roId ? customerName(
      Object.hasOwn(context, 'stickerCustomerName') ? context.stickerCustomerName : context.customerName,
    ) : '';
    return config?.personalizeThankYou === true && name
      ? `Thank you, ${name}` : (config?.tagline || '');
  }
  function contextKey(context) {
    return JSON.stringify([context?._tabId ?? '', context?.provider ?? '',
      context?.shopId ?? '', context?.swShopId ?? '', context?.roId ?? '']);
  }
  root.MosStickerPersonalization = Object.freeze({ customerName, tagline, contextKey });
})(globalThis);
