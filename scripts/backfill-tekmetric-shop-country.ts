/**
 * Backfill / audit each Tekmetric shop's country (and the distance unit it
 * implies) from the shop's own Tekmetric address.
 *
 * Why: Tekmetric predominantly serves the US (miles) but DOES have Canadian
 * shops (kilometers). We previously stored no location on shop docs, so the
 * distance-unit guardrail could only fall back to "Tekmetric = miles" — which
 * would wrongly force a Canadian Tekmetric shop to miles. This reads the real
 * shop address from the Tekmetric API, infers US vs CA from the state/province
 * + postal/ZIP, and writes `geo` onto the shop doc so the central policy
 * (lib/shop-distance-unit.ts) resolves the correct unit.
 *
 * It is also an AUDIT: in dry-run it reports every Tekmetric shop's inferred
 * country and whether that DISAGREES with the shop's current stored
 * distanceUnit — which is how we confirm the earlier km->miles fix on shops
 * 63/86/155 was correct (US) and surface any genuinely Canadian shop.
 *
 * Usage:
 *   npx tsx scripts/backfill-tekmetric-shop-country.ts                 # dry run (audit)
 *   npx tsx scripts/backfill-tekmetric-shop-country.ts --apply         # writes geo
 *   npx tsx scripts/backfill-tekmetric-shop-country.ts --shop=63       # limit to one shop
 */

import { getDb } from "../lib/mongo";
import { getShops } from "../lib/integrations/tekmetric/client";
import {
  inferCountryFromAddress,
  unitForCountry,
  type ShopCountry,
} from "../lib/shop-distance-unit";

async function main() {
  const apply = process.argv.includes("--apply");
  const shopArg = process.argv.find((a) => a.startsWith("--shop="));
  const onlyShop = shopArg ? Number(shopArg.split("=")[1]) : null;

  const db = await getDb();
  const query: any = {
    $or: [
      { integrationProvider: { $regex: /^tekmetric$/i } },
      { smsProvider: { $regex: /^tekmetric$/i } },
    ],
  };
  if (onlyShop != null) query.shopId = onlyShop;

  const shops = await db
    .collection("shops")
    .find(query)
    .project({
      shopId: 1,
      name: 1,
      "tekmetric.shopId": 1,
      "preferences.distanceUnit": 1,
      "preferences.distanceUnitSource": 1,
      "settings.distanceUnit": 1,
      geo: 1,
    })
    .toArray();

  console.log(`Found ${shops.length} Tekmetric shop(s).${apply ? " (APPLY)" : " (dry run)"}\n`);

  // One API call returns every Tekmetric shop under the OAuth token; match in
  // memory by tek id instead of issuing one rate-limited /shops/{id} per shop.
  let tekById = new Map<number, any>();
  let fetchErr = "";
  try {
    const allTek = await getShops();
    for (const t of allTek) {
      if (t?.id != null) tekById.set(Number(t.id), t);
    }
    console.log(`Fetched ${tekById.size} shop(s) from Tekmetric /shops in one call.\n`);
  } catch (e: any) {
    fetchErr = e?.message ? String(e.message).slice(0, 160) : String(e);
    console.error(`Failed to fetch Tekmetric /shops: ${fetchErr}\n`);
  }

  const rows: any[] = [];
  let caCount = 0;
  let usCount = 0;
  let unknownCount = 0;
  const conflicts: any[] = [];

  for (const s of shops) {
    const tekId = s.tekmetric?.shopId;
    const stored = s.preferences?.distanceUnit ?? s.settings?.distanceUnit ?? "(unset)";
    // A deliberate owner override is intentional — never auto-correct it.
    const ownerOverride =
      String(s.preferences?.distanceUnitSource ?? "").toLowerCase() === "owner";
    let country: ShopCountry | null = null;
    let state = "";
    let zip = "";
    let err = "";

    if (tekId == null) {
      err = "no tekmetric.shopId";
    } else {
      const tek = tekById.get(Number(tekId));
      if (!tek) {
        err = fetchErr || "not in Tekmetric /shops response";
      } else {
        state = tek.address?.state ?? "";
        zip = tek.address?.zip ?? "";
        country = inferCountryFromAddress({ state, zip });
      }
    }

    if (country === "CA") caCount++;
    else if (country === "US") usCount++;
    else unknownCount++;

    const impliedUnit = country ? unitForCountry(country) : null;
    // A conflict needs correcting only when it is NOT a deliberate owner
    // override — owners may intentionally run a unit that differs from their
    // country (the override Brandon asked for).
    const conflict =
      !!impliedUnit && stored !== "(unset)" && stored !== impliedUnit && !ownerOverride;
    if (conflict) {
      conflicts.push({ shopId: s.shopId, name: s.name, stored, impliedUnit, country, state, zip });
    }

    rows.push({
      shopId: s.shopId,
      name: s.name,
      tekId,
      state,
      zip,
      country: country ?? "(unknown)",
      stored: ownerOverride ? `${stored} (owner)` : stored,
      impliedUnit: impliedUnit ?? "(n/a)",
      conflict: conflict ? "CONFLICT" : ownerOverride ? "owner-override" : "",
      err,
    });

    if (apply && country) {
      const set: any = {
        "geo.country": country,
        "geo.state": state || null,
        "geo.zip": zip || null,
        "geo.source": "tekmetric_api",
        "geo.updatedAt": new Date(),
      };
      // Most read paths (dashboard, reports, and the Detect Dog extension
      // overlay endpoints) read `preferences.distanceUnit` RAW, not through the
      // policy. So when the stored unit disagrees with the shop's real country,
      // correct the stored value too — otherwise those surfaces keep showing the
      // wrong unit even after geo is written. Mark the source "auto" (this is a
      // location-driven correction, NOT an owner override) and drop the shop's
      // caches so its VHI scores rebuild with the right unit.
      if (impliedUnit && conflict) {
        set["preferences.distanceUnit"] = impliedUnit;
        set["preferences.distanceUnitSource"] = "auto";
        const planRes = await db
          .collection("cached_plans")
          .deleteMany({ shopId: s.shopId });
        const analysisRes = await db
          .collection("maintenance_analysis_cache")
          .deleteMany({ shopId: s.shopId });
        console.log(
          `  ↳ shop ${s.shopId} (${s.name}): stored ${stored} -> ${impliedUnit}; cleared cached_plans=${planRes.deletedCount} maintenance_analysis_cache=${analysisRes.deletedCount}`
        );
      }
      await db.collection("shops").updateOne({ shopId: s.shopId }, { $set: set });
    }
  }

  console.table(
    rows.map((r) => ({
      shopId: r.shopId,
      name: (r.name ?? "").slice(0, 28),
      state: r.state,
      zip: r.zip,
      country: r.country,
      stored: r.stored,
      implied: r.impliedUnit,
      flag: r.conflict || r.err,
    }))
  );

  console.log(`\nSummary: US=${usCount} CA=${caCount} unknown=${unknownCount}`);
  if (conflicts.length > 0) {
    console.log(`\n⚠️  ${conflicts.length} shop(s) whose stored unit DISAGREES with their actual country:`);
    console.log(JSON.stringify(conflicts, null, 2));
    console.log(
      "\nFor these, the stored unit is wrong. After --apply writes geo, the policy will resolve the correct unit; you must also delete their cached_plans + maintenance_analysis_cache so scores rebuild."
    );
  } else {
    console.log("\n✓ No conflicts: every shop's stored unit matches its inferred country (or country unknown).");
  }

  if (!apply) console.log("\nDRY RUN — pass --apply to write geo onto shop docs.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
