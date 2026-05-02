/**
 * Smoke test for the Autoflow secondary-source merge logic introduced in
 * Task #254 (combine Autoflow with Tekmetric / Protractor / Shop-Ware
 * instead of treating it as standalone).
 *
 * Run: `npx tsx tests/autoflow-merge-task-254.smoke.ts`
 *
 * Why: the dashboard, plan-build, and extension RO-context endpoints now
 * treat Autoflow as additive on top of any primary SMS. The behavior the
 * shop sees is:
 *
 *   - Autoflow-only:           Autoflow rows are emitted as-is.
 *   - Tekmetric + Autoflow:    one row per VIN, Tekmetric-sourced, with
 *                              the Autoflow DVI checkmark merged in.
 *   - Protractor + Autoflow:   Autoflow rows for VINs the primary doesn't
 *                              cover are no longer silently dropped.
 *   - Shop-Ware + Autoflow:    Shop-Ware rows pick up the Autoflow DVI
 *                              indicator instead of hardcoded "not done".
 *
 * The merge is implemented in `lib/dashboard/autoflow-merge.ts`; the same
 * shopId + RO (with VIN fallback) reconciliation key is reused by the
 * extension RO-context endpoint and the Autoflow webhook cross-reference
 * step. This test pins down the dashboard-side behavior for all four
 * shop configurations so a regression flips the DVI checkmark off or
 * silently drops Autoflow rows again.
 */

import { mergeAutoflowIntoPrimary } from "../lib/dashboard/autoflow-merge";

let failed = 0;

function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  \u2713 ${name}`);
  } else {
    failed += 1;
    console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ""}`);
  }
}

console.log("Task #254 Autoflow merge smoke checks");

const VIN_A = "1HGCM82633A123456";
const VIN_B = "5YJSA1E26HF000001";
const VIN_C = "JTDKARFU0H3000002";

const olderTs = new Date("2026-04-25T10:00:00Z");
const newerTs = new Date("2026-04-29T10:00:00Z");

// ------------------------------------------------------------------
// Scenario 1: Autoflow-only shop
// ------------------------------------------------------------------
{
  const result = mergeAutoflowIntoPrimary(
    [],
    [
      { source: "autoflow", displayVin: VIN_A, displayRo: "AF-1", dviDone: true, updatedAt: newerTs },
      { source: "autoflow", displayVin: VIN_B, displayRo: "AF-2", dviDone: false, updatedAt: olderTs },
    ],
  );

  ok("Autoflow-only: keeps every Autoflow row", result.rows.length === 2);
  ok("Autoflow-only: nothing was merged", result.mergedCount === 0);
  ok("Autoflow-only: DVI signal preserved", result.rows.find((r) => r.displayVin === VIN_A)?.dviDone === true);
}

// ------------------------------------------------------------------
// Scenario 2: Tekmetric + Autoflow — one row per VIN, DVI merged in
// ------------------------------------------------------------------
{
  const result = mergeAutoflowIntoPrimary(
    [
      { source: "tekmetric", displayVin: VIN_A, displayRo: "TK-101", dviDone: false, updatedAt: olderTs },
    ],
    [
      // Autoflow has the DVI completed for the same VIN, with a newer ts.
      { source: "autoflow", displayVin: VIN_A, displayRo: "AF-501", dviDone: true, updatedAt: newerTs },
    ],
  );

  ok("Tek+AF: one row per VIN (no duplicate)", result.rows.length === 1);
  const row = result.rows[0];
  ok("Tek+AF: row is sourced from primary (Tekmetric)", row.source === "tekmetric");
  ok("Tek+AF: DVI checkmark reflects Autoflow completion", row.dviDone === true);
  ok(
    "Tek+AF: most-recent Autoflow timestamp wins",
    new Date(row.updatedAt as Date).getTime() === newerTs.getTime(),
  );
  ok("Tek+AF: counted as merged, not standalone", result.mergedCount === 1 && result.standaloneCount === 0);
}

