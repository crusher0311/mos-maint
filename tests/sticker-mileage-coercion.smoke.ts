/**
 * Smoke test for sticker mileage coercion (task #939).
 *
 * Run: `npx tsx tests/sticker-mileage-coercion.smoke.ts`
 *
 * Harrell's printed "Next Service Due 713,785,000 mi" because the
 * extension sent currentMileage as a string and the route did
 * "71378" + 5000 → "713785000". Locks in:
 *  - parseMileageInput coerces numbers AND numeric strings (with commas),
 *  - the computed next-service math is numeric addition,
 *  - the absurd-value ceiling rejects garbage,
 *  - the extension sticker route + sibling entry points are actually
 *    wired through the helper (source-level guard).
 */

import { readFileSync } from "fs";
import {
  parseMileageInput,
  parseMonthsInput,
  isAbsurdMileage,
  MAX_PLAUSIBLE_MILEAGE,
} from "../lib/sticker-mileage";

let failed = 0;

function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function eq(name: string, got: unknown, want: unknown) {
  ok(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

console.log("parseMileageInput — numeric inputs");
eq("number passes through", parseMileageInput(71378), 71378);
eq("float floors", parseMileageInput(71378.9), 71378);
eq("zero rejected", parseMileageInput(0), null);
eq("negative rejected", parseMileageInput(-5), null);
eq("NaN rejected", parseMileageInput(NaN), null);
eq("Infinity rejected", parseMileageInput(Infinity), null);

console.log("parseMileageInput — string inputs (the Harrell's bug)");
eq('"71378" parses', parseMileageInput("71378"), 71378);
eq('"71,378" parses (commas stripped)', parseMileageInput("71,378"), 71378);
eq('" 71378 " parses (trimmed)', parseMileageInput(" 71378 "), 71378);
eq('"abc" rejected', parseMileageInput("abc"), null);
eq('"71378mi" rejected', parseMileageInput("71378mi"), null);
eq('"" rejected', parseMileageInput(""), null);
eq('"-5" rejected', parseMileageInput("-5"), null);
eq("null rejected", parseMileageInput(null), null);
eq("undefined rejected", parseMileageInput(undefined), null);
eq("object rejected", parseMileageInput({} as unknown), null);

console.log("next-service math — string mileage must ADD, not concatenate");
{
  const parsed = parseMileageInput("71378");
  ok("parsed is a number", typeof parsed === "number");
  eq("71378 (string) + 5000 = 76378", (parsed as number) + 5000, 76378);
  const parsedComma = parseMileageInput("71,378");
  eq("71,378 (string) + 5000 = 76378", (parsedComma as number) + 5000, 76378);
}

console.log("absurd-value guard");
ok("713785000 is absurd", isAbsurdMileage(713785000));
ok("76378 is fine", !isAbsurdMileage(76378));
ok("ceiling itself is fine", !isAbsurdMileage(MAX_PLAUSIBLE_MILEAGE));
ok("ceiling+1 is absurd", isAbsurdMileage(MAX_PLAUSIBLE_MILEAGE + 1));
ok("Infinity is absurd", isAbsurdMileage(Infinity));

console.log("parseMonthsInput");
eq('"6" parses', parseMonthsInput("6"), 6);
eq("0 rejected", parseMonthsInput(0), null);

console.log("route wiring — entry points must go through the helper");
{
  const extRoute = readFileSync("app/api/extension/sticker/route.ts", "utf8");
  ok(
    "extension route imports sticker-mileage helper",
    extRoute.includes('from "@/lib/sticker-mileage"'),
  );
  ok(
    "extension route computes next-service from the PARSED mileage",
    /const nextServiceMileage = parsedCurrentMileage \+ intervalMileage/.test(extRoute),
  );
  ok(
    "extension route no longer adds raw currentMileage",
    !/currentMileage \+ intervalMileage/.test(extRoute),
  );
  ok(
    "extension route guards absurd computed mileage",
    extRoute.includes("isAbsurdMileage(nextServiceMileage)"),
  );
  ok(
    "extension route 400s on invalid customMonths (no silent 6-month fallback)",
    extRoute.includes("customMonths must be a positive number"),
  );
  ok(
    "extension route only defaults months when customMonths omitted",
    /customMonthsProvided && parsedCustomMonths === null/.test(extRoute),
  );

  const genRoute = readFileSync("app/api/sticker/generate/route.ts", "utf8");
  ok(
    "sticker generate route coerces via helper",
    genRoute.includes('from "@/lib/sticker-mileage"') &&
      genRoute.includes("parseMileageInput(body.nextServiceMileage)"),
  );

  const extStickers = readFileSync("app/api/external/stickers/route.ts", "utf8");
  ok(
    "external stickers route coerces via helper",
    extStickers.includes("sticker-mileage") &&
      extStickers.includes("parseMileageInput(nextServiceMileage)"),
  );

  const extKeytags = readFileSync("app/api/external/keytags/route.ts", "utf8");
  ok(
    "external keytags route coerces via helper",
    extKeytags.includes("sticker-mileage") &&
      extKeytags.includes("parseMileageInput(nextServiceMileage)"),
  );
}

if (failed > 0) {
  console.error(`\n${failed} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll sticker mileage coercion checks passed.");
