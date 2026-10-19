---
name: Normalized adapter entrypoint
description: Cold tsx imports can fail on the normalized adapter factory cycle.
---

Import normalized provider adapters through the core adapter module in standalone
tsx scripts, rather than importing a provider implementation first.

**Why:** A cold CommonJS-style tsx load of the Protractor implementation failed
with “Cannot access 'ProtractorAdapter' before initialization”: its core dependency
constructs the provider adapters before that direct import has finished.

**How to apply:** Use the core module's exported adapter class when adding offline
validation scripts. Do not load the application server or change production
configuration to work around this import-order failure.
