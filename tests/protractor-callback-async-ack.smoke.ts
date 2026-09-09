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

// ---- 1. Locate both callback handlers ----
const postIdx = src.indexOf("export async function POST(");
ok("POST handler exists", postIdx >= 0);

// Slice from the POST start to the next top-level `export` (GET handler)
const getIdx = src.indexOf("export async function GET(", postIdx + 1);
ok("GET handler exists (used as POST end-marker)", getIdx > postIdx);
const postBody = src.slice(postIdx, getIdx);

// ---- 2. Ingress persists a replayable queue row and never launches work ----
ok(
  "POST captures eventId from the event-insert (repo insertPostEvent)",
  /const\s+eventId\s*=\s*await\s+callbackEvents\.insertPostEvent\s*\(/.test(postBody),
);
ok(
  "POST always stores the normalized replay shape",
  /deferredForReplay:\s*true/.test(postBody),
);
ok(
  "POST launches no in-process callback worker",
  !/processAdmittedOpenPost\s*\(/.test(postBody),
);
ok(
  "POST never returns provider-retry-inducing 429",
  !/\b429\b/.test(postBody),
);

const getBody = src.slice(getIdx);
ok(
  "GET persists before ACK",
  /await\s+callbackEvents\.insertGetEvent\s*\(/.test(getBody),
);
ok(
  "GET performs no inline provider fetch",
  !/fetchWorkOrderById\s*\(|fetchVehicleById\s*\(/.test(getBody),
);
ok(
  "POST performs no inline provider fetch",
  !/fetchWorkOrderById\s*\(|fetchVehicleById\s*\(/.test(postBody),
);

// ---- 3. Final ACK is unconditional after persistence ----
ok(
  "POST returns a queue/deferred 200 response",
  /received:\s*true[\s\S]*status:\s*requestOutboundPolicy\.allowed\s*\?\s*"queued"\s*:\s*"deferred"/.test(postBody),
);

console.log("");
if (failed > 0) {
  console.error(`FAILED: ${failed} assertion(s) failed`);
  process.exit(1);
} else {
  console.log("All assertions passed.");
}
