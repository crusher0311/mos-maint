/**
 * Smoke test for the canonical job content hash (computeJobHash).
 *
 * Run: `npx tsx tests/job-index-hash-canonical.smoke.ts`
 *
 * Pins the invariant that the SAME job produces the SAME content hash
 * regardless of cosmetic differences in how a source path extracted it:
 *   - line items in a different order (Protractor list vs detail), and
 *   - float-representation blips on money (267.29999999999995 vs 267.3).
 * A real content change (different part/price) must STILL change the hash.
 *
 * This is the invariant that lets the faster Protractor list path reuse the
 * existing index without spurious "changed" detections and the redundant
 * re-index writes they trigger. Shared by Protractor and Shop-Ware.
 */
import { computeJobHash } from "@/lib/job-index";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const base: any = {
  workOrderId: "wo1",
  servicePackageId: "sp1",
  vehicle: { vin: "1HGCM82633A004352", year: 2020, make: "Honda", model: "Accord" },
  job: { title: "Air Filter Replacement", keywords: ["air", "filter"] },
  totals: { laborHours: 1, laborAmount: 17, partsAmount: 26.75, totalAmount: 267.29999999999995 },
};

const partThenLabor = {
  ...base,
  lines: [
    { lineType: "part", description: "Air Filter", partNumber: "R95261", manufacturer: "advance auto", quantity: 1, unitPrice: 26.75, extendedPrice: 26.75 },
    { lineType: "labor", description: "Labor", quantity: 1, unitPrice: 0, extendedPrice: 17 },
  ],
};

// Same job, lines reordered (labor first) AND total carries the float blip rounded.
const laborThenPart = {
  ...base,
  totals: { ...base.totals, totalAmount: 267.3 },
  lines: [
    { lineType: "labor", description: "Labor", quantity: 1, unitPrice: 0, extendedPrice: 17 },
    { lineType: "part", description: "Air Filter", partNumber: "R95261", manufacturer: "advance auto", quantity: 1, unitPrice: 26.75, extendedPrice: 26.75 },
  ],
};

// A genuinely different job (different part + price) must hash differently.
const realChange = {
  ...base,
  lines: [
    { lineType: "part", description: "Cabin Filter", partNumber: "C99999", manufacturer: "advance auto", quantity: 1, unitPrice: 31.0, extendedPrice: 31.0 },
    { lineType: "labor", description: "Labor", quantity: 1, unitPrice: 0, extendedPrice: 17 },
  ],
};

// Optional line-identity fields (PCDB / PartsTech) must STILL affect the hash —
// these are populated by Shop-Ware/Tekmetric and were part of the old hash.
const withPcdbA = {
  ...base,
  lines: [
    { lineType: "part", description: "Air Filter", partNumber: "R95261", quantity: 1, unitPrice: 26.75, extendedPrice: 26.75, pcdbPartTypeId: 5340 },
  ],
};
const withPcdbB = {
  ...base,
  lines: [
    { lineType: "part", description: "Air Filter", partNumber: "R95261", quantity: 1, unitPrice: 26.75, extendedPrice: 26.75, pcdbPartTypeId: 9999 },
  ],
};

// Malformed lines (null element, non-array) must not throw and must be stable.
const malformed = { ...base, lines: [null, { lineType: "labor", description: "Labor", quantity: 1, unitPrice: 0, extendedPrice: 17 }] };
const noLines = { ...base, lines: undefined };

const hPartThenLabor = computeJobHash(partThenLabor);
const hLaborThenPart = computeJobHash(laborThenPart);
const hRealChange = computeJobHash(realChange);

console.log("canonical job hash:");
ok("line order does not change the hash", hPartThenLabor === hLaborThenPart, `${hPartThenLabor} vs ${hLaborThenPart}`);
ok("float-rounding blip does not change the hash", hPartThenLabor === hLaborThenPart);
ok("hash is stable across repeated calls", computeJobHash(partThenLabor) === hPartThenLabor);
ok("a real content change DOES change the hash", hPartThenLabor !== hRealChange, `${hPartThenLabor} vs ${hRealChange}`);
ok("hash is the expected 16-hex-char length", /^[0-9a-f]{16}$/.test(hPartThenLabor), hPartThenLabor);
ok("differing PCDB part-type id DOES change the hash", computeJobHash(withPcdbA) !== computeJobHash(withPcdbB));

let threw = false;
let hMalformed = "";
try { hMalformed = computeJobHash(malformed as any); } catch { threw = true; }
ok("malformed lines (null element) do not throw", !threw);
ok("malformed-lines hash is stable", !threw && hMalformed === computeJobHash(malformed as any));
let threwNoLines = false;
try { computeJobHash(noLines as any); } catch { threwNoLines = true; }
ok("missing lines array does not throw", !threwNoLines);

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
