import { isAutoflowHistoryActive } from "../lib/dashboard/autoflow-classification";

let failed = 0;
function ok(name: string, condition: boolean) {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}`);
  }
}

console.log("autoflow dashboard classification smoke");

const mapping = {
  active: ["Checkin", "Servicing"],
  closed: ["Close"],
  excluded: ["Appointment"],
};

ok(
  "case and harmless whitespace normalization keeps active statuses visible",
  isAutoflowHistoryActive(
    [{ status: "  CHECKIN ", occurredAt: "2026-09-17T12:00:00Z" }],
    mapping,
  ),
);
ok(
  "unknown statuses fail closed",
  !isAutoflowHistoryActive(
    [{ status: "Warranty Claim", occurredAt: "2026-09-17T12:00:00Z" }],
    mapping,
  ),
);
ok(
  "an appointment suppresses an older active event",
  !isAutoflowHistoryActive(
    [
      { status: "Servicing", occurredAt: "2026-09-17T12:00:00Z" },
      { status: "Appointment", occurredAt: "2026-09-17T13:00:00Z" },
    ],
    mapping,
  ),
);
ok(
  "a later active event reopens after close or exclusion",
  isAutoflowHistoryActive(
    [
      { status: "Servicing", occurredAt: "2026-09-17T12:00:00Z" },
      { status: "Close", occurredAt: "2026-09-17T13:00:00Z" },
      { status: "Appointment", occurredAt: "2026-09-17T14:00:00Z" },
      { status: "Servicing", occurredAt: "2026-09-17T15:00:00Z" },
    ],
    mapping,
  ),
);
ok(
  "legacy defaults still recognize the six original active statuses",
  isAutoflowHistoryActive([
    { status: "checked   in", occurredAt: "2026-09-17T12:00:00Z" },
  ]),
);

if (failed > 0) process.exitCode = 1;