/**
 * READ-ONLY probe — Task #583.
 *
 * Question we are answering empirically (not by guessing):
 *   Do Protractor *list* endpoints (`/Invoice/?…`, `/WorkOrder/?…`) already
 *   return the service-package line items our extractor needs, or do only the
 *   per-record *detail* endpoints (`/Invoice/{id}`, `/WorkOrder/{id}`) carry
 *   them? The Protractor backfill speed-up plan (mirroring AppFueled's bulk
 *   fetch) depends entirely on which is true for OUR API credentials/tier.
 *
 * What it does:
 *   For one configured Protractor shop it fetches a single list page of
 *   invoices and of work orders, then fetches the detail record for the first
 *   item of each, and compares — field by field — the data our extractor
 *   (lib/job-index.ts) actually consumes: ServicePackages, ServicePackageLines,
 *   pricing (PriceSummary / SellPrice / SellTotal), DeferredServicePackages,
 *   ServiceItem (vehicle), Contact, employees, odometer.
 *
 * It is strictly read-only: only GETs, reuses the existing client/auth and the
 * shared rate limiter (via protractorFetch), makes a handful of calls, and
 * writes NOTHING back to Protractor. Raw payloads are dumped locally (with PII
 * redacted) for side-by-side inspection.
 *
 * Usage:
 *   npx tsx scripts/probe-protractor-list-vs-detail.ts                 # auto-pick first configured shop
 *   npx tsx scripts/probe-protractor-list-vs-detail.ts --shop=116      # specific shop
 *   npx tsx scripts/probe-protractor-list-vs-detail.ts --shop=116 --days=180
 *   npx tsx scripts/probe-protractor-list-vs-detail.ts --shop=116 --out=docs/probe-dumps
 *
 * Flags:
 *   --shop=N     shopId to probe (default: first configured shop found)
 *   --days=N     look back N days for the list windows (default 90)
 *   --out=DIR    directory for raw JSON dumps (default: .local/protractor-probe)
 *   --raw        also print full (redacted) JSON to stdout, not just to files
 */
import fs from "fs";
import path from "path";
import { getDb } from "@/lib/mongo";
import { resolveProtractorConfig, protractorFetch } from "@/lib/integrations/protractor/client";

function parseArgs() {
  const out: { shop: number | null; days: number; outDir: string; raw: boolean; samples: number } = {
    shop: null,
    days: 90,
    outDir: ".local/protractor-probe",
    raw: false,
    samples: 3,
  };
  for (const a of process.argv.slice(2)) {
    if (a.startsWith("--shop=")) out.shop = Number(a.slice("--shop=".length)) || null;
    else if (a.startsWith("--days=")) out.days = Math.max(1, Number(a.slice("--days=".length)) || 90);
    else if (a.startsWith("--out=")) out.outDir = a.slice("--out=".length);
    else if (a.startsWith("--samples=")) out.samples = Math.max(1, Number(a.slice("--samples=".length)) || 3);
    else if (a === "--raw") out.raw = true;
  }
  return out;
}

function ymd(d: Date): string {
  return d.toISOString().split("T")[0];
}

/** Redact obvious PII so dumped JSON is safe to read/share. */
function redact(obj: any): any {
  if (Array.isArray(obj)) return obj.map(redact);
  if (obj && typeof obj === "object") {
    const cleaned: any = {};
    for (const [k, v] of Object.entries(obj)) {
      const key = k.toLowerCase();
      if (
        key.includes("email") ||
        key.includes("phone") ||
        key.includes("mobile") ||
        key.includes("cell") ||
        key === "firstname" ||
        key === "lastname" ||
        key === "name" ||
        key.includes("address") ||
        key.includes("street") ||
        key.includes("postal") ||
        key.includes("zip") ||
        key === "vin" ||
        key === "licenseplate" ||
        key === "plate"
      ) {
        cleaned[k] = v ? "***REDACTED***" : v;
      } else {
        cleaned[k] = redact(v);
      }
    }
    return cleaned;
  }
  return obj;
}

/** Pull the array out of Protractor's two shapes: bare array OR { ItemCollection }. */
function coerceArray(v: any): any[] {
  if (Array.isArray(v)) return v;
  if (v && Array.isArray(v.ItemCollection)) return v.ItemCollection;
  return [];
}

