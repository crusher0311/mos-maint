---
name: Sticker label inheritance
description: Why saved legacy label text is preserved rather than migrated.
---
New sticker layouts should inherit the global Service Label, with “Next Oil Service” as the intended default wording. Do not automatically clear saved “Next Service Due” element overrides.

**Why:** A saved old default is indistinguishable from a shop intentionally choosing that exact wording. Preserving shop customization is safer than guessing intent.

**How to apply:** Change fresh-layout defaults without rewriting persisted element content. Any future migration of legacy overrides needs an explicit user choice.
