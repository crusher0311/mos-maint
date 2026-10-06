---
name: Adapter test initialization
description: Standalone adapter tests need the registry initialized before provider adapters.
---
Initialize standalone normalized-adapter tests through the core adapter registry,
rather than importing a provider class first.

**Why:** The registry eagerly constructs provider adapters while provider modules
also import registry utilities. Importing the Protractor class first under tsx
produced a before-initialization error; entering through the registry resolved it.

**How to apply:** Use the registered adapter and assert that lookup succeeds.
Do not introduce database or network calls merely to initialize a mapping test.
