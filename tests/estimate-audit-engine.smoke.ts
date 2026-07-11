/**
 * Unit tests for the Estimate Assist audit engine's static rules and score
 * math (`lib/estimate-assist/audit-engine.ts`), extracted from the audit
 * route so they run without auth / Mongo / OpenAI.
 *
 * Run: `npx tsx tests/estimate-audit-engine.smoke.ts`
 *
 * Covers:
 *  - Missing-parts rule on labor-heavy jobs (and its diagnostic exemptions,
 *    including the regex-based detection edge cases)
 *  - Missing-labor rule on parts-only lines
 *  - Labor-hour range checks (low = min*0.5, high = max*1.5, in-range silent)
 *  - Companion-service suggestions (safety companions, brake-flush and
 *    timing-belt/water-pump heuristics, no duplicate suggestions)
 *  - Description-quality rule
 *  - Dedupe (category+title) and severity/confidence sort
 *  - Score calculation (100 − 15c − 5w − 1i, clamped to [0, 100])
 */
import {
  AuditFinding,
  AuditLineItem,
  runStaticAuditRules,
  dedupeAndSortFindings,
  summarizeFindings,
  isDiagnosticLine,
} from "../lib/estimate-assist/audit-engine";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function byCategory(findings: AuditFinding[], category: string): AuditFinding[] {
  return findings.filter(f => f.category === category);
}

// A line item that triggers NO rules: KB-matched, in-range hours, has parts,
// has labor, has a long description.
const CLEAN_OIL_CHANGE: AuditLineItem = {
  title: "Oil Change - Full Synthetic",
  description: "Drain engine oil, replace filter, refill with full synthetic oil.",
  laborHours: 0.4,
  laborTotal: 60,
  partsTotal: 45,
  total: 105,
};

console.log("estimate audit engine static rules");

// ---------------------------------------------------------------- missing parts
{
  console.log("\nMissing Parts rule:");
  const findings = runStaticAuditRules([
    {
      title: "Front Brake Pad Replacement",
      description: "Replace the front pads and inspect rotors for wear",
      laborTotal: 180,
      partsTotal: 0,
      laborHours: 1.0,
    },
  ]);
  const mp = byCategory(findings, "Missing Parts");
  ok("labor-only KB-matched job → critical Missing Parts finding", mp.length === 1);
  ok("  → severity critical", mp[0]?.severity === "critical");
  ok(
    "  → suggests the KB job's required parts",
    !!mp[0]?.description.includes("Front Brake Pads"),
    mp[0]?.description,
  );
  ok("  → carries lineItemIndex", mp[0]?.lineItemIndex === 0);

  // Explicit type-based exemptions
  for (const type of ["diagnostic", "inspection"]) {
    const f = runStaticAuditRules([
      { title: "Front Brake Pad Replacement", description: "long enough description here", laborTotal: 150, type },
    ]);
    ok(`type="${type}" is exempt from Missing Parts`, byCategory(f, "Missing Parts").length === 0);
  }

  // Regex-based exemptions: the title itself signals diagnostic work
  for (const title of [
    "Brake System Inspection",
    "Check Engine Light Diagnostic",
    "Coolant System Pressure Test",
    "Full Vehicle Scan",
    "Check brakes",
  ]) {
    const f = runStaticAuditRules([{ title, description: "long enough description here", laborTotal: 120 }]);
    ok(`title "${title}" is regex-exempt from Missing Parts`, byCategory(f, "Missing Parts").length === 0);
  }

  // Regex edge case the pattern does NOT cover: "Diag" shorthand isn't
  // matched by /diagnostic|inspection|check|test|scan/ — so a labor-only
  // "Brake Diag" line that fuzzy-matches a KB job WITH parts still fires.
  // Locks in current behavior so a regex change is a conscious decision.
  ok(
    'shorthand "Brake Pad Diag" is NOT exempt (regex misses "diag")',
    !isDiagnosticLine({ title: "Brake Pad Diag", laborTotal: 100 }),
  );

  // Zero/absent labor → rule requires laborTotal > 0
  const noLabor = runStaticAuditRules([
    { title: "Front Brake Pad Replacement", description: "long enough description here", laborTotal: 0, partsTotal: 0 },
  ]);
  ok("laborTotal=0 does not fire Missing Parts", byCategory(noLabor, "Missing Parts").length === 0);

  // KB job with NO required parts (e.g. alignment) must not fire
  const alignment = runStaticAuditRules([
    { title: "Four-Wheel Alignment", description: "long enough description here", laborTotal: 110, laborHours: 1.0 },
  ]);
  ok(
    "KB job with no required parts (alignment) does not fire Missing Parts",
    byCategory(alignment, "Missing Parts").length === 0,
  );
}

