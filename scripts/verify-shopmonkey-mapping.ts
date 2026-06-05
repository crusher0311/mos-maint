#!/usr/bin/env npx tsx
/**
 * Live verification for Shopmonkey order normalization (Task #595).
 *
 * Hits the live Shopmonkey v3 API with the global SHOPMONKEY_API_KEY, pulls a
 * sample of real orders, then runs them through the transform layer
 * (lib/integrations/shopmonkey/transform.ts) and the normalized adapter so we
 * can eyeball that amounts (cents), vehicle, customer, and job/line items map
 * correctly. Read-only.
 */
import {
  transformOrder,
  transformVehicle,
  transformCustomer,
} from "@/lib/integrations/shopmonkey/transform";
import { getAdapter } from "@/lib/integrations/core/normalized-adapter";

const BASE =
  process.env.SHOPMONKEY_API_BASE_URL || "https://api.shopmonkey.cloud/v3";
const KEY = process.env.SHOPMONKEY_API_KEY;
const SAMPLE = Number(process.env.SAMPLE || 10);

if (!KEY) {
  console.error("SHOPMONKEY_API_KEY not set");
  process.exit(1);
}

async function api<T = any>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${KEY}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    cache: "no-store",
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`GET ${path} -> ${res.status}: ${text.slice(0, 500)}`);
  }
  return JSON.parse(text) as T;
}

function keysOf(obj: any): string[] {
  return obj && typeof obj === "object" ? Object.keys(obj) : [];
}

