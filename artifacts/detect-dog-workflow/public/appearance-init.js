/* Blocking, local-only initialization before the application or preview paints. */
(function () {
  var preference = 'system';
  var dark = false;
  try {
    var stored = window.localStorage.getItem('mos-workflow-appearance');
    if (stored === 'light' || stored === 'dark' || stored === 'system') preference = stored;
  } catch (_) { /* Storage can be disabled; use System without writing anything. */ }
  try { dark = window.matchMedia('(prefers-color-scheme: dark)').matches; } catch (_) {}
  var resolved = preference === 'system' ? (dark ? 'dark' : 'light') : preference;
  document.documentElement.dataset.workflowTheme = resolved;
  document.documentElement.style.colorScheme = resolved;
  document.documentElement.style.backgroundColor = resolved === 'dark' ? '#17221e' : '#f1f2e9';
})();
