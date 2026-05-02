/**
 * Regression smoke test for Task #246 — Create RO multi-concern Protractor send.
 *
 * Run: `npx tsx tests/plan-build-task-246.smoke.ts`
 *
 * Background
 * ----------
 * Task #245 added support for sending multiple customer concerns from the
 * Create RO flow as separate Protractor "Concern" ServicePackage blocks (one
 * per concern, each with Chapter "Concern" and an incrementing Rank). Other
 * callers of `createProtractorWorkOrder` still pass the legacy single
 * `concernText` and rely on it producing exactly one Concern block.
 *
 * What this test locks in
 * -----------------------
 *   1. `concerns: ["A", "B", "C"]` produces three ServicePackages with
 *      Chapter "Concern", Ranks 1/2/3, the original strings as Descriptions,
 *      in the order provided.
 *   2. `concernText: "X"` (no `concerns`) still produces exactly one Concern
 *      ServicePackage (back-compat for legacy callers).
 *   3. When both are provided, `concerns` wins.
 *   4. Empty / whitespace-only entries inside `concerns` are filtered out and
 *     do not create empty Protractor blocks (Rank still increments only over
 *     surviving concerns).
 *   5. The route forwards `concerns` to `createProtractorWorkOrder`, and the
 *     NewWorkOrderModal caller posts the array.
 */

import * as fs from "fs";
import * as path from "path";
import { buildConcernServicePackages } from "../lib/integrations/protractor";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  \u2713 ${name}`);
  } else {
    failed += 1;
    console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ""}`);
  }
}

console.log("Task #246 regression checks");

// ---------------------------------------------------------------------------
// 1. Multi-concern array → one ServicePackage per concern, ranks 1..N
// ---------------------------------------------------------------------------
const multi = buildConcernServicePackages({ concerns: ["A", "B", "C"] });
ok(
  "multi-concern produces exactly 3 ServicePackages",
  multi.length === 3,
  `got ${multi.length}`,
);
ok(
  "multi-concern: every block has Chapter \"Concern\"",
  multi.every((p) => p.Chapter === "Concern"),
);
ok(
  "multi-concern: ranks are 1, 2, 3 in order",
  JSON.stringify(multi.map((p) => p.Rank)) === JSON.stringify([1, 2, 3]),
  `got ${JSON.stringify(multi.map((p) => p.Rank))}`,
);
ok(
  "multi-concern: descriptions preserve order and content",
  JSON.stringify(multi.map((p) => p.ServicePackageHeader.Description)) ===
    JSON.stringify(["A", "B", "C"]),
);
ok(
  "multi-concern: header title is the Customer Concern Assistant",
  multi.every((p) => p.ServicePackageHeader.Title === "Customer Concern Assistant"),
);
ok(
  "multi-concern: each block has an empty ServicePackageLines.ItemCollection",
  multi.every(
    (p) =>
      p.ServicePackageLines &&
      Array.isArray(p.ServicePackageLines.ItemCollection) &&
      p.ServicePackageLines.ItemCollection.length === 0,
  ),
);
ok(
  "multi-concern: every block has a unique ID",
  new Set(multi.map((p) => p.ID)).size === multi.length,
);

// ---------------------------------------------------------------------------
// 2. Legacy single concernText still works (back-compat)
// ---------------------------------------------------------------------------
const legacy = buildConcernServicePackages({ concernText: "X" });
ok(
  "concernText alone produces exactly 1 ServicePackage",
  legacy.length === 1,
  `got ${legacy.length}`,
);
ok(
  "concernText: single block uses Chapter \"Concern\", Rank 1, Description \"X\"",
  legacy[0]?.Chapter === "Concern" &&
    legacy[0]?.Rank === 1 &&
    legacy[0]?.ServicePackageHeader.Description === "X",
);

// Whitespace-only concernText must be treated as "no concern" (no empty blocks).
const blankLegacy = buildConcernServicePackages({ concernText: "   \n  " });
ok(
  "whitespace-only concernText produces zero ServicePackages",
  blankLegacy.length === 0,
);

