/**
 * Task #860 — DVI share-link ingestion: parser + link-extraction smoke tests.
 *
 * Run: `npm run test:dvi-link-parsers` (or `npx tsx tests/dvi-link-parsers.smoke.ts`)
 *
 * Covers:
 *  1. extractDviLinks — classifies AutoServe1 / AutoVitals (avlink.io) /
 *     AutoFlow microsite / MasterTech / AutoOps URLs found anywhere in an
 *     arbitrary object, ignores unrelated URLs, and strips trailing
 *     punctuation.
 *  2. Each HTML parser against a real captured fixture: item counts,
 *     severity buckets (required/suggested/ok), and metadata (VIN, RO#,
 *     odometer) where the page carries them.
 *
 * Fixtures in tests/fixtures/dvi-links/ are real public report pages
 * (AutoServe1's was captured via the Wayback Machine — its rewritten
 * web.archive.org URL prefixes are stripped before parsing).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractDviLinks } from "../lib/dvi-links/extract";
import { parseAutoVitalsReport } from "../lib/dvi-links/parsers/autovitals";
import { parseAutoServe1Report } from "../lib/dvi-links/parsers/autoserve1";
import { parseAutoFlowMicrosite } from "../lib/dvi-links/parsers/autoflow";

const FIXTURES = join(__dirname, "fixtures", "dvi-links");

let failures = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// 1. Link extraction / classification
// ---------------------------------------------------------------------------
console.log("extractDviLinks:");
{
  const links = extractDviLinks({
    note:
      "Report: https://app.autoserve1.com/report/abcDEF12345. " +
      "Also https://avlink.io/xYz, " +
      "https://gtm-x.autotext.me/Admin/microsite/?id=Zm9v " +
      "and https://aops.cc/QQ and " +
      "https://app.mastertech.ai/vin/1FTBR1C85MKA73249 " +
      "but not https://example.com/nothing",
  });
  const byProvider = new Map(links.map((l) => [l.provider, l.url]));
  check("finds 5 links", links.length === 5, `got ${links.length}`);
  check(
    "autoserve1 classified + trailing dot stripped",
    byProvider.get("autoserve1") ===
      "https://app.autoserve1.com/report/abcDEF12345",
    byProvider.get("autoserve1"),
  );
  check(
    "autovitals classified + trailing comma stripped",
    byProvider.get("autovitals") === "https://avlink.io/xYz",
    byProvider.get("autovitals"),
  );
  check(
    "autoflow microsite classified",
    byProvider.get("autoflow") ===
      "https://gtm-x.autotext.me/Admin/microsite/?id=Zm9v",
    byProvider.get("autoflow"),
  );
  check("autoops classified", byProvider.get("autoops") === "https://aops.cc/QQ");
  check(
    "mastertech classified",
    byProvider.get("mastertech") ===
      "https://app.mastertech.ai/vin/1FTBR1C85MKA73249",
  );
  check(
    "unrelated URL ignored",
    !links.some((l) => l.url.includes("example.com")),
  );

  const dupes = extractDviLinks({
    a: "https://avlink.io/xYz",
    b: { c: "see https://avlink.io/xYz again" },
  });
  check("duplicate URLs deduped", dupes.length === 1, `got ${dupes.length}`);
}

// ---------------------------------------------------------------------------
// 2. AutoVitals (avlink.io) parser
// ---------------------------------------------------------------------------
console.log("parseAutoVitalsReport:");
{
  const html = readFileSync(join(FIXTURES, "autovitals-page.html"), "utf8");
  const res = parseAutoVitalsReport(html, "https://avlink.io/fixture");
  check("parses ok", res.ok, res.ok ? undefined : res.error ?? "no error");
  if (res.ok && res.report) {
    const r = res.report;
    check("has items", r.items.length >= 20, `got ${r.items.length}`);
    check(
      "severity buckets populated",
      r.counts.required > 0 && r.counts.ok > 0,
      JSON.stringify(r.counts),
    );
    check("VIN extracted", typeof r.vin === "string" && r.vin!.length === 17, r.vin ?? "null");
    check("RO number extracted", !!r.roNumber, String(r.roNumber));
    check(
      "counts match items",
      r.counts.required + r.counts.suggested + r.counts.ok + r.counts.info ===
        r.items.length,
    );
    check(
      "every item has a name",
      r.items.every((i) => i.name && i.name.trim().length > 0),
    );
  }
}

// ---------------------------------------------------------------------------
// 3. AutoServe1 parser (fixture captured via Wayback — strip its URL rewrites)
// ---------------------------------------------------------------------------
console.log("parseAutoServe1Report:");
{
  const html = readFileSync(join(FIXTURES, "autoserve1-page.html"), "utf8")
    .replace(/https?:\/\/web\.archive\.org\/web\/\d+(?:js_|im_|cs_)?\//g, "");
  const res = parseAutoServe1Report(html, "https://app.autoserve1.com/report/fixture");
  check("parses ok", res.ok, res.ok ? undefined : res.error ?? "no error");
  if (res.ok && res.report) {
    const r = res.report;
    check("has items", r.items.length >= 20, `got ${r.items.length}`);
    check(
      "has required findings",
      r.counts.required > 0,
      JSON.stringify(r.counts),
    );
    check(
      "required items carry findings text",
      r.items
        .filter((i) => i.severity === "required")
        .every((i) => (i.finding ?? i.notes ?? "").length > 0 || i.name.length > 0),
    );
  }
}

// ---------------------------------------------------------------------------
// 4. AutoFlow microsite parser
// ---------------------------------------------------------------------------
console.log("parseAutoFlowMicrosite:");
{
  const html = readFileSync(join(FIXTURES, "autoflow-microsite.html"), "utf8");
  const res = parseAutoFlowMicrosite(
    html,
    "https://gtm-murrayville.autotext.me/Admin/microsite/?id=fixture",
  );
  check("parses ok", res.ok, res.ok ? undefined : res.error ?? "no error");
  if (res.ok && res.report) {
    const r = res.report;
    check("has items", r.items.length >= 20, `got ${r.items.length}`);
    check("VIN extracted", typeof r.vin === "string" && r.vin!.length === 17, r.vin ?? "null");
    check("RO number extracted", !!r.roNumber, String(r.roNumber));
    check(
      "non-ok findings present",
      r.items.some((i) => i.severity === "required" || i.severity === "suggested"),
      JSON.stringify(r.counts),
    );
  }
}

// ---------------------------------------------------------------------------
if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll DVI link parser checks passed.");
