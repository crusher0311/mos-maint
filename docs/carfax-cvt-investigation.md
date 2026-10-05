# CARFAX CVT credit investigation

## Evidence available

The incident attachment reports “Transmission Fluid Changed” at 46,615 miles
and an overdue CVT-fluid recommendation. It does not establish a reliable VIN,
shop identifier, current odometer, service date, or applicable mileage/time
interval. Do not infer those values from the small embedded screenshot.

## Offline result

`tests/plan-build-carfax-cvt.smoke.ts` exercises the actual CARFAX payload
parser, OEM key resolution, shared triage and cache serialization. Both
display-record and category inputs credit the service at 46,615 miles.
Mixed changed/checked records retain the replacement credit; checked-only
records, differential services and transfer-case services do not credit CVT.
Same-visit shop history retains source precedence.

Synthetic example (not the incident vehicle): service on March 1, 2025,
30,000-mile/24-month interval gives next due at 76,615 miles or March 1, 2027.
The test verifies an upcoming result at 60,000 miles in January 2026,
overdue at 80,000 miles, and overdue by time in April 2027.

No missing synonym or lost anchor was reproduced in shared triage. The
extension-specific reproduction below subsequently identified the failing path.

## Confirmed incident evidence

After the user supplied the VIN, bounded read-only queries located the
existing report and both cache representations. No paid report was requested:

- CARFAX replacement: April 1, 2026, 46,615 miles, with the exact phrase
  “Transmission fluid changed”; category “Transmission fluid exchange”.
- Cached current mileage: 57,387.
- Shared plan: automatic transmission fluid upcoming, anchored to a later
  shop service at 46,640 miles.
- Detect Dog analysis: “Replace CVT fluid.” had `serviceKey: null`,
  unknown last-performed, a 24,855-mile interval, and overdue by 32,532 miles.
  “Inspect CVT fluid.” likewise had no key.

The lost credit is in the extension route's independent regex mapper, not
CARFAX normalization or the shared synonym dictionary. Its patterns recognized
“Transmission fluid changed” but not the OEM title “Replace CVT fluid.”
With CARFAX alone, the replacement's next mileage is 71,470 (46,615 + 24,855),
so at the cached current mileage it is not overdue by mileage. A newer
qualifying shop service may legitimately supersede that CARFAX anchor.

Do not treat an extension text-search match as evidence of interval anchoring.
The extension also has a legacy analysis path distinct from shared triage.

## Refresh safety

The correction recognizes CVT fluid/service wording in the extension's mapper,
while keeping manual/DCT history separate and rejecting checked-only credit.
An affected cached analysis with an unresolved CVT service key is now treated
as stale by the existing rebuild condition. This is targeted detection, not a
fleet-wide cache deletion or global schema bump. An explicit extension refresh
also uses the corrected analyzer. Resolved CVT rows do not keep triggering
this targeted stale check.

`npm run test:extension-plan-cvt` includes actual on-demand analyzer execution
with fake dependencies: 46,615 + 24,855 = 71,470, upcoming at 57,387 and overdue
at 72,000, plus date-only intervals, inspection/type safety, and cache-rebuild
wiring. Existing shared-triage and CARFAX cache smoke tests also pass.

`POST /api/plan-build` returns an existing valid plan before computing. Its
`skipCarfax=1` option prevents both live and background paid CARFAX calls but
does not itself invalidate a valid plan.

The extension's `refresh=true` bypasses its plan-cache read, but its legacy
analysis path calls `fetchCarfaxWithCache`, which may make a paid request.
It is **not** an unconditional cache-only recovery procedure.

After evidence and separate operator approval, use targeted shop/VIN plan
invalidation followed by a rebuild with `skipCarfax=1`, preserving the existing
CARFAX snapshot. Confirm refreshed output and client state for that vehicle.
No invalidation or rebuild was executed during this investigation. Code
verification uses isolated fixtures; live recovery remains operator-only.

## Separate boundary finding

A negative fixture using “Manual transmission fluid replaced” unexpectedly
credits `trans_auto` through `findImpliesResetMatches`' generic transmission
replacement rule. This is a false-positive type-isolation issue, not evidence
of why the reported automatic/CVT service appears overdue. It remains
unmodified pending the incident investigation; any fix needs dedicated
manual/DCT/automatic mixed-record tests.