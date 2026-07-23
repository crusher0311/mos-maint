/**
 * Task #897: smoke test for the DVI pre-fill vocabulary fixes + skip
 * reporting shape.
 *
 * Run: `npx tsx tests/dvi-prefill-skip-reporting.smoke.ts`
 *
 * Covers:
 *   - New service-key synonym mappings for DVI checklist vocabulary
 *     (Heart Northbrook sheet): "Ignition System" → spark_plugs,
 *     "Battery & Charging System" → battery, "Belts" → serpentine_belt,
 *     plus "Plugs & Wires" phrasings.
 *   - Guards against substring false positives (ignition switch/coil,
 *     seat belts, timing belt, key-fob battery).
 *   - The free-text matcher mirrors the name matcher for the shared
 *     SERVICE_KEYS synonyms, with the inspect-only verb guard intact.
 *   - The skip-classification logic the prefill-dvi route uses (name →
 *     no service key vs. key resolved but no VHI/finding signal).
 */

import {
  toKeyFromName,
  toKeyFromFreeText,
  isInspectOnlyHistoryPhrase,
  toAnchorKeysFromHistory,
} from "../lib/service-keys";
import { isComplimentaryItem } from "../lib/complimentary-classification";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  \u2713 ${name}`);
  } else {
    failed += 1;
    console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ""}`);
  }
}

console.log("DVI prefill skip-reporting / vocabulary smoke checks");

// ---- New DVI checklist name mappings (Task #897) ----

ok(
  `"Ignition System" → spark_plugs`,
  toKeyFromName("Ignition System") === "spark_plugs",
  `got ${toKeyFromName("Ignition System")}`,
);
ok(
  `"Plugs & Wires" → spark_plugs`,
  toKeyFromName("Plugs & Wires") === "spark_plugs",
);
ok(
  `"Plugs and Wires" → spark_plugs`,
  toKeyFromName("Plugs and Wires") === "spark_plugs",
);
ok(
  `"Spark Plugs & Wires" → spark_plugs`,
  toKeyFromName("Spark Plugs & Wires") === "spark_plugs",
);
ok(
  `"Battery & Charging System" → battery`,
  toKeyFromName("Battery & Charging System") === "battery",
  `got ${toKeyFromName("Battery & Charging System")}`,
);
ok(
  `"Battery and Charging System" → battery`,
  toKeyFromName("Battery and Charging System") === "battery",
);
ok(
  `"Belts" → serpentine_belt (exact-equality)`,
  toKeyFromName("Belts") === "serpentine_belt",
  `got ${toKeyFromName("Belts")}`,
);

// ---- Substring false-positive guards ----

ok(
  `"Ignition Switch" does NOT match spark_plugs`,
  toKeyFromName("Ignition Switch") !== "spark_plugs",
  `got ${toKeyFromName("Ignition Switch")}`,
);
ok(
  `"Ignition Coil" does NOT match spark_plugs`,
  toKeyFromName("Ignition Coil") !== "spark_plugs",
);
ok(
  `"Ignition Coil" does NOT match oil (known "coil"→oil pitfall)`,
  toKeyFromName("Ignition Coil") !== "oil",
  `got ${toKeyFromName("Ignition Coil")}`,
);
ok(
  `"Seat Belts" does NOT match serpentine_belt`,
  toKeyFromName("Seat Belts") !== "serpentine_belt",
  `got ${toKeyFromName("Seat Belts")}`,
);
ok(
  `"Timing Belt" does NOT match serpentine_belt`,
  toKeyFromName("Timing Belt") !== "serpentine_belt",
);
ok(
  `"Key Fob Battery & Charging" does NOT match battery (accessory guard)`,
  toKeyFromName("Key Fob Battery & Charging") !== "battery",
  `got ${toKeyFromName("Key Fob Battery & Charging")}`,
);

// ---- Free-text matcher mirrors the shared SERVICE_KEYS synonyms ----

ok(
  `free-text "Ignition system serviced" → spark_plugs`,
  toKeyFromFreeText("Ignition system serviced").includes("spark_plugs"),
  `got [${toKeyFromFreeText("Ignition system serviced").join(", ")}]`,
);
ok(
  `free-text "Ignition system checked" is inspect-only (verb guard intact)`,
  isInspectOnlyHistoryPhrase("Ignition system checked"),
);
ok(
  `free-text "Anti-theft/keyless remote battery and charging port replaced" does NOT hit battery`,
  !toKeyFromFreeText("Anti-theft/keyless remote battery and charging port replaced").includes("battery"),
);

