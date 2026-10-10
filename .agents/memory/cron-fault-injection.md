---
name: Cron network fault injection
description: PostgreSQL driver protocol sequencing matters when simulating lost commit acknowledgments.
---

When testing lost PostgreSQL write acknowledgments, allow the parameter-description exchange before withholding execution results.

**Why:** postgres-js `unsafe()` describes parameterized statements before sending Execute. Blackholing every response after connection warmup prevents the write from being sent, so it does not establish an ambiguous committed outcome.

**How to apply:** Use an independent connection to prove the write committed before cutting the faulted connection; do not infer commit from elapsed time or intercepted bytes alone. Use disposable services only.
