---
name: Resume-file repair verification
description: Why resumable batch repairs can falsely report "done" and how to verify them
---
Rule: a resumable batch repair (--resume-file) that restarts mid-shop only scans FORWARD from the resume point; a later "done, updated=0" pass proves nothing about rows behind the marker. Any environment restart that trims the shop out of the lane script can also strand resolvable rows.

**Why:** during the Protractor Unknown-Service title repair (July 2026), ~12 shops verified "done" still had thousands of resolvable rows (e.g. one shop showed 7k residual vs ~500 expected) because restarts left rows behind resume markers.

**How to apply:** after any resumable fleet repair, verify per-shop residual counts against the run's own no-title-source/unresolvable tallies; where residual > final-pass unresolvable, DELETE the resume file and rerun that shop (idempotent). Only accept when residual == unresolvable. Per-shop count queries, not fleet-wide GROUP BY (2-min PG statement timeout).