async function main() {
  console.log(`\n=== Shopmonkey live mapping verification (sample=${SAMPLE}) ===\n`);

  // 1. Validate the key / discover company+location scope.
  try {
    const status = await api("/auth/api_key/status");
    console.log("API key status:", JSON.stringify(status?.data ?? status));
  } catch (e: any) {
    console.log("API key status check failed:", e.message);
  }

  // 2. Pull a page of orders. Try a few field combos that Shopmonkey supports.
  let orders: any[] = [];
  // Mirror the client: ask the list endpoint to embed vehicle + customer.
  const inc = `include[vehicle]=true&include[customer]=true`;
  const attempts = [
    `/order?limit=${SAMPLE}&${inc}`,
    `/order?limit=${SAMPLE}`,
  ].map((p) => encodeURI(p).replace(/\[/g, "%5B").replace(/\]/g, "%5D"));
  for (const p of attempts) {
    try {
      const resp = await api(p);
      orders = Array.isArray(resp?.data) ? resp.data : [];
      console.log(`\nGET ${p} -> ${orders.length} orders (meta: ${JSON.stringify(resp?.meta ?? {})})`);
      if (orders.length) break;
    } catch (e: any) {
      console.log(`GET ${p} failed: ${e.message}`);
    }
  }

  if (!orders.length) {
    console.log("\nNo orders returned from list endpoint. Nothing to verify.");
    return;
  }

  // 3. Inspect the raw shape of the first order (what fields the list returns).
  const first = orders[0];
  console.log("\n--- Raw order[0] top-level keys ---");
  console.log(keysOf(first).join(", "));
  console.log("vehicle present:", !!first.vehicle, "| keys:", keysOf(first.vehicle).join(", "));
  console.log("customer present:", !!first.customer, "| keys:", keysOf(first.customer).join(", "));

  // 3b. Fetch the full order detail (orders do NOT embed line items).
  let detail = first;
  try {
    const d = await api(`/order/${encodeURIComponent(first.id)}`);
    detail = d?.data ?? d;
    console.log("\n--- Full order detail keys ---");
    console.log(keysOf(detail).join(", "));
  } catch (e: any) {
    console.log("Order detail fetch failed:", e.message);
  }

  // 3c. Line items live on /service_item, filtered by vehicleId/customerId.
  //     Fetch them for the detail order so the transform has real lines.
  async function fetchServiceItems(order: any): Promise<any[]> {
    const where: Record<string, string> = {};
    if (order.vehicleId ?? order.vehicle?.id) where.vehicleId = String(order.vehicleId ?? order.vehicle?.id);
    else if (order.customerId ?? order.customer?.id) where.customerId = String(order.customerId ?? order.customer?.id);
    if (!Object.keys(where).length) return [];
    try {
      const resp = await api(`/service_item?where=${encodeURIComponent(JSON.stringify(where))}&limit=200`);
      const all: any[] = Array.isArray(resp?.data) ? resp.data : [];
      return all.filter((it) => String(it.order?.id ?? "") === String(order.id));
    } catch (e: any) {
      console.log("service_item fetch failed:", e.message);
      return [];
    }
  }

  const detailItems = await fetchServiceItems(detail);
  console.log("\n--- /service_item for detail order ---");
  console.log("line items:", detailItems.length);
  if (detailItems[0]) {
    console.log("service_item[0] keys:", keysOf(detailItems[0]).join(", "));
    console.log("service_item types:", detailItems.map((i) => i.type).join(", "));
  }

  // 4. Run each sampled order through the transform + normalized adapter.
  const normAdapter = getAdapter("shopmonkey")!;
  const issues: string[] = [];
  let withVehicle = 0,
    withCustomer = 0,
    withServices = 0,
    withLines = 0,
    withVin = 0,
    withMileage = 0;

  // Use detail for the first, list rows for the rest (cheaper, still real).
  const sample = [detail, ...orders.slice(1)];
  // Fetch line items for every sampled order (orders don't embed them).
  const itemsBySample = await Promise.all(
    sample.map((raw, i) => (i === 0 ? Promise.resolve(detailItems) : fetchServiceItems(raw))),
  );

  for (let i = 0; i < sample.length; i++) {
    const raw = sample[i];
    const wo = transformOrder(raw, { mileageUnit: "miles" }, itemsBySample[i]);

    if (wo.vehicle && (wo.vehicle.vin || wo.vehicle.make || wo.vehicle.id)) withVehicle++;
    if (wo.vehicle?.vin) withVin++;
    if (wo.vehicle?.mileage != null) withMileage++;
    if (wo.customer) withCustomer++;
    if (wo.serviceJobs?.length) withServices++;
    const lineCount = (wo.serviceJobs ?? []).reduce((s, j) => s + (j.lines?.length ?? 0), 0);
    if (lineCount) withLines++;

    // Sanity: the transformed service-job grand total should match the order's
    // totalCostCents (the real grand-total field) in dollars.
    if (raw.totalCostCents != null) {
      const dollars = raw.totalCostCents / 100;
      const got = (wo.serviceJobs ?? []).reduce((s, j) => s + (j.totals?.totalAmount ?? 0), 0);
      if (Math.abs(dollars - got) > 0.01) {
        issues.push(
          `Order ${wo.sourceId} grand total mismatch: raw totalCostCents=$${dollars.toFixed(2)} vs transformed $${got.toFixed(2)}`,
        );
      }
    }

    // Detect cents-not-converted bug: any line extendedPrice that equals an
    // integer in the thousands while raw was cents would hint at a miss.
    for (const job of wo.serviceJobs ?? []) {
      for (const line of job.lines ?? []) {
        if (typeof line.extendedPrice === "number" && line.extendedPrice > 100000) {
          issues.push(
            `Order ${wo.sourceId} line "${line.description}" extendedPrice=${line.extendedPrice} looks like un-converted cents`,
          );
        }
      }
    }
  }

  // 5. Detailed dump of the richest order for manual eyeballing.
  const richest = sample
    .map((r, i) => ({ r, items: itemsBySample[i], wo: transformOrder(r, { mileageUnit: "miles" }, itemsBySample[i]) }))
    .sort(
      (a, b) =>
        (b.wo.serviceJobs ?? []).reduce((s, j) => s + (j.lines?.length ?? 0), 0) -
        (a.wo.serviceJobs ?? []).reduce((s, j) => s + (j.lines?.length ?? 0), 0),
    )[0];

  if (richest) {
    console.log("\n--- Richest transformed order (transform.ts) ---");
    const wo = richest.wo;
    console.log({
      id: wo.id,
      workOrderNumber: wo.workOrderNumber,
      status: wo.status,
      stage: wo.stage,
      createdAt: wo.createdAt,
      closedAt: wo.closedAt,
      vehicle: wo.vehicle,
      customer: wo.customer,
      serviceJobCount: wo.serviceJobs?.length,
    });
    for (const job of (wo.serviceJobs ?? []).slice(0, 3)) {
      console.log("  job:", {
        title: job.title,
        status: job.status,
        totals: job.totals,
        lineCount: job.lines?.length,
      });
      for (const line of (job.lines ?? []).slice(0, 4)) {
        console.log("    line:", {
          type: line.lineType,
          desc: line.description,
          qty: line.quantity,
          unitPrice: line.unitPrice,
          ext: line.extendedPrice,
        });
      }
    }

    // 5b. Cross-check against the normalized adapter (the ingestion path).
    console.log("\n--- Same order via normalized-adapter.ts ---");
    const nwo = normAdapter.mapWorkOrder(0, richest.r);
    console.log({
      workOrderNumber: nwo.workOrderNumber,
      status: nwo.status,
      laborTotal: nwo.laborTotal,
      partsTotal: nwo.partsTotal,
      subtotal: nwo.subtotal,
      taxTotal: nwo.taxTotal,
      grandTotal: nwo.grandTotal,
      balanceDue: nwo.balanceDue,
      odometerIn: nwo.odometerIn,
    });
    // 5c. Exercise the FULL normalized ingestion path. Live v3 orders carry no
    // embedded line items, so we attach the fetched /service_item lines (exactly
    // what the sync path's attachServiceItems does) and then run the adapter's
    // extract → map ingestion pipeline, asserting it yields real line items.
    const orderForIngest = { ...richest.r, serviceItems: richest.items };
    const rawJobs = normAdapter.extractRawServiceJobsFromWorkOrder(orderForIngest);
    const mappedJob = rawJobs.length
      ? normAdapter.mapServiceJob(0, "wo-0", rawJobs[0])
      : null;
    const ingestLines = rawJobs.flatMap((rj: any) =>
      normAdapter.extractLineItemsFromServiceJob(rj).map((li: any) =>
        normAdapter.mapLineItem(0, "wo-0", "sj-0", li),
      ),
    );
    console.log(`  ingestion service jobs:   ${rawJobs.length}`);
    console.log(`  ingestion job totals:     `, mappedJob ? {
      laborTotal: mappedJob.laborTotal,
      partsTotal: mappedJob.partsTotal,
      total: mappedJob.total,
    } : null);
    console.log(`  ingestion line items:     ${ingestLines.length}`);
    for (const li of ingestLines.slice(0, 4)) {
      console.log("    ingest line:", {
        type: li.lineType,
        desc: li.partDescription,
        qty: li.quantity,
        unitPrice: li.unitPrice,
        ext: li.extendedPrice,
      });
    }
    if (richest.items.length > 0 && ingestLines.length === 0) {
      issues.push(
        `ingestion path produced 0 line items for order ${richest.r.id} despite ${richest.items.length} /service_item lines`,
      );
    }
    // Cross-check ingestion line-item total vs the /service_item raw extended total.
    const ingestExtTotal = ingestLines.reduce((s: number, li: any) => s + (li.extendedPrice ?? 0), 0);
    const rawExtTotal = richest.items.reduce(
      (s: number, it: any) => s + ((it.priceCents ?? it.subtotalCents ?? 0) / 100),
      0,
    );
    console.log(
      `  ingestion line ext total: $${ingestExtTotal.toFixed(2)} vs raw /service_item ext $${rawExtTotal.toFixed(2)}`,
    );
    if (Math.abs(ingestExtTotal - rawExtTotal) > 0.05) {
      issues.push(
        `ingestion line ext total $${ingestExtTotal.toFixed(2)} != raw /service_item ext $${rawExtTotal.toFixed(2)} for order ${richest.r.id}`,
      );
    }
  }

  // 6. Summary.
  console.log("\n=== SUMMARY ===");
  console.log(`orders sampled:     ${sample.length}`);
  console.log(`with vehicle:       ${withVehicle}`);
  console.log(`  with VIN:         ${withVin}`);
  console.log(`  with mileage:     ${withMileage}`);
  console.log(`with customer:      ${withCustomer}`);
  console.log(`with service jobs:  ${withServices}`);
  console.log(`with line items:    ${withLines}`);
  if (issues.length) {
    console.log(`\n!! ${issues.length} potential mapping issues:`);
    for (const i of issues) console.log("  - " + i);
  } else {
    console.log("\nNo cents-conversion red flags detected.");
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
