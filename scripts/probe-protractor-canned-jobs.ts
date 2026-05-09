/**
 * Read-only probe: dumps shop 116 (or any shop) Protractor data so we can
 * see the actual response shapes — list item AND every candidate detail
 * endpoint — instead of guessing. No caches written, no DB mutations.
 *
 * Usage:
 *   npx tsx scripts/probe-protractor-canned-jobs.ts <shopId>
 */
import { resolveProtractorConfig } from "@/lib/integrations/protractor";
import { protractorFetch } from "@/lib/integrations/protractor/client";

function snip(s: any, max = 1500): string {
  const str = typeof s === "string" ? s : JSON.stringify(s, null, 2);
  return str.length > max ? str.slice(0, max) + ` ...[+${str.length - max}b]` : str;
}

async function probe(label: string, path: string, config: any, shopId: number, init: any = {}) {
  console.log(`\n=== ${label} ===`);
  console.log(`PATH: ${path}`);
  const r = await protractorFetch<any>(path, config, init, 0, shopId);
  console.log(`ok=${r.ok}  error=${r.error ? snip(r.error, 300) : "none"}`);
  if (r.data !== undefined) {
    const topKeys = r.data && typeof r.data === "object" ? Object.keys(r.data) : [];
    console.log(`topKeys=[${topKeys.join(",")}]`);
    console.log(`body:\n${snip(r.data, 2000)}`);
  } else {
    console.log("body: <none>");
  }
  return r;
}

async function main() {
  const shopId = Number(process.argv[2]);
  if (!Number.isFinite(shopId) || shopId <= 0) {
    console.error("Usage: npx tsx scripts/probe-protractor-canned-jobs.ts <shopId>");
    process.exit(2);
  }

  const config = await resolveProtractorConfig(shopId);
  if (!config.configured) {
    console.error("Protractor not configured for this shop");
    process.exit(1);
  }

  // ---- 1. List endpoint: get one raw item.
  const listResp = await probe(
    "LIST: GET /ServicePackageTemplate (1 item)",
    "/ServicePackageTemplate?take=1&skip=0",
    config,
    shopId,
  );

  const items: any[] =
    listResp.data?.ItemCollection ||
    listResp.data?.ServicePackageTemplates ||
    [];
  if (!items.length) {
    console.error("\nNo items in list response — can't probe detail endpoints. Trying GET /CannedJob/?take=1...");
    await probe("LIST: GET /CannedJob/?take=1", "/CannedJob/?take=1&skip=0", config, shopId);
    process.exit(0);
  }

  const sample = items[0];
  console.log(`\n--- sample item keys: [${Object.keys(sample).join(",")}] ---`);
  const sampleId =
    sample.ID ||
    sample.Id ||
    sample.id ||
    sample.Header?.ID ||
    sample.ServicePackageTemplateID;
  console.log(`extracted ID: ${sampleId}`);
  console.log(`sample.Code = ${JSON.stringify(sample.Code)}`);
  console.log(`sample.ServicePackageHeader = ${snip(sample.ServicePackageHeader, 500)}`);
  console.log(`sample.ServicePackageLines = ${snip(sample.ServicePackageLines, 500)}`);

  if (!sampleId) {
    console.error("Could not extract ID from sample item. Stopping.");
    process.exit(1);
  }

  // ---- 2. Try every candidate detail endpoint against that ID.
  await probe(
    "DETAIL CANDIDATE A: GET /ServicePackageTemplate/Read/{id}",
    `/ServicePackageTemplate/Read/${sampleId}`,
    config,
    shopId,
  );
  await probe(
    "DETAIL CANDIDATE B: GET /ServicePackageTemplate/{id}",
    `/ServicePackageTemplate/${sampleId}`,
    config,
    shopId,
  );
  await probe(
    "DETAIL CANDIDATE C: GET /ServicePackage/CannedJob/{id}",
    `/ServicePackage/CannedJob/${sampleId}`,
    config,
    shopId,
  );
  await probe(
    "DETAIL CANDIDATE D: GET /CannedJob/{id}",
    `/CannedJob/${sampleId}`,
    config,
    shopId,
  );

  console.log("\n=== probe complete ===");
  process.exit(0);
}

main().catch((e) => {
  console.error("[probe] fatal:", e);
  process.exit(1);
});