// ---------------------------------------------------------------- missing labor
{
  console.log("\nMissing Labor rule:");
  const findings = runStaticAuditRules([
    {
      title: "Front Brake Pad Replacement",
      description: "long enough description here",
      partsTotal: 89,
      laborTotal: 0,
    },
  ]);
  const ml = byCategory(findings, "Missing Labor");
  ok("parts-only line → warning Missing Labor finding", ml.length === 1);
  ok("  → severity warning", ml[0]?.severity === "warning");
  ok(
    "  → suggests the KB typical hours",
    !!ml[0]?.suggestedAction?.includes("1 hours"),
    ml[0]?.suggestedAction,
  );

  // No KB match → generic suggestion, finding still fires
  const noKb = runStaticAuditRules([
    { title: "zzzz unmatchable widget qqqq", description: "long enough description here", partsTotal: 50 },
  ]);
  const mlNoKb = byCategory(noKb, "Missing Labor");
  ok("parts-only with no KB match still fires with generic action", mlNoKb.length === 1);
  ok(
    "  → generic suggested action",
    mlNoKb[0]?.suggestedAction === "Add appropriate labor time",
    mlNoKb[0]?.suggestedAction,
  );
}

// ---------------------------------------------------------------- labor hours range
{
  console.log("\nLabor Hours range rule:");
  // Front pads KB: min 0.8, max 1.5. Low threshold = 0.4, high threshold = 2.25.
  const base = {
    title: "Front Brake Pad Replacement",
    description: "long enough description here",
    laborTotal: 150,
    partsTotal: 80,
  };

  const low = runStaticAuditRules([{ ...base, laborHours: 0.3 }]);
  const lowF = byCategory(low, "Labor Hours");
  ok("0.3h (< min*0.5=0.4) → low-hours warning", lowF.length === 1 && lowF[0].severity === "warning");
  ok("  → title says Low", !!lowF[0]?.title.startsWith("Low"));

  const atBoundary = runStaticAuditRules([{ ...base, laborHours: 0.4 }]);
  ok("exactly min*0.5 (0.4h) does NOT fire (strict <)", byCategory(atBoundary, "Labor Hours").length === 0);

  const inRange = runStaticAuditRules([{ ...base, laborHours: 1.2 }]);
  ok("in-range hours → no Labor Hours finding", byCategory(inRange, "Labor Hours").length === 0);

  const highBoundary = runStaticAuditRules([{ ...base, laborHours: 2.25 }]);
  ok("exactly max*1.5 (2.25h) does NOT fire (strict >)", byCategory(highBoundary, "Labor Hours").length === 0);

  const high = runStaticAuditRules([{ ...base, laborHours: 4 }]);
  const highF = byCategory(high, "Labor Hours");
  ok("4h (> max*1.5) → high-hours info", highF.length === 1 && highF[0].severity === "info");
  ok("  → title says High", !!highF[0]?.title.startsWith("High"));

  const noHours = runStaticAuditRules([{ ...base }]);
  ok("absent laborHours → no Labor Hours finding", byCategory(noHours, "Labor Hours").length === 0);
}

// ---------------------------------------------------------------- companion suggestions
{
  console.log("\nCompanion service suggestions:");

  // Brake pads alone → brake fluid flush suggested (both safety-companion
  // rule and the brake-specific heuristic produce it; dedupe collapses later)
  const pads = runStaticAuditRules([
    { ...CLEAN_OIL_CHANGE, title: "Front Brake Pad Replacement", description: "long enough description here" },
  ]);
  const comp = byCategory(pads, "Missing Companion Service");
  ok("brake pads alone → companion suggestion(s) fired", comp.length >= 1);
  ok(
    "  → brake fluid flush among suggestions",
    comp.some(f => f.suggestedJobId === "brake-fluid-flush"),
    JSON.stringify(comp.map(f => f.suggestedJobId)),
  );

  // Pads + flush on the same estimate → the flush suggestion must NOT fire
  const padsAndFlush = runStaticAuditRules([
    { title: "Front Brake Pad Replacement", description: "long enough description here", laborTotal: 150, partsTotal: 80, laborHours: 1.0 },
    { title: "Brake Fluid Flush", description: "long enough description here", laborTotal: 70, partsTotal: 20, laborHours: 0.7 },
  ]);
  ok(
    "pads + flush together → no brake-fluid-flush suggestion",
    !byCategory(padsAndFlush, "Missing Companion Service").some(f => f.suggestedJobId === "brake-fluid-flush"),
  );

  // Timing belt without water pump → water pump heuristic
  const tb = runStaticAuditRules([
    { title: "Timing Belt Replacement", description: "long enough description here", laborTotal: 500, partsTotal: 200, laborHours: 4 },
  ]);
  ok(
    "timing belt alone → water pump suggestion",
    byCategory(tb, "Missing Companion Service").some(f => f.suggestedJobId === "water-pump"),
  );

  const tbWp = runStaticAuditRules([
    { title: "Timing Belt Replacement", description: "long enough description here", laborTotal: 500, partsTotal: 200, laborHours: 4 },
    { title: "Water Pump Replacement", description: "long enough description here", laborTotal: 200, partsTotal: 150, laborHours: 2 },
  ]);
  ok(
    "timing belt + water pump → no water pump suggestion",
    !byCategory(tbWp, "Missing Companion Service").some(f => f.suggestedJobId === "water-pump"),
  );

  // The same companion must not be suggested twice even when two safety
  // lines share it (front + rear pads both list brake-fluid-flush).
  const bothAxles = runStaticAuditRules([
    { title: "Front Brake Pad Replacement", description: "long enough description here", laborTotal: 150, partsTotal: 80, laborHours: 1.0 },
    { title: "Rear Brake Pad Replacement", description: "long enough description here", laborTotal: 160, partsTotal: 85, laborHours: 1.2 },
  ]);
  const flushSuggestions = byCategory(bothAxles, "Missing Companion Service").filter(
    f => f.suggestedJobId === "brake-fluid-flush" && f.title.startsWith("Consider adding"),
  );
  ok(
    "front+rear pads → safety-companion flush suggested at most once",
    flushSuggestions.length <= 1,
    `got ${flushSuggestions.length}`,
  );
}