// ---- Wiper mechanism-repair guard (follow-up) ----

ok(
  `"rear wiper got stuck and now won't move" does NOT map (name matcher)`,
  toKeyFromName("rear wiper got stuck and now won't move") !== "wiper_blades",
  `got ${toKeyFromName("rear wiper got stuck and now won't move")}`,
);
ok(
  `"rear wiper got stuck and now won't move" does NOT map (free-text)`,
  !toKeyFromFreeText("rear wiper got stuck and now won't move").includes("wiper_blades"),
);
ok(
  `"rear wiper got stuck…" never anchors wiper_blades history`,
  !toAnchorKeysFromHistory("rear wiper got stuck and now won't move").includes("wiper_blades"),
);
ok(
  `"Wiper motor replaced" does NOT map to wiper_blades`,
  !toKeyFromFreeText("Wiper motor replaced").includes("wiper_blades"),
);
ok(
  `"Wiper linkage repair" does NOT map to wiper_blades`,
  toKeyFromName("Wiper linkage repair") !== "wiper_blades",
);
ok(
  `"Replace rear wiper blade" still maps to wiper_blades`,
  toKeyFromName("Replace rear wiper blade") === "wiper_blades",
  `got ${toKeyFromName("Replace rear wiper blade")}`,
);
ok(
  `"Wiper(s) replaced" still maps to wiper_blades (free-text)`,
  toKeyFromFreeText("Wiper(s) replaced").includes("wiper_blades"),
);
ok(
  `"Windshield wipers" still maps to wiper_blades`,
  toKeyFromName("Windshield wipers") === "wiper_blades",
);

// ---- Shop-interval override beats inspect-only demotion (follow-up) ----

ok(
  `"Inspect brake fluid." WITHOUT shop override is complimentary (unchanged)`,
  isComplimentaryItem({ serviceKey: "brake_fluid", title: "Inspect brake fluid." }),
);
ok(
  `"Inspect brake fluid." WITH usingShopInterval is NOT complimentary`,
  !isComplimentaryItem({ serviceKey: "brake_fluid", title: "Inspect brake fluid.", usingShopInterval: true }),
);
ok(
  `multi-point inspection stays complimentary even with usingShopInterval false`,
  isComplimentaryItem({ serviceKey: "multi_point_inspection", title: "Multi-point inspection", usingShopInterval: false }),
);

// ---- Skip classification (mirrors the prefill-dvi route's loop) ----

function classify(
  tasks: Array<{ id: number; name: string }>,
  vhiKeys: Set<string>,
): { updated: string[]; noServiceKey: string[]; noSignal: Array<{ taskName: string; serviceKey: string }> } {
  const updated: string[] = [];
  const noServiceKey: string[] = [];
  const noSignal: Array<{ taskName: string; serviceKey: string }> = [];
  for (const t of tasks) {
    const key = toKeyFromName(t.name);
    if (!key) {
      noServiceKey.push(t.name);
    } else if (!vhiKeys.has(key)) {
      noSignal.push({ taskName: t.name, serviceKey: key });
    } else {
      updated.push(t.name);
    }
  }
  return { updated, noServiceKey, noSignal };
}

{
  const r = classify(
    [
      { id: 1, name: "Ignition System" },
      { id: 2, name: "Engine Oil" },
      { id: 3, name: "Body Damage" },
      { id: 4, name: "Belts" },
    ],
    new Set(["spark_plugs", "oil"]),
  );
  ok(
    "Ignition System + Engine Oil rate (VHI signal present)",
    r.updated.length === 2 && r.updated.includes("Ignition System"),
    JSON.stringify(r.updated),
  );
  ok(
    `"Body Damage" is skipped as no-service-key`,
    r.noServiceKey.length === 1 && r.noServiceKey[0] === "Body Damage",
    JSON.stringify(r.noServiceKey),
  );
  ok(
    `"Belts" is skipped as no-signal WITH its resolved key`,
    r.noSignal.length === 1 &&
      r.noSignal[0].taskName === "Belts" &&
      r.noSignal[0].serviceKey === "serpentine_belt",
    JSON.stringify(r.noSignal),
  );
}

if (failed > 0) {
  console.error(`\n${failed} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll checks passed.");
process.exit(0);