// ------------------------------------------------------------------
// Scenario 3: Protractor + Autoflow — Autoflow VINs not in primary
// must no longer be silently dropped.
// ------------------------------------------------------------------
{
  const result = mergeAutoflowIntoPrimary(
    [
      { source: "protractor", displayVin: VIN_A, displayRo: "PR-1", dviDone: false, updatedAt: olderTs },
    ],
    [
      // Same VIN as Protractor — should merge.
      { source: "autoflow", displayVin: VIN_A, displayRo: "AF-1", dviDone: true, updatedAt: newerTs },
      // VIN that Protractor doesn't have — must be emitted standalone.
      { source: "autoflow", displayVin: VIN_C, displayRo: "AF-9", dviDone: true, updatedAt: newerTs },
    ],
  );

  ok("Pro+AF: includes Autoflow-only VIN as a standalone row", result.rows.some((r) => r.displayVin === VIN_C && r.source === "autoflow"));
  ok("Pro+AF: still has the Protractor row", result.rows.some((r) => r.displayVin === VIN_A && r.source === "protractor"));
  ok("Pro+AF: Protractor row picked up Autoflow DVI", result.rows.find((r) => r.displayVin === VIN_A)?.dviDone === true);
  ok("Pro+AF: one merged + one standalone", result.mergedCount === 1 && result.standaloneCount === 1);
  // Regression net for the historical bug: the row count must include the
  // Autoflow-only VIN.
  ok("Pro+AF: row count is 2 (1 merged + 1 standalone)", result.rows.length === 2);
}

// ------------------------------------------------------------------
// Scenario 4: Shop-Ware + Autoflow — Shop-Ware row gets DVI checkmark.
// ------------------------------------------------------------------
{
  const result = mergeAutoflowIntoPrimary(
    [
      { source: "shopware", displayVin: VIN_B, displayRo: 12345, dviDone: false, updatedAt: olderTs },
    ],
    [
      { source: "autoflow", displayVin: VIN_B, displayRo: "12345", dviDone: true, updatedAt: newerTs },
    ],
  );

  ok("SW+AF: one row per VIN", result.rows.length === 1);
  const row = result.rows[0];
  ok("SW+AF: row stays Shop-Ware sourced", row.source === "shopware");
  ok("SW+AF: dviDone flipped to true from Autoflow", row.dviDone === true);
}

// ------------------------------------------------------------------
// Regression net: an older Autoflow timestamp must not overwrite a
// newer primary timestamp.
// ------------------------------------------------------------------
{
  const result = mergeAutoflowIntoPrimary(
    [
      { source: "tekmetric", displayVin: VIN_A, displayRo: "TK-1", dviDone: false, updatedAt: newerTs },
    ],
    [
      { source: "autoflow", displayVin: VIN_A, displayRo: "AF-1", dviDone: true, updatedAt: olderTs },
    ],
  );
  const row = result.rows[0];
  ok(
    "Older Autoflow ts does not overwrite newer primary ts",
    new Date(row.updatedAt as Date).getTime() === newerTs.getTime(),
  );
  ok("DVI checkmark still merges in regardless of ts", row.dviDone === true);
}

// ------------------------------------------------------------------
// Edge case: case-insensitive VIN match.
// ------------------------------------------------------------------
{
  const result = mergeAutoflowIntoPrimary(
    [{ source: "tekmetric", displayVin: VIN_A.toLowerCase(), displayRo: "TK-1", dviDone: false, updatedAt: olderTs }],
    [{ source: "autoflow", displayVin: VIN_A.toUpperCase(), displayRo: "AF-1", dviDone: true, updatedAt: newerTs }],
  );
  ok("VIN match is case-insensitive (no duplicate row)", result.rows.length === 1);
  ok("VIN match is case-insensitive (DVI merged)", result.rows[0].dviDone === true);
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll Task #254 Autoflow merge checks passed");
