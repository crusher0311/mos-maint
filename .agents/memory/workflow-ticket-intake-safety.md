---
name: Workflow ticket intake safety
description: Authorized ticket scope and recovery boundary for authenticated workflow intake.
---

Authenticated workflow staff may explicitly create or link Protractor tickets.
This does not authorize provider appointment writes, automatic dispatch, repair
authorization, customer messaging or production activation.

**Why:** The user approved check-in, walk-ins, official tickets and advisory
technician offers as the first release, specifically excluding those other actions.

**How to apply:** Keep appointment arrivals, local drafts, temporary MOS holds and
verified official tickets distinct. Check-in alone never releases capacity.
Appointment IDs and work-order GUIDs are separate identities even when examples
happen to contain equal values.

An admitted provider write can outlive an HTTP timeout. Recover the saved exact
identity; never allocate a fresh ticket because a response was lost.

**Why:** Upsert-by-ID avoids duplicate records but replaying an already accepted
write can still overwrite subsequent provider edits. Local-save failure also
does not establish upstream failure.

**How to apply:** Persist intent before I/O, verify stages separately, continue
unattempted stages, and retain uncertain state when exact-ID evidence is
incomplete. Missing/partial records may require upstream operator resolution;
do not imply that a timeout canceled work.
