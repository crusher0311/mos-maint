---
name: Client-safe shared modules
description: Why browser-used helpers must live in modules with an entirely browser-safe import graph.
---

Any runtime helper imported by a client component must live in a module whose complete import graph is browser-safe. Importing only a harmless named export does not prevent the bundler from following the module's other server dependencies.

**Why:** A pure report module also imported a server-side matching chain that eventually reached the MongoDB driver. Reusing currency helpers from that module in a client component made Next.js try to bundle Node built-ins such as `net` and `child_process`.

**How to apply:** Put types and pure formatting/classification helpers needed by client components in a dedicated dependency-free sibling module. Server modules may import or re-export those helpers, but client components must import the browser-safe sibling directly.