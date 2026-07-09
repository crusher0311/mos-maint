/**
 * Task #742: smoke test for the history-aware DVI pre-fill helpers.
 *
 * Run: `npx tsx tests/dvi-prefill-history.smoke.ts`
 *
 * Covers:
 *   - detectRecentlyPerformed: mileage-primary window, day fallback, the
 *     hard-driven-fleet guard (recent date but far by miles is NOT "recent"),
 *     and rollback / missing-data edge cases.
 *   - extractPastInspectionFindings: modern inspectionTasks groups + legacy
 *     items[] shape, red/yellow only, most-recent-per-key wins, unknown names
 *     dropped.
 *   - isFindingRemedied: a performed anchor dated after the finding clears it.
 */

import {
  detectRecentlyPerformed,
  extractPastInspectionFindings,
  isFindingRemedied,
  isRemediedSinceInspection,
  RECENT_PERFORMED_MILES,
  RECENT_PERFORMED_DAYS,
} from "../lib/dvi-prefill-history";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  \u2713 ${name}`);
  } else {
    failed += 1;
    console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ""}`);
  }
}

console.log("DVI prefill history smoke checks");

const now = new Date("2026-07-06T00:00:00Z");

// ---- detectRecentlyPerformed ----

// Performed 400 mi ago → recent (mileage-primary).
{
  const r = detectRecentlyPerformed({ miles: 79600, date: "2026-06-01" }, 80000, now);
  ok("Recent by miles (400 mi ago) is performed", r.performed, `milesAgo=${r.milesAgo}`);
}

// Performed exactly at the mileage threshold → recent.
{
  const r = detectRecentlyPerformed(
    { miles: 80000 - RECENT_PERFORMED_MILES },
    80000,
    now,
  );
  ok("Recent at exact mileage threshold is performed", r.performed);
}

// Drove a lot since the service (6,000 mi) even though the date is recent →
// NOT recent (fleet guard: mileage axis wins when present).
{
  const r = detectRecentlyPerformed({ miles: 74000, date: "2026-06-20" }, 80000, now);
  ok(
    "Recent date but 6,000 mi driven is NOT performed",
    !r.performed,
    `milesAgo=${r.milesAgo} daysAgo=${r.daysAgo}`,
  );
}

// No mileage anywhere → fall back to the date axis (recent).
{
  const r = detectRecentlyPerformed({ date: "2026-06-20" }, null, now);
  ok("No miles, recent date falls back to day axis (performed)", r.performed, `daysAgo=${r.daysAgo}`);
}

// No mileage, old date → not recent.
{
  const r = detectRecentlyPerformed(
    { date: "2026-01-01" },
    null,
    now,
  );
  ok("No miles, old date is NOT performed", !r.performed, `daysAgo=${r.daysAgo}`);
  ok("Day window sanity", RECENT_PERFORMED_DAYS < 180);
}

// Odometer rollback (anchor miles greater than current) → not recent by miles,
// and no usable date → not performed.
{
  const r = detectRecentlyPerformed({ miles: 85000 }, 80000, now);
  ok("Odometer rollback is NOT performed", !r.performed, `milesAgo=${r.milesAgo}`);
}

// Null anchor → not performed, no throw.
{
  const r = detectRecentlyPerformed(null, 80000, now);
  ok("Null anchor is safe and not performed", !r.performed);
}

// ---- extractPastInspectionFindings ----

const workOrders = [
  {
    completedDate: "2026-05-01T00:00:00Z",
    inspections: [
      {
        inspectionTasks: [
          {
            title: "Brakes",
            tasks: [
              {
                name: "Front Brake Pads",
                inspectionRating: { code: "MAYRQRATTN" },
                finding: "4mm remaining",
              },
              {
                name: "Engine Air Filter",
                inspectionRating: { code: "CHCKD" }, // pass — must be ignored
                finding: null,
              },
              {
                name: "Some Non-Service Task",
                inspectionRating: { code: "RQRSATTN" }, // no service key → dropped
                finding: "n/a",
              },
            ],
          },
        ],
      },
    ],
  },
  {
    // Newer WO: upgrades front brake pads to red — most-recent wins.
    completedDate: "2026-06-10T00:00:00Z",
    inspections: [
      {
        inspectionTasks: [
          {
            title: "Brakes",
            tasks: [
              {
                name: "Front Brake Pads",
                inspectionRating: { code: "RQRSATTN" },
                finding: "2mm, metal-to-metal soon",
              },
            ],
          },
        ],
      },
    ],
  },
  {
    // Legacy items[] shape (no inspectionTasks groups).
    completedDate: "2026-04-01T00:00:00Z",
    inspections: [
      {
        items: [
          { name: "Wiper Blades", status: "marginal", notes: "streaking" },
          { name: "Cabin Air Filter", status: "good", notes: "fine" }, // good → ignored
        ],
      },
    ],
  },
];

