---
name: MV3 state-restore race in background handlers
description: Extension background message handlers must await _stateReady before reading mosApiUrl/mosApiToken globals
---
Background.js globals (`mosApiUrl`, `mosApiToken`, `mosShops`) start null and are restored asynchronously from chrome.storage via the `_stateReady` promise. After EVERY MV3 service-worker wake, any message handler that reads them synchronously races the restore.

**Why:** GET_SHOP_FEATURES read `mosApiUrl` while still null → fetched `null/api/extension/features` → perpetual "[MOS] Feature fetch error: Failed to fetch" console loop (fixed in ext 1.28.3). `handleMosApiRequest` never had the bug because it awaits `_stateReady`.

**How to apply:** any new background message handler touching MOS auth/URL globals must `await _stateReady` first (inside its async IIFE, still `return true` synchronously so sendResponse stays valid). A network-level "Failed to fetch" from the extension while other MOS calls succeed = suspect this race, not the server.

Diagnostic signature: server logs show NO request arriving while the client logs "Failed to fetch" — the URL was malformed client-side.