// ---------------------------------------------------------------- description quality
{
  console.log("\nDescription quality rule:");
  const noDesc = runStaticAuditRules([{ ...CLEAN_OIL_CHANGE, description: undefined }]);
  ok("missing description → info finding", byCategory(noDesc, "Description Quality").length === 1);

  const shortDesc = runStaticAuditRules([{ ...CLEAN_OIL_CHANGE, description: "   short  " }]);
  ok("<10-char (trimmed) description → info finding", byCategory(shortDesc, "Description Quality").length === 1);

  const goodDesc = runStaticAuditRules([CLEAN_OIL_CHANGE]);
  ok("adequate description → no finding", byCategory(goodDesc, "Description Quality").length === 0);
}

// ---------------------------------------------------------------- clean estimate
{
  console.log("\nClean estimate:");
  const clean = runStaticAuditRules([CLEAN_OIL_CHANGE]);
  // The oil-change KB entry is not safetyRelated, so no companion pushes.
  ok("fully clean line → zero findings", clean.length === 0, JSON.stringify(clean.map(f => f.category)));
  ok("clean estimate scores 100", summarizeFindings(dedupeAndSortFindings(clean)).score === 100);
}

// ---------------------------------------------------------------- dedupe + sort
{
  console.log("\nDedupe and sort:");
  const mk = (over: Partial<AuditFinding>): AuditFinding => ({
    id: "f-x",
    severity: "info",
    category: "C",
    title: "T",
    description: "D",
    confidence: 0.5,
    ...over,
  });

  const deduped = dedupeAndSortFindings([
    mk({ id: "f-1", category: "Missing Parts", title: "dup" }),
    mk({ id: "f-2", category: "Missing Parts", title: "dup" }),
    mk({ id: "f-3", category: "Other", title: "dup" }),
  ]);
  ok("same category+title deduped (first wins)", deduped.filter(f => f.category === "Missing Parts").length === 1);
  ok("  → first occurrence kept", deduped.some(f => f.id === "f-1") && !deduped.some(f => f.id === "f-2"));
  ok("same title different category NOT deduped", deduped.length === 2);

  const sorted = dedupeAndSortFindings([
    mk({ id: "i", severity: "info", title: "a", confidence: 0.9 }),
    mk({ id: "w-lo", severity: "warning", title: "b", confidence: 0.3 }),
    mk({ id: "c", severity: "critical", title: "c", confidence: 0.1 }),
    mk({ id: "w-hi", severity: "warning", title: "d", confidence: 0.8 }),
  ]);
  ok(
    "sorted critical → warning(conf desc) → info",
    sorted.map(f => f.id).join(",") === "c,w-hi,w-lo,i",
    sorted.map(f => f.id).join(","),
  );
}

// ---------------------------------------------------------------- score math
{
  console.log("\nScore calculation:");
  const mk = (severity: AuditFinding["severity"], n: number): AuditFinding[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `f-${severity}-${i}`,
      severity,
      category: "C",
      title: `t-${severity}-${i}`,
      description: "d",
      confidence: 0.5,
    }));

  const s0 = summarizeFindings([]);
  ok("no findings → score 100, zero counts", s0.score === 100 && s0.totalFindings === 0);

  const s1 = summarizeFindings([...mk("critical", 1), ...mk("warning", 2), ...mk("info", 3)]);
  ok("1c+2w+3i → 100−15−10−3 = 72", s1.score === 72, `got ${s1.score}`);
  ok("  → counts match", s1.critical === 1 && s1.warnings === 2 && s1.info === 3 && s1.totalFindings === 6);

  const s2 = summarizeFindings(mk("critical", 10));
  ok("10 criticals → clamped to 0 (not negative)", s2.score === 0, `got ${s2.score}`);
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll assertions passed");
