/**
 * Smoke test for the Protractor webhook async-ack fix.
 *
 * Run: `npx tsx tests/protractor-callback-async-ack.smoke.ts`
 *
 * Background: on 2026-05-13 Protractor's contact reported that
 * webhooks to mos.tools/api/callbacks/protractor were "taking a long
 * time to complete." Root cause was the POST handler doing a
 * SYNCHRONOUS round-trip back to Protractor's own
 * `/workorders/{id}` API (via `fetchWorkOrderById`) before sending
 * its 200. On a high-traffic day at Protractor that single inline
 * fetch could push the webhook ack into the multi-second range,
 * which then caused Protractor to retry, which loaded their API
 * even more — classic feedback loop.
 *
 * The fix factored the enrichment into
 * `enrichOpenWorkOrderInBackground` and made the POST handler
 * fire-and-forget that helper instead of awaiting it.
 *
 * This smoke test is a *static* regression guard: it parses the
 * route source and verifies (a) the helper exists and is async,
 * (b) the POST handler's new/open branch invokes the helper without
 * an `await`, and (c) the legacy synchronous block (which awaited
 * `fetchWorkOrderById` inline) is gone. A static guard is enough
 * here because the failure mode is "someone re-introduces the
 * inline await" — a behavior that is trivially visible in source
 * but hard to catch end-to-end without a full Mongo + Next.js
 * harness.
 */

import * as fs from "fs";
import * as path from "path";

const ROUTE_PATH = path.join(__dirname, "..", "app", "api", "callbacks", "protractor", "route.ts");
const src = fs.readFileSync(ROUTE_PATH, "utf8");

let failed = 0;

function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  \u2713 ${name}`);
  } else {
    failed += 1;
    console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ""}`);
  }
}

console.log("Protractor webhook async-ack smoke test\n");

// ---- 1. The helper exists and is declared async ----
ok(
  "enrichOpenWorkOrderInBackground helper is defined as async",
  /async\s+function\s+enrichOpenWorkOrderInBackground\s*\(/.test(src),
);

// ---- 2. The helper owns its own try/catch ----
const helperMatch = src.match(
  /async\s+function\s+enrichOpenWorkOrderInBackground[\s\S]*?\n\}\n/,
);
ok("helper body parsed", helperMatch !== null);
if (helperMatch) {
  const helperBody = helperMatch[0];
  ok(
    "helper wraps work in try/catch (so background failures cannot leak)",
    /try\s*\{[\s\S]*\}\s*catch/.test(helperBody),
  );
  ok(
    "helper actually performs the Protractor fetch internally",
    /await\s+fetchWorkOrderById\s*\(/.test(helperBody),
  );
}

// ---- 3. Locate the POST handler and inspect its new/open branch ----
const postIdx = src.indexOf("export async function POST(");
ok("POST handler exists", postIdx >= 0);

// Slice from the POST start to the next top-level `export` (GET handler)
const getIdx = src.indexOf("export async function GET(", postIdx + 1);
ok("GET handler exists (used as POST end-marker)", getIdx > postIdx);
const postBody = src.slice(postIdx, getIdx);

// ---- 4. POST must call the background helper WITHOUT await ----
ok(
  "POST invokes enrichOpenWorkOrderInBackground",
  /enrichOpenWorkOrderInBackground\s*\(/.test(postBody),
);

const awaitedCallRe = /await\s+enrichOpenWorkOrderInBackground\s*\(/;
ok(
  "POST does NOT await enrichOpenWorkOrderInBackground (fire-and-forget)",
  !awaitedCallRe.test(postBody),
  "found `await enrichOpenWorkOrderInBackground(...)` in POST — that re-introduces the slow-ack regression",
);

// The fire-and-forget call must attach a .catch so unhandled rejections
// can't crash the Node process.
const fireAndForgetRe =
  /enrichOpenWorkOrderInBackground\s*\([\s\S]*?\)\s*\.catch\s*\(/;
ok(
  "fire-and-forget call has a .catch handler",
  fireAndForgetRe.test(postBody),
  "the background promise must have .catch(...) so a Protractor outage cannot become an unhandledRejection",
);

// The fire-and-forget call must pass `eventId` so the helper updates
// the SPECIFIC event row (by _id) rather than racing with sibling
// events for the same workOrderId.
ok(
  "POST captures eventId from insertOne result",
  /const\s+eventId\s*=\s*insertResult\.insertedId/.test(postBody),
);
ok(
  "POST passes eventId into enrichOpenWorkOrderInBackground",
  /enrichOpenWorkOrderInBackground\s*\(\s*db\s*,\s*shopId\s*,\s*workOrderId\s*,\s*status\s*,\s*eventId\s*\)/.test(
    postBody,
  ),
);

// Helper must update the event by _id, not by {workOrderId,
// processed:false} (which would race across concurrent webhooks for
// the same WO).
if (helperMatch) {
  const helperBody = helperMatch[0];
  ok(
    "helper updates protractor_callback_events by _id (not workOrderId)",
    /\{\s*_id:\s*eventId\s*\}/.test(helperBody) &&
      !/\{\s*workOrderId\s*,\s*processed:\s*false\s*\}/.test(helperBody),
    "helper must scope its updateOne to {_id: eventId} so concurrent webhooks for the same WO can't clobber each other's state",
  );
  ok(
    "helper stamps lastAttemptAt + increments attempts on failure",
    /lastAttemptAt:\s*new Date\(\)/.test(helperBody) &&
      /\$inc:\s*\{\s*attempts:\s*1\s*\}/.test(helperBody),
    "without these the daily cron can't tell a failed background attempt from one that was never tried",
  );
}

// ---- 5. The legacy synchronous block must be gone ----
// Specifically: the POST handler must no longer contain an inline
// `await fetchWorkOrderById(...)` — that is the exact line that was
// blocking the ack. (The helper above is allowed to await it; the
// POST handler is not.)
ok(
  "POST handler no longer contains an inline `await fetchWorkOrderById(...)`",
  !/await\s+fetchWorkOrderById\s*\(/.test(postBody),
  "found `await fetchWorkOrderById(...)` in POST — that is the legacy synchronous enrichment that must run in the background",
);

// Same for the other heavy upstream snapshot upserts that used to live
// inline. They belong in the background helper now.
ok(
  "POST handler no longer awaits upsertProtractorWorkOrderSnapshot inline",
  !/await\s+upsertProtractorWorkOrderSnapshot\s*\(/.test(postBody),
);
ok(
  "POST handler no longer awaits upsertProtractorVehicleSnapshot inline",
  !/await\s+upsertProtractorVehicleSnapshot\s*\(/.test(postBody),
);

// ---- 6. The closed-WO path is preserved (it's all Mongo, fast) ----
ok(
  "POST still handles the closed/terminal-status branch synchronously",
  /if\s*\(\s*isClosed\s*\)\s*\{/.test(postBody),
);
ok(
  "closed-WO branch still updates protractor_work_orders",
  /protractor_work_orders[\s\S]*workflowStage:\s*status/.test(postBody),
);

// ---- 7. Final ack is unconditional and quick ----
ok(
  "POST returns the ack JSON at the bottom of the handler",
  /return\s+NextResponse\.json\s*\(\s*\{[\s\S]*received:\s*true[\s\S]*status:\s*"acknowledged"/.test(
    postBody,
  ),
);

console.log("");
if (failed > 0) {
  console.error(`FAILED: ${failed} assertion(s) failed`);
  process.exit(1);
} else {
  console.log("All assertions passed.");
}
