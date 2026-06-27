---
name: Extension dual timeout (client vs proxy)
description: Slow extension writes need BOTH timeouts widened or the client cap wins
---

# Extension request timeout has TWO independent caps

A slow MOS API call from the extension can be killed by either of two separate
timers, and widening only one does nothing:

1. **Background proxy cap** — `MOS_FETCH_TIMEOUT_MS` (45s default) in
   `background.js`. A caller can override per-request via `options.timeoutMs`.
2. **Sidepanel messaging cap** — `sendMessage(message, timeoutMs = 30000)` in
   `sidepanel.js` wraps `chrome.runtime.sendMessage` in its own `setTimeout`
   that resolves with `{ error: 'Request timed out. Please try again.' }`.

**Why:** The Create RO submit (`/api/extension/protractor/create-work-order`)
runs several slow upstream Protractor calls server-side (open-WO lookup,
vehicle-by-VIN, line resolution from job_index, then the write) and tripped the
30s sidepanel cap even after `options.timeoutMs` was raised.

**How to apply:** For any slow extension write, set `options.timeoutMs` (proxy)
AND pass a larger second arg to `sendMessage(payload, N)`. Keep the client arg
slightly ABOVE the proxy cap (e.g. proxy 120s, client 125s) so the friendly
proxy timeout message wins instead of the generic sidepanel one.
