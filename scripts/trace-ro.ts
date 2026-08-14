/**
 * trace-ro — trace a repair order (or VIN) end-to-end through ingestion
 * (task #1119).
 *
 * Usage:
 *   npx tsx scripts/trace-ro.ts <shopId> <roNumber|VIN>
 *
 * STRICTLY READ-ONLY. Dev Mongo IS the production cluster.
 *
 * Walks the chain and flags where data stopped flowing:
 *   provider RO cache row (webhook/poll arrival)
 *     → job_index rows (jobsIndexed?)
 *     → normalized_work_orders / service jobs
 *     → cached_plans / maintenance_analysis_cache (degraded flags, TTL age)
 *
 * Identity note: the DISPLAY RO# is `workOrderNumber`; the internal provider
 * id is `workOrderId` — never confuse the two. A 17-char argument is treated
 * as a VIN instead.
 */
import { getDb } from "../lib/mongo";

const DAY = 24 * 60 * 60 * 1000;
function ago(v: any): string {
  if (!v) return "never";
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  if (!Number.isFinite(t)) return String(v);
  const ms = Date.now() - t;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 2 * DAY) return `${(ms / 3_600_000).toFixed(1)}h ago`;
  return `${(ms / DAY).toFixed(1)}d ago`;
}
function iso(v: any): string {
  if (!v) return "—";
  try { return new Date(v).toISOString(); } catch { return String(v); }
}
function step(ok: boolean | null, label: string, detail: string) {
  const mark = ok === null ? "·" : ok ? "✓" : "✗";
  console.log(`  ${mark} ${label}: ${detail}`);
}

const CACHE_BY_PROVIDER: Record<string, string> = {
  tekmetric: "tekmetric_work_orders",
  protractor: "protractor_work_orders",
  shopware: "shopware_repair_orders",
  shopmonkey: "shopmonkey_work_orders",
};

