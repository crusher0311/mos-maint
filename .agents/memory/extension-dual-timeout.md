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

**How to apply:** The sidepanel `sendMessage` now self-derives its cap: default
60s (> 45s proxy default), and if the message carries `options.timeoutMs` it
waits that value + 10s buffer automatically — so plain call sites are safe by
default. Only pass an explicit second arg when the background can run LONGER
than its fetch cap (e.g. widened `authRetryDelaysMs` 401 retry schedules add
~26s of delays on top of the fetch cap → those write sites pass 90s). The
client cap must always end up above the effective background time so the
proxy's accurate timeout message wins instead of the generic sidepanel one.
