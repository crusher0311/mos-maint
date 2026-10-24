# Isolated website appearance checks

No Next server, authentication bypass or live store is used. This Vite fixture
imports real public/auth/settings/admin/report components and replaces Next
navigation and API responses locally. Dashboard samples exercise shared utility
surfaces. This is not an end-to-end test of authenticated Next routes.

```sh
node artifacts/detect-dog-workflow/node_modules/vite/bin/vite.js --config tests/theme-browser/vite.config.mjs
DEMO_CHROMIUM_PATH=$(which chromium) node tests/theme-browser/check.cjs
node --import tsx --test tests/theme-runtime.test.ts
```

The browser check writes screenshots to ignored `generated-artifacts/theme/`.
It covers light/dark desktop/mobile page families, simulated SSR hydration,
prepaint bootstrap with the React entry blocked, system preference changes,
explicit persistence/navigation, unavailable storage, keyboard focus, dialogs
and print. External browser requests are blocked.

Use `data-theme-surface="light"` on physical label/document preview canvases,
never on their editors. Screen palette rules must not affect generated output.
