/**
 * Task #860 — DVI share-link ingestion: plan-finding selection smoke tests.
 *
 * Run: `npm run test:dvi-link-plan-findings`
 *      (or `npx tsx tests/dvi-link-plan-findings.smoke.ts`)
 *
 * Exercises the pure `selectDviLinkFindings` selector (no Mongo):
 *  1. Severity mapping — required → "0" (red), suggested → "1" (yellow);
 *     ok/info items never pass through.
 *  2. Newest report per provider wins; older same-provider reports are
 *     superseded.
 *  3. Reports older than 365 days are ignored.
 *  4. Items are deduped by (case-insensitive) name across providers.
 *  5. Findings carry provider as `source` (becomes the item's dviSource)
 *     and are advisory only — this module exposes no history-anchor fields.
 */
import {
  selectDviLinkFindings,
  type DviReportDocLike,
} from "../lib/dvi-links/plan-findings";

const NOW = Date.parse("2026-07-01T00:00:00Z");

let failures = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function doc(
  provider: string,
  inspectionDate: string,
  items: Array<{ name: string; severity: string; finding?: string }>,
): DviReportDocLike {
  return {
    parsedAt: new Date(inspectionDate),
    report: { provider, inspectionDate, items },
  };
}

console.log("severity mapping:");
{
  const out = selectDviLinkFindings(
    [
      doc("autovitals", "2026-06-01", [
        { name: "Front Brake Pads", severity: "required", finding: "2mm remaining" },
        { name: "Cabin Air Filter", severity: "suggested" },
        { name: "Battery", severity: "ok" },
        { name: "Wipers", severity: "info" },
      ]),
    ],
    NOW,
  );
  check("only required+suggested pass", out.length === 2, `got ${out.length}`);
  const brake = out.find((f) => f.name === "Front Brake Pads");
  const cabin = out.find((f) => f.name === "Cabin Air Filter");
  check('required → status "0"', brake?.status === "0", String(brake?.status));
  check('suggested → status "1"', cabin?.status === "1", String(cabin?.status));
  check("provider carried as source", brake?.source === "autovitals");
  check("finding text carried", brake?.finding === "2mm remaining");
  check(
    "no anchor-like fields exposed",
    out.every((f) => !("performedAt" in f) && !("odometer" in f)),
  );
}

console.log("newest report per provider wins:");
{
  const out = selectDviLinkFindings(
    [
      doc("autovitals", "2026-01-15", [
        { name: "Old Finding", severity: "required" },
      ]),
      doc("autovitals", "2026-06-20", [
        { name: "New Finding", severity: "required" },
      ]),
    ],
    NOW,
  );
  check("one report selected", out.length === 1, `got ${out.length}`);
  check("newer report's finding used", out[0]?.name === "New Finding", out[0]?.name);
}

console.log("stale reports ignored:");
{
  const out = selectDviLinkFindings(
    [
      doc("autoserve1", "2024-05-01", [
        { name: "Ancient Brakes", severity: "required" },
      ]),
    ],
    NOW,
  );
  check("report older than 365d dropped", out.length === 0, `got ${out.length}`);
}

console.log("cross-provider name dedup:");
{
  const out = selectDviLinkFindings(
    [
      doc("autovitals", "2026-06-20", [
        { name: "Engine Air Filter", severity: "required" },
      ]),
      doc("autoserve1", "2026-06-10", [
        { name: "engine air filter", severity: "suggested" },
        { name: "Serpentine Belt", severity: "suggested" },
      ]),
    ],
    NOW,
  );
  check("duplicate name collapsed", out.length === 2, `got ${out.length}`);
  check(
    "both providers can contribute distinct items",
    out.some((f) => f.source === "autovitals") &&
      out.some((f) => f.source === "autoserve1"),
  );
}

console.log("edge cases:");
{
  check("empty docs → []", selectDviLinkFindings([], NOW).length === 0);
  check(
    "doc without report → []",
    selectDviLinkFindings([{ parsedAt: new Date(NOW), report: null }], NOW)
      .length === 0,
  );
  check(
    "nameless item skipped",
    selectDviLinkFindings(
      [doc("autoflow", "2026-06-01", [{ name: "  ", severity: "required" }])],
      NOW,
    ).length === 0,
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll DVI plan-finding checks passed.");
