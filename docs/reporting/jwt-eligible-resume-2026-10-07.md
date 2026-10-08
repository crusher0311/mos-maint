# JWT eligible-first handoff — October 7, 2026

User approved fixing the scheduler and safely resuming eligible shops tonight.
No quiet-hour override, budget increase, or cutoff extension was authorized.

The original Render job was confirmed canceled before preparing the one-use
handoff. Checkpoint: 61 completed windows, page 0; 810 corrected, 293 matching,
618 held. Read-only reconciliation verified all 1,103 non-held outcomes, source
digests for 61 pages, no duplicate results, and no raw-mirror discrepancies.
Consumed requests remain 125 of 1,000. Cutoff remains October 8 at 05:00 Central.

Resume uses the same job and permit, guarded by checkpoint and permit digests,
confirmed termination of the old Render process, and a one-use claim. Pending
windows are selected by current per-shop quiet-hour eligibility; each keeps its
own page checkpoint. Archived pages and recorded outcomes are reused.

Validation: scheduler/handoff tests, existing overnight suite, and TypeScript
typecheck passed. Activation must be verified separately after production build.

## Activation verified

Production release `654f14ddbec8395ff408dc677e46dedf1ee5cbb2` went live.
Replacement Render job `job-db3eiobtqb8s73dm1n5g` started successfully.
At 2026-10-08 00:54:27 UTC (October 7, 7:54 PM Central), the same recovery
record was running on shop 227 / August 5, with 65 of 403 windows completed,
861 corrected, 314 already matching, and 622 held. Requests increased from
125 to 129 of 1,000, with the original 10:00 UTC cutoff unchanged.
Provider logs confirmed a successful invoice GET for shop 227.
