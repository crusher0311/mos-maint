---
name: Keytag optional details scope
description: Product boundary for shop-defined vehicle-identification print values.
---
Optional keytag color, plate, and shop-defined short text are print-operation details, not a vehicle custom-field system.

**Why:** The user explicitly excluded vehicle-profile editing, provider write-back, historical imports, external partner expansion, and prototype changes. Shops must opt in without changing other shops' print flows.

**How to apply:** Reuse already-scoped vehicle context only; missing defaults remain optional and editable. Keep manual values local and discard them across shop/vehicle changes. Hardware legibility remains a separate check from PNG/PDF geometry.