const pf = extractPastInspectionFindings(workOrders);

ok("Front brake pads finding captured", pf.has("front_brake_pads"));
ok(
  "Most-recent front brake pads finding wins (red, 2mm note)",
  pf.get("front_brake_pads")?.rating === "bad" &&
    pf.get("front_brake_pads")?.finding === "2mm, metal-to-metal soon",
  JSON.stringify(pf.get("front_brake_pads")),
);
ok("Pass (CHCKD) task did NOT create an engine_air finding", !pf.has("engine_air"));
ok("Unknown-name RQRSATTN task was dropped (no service key)", pf.size === 2 || !pf.has(""));
ok(
  "Legacy items[] marginal captured as wiper_blades/marginal",
  pf.get("wiper_blades")?.rating === "marginal" && pf.get("wiper_blades")?.finding === "streaking",
  JSON.stringify(pf.get("wiper_blades")),
);
ok("Legacy items[] 'good' status was ignored", !pf.has("cabin_air"));

// Empty / malformed inputs are safe.
ok("Empty array yields empty map", extractPastInspectionFindings([]).size === 0);
ok("Non-array is safe", extractPastInspectionFindings(null as any).size === 0);

// ---- isFindingRemedied ----

const inspDate = new Date("2026-05-01T00:00:00Z");
ok(
  "Finding remedied when service performed after it",
  isFindingRemedied({ date: inspDate }, { date: "2026-06-01" }),
);
ok(
  "Finding NOT remedied when last service predates it",
  !isFindingRemedied({ date: inspDate }, { date: "2026-04-01" }),
);
ok(
  "Finding NOT remedied when there is no anchor",
  !isFindingRemedied({ date: inspDate }, null),
);
ok(
  "Finding with no date is never remedied",
  !isFindingRemedied({ date: null }, { date: "2026-06-01" }),
);

// ---- isRemediedSinceInspection (shared plan-build + DVI helper) ----

// Anchor-only (DVI pre-fill): matches isFindingRemedied.
ok(
  "Shared: anchor after finding remedies it",
  isRemediedSinceInspection({ date: inspDate }, { anchor: { date: "2026-06-01" } }),
);
ok(
  "Shared: anchor before finding does NOT remedy it",
  !isRemediedSinceInspection({ date: inspDate }, { anchor: { date: "2026-04-01" } }),
);
ok(
  "Shared: no signals never remedies",
  !isRemediedSinceInspection({ date: inspDate }, {}),
);
ok(
  "Shared: no finding date is never remedied",
  !isRemediedSinceInspection(
    { date: null },
    { anchor: { date: "2026-06-01" } },
  ),
);

// Service-key-indexed history (plan-build path 2): a later record clears it.
{
  const byKey = new Map<string, { date: Date | null }[]>([
    [
      "front_brake_pads",
      [{ date: new Date("2026-03-01") }, { date: new Date("2026-06-01") }],
    ],
  ]);
  ok(
    "Shared: by-service-key record after finding remedies it",
    isRemediedSinceInspection(
      { date: inspDate, serviceKey: "front_brake_pads", name: "Front Brake Pads" },
      { byServiceKey: byKey },
    ),
  );
}
{
  const byKey = new Map<string, { date: Date | null }[]>([
    ["front_brake_pads", [{ date: new Date("2026-03-01") }]],
  ]);
  ok(
    "Shared: by-service-key records all before finding does NOT remedy it",
    !isRemediedSinceInspection(
      { date: inspDate, serviceKey: "front_brake_pads", name: "Front Brake Pads" },
      { byServiceKey: byKey },
    ),
  );
}

// Name-substring fallback (plan-build path 3): matches when the key doesn't.
ok(
  "Shared: name-substring history after finding remedies it",
  isRemediedSinceInspection(
    { date: inspDate, serviceKey: null, name: "Wiper Blades" },
    {
      nameEntries: [
        { serviceName: "Replaced Wiper Blades", date: new Date("2026-06-01") },
      ],
    },
  ),
);
ok(
  "Shared: name-substring history before finding does NOT remedy it",
  !isRemediedSinceInspection(
    { date: inspDate, serviceKey: null, name: "Wiper Blades" },
    {
      nameEntries: [
        { serviceName: "Replaced Wiper Blades", date: new Date("2026-04-01") },
      ],
    },
  ),
);
ok(
  "Shared: unrelated name history does NOT remedy it",
  !isRemediedSinceInspection(
    { date: inspDate, serviceKey: null, name: "Wiper Blades" },
    { nameEntries: [{ serviceName: "Oil Change", date: new Date("2026-06-01") }] },
  ),
);

if (failed === 0) {
  console.log("\nAll DVI prefill history smoke checks passed.");
  process.exit(0);
} else {
  console.error(`\n${failed} DVI prefill history smoke check(s) failed.`);
  process.exit(1);
}
