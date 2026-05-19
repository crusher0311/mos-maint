/**
 * One-shot CARFAX diagnostic.
 *
 * Usage:
 *   npx tsx scripts/dump-carfax.ts <shopId> <VIN>
 *
 * Hits CARFAX live (same path as the plan-build route) and prints:
 *   - whether the call succeeded
 *   - how many serviceRecords came back
 *   - how many serviceCategories came back
 *   - every serviceCategory name (CARFAX's pre-classified rollup)
 *   - the first 30 raw service-record descriptions (free text)
 *
 * That output tells us whether the score=0 problem is a fetch failure
 * (ok=false), missing history (records=0), or a vocabulary-matching gap
 * (records arrive but our normalizer doesn't recognize the wording).
 *
 * Reads same env CARFAX_POST_URL + CARFAX_PDI and same Mongo `shops`
 * collection the live route does — no separate config.
 */
import { fetchCarfaxLive, resolveCarfaxConfig } from "@/lib/integrations/carfax";

async function main() {
  const [shopIdArg, vinArg] = process.argv.slice(2);
  if (!shopIdArg || !vinArg) {
    console.error("Usage: npx tsx scripts/dump-carfax.ts <shopId> <VIN>");
    process.exit(1);
  }
  const shopId = Number(shopIdArg);
  const vin = vinArg.toUpperCase().trim();
  if (!Number.isFinite(shopId)) {
    console.error(`Invalid shopId: ${shopIdArg}`);
    process.exit(1);
  }
  if (vin.length !== 17) {
    console.error(`Invalid VIN (need 17 chars): ${vin} (${vin.length} chars)`);
    process.exit(1);
  }

  console.log(`\n=== Resolving CARFAX config for shop ${shopId} ===`);
  const cfg = await resolveCarfaxConfig(shopId);
  console.log(`  hasEnv:      ${cfg.hasEnv}`);
  console.log(`  hasLocation: ${cfg.hasLocation}`);
  console.log(`  locationId:  ${cfg.locationId ?? "(none)"}`);
  console.log(`  configured:  ${cfg.configured}`);
  if (!cfg.configured) {
    console.error("\nCARFAX not fully configured for this shop. Aborting.");
    process.exit(2);
  }

  console.log(`\n=== Calling CARFAX live for VIN ${vin} ===`);
  const t0 = Date.now();
  const result = await fetchCarfaxLive(shopId, vin);
  const ms = Date.now() - t0;
  console.log(`  took ${ms}ms`);
  console.log(`  ok:    ${(result as any).ok}`);
  if (!(result as any).ok) {
    console.error(`  error: ${(result as any).error}`);
    process.exit(3);
  }

  const r: any = result;
  const records: Array<{ date?: string | null; odometer?: number | null; description?: string | null }> =
    Array.isArray(r.serviceRecords) ? r.serviceRecords : [];
  const categories: Array<{ serviceName: string; date?: string | null; odometer?: number | null }> =
    Array.isArray(r.serviceCategories) ? r.serviceCategories : [];

  console.log(`\n=== Summary ===`);
  console.log(`  serviceRecords:    ${records.length}`);
  console.log(`  serviceCategories: ${categories.length}`);
  console.log(`  lastReportedMileage: ${r.lastReportedMileage ?? "(none)"}`);
  console.log(`  owners:            ${r.numberOfOwners ?? "(none)"}`);

  if (categories.length) {
    console.log(`\n=== serviceCategories (CARFAX's pre-classified rollup — the GOOD anchor source) ===`);
    for (const c of categories) {
      const date = c.date ?? "?";
      const odo = c.odometer != null ? `${c.odometer} mi` : "(no odo)";
      console.log(`  [${date}  ${odo}] ${c.serviceName}`);
    }
  } else {
    console.log(`\n=== serviceCategories: NONE — triage will fall back to per-record free-text matching ===`);
  }

  if (records.length) {
    const shown = Math.min(30, records.length);
    console.log(`\n=== serviceRecords (first ${shown} of ${records.length} — what toKeyFromFreeText sees) ===`);
    for (let i = 0; i < shown; i++) {
      const rec = records[i];
      const date = rec.date ?? "?";
      const odo = rec.odometer != null ? `${rec.odometer} mi` : "(no odo)";
      const desc = (rec.description ?? "").replace(/\s+/g, " ").trim();
      console.log(`  [${date}  ${odo}] ${desc}`);
    }
    if (records.length > shown) {
      console.log(`  ... ${records.length - shown} more`);
    }
  } else {
    console.log(`\n=== serviceRecords: NONE ===`);
  }

  console.log(`\nDone. Paste the serviceCategories + serviceRecords sections back so we can audit normalizer coverage.\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(99);
});
