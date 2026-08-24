// Task #991 — Auto DVI: unit tests for the pure composition/dedup logic and
// the history-anchor safety of generated inspection line titles.
//
// Run: npm run test:auto-dvi-compose
// Exit codes: 0 = pass, 1 = assertion failures, 2 = crash.

import {
  collectVhiInspectionItems,
  composeInspectionChecklist,
  buildInspectionLineTitle,
  buildFindingsNote,
  appendRatingTag,
  buildVhiContextNote,
  defaultRatingForBucket,
  buildRecallInspectionItems,
  type ResolvedShopItem,
} from "../lib/auto-dvi/compose";
import {
  isInspectOnlyHistoryPhrase,
  toAnchorKeysFromHistory,
  INSPECTION_SERVICE_KEYS,
} from "../lib/service-keys";
import { featuresForPlan } from "../lib/plan-feature-tiers";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function shopItem(id: string, name: string, serviceKey: string | null, keySource: ResolvedShopItem["keySource"] = "deterministic"): ResolvedShopItem {
  return { id, name, serviceKey, keySource };
}

async function main() {
  console.log("[1] collectVhiInspectionItems bucket rules");
  {
    const items = collectVhiInspectionItems({
      overdue: [
        { serviceKey: "engine_oil", title: "Engine Oil & Filter", action: "replace" },
        { serviceKey: null, title: "Mystery item" }, // no key → dropped
      ],
      dueSoon: [
        { serviceKey: "brake_fluid", title: "Brake Fluid", action: "replace" },
        { serviceKey: "engine_oil", title: "Engine Oil (dupe)", action: "replace" }, // dedup, overdue wins
      ],
      upcoming: [
        { serviceKey: "brake_system", title: "Brake System", action: "inspect" }, // OE inspect → included
        { serviceKey: "spark_plugs", title: "Spark Plugs", action: "replace" },   // upcoming replace → excluded
      ],
    });
    const keys = items.map((i) => i.serviceKey).sort();
    check("includes overdue + dueSoon + upcoming inspect-only", JSON.stringify(keys) === JSON.stringify(["brake_fluid", "brake_system", "engine_oil"]), JSON.stringify(keys));
    const oil = items.find((i) => i.serviceKey === "engine_oil");
    check("dedup keeps highest-priority bucket (overdue)", oil?.bucket === "overdue" && oil?.title === "Engine Oil & Filter");
    check("upcoming replace item excluded", !items.some((i) => i.serviceKey === "spark_plugs"));
    check("keyless items dropped", !items.some((i) => i.title === "Mystery item"));
  }

  console.log("[2] composeInspectionChecklist coverage/dedup rules");
  {
    const vhiItems = collectVhiInspectionItems({
      overdue: [{ serviceKey: "engine_oil", title: "Engine Oil & Filter", action: "replace" }],
      dueSoon: [{ serviceKey: "brake_fluid", title: "Brake Fluid", action: "replace" }],
      upcoming: [{ serviceKey: "brake_system", title: "Brake System", action: "inspect" }],
    });
    const shopItems = [
      shopItem("a", "Check brake fluid condition", "brake_fluid"),       // covered by due-soon
      shopItem("b", "Brake inspection", "brake_system"),                  // covered by OE inspect
      shopItem("c", "Oil level check", "engine_oil"),                     // covered by overdue
      shopItem("d", "Battery terminals", "battery"),                      // key but no VHI match → visible
      shopItem("e", "Frobnicator check", null, "unresolved"),             // unresolved → visible
    ];
    const { items, hidden } = composeInspectionChecklist({ vhiItems, shopItems });

    check("OE-inspect covers shop item", hidden.some((h) => h.item.id === "b" && h.reason.includes("OE inspect")), JSON.stringify(hidden.map((h) => h.reason)));
    check("due-soon covers shop item", hidden.some((h) => h.item.id === "a" && h.reason.includes("due soon")));
    check("overdue covers shop item", hidden.some((h) => h.item.id === "c" && h.reason.includes("overdue")));
    check("hidden reasons name the covering item", hidden.every((h) => h.reason.startsWith('Covered by "')));
    check("non-matching keyed shop item stays visible", items.some((i) => i.id === "shop:d"));
    check("unresolved shop item stays visible", items.some((i) => i.id === "shop:e"));
    check("visible = 3 VHI + 2 shop", items.length === 5, `got ${items.length}`);
    check("all visible items have inspection-phrased lineTitle", items.every((i) => i.lineTitle.startsWith("Inspected")));
  }

  console.log("[3] buildInspectionLineTitle history-anchor safety");
  {
    const nasty = [
      ["Replace engine oil", "engine_oil"],
      ["Coolant flush", "coolant"],
      ["Tire rotation and balance", "tire_rotation"],
      ["Transmission fluid exchange", "transmission_fluid"],
      ["Serpentine belt — replaced", null],
      ["Clean and adjust rear brakes", null],
      ["Battery terminals (clean/service)", null],
      ["Topped off washer fluid", "washer_fluid"],
      ["Lubricate chassis", null],
      ["Cabin air filter", "cabin_air_filter"],
      ["Brake fluid condition", "brake_fluid"],
      ["replace", null], // pathological: nothing left after stripping
    ] as const;
    for (const [name, key] of nasty) {
      const title = buildInspectionLineTitle(name, key);
      const inspectOnly = isInspectOnlyHistoryPhrase(title);
      check(`"${name}" → "${title}" is inspect-only`, inspectOnly);
      // The real safety property: run through the actual history anchorer —
      // no non-inspection service key may anchor from this line.
      const anchors = toAnchorKeysFromHistory(title);
      const badAnchors = anchors.filter((k) => !INSPECTION_SERVICE_KEYS.has(k));
      check(`"${title}" anchors no replacement keys`, badAnchors.length === 0, JSON.stringify(badAnchors));
    }
  }

  console.log("[4] auto_dvi feature flag dark launch");
  {
    for (const plan of ["trial", "starter", "plus", "elite", "professional", "enterprise", "demo", "oil_sticker_legacy"]) {
      check(`${plan} tier has auto_dvi OFF`, featuresForPlan(plan).auto_dvi === false);
    }
    check("founder wildcard has auto_dvi ON", featuresForPlan("detect_dog_founder").auto_dvi === true);
    check("elite still has launched features", featuresForPlan("elite").dvi_prefill === true && featuresForPlan("elite").maintenance === true);
  }

  console.log("[5] buildFindingsNote composition");
  {
    check("empty findings → null", buildFindingsNote([]) === null);
    check(
      "all-green no-detail → null",
      buildFindingsNote([{ name: "Battery", rating: "green" }, { name: "Wipers", rating: "green" }]) === null,
    );
    const note = buildFindingsNote([
      { name: "Wipers", rating: "yellow", recommendation: "Replace next visit" },
      { name: "Brake fluid", rating: "red", notes: "Dark, test strip failed" },
      { name: "Battery", rating: "green" },
      { name: "Cabin filter", rating: "green", notes: "Slightly dirty" },
      { name: "Floor mats", notes: "Worn" },
    ]);
    check("note is non-null", note !== null);
    check("red listed before yellow", (note || "").indexOf("Brake fluid") < (note || "").indexOf("Wipers"));
    check("plain green omitted", !(note || "").includes("GREEN (good): Battery"));
    check("green with notes included", (note || "").includes("Cabin filter — Slightly dirty"));
    check("recommendation phrased", (note || "").includes("Recommend: Replace next visit"));
    check("unrated with notes surfaces", (note || "").includes("NOTE: Floor mats — Worn"));
    check("red labeled", (note || "").includes("RED (needs attention): Brake fluid — Dark, test strip failed"));
    check(
      "rating-only red/yellow omitted from note (tag lives on the title now)",
      buildFindingsNote([{ name: "Battery", rating: "red" }, { name: "Wipers", rating: "yellow" }]) === null,
    );
  }

  console.log("[6] appendRatingTag on line titles");
  {
    check("red tag", appendRatingTag("Inspected: Battery", "red") === "Inspected: Battery [Red]");
    check("yellow tag", appendRatingTag("Inspected: Wiper Blades", "yellow") === "Inspected: Wiper Blades [Yellow]");
    check("green untagged", appendRatingTag("Inspected: Brake Fluid", "green") === "Inspected: Brake Fluid");
    check("unrated untagged", appendRatingTag("Inspected: Cabin Air Filter", null) === "Inspected: Cabin Air Filter");
    for (const rating of ["red", "yellow"] as const) {
      const title = appendRatingTag(buildInspectionLineTitle("Brake fluid condition", "brake_fluid"), rating);
      check(`tagged title "${title}" stays inspect-only`, isInspectOnlyHistoryPhrase(title));
      const bad = toAnchorKeysFromHistory(title).filter((k) => !INSPECTION_SERVICE_KEYS.has(k));
      check(`tagged title "${title}" anchors no replacement keys`, bad.length === 0, JSON.stringify(bad));
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} assertion(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll auto-dvi-compose assertions passed.");
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(2);
});

// ---------------------------------------------------------------------------
// [7] buildVhiContextNote — plan-context auto-fill for inspection line notes
// ---------------------------------------------------------------------------
{
  const overdue = buildVhiContextNote({ source: "vhi", bucket: "overdue", action: "Replace engine air filter.", milesToGo: -3200 });
  check("overdue context", overdue === "Maintenance plan: Overdue — Replace engine air filter — 3,200 mi past due", overdue);
  const dueSoon = buildVhiContextNote({ source: "vhi", bucket: "due_soon", milesToGo: 1500 });
  check("due-soon context", dueSoon === "Maintenance plan: Due soon — due in 1,500 mi", dueSoon);
  const oeInspect = buildVhiContextNote({ source: "vhi", bucket: "upcoming", action: "inspect", dueAtMiles: 180000 });
  check("OE inspect context (verb suppressed)", oeInspect === "Maintenance plan: OE inspect item — due at 180,000 mi", oeInspect);
  check("bare overdue", buildVhiContextNote({ source: "vhi", bucket: "overdue" }) === "Maintenance plan: Overdue");
  check("shop notes pass through", buildVhiContextNote({ source: "shop", notes: "Check for leaks at the hangers" }) === "Check for leaks at the hangers");
  check("shop without notes empty", buildVhiContextNote({ source: "shop" }) === "");
  check("zero mileage sentinel-safe", buildVhiContextNote({ source: "vhi", bucket: "due_soon", milesToGo: 0, dueAtMiles: 0 }) === "Maintenance plan: Due soon");
}

// [8] Plan-suggested default ratings — checklist should start in agreement
// with the VHI (overdue → red, due soon → yellow, others unrated).
{
  check("overdue defaults red", defaultRatingForBucket("overdue") === "red");
  check("due_soon defaults yellow", defaultRatingForBucket("due_soon") === "yellow");
  check("upcoming defaults null", defaultRatingForBucket("upcoming") === null);
  check("undefined defaults null", defaultRatingForBucket(undefined) === null);
  const composed = composeInspectionChecklist({
    vhiItems: [
      { serviceKey: "transfer_case", title: "Replace transfer case fluid.", action: "replace", bucket: "overdue" },
      { serviceKey: "battery", title: "Battery", bucket: "due_soon" },
      { serviceKey: "brake_lines", title: "Inspect brake lines.", action: "inspect", bucket: "upcoming" },
    ],
    shopItems: [],
  });
  const byKey = Object.fromEntries(composed.items.map((i) => [i.serviceKey, i.defaultRating ?? null]));
  check("composed overdue item red", byKey["transfer_case"] === "red");
  check("composed due-soon item yellow", byKey["battery"] === "yellow");
  check("composed OE inspect item unrated", byKey["brake_lines"] === null);
}

// [9] Recall inspection items — safety recalls join the DVI as red,
// inspection-phrased lines that never anchor a replacement key.
{
  const recalls = buildRecallInspectionItems([
    { nhtsa_campaign_number: "21V050000", component_description: "AIR BAGS:FRONTAL:PASSENGER SIDE:INFLATOR MODULE" },
    { nhtsa_campaign_number: "21V050000", component_description: "AIR BAGS:FRONTAL" }, // dupe campaign
    { nhtsa_campaign_number: "", component_description: "STEERING" }, // no campaign — skipped
  ]);
  check("recall dedup by campaign", recalls.length === 1, String(recalls.length));
  const r = recalls[0];
  check("recall carries no rating prefill (own category)", r.defaultRating === null);
  check("recall source", r.source === "recall");
  check("recall title inspection-phrased", r.lineTitle.startsWith("Inspected: Safety recall:"), r.lineTitle);
  check("recall notes carry campaign", (r.notes || "").includes("21V050000"), r.notes || "");
  check("recall title stays inspect-only", isInspectOnlyHistoryPhrase(r.lineTitle), r.lineTitle);
  const bad = toAnchorKeysFromHistory(r.lineTitle).filter((k) => !INSPECTION_SERVICE_KEYS.has(k));
  check("recall title anchors no replacement keys", bad.length === 0, JSON.stringify(bad));
  check("recall context note passthrough", buildVhiContextNote({ source: "recall", notes: r.notes }) === r.notes);
}