/** Summarize one record's service-package richness for list-vs-detail comparison. */
function summarizeRecord(rec: any): {
  hasServicePackages: boolean;
  servicePackageCount: number;
  packagesWithLines: number;
  totalLines: number;
  linesWithPriceSummary: number;
  linesWithFlatPrice: number;
  hasDeferredPackages: boolean;
  deferredPackageCount: number;
  hasServiceItem: boolean;
  hasContact: boolean;
  hasEmployees: boolean;
  odometer: number | null;
  samplePackageTitles: string[];
  sampleLineShape: any;
} {
  const packages = coerceArray(rec?.ServicePackages);
  const deferred = coerceArray(rec?.DeferredServicePackages);

  let packagesWithLines = 0;
  let totalLines = 0;
  let linesWithPriceSummary = 0;
  let linesWithFlatPrice = 0;
  const samplePackageTitles: string[] = [];
  let sampleLineShape: any = null;

  for (const pkg of packages) {
    const lines = coerceArray(pkg?.ServicePackageLines ?? pkg?.lines);
    if (lines.length > 0) packagesWithLines++;
    totalLines += lines.length;
    const title = pkg?.ServicePackageHeader?.Title || pkg?.Title || pkg?.title;
    if (title && samplePackageTitles.length < 5) samplePackageTitles.push(String(title));
    for (const line of lines) {
      if (line?.PriceSummary && typeof line.PriceSummary === "object") linesWithPriceSummary++;
      if (
        line?.Price != null ||
        line?.UnitPrice != null ||
        line?.ExtendedPrice != null ||
        line?.Total != null ||
        line?.ExtendedTotal != null
      ) {
        linesWithFlatPrice++;
      }
      if (!sampleLineShape) sampleLineShape = redact(line);
    }
  }

  const odo =
    (typeof rec?.OutUsage === "number" && rec.OutUsage > 0 ? rec.OutUsage : null) ??
    (typeof rec?.InUsage === "number" && rec.InUsage > 0 ? rec.InUsage : null) ??
    (typeof rec?.Odometer === "number" && rec.Odometer > 0 ? rec.Odometer : null) ??
    null;

  return {
    hasServicePackages: packages.length > 0,
    servicePackageCount: packages.length,
    packagesWithLines,
    totalLines,
    linesWithPriceSummary,
    linesWithFlatPrice,
    hasDeferredPackages: deferred.length > 0,
    deferredPackageCount: deferred.length,
    hasServiceItem: Boolean(rec?.ServiceItem),
    hasContact: Boolean(rec?.Contact),
    hasEmployees: Boolean(rec?.Employees || rec?.ServiceAdvisor || rec?.Technician),
    odometer: odo,
    samplePackageTitles,
    sampleLineShape,
  };
}

async function findConfiguredShop(preferred: number | null): Promise<number | null> {
  if (preferred != null) {
    const cfg = await resolveProtractorConfig(preferred);
    return cfg.configured ? preferred : null;
  }
  const db = await getDb();
  const shops = await db
    .collection("shops")
    .find(
      {
        $or: [
          { "protractor.apiKey": { $exists: true, $nin: [null, ""] } },
          { protractorApiKey: { $exists: true, $nin: [null, ""] } },
          { "protractor.connectionId": { $exists: true, $nin: [null, ""] } },
          { protractorConnectionId: { $exists: true, $nin: [null, ""] } },
        ],
      },
      { projection: { shopId: 1, name: 1, _id: 0 } }
    )
    .toArray();
  for (const s of shops) {
    const id = Number(s.shopId);
    if (!Number.isFinite(id)) continue;
    const cfg = await resolveProtractorConfig(id);
    if (cfg.configured) {
      console.log(`[probe] auto-picked configured shop ${id} (${s.name || "?"})`);
      return id;
    }
  }
  return null;
}

