#!/usr/bin/env tsx
/**
 * DVI Share-Link Historical Sweep (task #860) — CLI operator trigger.
 *
 * One-shot backfill that scans historical Protractor invoice payloads
 * (`protractor_invoice_cache`) for public DVI share links (AutoServe1,
 * AutoVitals avlink.io, AutoFlow microsites, MasterTech, AutoOps) and
 * registers them into `dvi_links` for the fetch pipeline. Optionally runs
 * fetch passes immediately (links expire at the provider, so sweeping and
 * fetching in one sitting maximizes yield).
 *
 * OPERATOR-GATED (writes to production Mongo):
 *   - refuses to run without --confirm
 *   - refuses to run unless DVI_LINK_INGEST_ENABLED=true
 *
 * Also ensures the dvi_links / dvi_link_snapshots indexes (runtime code
 * never calls createIndex — memory: index creation from dev hits prod).
 *
 * Usage:
 *   DVI_LINK_INGEST_ENABLED=true npm run sweep:dvi-links -- --confirm
 *   DVI_LINK_INGEST_ENABLED=true npm run sweep:dvi-links -- --confirm --fetch
 *   DVI_LINK_INGEST_ENABLED=true npm run sweep:dvi-links -- --confirm --shop 116
 *   npm run sweep:dvi-links                # dry-run: counts only, no writes
 */
import { extractDviLinks } from "@/lib/dvi-links/extract";
import { iterateInvoiceCacheEntries } from "@/lib/data/repositories/protractor-invoice-cache";
import {
  registerDviLink,
  ensureDviLinkIndexes,
} from "@/lib/data/repositories/dvi-links";
import { fetchPendingDviLinks, isDviLinkIngestEnabled } from "@/lib/dvi-links/ingest";

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

const args = process.argv.slice(2);
const confirmed = args.includes("--confirm");
const doFetch = args.includes("--fetch");
const shopArgIdx = args.indexOf("--shop");
const onlyShopId = shopArgIdx >= 0 ? Number(args[shopArgIdx + 1]) : null;

async function main() {
  const dryRun = !confirmed;
  if (!dryRun && !isDviLinkIngestEnabled()) {
    console.error(
      "Refusing to write: set DVI_LINK_INGEST_ENABLED=true to run a confirmed sweep.",
    );
    process.exit(1);
  }
  log(
    dryRun
      ? "DRY RUN (no writes). Pass --confirm to register links."
      : "CONFIRMED sweep — registering links into dvi_links.",
  );

  if (!dryRun) {
    log("Ensuring dvi_links / dvi_link_snapshots indexes…");
    await ensureDviLinkIndexes();
  }

  let scanned = 0;
  let withLinks = 0;
  let totalLinks = 0;
  let registered = 0;
  const perProvider: Record<string, number> = {};

  for await (const doc of iterateInvoiceCacheEntries(
    onlyShopId ?? undefined,
  )) {
    scanned++;
    const inv = doc.invoice;
    if (!inv) continue;
    const links = extractDviLinks(inv);
    if (links.length === 0) continue;
    withLinks++;
    totalLinks += links.length;
    const vin: string | null = inv?.ServiceItem?.VIN ?? null;
    const workOrderNumber = inv?.InvoiceNumber ?? inv?.WorkOrderNumber ?? null;
    for (const link of links) {
      perProvider[link.provider] = (perProvider[link.provider] || 0) + 1;
      if (dryRun) continue;
      const isNew = await registerDviLink({
        provider: link.provider,
        url: link.url,
        shopId: String(doc.shopId),
        vin,
        workOrderNumber: workOrderNumber != null ? String(workOrderNumber) : null,
        sourceProvider: "protractor",
      });
      if (isNew) registered++;
    }
    if (scanned % 5000 === 0) {
      log(`…scanned ${scanned} invoices (${withLinks} with links)`);
    }
  }

  log(
    `Scan complete: ${scanned} invoices, ${withLinks} with links, ${totalLinks} link occurrences, ${registered} newly registered.`,
  );
  log(`Per provider: ${JSON.stringify(perProvider)}`);

  if (!dryRun && doFetch) {
    log("Running fetch passes until the pending queue drains…");
    // Bounded loop: each pass handles up to 50 links; stop when a pass
    // processes nothing.
    for (let pass = 1; pass <= 100; pass++) {
      const result = await fetchPendingDviLinks(50);
      log(`fetch pass ${pass}: ${JSON.stringify(result)}`);
      if (result.processed === 0) break;
    }
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
