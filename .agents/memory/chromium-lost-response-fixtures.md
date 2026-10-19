---
name: Chromium lost-response fixtures
description: Avoid transparent browser retries when simulating ambiguous write acknowledgments.
---

For offline browser tests of an admitted write with a lost acknowledgment, send
response headers and a partial body before cutting the connection.

**Why:** Chromium can transparently retry when a socket closes before any response
bytes arrive, even when the fixture has received the POST. That simulates a
different failure boundary and can falsely attribute a duplicate to application
retry logic.

**How to apply:** Declare a larger Content-Length than the partial JSON response,
flush some response bytes, then destroy the response. Count received requests
and assert persisted identity before returning any acknowledgment.