async function main() {
  const args = parseArgs();
  const resolvedShopId = await findConfiguredShop(args.shop);
  if (resolvedShopId == null) {
    console.error("[probe] No configured Protractor shop found. Pass --shop=N.");
    process.exit(1);
  }
  const shopId: number = resolvedShopId;

  const config = await resolveProtractorConfig(shopId);
  if (!config.configured) {
    console.error(`[probe] Shop ${shopId} is not configured for Protractor.`);
    process.exit(1);
  }

  const end = new Date();
  const start = new Date(end.getTime() - args.days * 24 * 60 * 60 * 1000);
  const startStr = ymd(start);
  const endStr = ymd(end);

  fs.mkdirSync(args.outDir, { recursive: true });
  const dump = (name: string, data: any) => {
    const file = path.join(args.outDir, `shop${shopId}-${name}.json`);
    fs.writeFileSync(file, JSON.stringify(redact(data), null, 2));
    console.log(`[probe] wrote ${file}`);
    if (args.raw) console.log(JSON.stringify(redact(data), null, 2));
  };

  console.log(`\n[probe] shop=${shopId} window=${startStr}..${endStr} (${args.days}d) samples=${args.samples}\n`);

  // Generic: fetch a list page, then fetch detail for the first N items and
  // compare list-vs-detail line richness per record. Returns a structured
  // block for the report.
  async function probeKind(kind: "Invoice" | "WorkOrder") {
    const params = new URLSearchParams();
    params.set("startDate", startStr);
    params.set("endDate", endStr);
    if (kind === "WorkOrder") params.set("readInProgress", "True");
    params.set("take", "100");
    params.set("skip", "0");

    const listRes = await protractorFetch<{ ItemCollection?: any[] }>(
      `/${kind}/?${params.toString()}`,
      config,
      {},
      0,
      shopId,
      { priority: true }
    );
    if (!listRes.ok) console.error(`[probe] ${kind} list FAILED: ${listRes.error}`);
    const list = listRes.data?.ItemCollection || [];
    console.log(`[probe] ${kind} list returned ${list.length} item(s)`);
    dump(`${kind.toLowerCase()}-list`, listRes.data ?? { error: listRes.error });

    const n = Math.min(args.samples, list.length);
    const comparisons: any[] = [];
    for (let i = 0; i < n; i++) {
      const listItem = list[i];
      if (!listItem?.ID) continue;
      const detailRes = await protractorFetch<any>(
        `/${kind}/${listItem.ID}`,
        config,
        {},
        0,
        shopId,
        { priority: true }
      );
      if (!detailRes.ok) {
        console.error(`[probe] ${kind} detail FAILED (${listItem.ID}): ${detailRes.error}`);
        continue;
      }
      const detail = detailRes.data;
      if (i === 0) dump(`${kind.toLowerCase()}-detail-sample0`, detail ?? { error: detailRes.error });
      const listS = summarizeRecord(listItem);
      const detailS = summarizeRecord(detail);
      comparisons.push({
        id: listItem.ID,
        listLines: listS.totalLines,
        detailLines: detailS.totalLines,
        listPackages: listS.servicePackageCount,
        detailPackages: detailS.servicePackageCount,
        listHasDeferred: listS.hasDeferredPackages,
        detailHasDeferred: detailS.hasDeferredPackages,
        listHasServiceItem: listS.hasServiceItem,
        listHasContact: listS.hasContact,
        listParityWithDetail: listS.totalLines >= detailS.totalLines && listS.servicePackageCount >= detailS.servicePackageCount,
        listSummary: listS,
        detailSummary: detailS,
      });
    }

    // Aggregate verdict across the compared records.
    let verdict: string;
    if (comparisons.length === 0) {
      verdict = "NO DATA — no records in window to compare. Widen --days.";
    } else {
      const anyDetailRich = comparisons.some((c) => c.detailLines > 0);
      const allListParity = comparisons.every((c) => c.listParityWithDetail && c.listLines > 0);
      const anyListRich = comparisons.some((c) => c.listLines > 0);
      if (allListParity && anyDetailRich) {
        verdict = `LIST IS RICH — across ${comparisons.length}/${comparisons.length} sampled records the list already carries full line items (>= detail). Per-record detail fetch is AVOIDABLE for ${kind}.`;
      } else if (!anyListRich && anyDetailRich) {
        verdict = `LIST IS THIN — list carries NO line items; only the detail endpoint does. The N+1 detail fetch is UNAVOIDABLE for ${kind} on this tier.`;
      } else if (anyListRich && !allListParity) {
        verdict = `LIST PARTIAL — some list records carry lines but at least one has FEWER than its detail. Treat list as unreliable; keep detail fetch (or detail-on-mismatch) for ${kind}.`;
      } else {
        verdict = `INCONCLUSIVE — no line items in either list or detail in this window for ${kind}. Widen --days or pick a busier shop.`;
      }
    }

    return { listCount: list.length, sampled: comparisons.length, comparisons, verdict };
  }

  const invoice = await probeKind("Invoice");
  const workOrder = await probeKind("WorkOrder");

  const report = {
    shopId,
    window: { startStr, endStr, days: args.days },
    samples: args.samples,
    invoice,
    workOrder,
    invoiceVerdict: invoice.verdict,
    workOrderVerdict: workOrder.verdict,
  };
  dump("comparison-report", report);

  const printKind = (label: string, k: any) => {
    console.log(`\n-- ${label} -- (list size ${k.listCount}, sampled ${k.sampled})`);
    for (const c of k.comparisons) {
      console.log(
        `  ${c.id.slice(0, 8)}…  listLines=${c.listLines} detailLines=${c.detailLines}  listPkgs=${c.listPackages} detailPkgs=${c.detailPackages}  deferred(list=${c.listHasDeferred},detail=${c.detailHasDeferred})  parity=${c.listParityWithDetail}`
      );
    }
    console.log(`  VERDICT: ${k.verdict}`);
  };

  console.log("\n========== PROBE SUMMARY ==========");
  console.log(`Shop ${shopId} | window ${startStr}..${endStr} | samples=${args.samples}`);
  printKind("INVOICE", invoice);
  printKind("WORK ORDER", workOrder);
  console.log("\n===================================\n");

  process.exit(0);
}

main().catch((e) => {
  console.error("[probe] fatal:", e);
  process.exit(1);
});