async function main() {
  const [shopIdArg, keyArg] = process.argv.slice(2);
  if (!shopIdArg || !keyArg) {
    console.error("Usage: npx tsx scripts/trace-ro.ts <shopId> <roNumber|VIN>");
    process.exit(1);
  }
  const shopId = Number(shopIdArg);
  const isVin = /^[A-HJ-NPR-Z0-9]{17}$/i.test(keyArg);
  const vinUpper = keyArg.toUpperCase();
  const db = await getDb();
  const now = Date.now();
  const shopIdVariants = [shopId, String(shopId)];

  const shop: any = await db.collection("shops")
    .findOne({ shopId: { $in: shopIdVariants } });
  if (!shop) { console.error(`No shops doc for shopId=${shopIdArg}`); process.exit(1); }
  const provider: string =
    (shop.integrationProvider && String(shop.integrationProvider).toLowerCase()) ||
    (shop.tekmetricShopId || shop.tekmetric?.shopId ? "tekmetric" : null) ||
    (shop.protractor?.connectionId ? "protractor" : null) ||
    (shop.shopware?.tenantId ? "shopware" : null) ||
    (shop.shopmonkey?.locationId ? "shopmonkey" : null) ||
    "tekmetric";

  console.log(`\n=== TRACE ${isVin ? `VIN ${vinUpper}` : `RO# ${keyArg}`} @ shop ${shopId} (${shop.name || "?"}, provider=${provider}) ===`);

  // -------- 1) provider RO cache (webhook / poll arrival) ----------------
  const cacheColl = CACHE_BY_PROVIDER[provider];
  let cacheRows: any[] = [];
  let vin: string | null = isVin ? vinUpper : null;
  if (cacheColl) {
    const query: any = { shopId: { $in: shopIdVariants } };
    if (isVin) query.vin = { $in: [keyArg, vinUpper, keyArg.toLowerCase()] };
    else query.$or = [
      { workOrderNumber: { $in: [keyArg, Number(keyArg)] } },   // display RO#
      { workOrderId: { $in: [keyArg, String(keyArg)] } },       // internal id fallback
    ];
    cacheRows = await db.collection(cacheColl)
      .find(query).sort({ updatedAt: -1 }).limit(5).toArray();
    if (!cacheRows.length) {
      step(false, "provider cache", `NO row in ${cacheColl} for this ${isVin ? "VIN" : "RO#"} — the RO never arrived via webhook/poll (or arrived under a different number: display RO# = workOrderNumber, internal = workOrderId)`);
    }
    for (const r of cacheRows) {
      vin = vin || (r.vin ? String(r.vin).toUpperCase() : null);
      const ts = r.updatedAt ?? r.fetchedAt ?? r.receivedAt;
      const jobsInData = Array.isArray(r.data?.jobs) ? r.data.jobs.length : (Array.isArray(r.jobs) ? r.jobs.length : null);
      step(true, "provider cache",
        `${cacheColl} row: RO#=${r.workOrderNumber ?? "—"} internalId=${r.workOrderId ?? "—"} vin=${r.vin ?? "⚠ MISSING"} ` +
        `updated=${iso(ts)} (${ago(ts)}) data.jobs=${jobsInData ?? "—"} jobsIndexed=${r.jobsIndexed ?? "unset"} jobsIndexedAt=${iso(r.jobsIndexedAt)}`);
      if (r.jobsIndexed !== true && jobsInData) {
        step(false, "  indexing gate", "cache row has jobs but jobsIndexed is unset — the terminal-index gate may have raced VIN enrichment (webhook arrived, jobs never indexed)");
      }
      if (!r.vin) {
        step(false, "  vin", "cache row has NO VIN — downstream (job_index / plan) can't anchor this RO");
      }
    }
  } else {
    step(null, "provider cache", `no RO cache collection known for provider=${provider}`);
  }

  // -------- 2) job_index ---------------------------------------------------
  const internalIds = cacheRows.map((r) => String(r.workOrderId)).filter(Boolean);
  const jiQuery: any = { shopId: { $in: shopIdVariants } };
  if (internalIds.length) jiQuery.workOrderId = { $in: [...internalIds, ...internalIds.map(Number).filter(Number.isFinite)] };
  else if (vin) jiQuery["vehicle.vin"] = { $in: [vin, vin.toLowerCase()] };
  else jiQuery.workOrderId = { $in: [keyArg, Number(keyArg)] };
  const jiRows = await db.collection("job_index").find(jiQuery).limit(20).toArray();
  if (jiRows.length) {
    step(true, "job_index", `${jiRows.length} row(s)`);
    for (const j of jiRows.slice(0, 8)) {
      console.log(`      • "${(j as any).job?.title ?? (j as any).title ?? "?"}" performedAt=${iso((j as any).performedAt)} workOrderId=${(j as any).workOrderId} source=${(j as any).metadata?.sourceSystem ?? (j as any).sourceSystem ?? (j as any).provider ?? "?"}`);
    }
  } else {
    step(false, "job_index", internalIds.length
      ? `NO rows for internal workOrderId(s) ${internalIds.join(", ")} — jobs never indexed (chain broke between cache and job_index)`
      : `NO rows matched — nothing indexed for this ${isVin ? "VIN" : "RO"}`);
  }

  // -------- 3) normalized stores (Mongo mirror) ---------------------------
  const nwoQuery: any = {
    $and: [
      { $or: [{ shopId: { $in: shopIdVariants } }, { shop_id: { $in: shopIdVariants } }] },
    ],
  };
  if (!isVin) {
    nwoQuery.$and.push({ $or: [
      { workOrderNumber: { $in: [keyArg, Number(keyArg)] } },
      { work_order_number: { $in: [keyArg, Number(keyArg), String(keyArg)] } },
    ]});
  } else {
    nwoQuery.$and.push({ $or: [
      { "vehicle.vin": { $in: [vinUpper, keyArg.toLowerCase()] } },
      { vin: { $in: [vinUpper, keyArg.toLowerCase()] } },
    ]});
  }
  const nwoRows = await db.collection("normalized_work_orders")
    .find(nwoQuery).maxTimeMS(15_000).limit(10).toArray().catch(() => []);
  if (nwoRows.length) {
    step(true, "normalized_work_orders", `${nwoRows.length} row(s), newest updated ${ago((nwoRows[0] as any).updatedAt ?? (nwoRows[0] as any).updated_at)}`);
  } else {
    step(false, "normalized_work_orders", "no rows in the Mongo mirror (note: canonical normalized store is Postgres; SM/normalized-only providers write only normalized_*)");
  }

  // -------- 4) plan cache --------------------------------------------------
  if (vin) {
    const shopVariants: any[] = [...shopIdVariants];
    const plans = await db.collection("cached_plans")
      .find({ vin: { $in: [vin, vin.toLowerCase()] }, shopId: { $in: shopVariants } })
      .sort({ createdAt: -1 }).limit(3).toArray();
    if (!plans.length) {
      step(false, "cached_plans", `no plan-cache entry for ${vin} at this shop — VHI views will do a cold build`);
    }
    for (const p of plans as any[]) {
      const ageMs = p.createdAt ? now - new Date(p.createdAt).getTime() : null;
      const expired = p.expiresAt && new Date(p.expiresAt).getTime() < now;
      const oemMissing = p.plan?.oemMissing === true;
      step(!expired, "cached_plans",
        `createdAt=${iso(p.createdAt)} (${ago(p.createdAt)}) expiresAt=${iso(p.expiresAt)}${expired ? " — EXPIRED (stale)" : ""} ` +
        `mileage=${p.mileage ?? "—"}${oemMissing ? "  ⚠ DEGRADED (oemMissing=true — built while OEM/DataOne lookup failed; skipped on read after 30s)" : ""}`);
      if (ageMs != null && !expired && ageMs > 4 * 3600_000) {
        console.log("      note: older than the normal 4h TTL yet unexpired — check expiresAt semantics");
      }
    }
    const analysis: any = await db.collection("maintenance_analysis_cache")
      .findOne({ vin: { $in: [vin, vin.toLowerCase()] }, shopId: { $in: shopVariants } })
      .catch(() => null);
    step(analysis ? true : null, "maintenance_analysis_cache",
      analysis
        ? `analyzedAt=${iso(analysis.analyzedAt)} (${ago(analysis.analyzedAt)}) mileageAtAnalysis=${analysis.mileageAtAnalysis ?? "—"}`
        : "no analysis-cache row");
  } else {
    step(null, "plan cache", "no VIN resolved from the cache row — cannot check cached_plans (this itself is a break: plans are keyed by VIN)");
  }

  // -------- verdict --------------------------------------------------------
  console.log("\n--- Verdict ---");
  if (!cacheRows.length && !isVin) {
    console.log("  Chain broke at ARRIVAL: the RO never reached the provider cache. Check webhook receipt / backfill coverage for its date window.");
  } else if (cacheRows.length && !jiRows.length) {
    console.log("  Chain broke at INDEXING: RO arrived but job_index is empty (jobsIndexed gate / VIN enrichment race). Plan views will fall back to CARFAX.");
  } else if (vin) {
    console.log("  Data flowed through indexing. If the user still sees stale results, suspect the plan cache (see degraded/expired flags above) — a deploy does NOT clear cached_plans.");
  }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
