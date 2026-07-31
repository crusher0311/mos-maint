/**
 * Smoke test for Estimate Assist prefill + identifier preference (Task #979).
 *
 * Run: `npx tsx tests/estimate-assist-prefill.smoke.ts`
 *
 * Prod incident regression target: legacy /api/dashboard/data rows carry
 * `displayRo` as a NUMBER for Protractor shops; the modal prefill called
 * `.trim()` on it and crashed the whole dashboard. This test locks in:
 *  1. String() coercion everywhere (numeric displayRo never throws).
 *  2. Identifier preference order: normalizedId → workOrderGuid →
 *     workOrderId → roId → displayRo, across legacy and data-v2 row shapes
 *     for protractor / tekmetric / shopware / manual rows.
 *  3. The panel prefill mirror (resolvePrefill) — audit id vs input display.
 *  4. The dashboard call site and the panel actually route through the
 *     shared helper, so a refactor can't silently reintroduce inline .trim().
 */

import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  hasAuditableIdentifier,
  pickEstimateAssistIdentifier,
  resolvePrefill,
} from "../lib/estimate-assist-prefill";

function main() {
  // ── 1. Numeric displayRo (the actual incident shape: legacy data route,
  //       Protractor shop, no normalizedId) ────────────────────────────────
  const legacyProtractorRow = {
    displayRo: 48213, // NUMBER, not string
    workOrderGuid: undefined,
    workOrderId: undefined,
  };
  assert.ok(hasAuditableIdentifier(legacyProtractorRow), "numeric displayRo is auditable");
  const legacy = pickEstimateAssistIdentifier(legacyProtractorRow);
  assert.strictEqual(legacy.workOrderId, "48213", "numeric displayRo coerced to string");
  assert.strictEqual(legacy.roDisplay, "48213", "roDisplay coerced to string");
  // The historical crash: .trim() on the picked values must be safe.
  assert.doesNotThrow(() => legacy.workOrderId.trim(), "picked id supports string methods");

  // resolvePrefill with a NUMBER passed straight through as props must not throw
  // (this is exactly what crashed in prod).
  assert.doesNotThrow(
    () => resolvePrefill(48213 as unknown, 48213 as unknown),
    "resolvePrefill never throws on numeric props",
  );
  const numericPrefill = resolvePrefill(48213, 48213);
  assert.strictEqual(numericPrefill.auditId, "48213");
  assert.strictEqual(numericPrefill.inputDisplay, "48213");

  // ── 2. Preference order per provider row shape ──────────────────────────
  // data-v2 shape (includes normalizedId): normalizedId wins over everything.
  const dataV2Row = {
    normalizedId: "665f1c2ab3d4e5f601234567",
    workOrderGuid: "0a1b2c3d-0000-4000-8000-000000000001",
    workOrderId: "0a1b2c3d-0000-4000-8000-000000000001",
    displayRo: 991,
  };
  assert.strictEqual(
    pickEstimateAssistIdentifier(dataV2Row).workOrderId,
    "665f1c2ab3d4e5f601234567",
    "normalizedId preferred over GUID and displayRo",
  );
  assert.strictEqual(pickEstimateAssistIdentifier(dataV2Row).roDisplay, "991");

  // Protractor open RO, missing normalizedId (legacy route): GUID next.
  const protractorLegacy = {
    normalizedId: null,
    workOrderGuid: "0a1b2c3d-0000-4000-8000-0000000000ff",
    workOrderId: "0a1b2c3d-0000-4000-8000-0000000000ff",
    displayRo: 1234,
  };
  assert.strictEqual(
    pickEstimateAssistIdentifier(protractorLegacy).workOrderId,
    "0a1b2c3d-0000-4000-8000-0000000000ff",
    "workOrderGuid preferred when normalizedId missing",
  );

  // Tekmetric-style row: numeric workOrderId, no GUID.
  const tekmetricRow = { workOrderId: 555001, displayRo: 7788 };
  assert.strictEqual(
    pickEstimateAssistIdentifier(tekmetricRow).workOrderId,
    "555001",
    "numeric workOrderId coerced and preferred over displayRo",
  );

  // Shop-Ware-style row: roId only.
  const shopwareRow = { roId: 424242, displayRo: undefined };
  const sw = pickEstimateAssistIdentifier(shopwareRow);
  assert.strictEqual(sw.workOrderId, "424242", "roId used when nothing better");
  assert.strictEqual(sw.roDisplay, undefined, "missing displayRo → undefined, not 'undefined'");

  // Manual row: only displayRo (string).
  const manualRow = { displayRo: "M-100" };
  assert.strictEqual(pickEstimateAssistIdentifier(manualRow).workOrderId, "M-100");

  // Row with nothing → not auditable, empty id, no crash.
  const emptyRow = {};
  assert.strictEqual(hasAuditableIdentifier(emptyRow), false, "empty row is not auditable");
  assert.strictEqual(pickEstimateAssistIdentifier(emptyRow).workOrderId, "");

  // Whitespace-only / empty-string ids are treated as missing.
  assert.strictEqual(
    pickEstimateAssistIdentifier({ normalizedId: "  ", displayRo: 9 }).workOrderId,
    "9",
    "whitespace normalizedId skipped",
  );

  // ── 3. Panel prefill mirror ──────────────────────────────────────────────
  // Opaque id + human RO display: audit by id, show the RO number.
  const p1 = resolvePrefill("665f1c2ab3d4e5f601234567", 48213);
  assert.strictEqual(p1.auditId, "665f1c2ab3d4e5f601234567");
  assert.strictEqual(p1.inputDisplay, "48213", "input shows human RO, audit uses opaque id");

  // No RO display → input falls back to the id itself.
  const p2 = resolvePrefill("abc-id", undefined);
  assert.strictEqual(p2.inputDisplay, "abc-id");

  // Missing/empty id → no auto-run.
  assert.strictEqual(resolvePrefill(undefined, 123).auditId, "", "no id → no auto-run");
  assert.strictEqual(resolvePrefill("   ", "x").auditId, "", "blank id → no auto-run");
  assert.strictEqual(resolvePrefill(null, null).auditId, "");

  // Whitespace-only roDisplay falls back to the id.
  assert.strictEqual(resolvePrefill("id-1", "   ").inputDisplay, "id-1");

  // ── 4. Call sites route through the shared helper ───────────────────────
  const dashSrc = readFileSync(join(process.cwd(), "app/dashboard/DashboardClient.tsx"), "utf8");
  assert.ok(
    dashSrc.includes("pickEstimateAssistIdentifier") && dashSrc.includes("hasAuditableIdentifier"),
    "DashboardClient must use the shared identifier helpers",
  );
  const panelSrc = readFileSync(join(process.cwd(), "components/EstimateAssistPanel.tsx"), "utf8");
  assert.ok(
    panelSrc.includes("resolvePrefill"),
    "EstimateAssistPanel prefill must use the shared resolvePrefill helper",
  );
  assert.ok(
    !/String\(initialWorkOrderId \?\? ""\)\.trim\(\)/.test(panelSrc),
    "panel must not reintroduce inline prefill coercion",
  );

  console.log("estimate-assist-prefill smoke: all assertions passed");
}

main();
