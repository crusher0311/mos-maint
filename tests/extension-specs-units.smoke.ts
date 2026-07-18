/**
 * Smoke test for Task #491 — extension Specs tab unit handling and
 * sticker km-toggle fallback.
 *
 * Two layers:
 *   - Runtime: imports the pure resolvers and the retry helper from
 *     the route modules and exercises them with mock inputs (no Mongo
 *     and no real DataOne calls).
 *   - Static: lightweight source-regex assertions to keep the
 *     extension sidepanel renderer and manifest version honest.
 */

import { readFileSync } from "fs";
import {
  formatInches,
  formatCubicFeet,
  formatGallons,
  formatPounds,
} from "../lib/unit-format";
import {
  resolveSpecsUnitDisplayFromShop,
  callDataOneWithRetry,
} from "../app/api/extension/specs/unit-resolver";
import { resolveStickerUseKilometers } from "../app/api/extension/sticker/unit-resolver";

let assertions = 0;
let failed = 0;
function assert(cond: any, msg: string) {
  assertions++;
  if (!cond) {
    failed++;
    console.error(`FAIL: ${msg}`);
  } else {
    console.log(`  ok  ${msg}`);
  }
}

async function main() {
  // ---- 1. Unit formatter behavior (imperial / metric / both) ----
  console.log("\n[1] unit-format inches + cubic feet helpers");
  // fmtDecimal trims trailing zeros (min 0 / max 1 decimal), so an integer
  // input renders without a ".0" but a non-integer keeps one decimal.
  assert(formatInches(17, "imperial") === '17"', "inches imperial integer");
  assert(formatInches(17, "metric") === "43.2 cm", "inches metric");
  assert(formatInches(17, "both") === '17" / 43.2 cm', "inches both");
  assert(formatInches(17.5, "imperial") === '17.5"', "inches imperial decimal");
  assert(formatInches(null) === null, "inches null in → null out");

  assert(formatCubicFeet(15, "imperial") === "15 cu ft", "cu ft imperial integer");
  assert(formatCubicFeet(15, "metric") === "425 L", "cu ft metric");
  assert(formatCubicFeet(15, "both") === "15 cu ft / 425 L", "cu ft both");
  assert(formatCubicFeet(15.4, "imperial") === "15.4 cu ft", "cu ft imperial decimal");

  // Pre-existing gal/lbs helpers still respect mode (regression).
  assert(formatGallons(10, "metric")?.endsWith(" L"), "gallons metric ends in L");
  assert(formatPounds(3000, "imperial")?.endsWith(" lbs"), "pounds imperial ends in lbs");

  // ---- 2. specs route — runtime resolver behavior ----
  console.log("\n[2] resolveSpecsUnitDisplayFromShop runtime cases");

  // Default — no shop doc at all.
  {
    const r = resolveSpecsUnitDisplayFromShop(null);
    assert(r.distanceUnit === "miles" && r.unitDisplay === "imperial",
      "null shop → miles + imperial default");
  }
  // Empty shop doc.
  {
    const r = resolveSpecsUnitDisplayFromShop({});
    assert(r.distanceUnit === "miles" && r.unitDisplay === "imperial",
      "empty shop → miles + imperial");
  }
  // Modern preferences.distanceUnit = kilometers.
  {
    const r = resolveSpecsUnitDisplayFromShop({ preferences: { distanceUnit: "kilometers" } });
    assert(r.distanceUnit === "kilometers" && r.unitDisplay === "metric",
      "preferences.distanceUnit=kilometers → metric");
  }
  // Legacy settings.distanceUnit fallback.
  {
    const r = resolveSpecsUnitDisplayFromShop({ settings: { distanceUnit: "kilometers" } });
    assert(r.distanceUnit === "kilometers" && r.unitDisplay === "metric",
      "legacy settings.distanceUnit=kilometers → metric");
  }
  // Modern wins when both set and disagree.
  {
    const r = resolveSpecsUnitDisplayFromShop({
      preferences: { distanceUnit: "miles" },
      settings: { distanceUnit: "kilometers" },
    });
    assert(r.distanceUnit === "miles" && r.unitDisplay === "imperial",
      "modern preferences.distanceUnit overrides legacy settings.distanceUnit");
  }
  // Explicit preferences.specsUnitDisplay = "both" (the #331 dual-mode knob).
  {
    const r = resolveSpecsUnitDisplayFromShop({
      preferences: { distanceUnit: "miles", specsUnitDisplay: "both" },
    });
    assert(r.distanceUnit === "miles" && r.unitDisplay === "both",
      "preferences.specsUnitDisplay='both' overrides derived imperial");
  }
  // Explicit preferences.specsUnitDisplay = "metric" on a miles shop.
  {
    const r = resolveSpecsUnitDisplayFromShop({
      preferences: { distanceUnit: "miles", specsUnitDisplay: "metric" },
    });
    assert(r.distanceUnit === "miles" && r.unitDisplay === "metric",
      "preferences.specsUnitDisplay='metric' overrides derived imperial");
  }
  // Garbage specsUnitDisplay value → fall through to derivation.
  {
    const r = resolveSpecsUnitDisplayFromShop({
      preferences: { distanceUnit: "kilometers", specsUnitDisplay: "weird" },
    });
    assert(r.distanceUnit === "kilometers" && r.unitDisplay === "metric",
      "invalid specsUnitDisplay falls through to distance-derived metric");
  }

  // ---- 3. specs route — DataOne retry behavior ----
  console.log("\n[3] callDataOneWithRetry runtime cases");
  const fakeSpecsResult = { ok: true, grouped: {}, specs: [] } as any;
  const fakeDecodeResult = { ok: true, decoded: { year: 2020 }, ambiguous: false } as any;

  // Happy path — succeeds on first attempt, no retry.
  {
    let specsCalls = 0;
    let decodeCalls = 0;
    const callers = {
      getSpecs: async () => { specsCalls++; return fakeSpecsResult; },
      decode: async () => { decodeCalls++; return fakeDecodeResult; },
    };
    const r = await callDataOneWithRetry("VIN1", undefined,
      { vin: "VIN1", hasHint: false },
      { callers, backoffMs: 1 });
    assert(specsCalls === 1 && decodeCalls === 1, "happy path calls each DataOne function exactly once");
    assert(r.specsResult === fakeSpecsResult, "happy path returns specsResult from caller");
    assert(r.decodeResult === fakeDecodeResult, "happy path returns decodeResult from caller");
  }

  // Fails once, then succeeds — should retry exactly once.
  {
    let specsCalls = 0;
    let decodeCalls = 0;
    const callers = {
      getSpecs: async () => {
        specsCalls++;
        if (specsCalls === 1) throw new Error("DataOne 503 (specs)");
        return fakeSpecsResult;
      },
      decode: async () => { decodeCalls++; return fakeDecodeResult; },
    };
    const r = await callDataOneWithRetry("VIN2", undefined,
      { vin: "VIN2", hasHint: false },
      { callers, backoffMs: 1 });
    assert(specsCalls === 2, "transient failure triggers exactly one retry of getSpecs");
    assert(decodeCalls === 2, "retry re-runs the decode call too (Promise.all pair)");
    assert(r.specsResult === fakeSpecsResult, "retry surface returns the recovered specsResult");
  }

  // Fails twice — should throw a DataOneCallError after the single retry.
  {
    let specsCalls = 0;
    const callers = {
      getSpecs: async () => { specsCalls++; throw new Error("DataOne 503 (specs)"); },
      decode: async () => fakeDecodeResult,
    };
    let threw: any = null;
    try {
      await callDataOneWithRetry("VIN3", undefined,
        { vin: "VIN3", hasHint: false },
        { callers, backoffMs: 1 });
    } catch (e) {
      threw = e;
    }
    assert(threw !== null, "two consecutive failures rethrow");
    assert(specsCalls === 2, "exactly two attempts (no third retry)");
    assert(
      threw && threw.name === "DataOneCallError" && (threw.which === "specs" || threw.which === "both"),
      `error is a DataOneCallError tagged with which=specs|both (got which=${threw?.which})`,
    );
  }

  // ---- 4. sticker route — runtime fallback resolver ----
  console.log("\n[4] resolveStickerUseKilometers runtime cases");
  assert(
    resolveStickerUseKilometers({ useKilometers: false }, { preferences: { distanceUnit: "kilometers" } }) === false,
    "explicit useKilometers:false beats shop kilometers preference",
  );
  assert(
    resolveStickerUseKilometers({ useKilometers: true }, { preferences: { distanceUnit: "miles" } }) === true,
    "explicit useKilometers:true beats shop miles preference",
  );
  assert(
    resolveStickerUseKilometers({}, { preferences: { distanceUnit: "kilometers" } }) === true,
    "unset useKilometers falls back to shop preferences.distanceUnit=kilometers",
  );
  assert(
    resolveStickerUseKilometers({}, { settings: { distanceUnit: "kilometers" } }) === true,
    "unset useKilometers falls back to legacy settings.distanceUnit=kilometers",
  );
  assert(
    resolveStickerUseKilometers({}, {}) === false,
    "unset useKilometers + no shop pref defaults to miles (false)",
  );
  assert(
    resolveStickerUseKilometers(null, null) === false,
    "null config + null shop is safe and defaults to miles",
  );
  assert(
    resolveStickerUseKilometers({ useKilometers: "true" as any }, { preferences: { distanceUnit: "kilometers" } }) === true,
    "non-boolean stickerConfig.useKilometers is ignored, falls back to shop pref",
  );

  // ---- 5. extension sidepanel renders from server unitDisplay ----
  console.log("\n[5] mos-tools-extension/sidepanel.js render contract");
  const sp = readFileSync("mos-tools-extension/sidepanel.js", "utf8");
  assert(
    /data\.unitDisplay/.test(sp),
    "sidepanel reads data.unitDisplay from the specs response",
  );
  assert(
    /formatInchesDual\(/.test(sp) && /formatCuFtDual\(/.test(sp),
    "sidepanel uses inches + cubic-feet dual formatters",
  );
  const renderBlock = sp.match(/function renderSpecs\(data\)[\s\S]*?function renderSpecsSection/);
  assert(renderBlock, "renderSpecs block located");
  if (renderBlock) {
    const block = renderBlock[0];
    assert(
      !/\+ '"'/.test(block),
      "renderSpecs no longer appends hardcoded `\"` to dimensions/wheels/brakes",
    );
    assert(
      !/\+ ' cu ft'/.test(block),
      "renderSpecs no longer appends hardcoded ` cu ft` to interior volumes",
    );
  }

  // ---- 6. manifest bump ----
  console.log("\n[6] manifest version bump");
  const manifest = JSON.parse(readFileSync("mos-tools-extension/manifest.json", "utf8"));
  const [maj, min, patch] = manifest.version.split(".").map((n: string) => parseInt(n, 10));
  const atLeast = (a: number[], b: number[]) => {
    for (let i = 0; i < 3; i++) {
      if ((a[i] ?? 0) > (b[i] ?? 0)) return true;
      if ((a[i] ?? 0) < (b[i] ?? 0)) return false;
    }
    return true;
  };
  assert(
    atLeast([maj, min, patch], [1, 27, 11]),
    `manifest version is at least 1.27.11 (got ${manifest.version})`,
  );

  console.log(`\nAssertions: ${assertions}, failures: ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("UNCAUGHT", err);
  process.exit(1);
});