// No inputs at all → no concern blocks (so the WO is created without
// ServicePackages.ItemCollection containing empty Concern entries).
const none = buildConcernServicePackages({});
ok("no concern inputs produces zero ServicePackages", none.length === 0);

// ---------------------------------------------------------------------------
// 3. When both are provided, `concerns` wins
// ---------------------------------------------------------------------------
const both = buildConcernServicePackages({
  concerns: ["first", "second"],
  concernText: "ignored legacy text",
});
ok(
  "both inputs: concerns array is used (not concernText)",
  both.length === 2 &&
    both[0]?.ServicePackageHeader.Description === "first" &&
    both[1]?.ServicePackageHeader.Description === "second",
  `got ${JSON.stringify(both.map((p) => p.ServicePackageHeader.Description))}`,
);
ok(
  "both inputs: legacy concernText does not leak in as an extra block",
  !both.some((p) => p.ServicePackageHeader.Description === "ignored legacy text"),
);

// An empty `concerns` array should NOT win — it should fall back to concernText.
const emptyArrayFallback = buildConcernServicePackages({
  concerns: [],
  concernText: "fallback",
});
ok(
  "empty concerns array falls back to concernText",
  emptyArrayFallback.length === 1 &&
    emptyArrayFallback[0]?.ServicePackageHeader.Description === "fallback",
);

// ---------------------------------------------------------------------------
// 4. Empty / whitespace-only entries inside `concerns` are filtered out
// ---------------------------------------------------------------------------
const filtered = buildConcernServicePackages({
  concerns: ["A", "", "  ", "  B  ", "\t\n", "C"],
});
ok(
  "whitespace/empty entries filtered out (3 survive, not 6)",
  filtered.length === 3,
  `got ${filtered.length}`,
);
ok(
  "filtered descriptions are trimmed and ordered A, B, C",
  JSON.stringify(filtered.map((p) => p.ServicePackageHeader.Description)) ===
    JSON.stringify(["A", "B", "C"]),
  `got ${JSON.stringify(filtered.map((p) => p.ServicePackageHeader.Description))}`,
);
ok(
  "ranks increment only over surviving concerns (1, 2, 3 — not skipping)",
  JSON.stringify(filtered.map((p) => p.Rank)) === JSON.stringify([1, 2, 3]),
  `got ${JSON.stringify(filtered.map((p) => p.Rank))}`,
);

// All-blank concerns → zero blocks (and no fallback to concernText, because
// the array was non-empty as provided — matches the wired behavior).
const allBlank = buildConcernServicePackages({
  concerns: ["", "  ", "\n"],
  concernText: "should-not-appear",
});
ok(
  "all-blank concerns array yields zero blocks (does not fall back to concernText)",
  allBlank.length === 0,
);

// ---------------------------------------------------------------------------
// 5. Wiring: the route forwards `concerns`, the modal posts the array
// ---------------------------------------------------------------------------
const routeSrc = fs.readFileSync(
  path.join(
    __dirname,
    "..",
    "app",
    "api",
    "dashboard",
    "protractor",
    "create-work-order",
    "route.ts",
  ),
  "utf8",
);
ok(
  "route destructures `concerns` from the request body",
  /\bconcerns\b/.test(routeSrc) &&
    /const\s*\{[^}]*\bconcerns\b[^}]*\}\s*=\s*body/.test(routeSrc),
);
ok(
  "route forwards `concerns` into createProtractorWorkOrder",
  /createProtractorWorkOrder\([\s\S]*concerns\s*:/.test(routeSrc),
);

const modalSrc = fs.readFileSync(
  path.join(__dirname, "..", "components", "NewWorkOrderModal.tsx"),
  "utf8",
);
ok(
  "NewWorkOrderModal posts a `concerns` array to the create route",
  /concerns\s*:\s*concerns\.length\s*>\s*0\s*\?\s*concerns\s*:\s*undefined/.test(
    modalSrc,
  ),
);

if (failed === 0) {
  console.log("\nAll Task #246 regression checks passed.");
  process.exit(0);
} else {
  console.error(`\n${failed} Task #246 regression check(s) failed.`);
  process.exit(1);
}
