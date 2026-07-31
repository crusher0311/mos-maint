// AI sales-script generation for open estimates (task #987, dashboard side).
//
// Given an open work order in the normalized store, snapshots its
// sales-relevant context (same shape the practice trainer uses), generates a
// structured advisor script via the central OpenAI client (usage tracked),
// and caches it per (workOrderId, contextHash) — repeat views cost nothing,
// a changed estimate regenerates.
import { createHash } from "crypto";
import { sql, and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/drizzle";
import { getOpenAI, trackOpenAiCall } from "@/lib/ai";
import {
  salesScriptCache,
  type SalesScript,
  type SalesCoachScenarioContext,
} from "@/lib/db/schema/sales-coach";
import { fetchJobs, buildContext, type CandidateRow } from "@/lib/sales-coach/scenario-sampler";
import {
  listOpenWorkOrdersWithPricing,
  findCachedWorkOrderById,
  type ProtractorWorkOrderCacheDoc,
} from "@/lib/data/repositories/protractor-work-orders";
import { findVehicleByShopAndVin } from "@/lib/data/repositories/protractor-vehicles";

const ROUTE = "/api/sales-script";
// Open Protractor WOs live in the protractor_work_orders cache (kept fresh by
// the sync/callbacks); the normalized PG store only has thin, price-less rows
// for open Protractor WOs. Protractor-sourced ids get this prefix so the
// script fetch knows which store to hydrate from.
const PWO_PREFIX = "pwo:";

export interface OpenEstimateSummary {
  workOrderId: string;
  workOrderNumber: string | null;
  status: string;
  vehicle: { year?: number; make?: string; model?: string } | null;
  customerFirstName: string | null;
  customerConcern: string | null;
  grandTotal: number;
  deferredCount: number;
  updatedAt: string | null;
}

function protractorSummary(doc: ProtractorWorkOrderCacheDoc): OpenEstimateSummary {
  const firstName =
    typeof doc.contactName === "string" && doc.contactName.trim()
      ? doc.contactName.trim().split(/\s+/)[0]
      : null;
  return {
    workOrderId: `${PWO_PREFIX}${doc.workOrderId}`,
    workOrderNumber: doc.workOrderNumber != null ? String(doc.workOrderNumber) : null,
    status: doc.workflowStage || "open",
    vehicle: null, // hydrated below where cheap
    customerFirstName: firstName,
    customerConcern: null,
    grandTotal: Math.round((Number(doc.pricing?.grandTotal) || 0) * 100) / 100,
    deferredCount: 0,
    updatedAt: doc.fetchedAt ? new Date(doc.fetchedAt).toISOString() : null,
  };
}

async function listOpenProtractorEstimates(shopId: number, limit: number): Promise<OpenEstimateSummary[]> {
  const docs = await listOpenWorkOrdersWithPricing(shopId, limit);
  const out: OpenEstimateSummary[] = [];
  for (const doc of docs) {
    const summary = protractorSummary(doc);
    if (doc.vin) {
      try {
        const v = await findVehicleByShopAndVin(shopId, doc.vin);
        if (v) summary.vehicle = { year: v.year ?? undefined, make: v.make ?? undefined, model: v.model ?? undefined };
      } catch { /* vehicle enrichment is best-effort */ }
    }
    out.push(summary);
  }
  return out;
}

/**
 * Open (pre-terminal) work orders for a shop, newest first.
 *
 * Two sources merged: the Protractor open-WO cache (open Protractor WOs in
 * the normalized store are thin — no pricing), then normalized PG for other
 * providers. Protractor's adapter backfills closed_date from
 * LastModifiedTime on some records, so the PG arm anchors on STATUS
 * (non-terminal) rather than closed_date alone.
 */
export async function listOpenEstimates(shopId: number, limit = 25): Promise<OpenEstimateSummary[]> {
  const protractor = await listOpenProtractorEstimates(shopId, limit).catch((err) => {
    console.warn(`[SalesScript] protractor open-WO lookup failed: ${err?.message || err}`);
    return [] as OpenEstimateSummary[];
  });
  const remaining = limit - protractor.length;
  if (remaining <= 0) return protractor;
  const pgRows = await listOpenEstimatesPg(shopId, remaining);
  return [...protractor, ...pgRows];
}

async function listOpenEstimatesPg(shopId: number, limit: number): Promise<OpenEstimateSummary[]> {
  const db = getDb();
  const rows: any[] = await db.execute(sql`
    SELECT wo.id, wo.work_order_number, wo.status, wo.vehicle, wo.customer,
           wo.customer_concern, wo.grand_total, wo.provenance, wo.updated_at,
           (SELECT count(*) FROM normalized_service_jobs sj
             WHERE sj.work_order_id = wo.id
               AND sj.status IN ('deferred','declined')
               AND (sj.soft_delete->>'isDeleted')::boolean IS NOT TRUE) AS deferred_count
    FROM normalized_work_orders wo
    WHERE wo.shop_id = ${shopId}
      AND (wo.soft_delete->>'isDeleted')::boolean IS NOT TRUE
      AND wo.is_internal = false
      AND wo.status NOT IN ('invoiced','paid','closed','voided','archived')
      AND wo.grand_total::numeric > 0
      AND EXISTS (
        SELECT 1 FROM normalized_service_jobs sj
        WHERE sj.work_order_id = wo.id
          AND (sj.soft_delete->>'isDeleted')::boolean IS NOT TRUE
      )
    ORDER BY wo.updated_at DESC NULLS LAST
    LIMIT ${limit}
  `);
  return rows.map((r) => ({
    workOrderId: r.id,
    workOrderNumber: r.work_order_number,
    status: r.status,
    vehicle: r.vehicle
      ? { year: r.vehicle.year, make: r.vehicle.make, model: r.vehicle.model }
      : null,
    customerFirstName:
      r.customer?.firstName || r.customer?.first_name ||
      (typeof r.customer?.name === "string" ? r.customer.name.split(/\s+/)[0] : null) || null,
    customerConcern: r.customer_concern,
    grandTotal:
      Math.round((Number(r.grand_total) || 0) *
        (r.provenance?.sourceSystem === "tekmetric" ? 0.01 : 1) * 100) / 100,
    deferredCount: Number(r.deferred_count) || 0,
    updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
  }));
}

async function fetchProtractorContext(
  shopId: number,
  workOrderId: string,
): Promise<SalesCoachScenarioContext | null> {
  const doc = await findCachedWorkOrderById(shopId, workOrderId);
  if (!doc || !doc.pricing?.grandTotal) return null;
  const summaries: any[] = Array.isArray(doc.packageSummaries) ? doc.packageSummaries : [];
  const jobs = summaries
    .filter((p) => p && typeof p.title === "string")
    .map((p) => ({
      title: p.title,
      status: "pending",
      total: Math.round((Number(p.total) || 0) * 100) / 100,
      laborTotal: Math.round((Number(p.laborTotal) || 0) * 100) / 100,
      partsTotal: Math.round((Number(p.partsTotal) || 0) * 100) / 100,
      laborHours: null,
      declined: false,
      declineReason: null,
    }))
    // Keep priced packages; unpriced boilerplate (courtesy check, notes)
    // isn't sellable content.
    .filter((j) => j.total > 0);
  if (!jobs.length) return null;

  let vehicle: SalesCoachScenarioContext["vehicle"] = null;
  if (doc.vin) {
    try {
      const v = await findVehicleByShopAndVin(shopId, doc.vin);
      if (v) vehicle = { year: v.year ?? undefined, make: v.make ?? undefined, model: v.model ?? undefined };
    } catch { /* best-effort */ }
  }
  const firstName =
    typeof doc.contactName === "string" && doc.contactName.trim()
      ? doc.contactName.trim().split(/\s+/)[0]
      : null;
  return {
    vehicle,
    customerFirstName: firstName,
    customerConcern: null,
    odometerIn: doc.odometer ?? null,
    workOrderNumber: doc.workOrderNumber != null ? String(doc.workOrderNumber) : null,
    grandTotal: Math.round((Number(doc.pricing.grandTotal) || 0) * 100) / 100,
    jobs,
    declinedTotal: 0,
    provider: "protractor",
    closedDate: null,
  };
}

async function fetchWorkOrderContext(
  shopId: number,
  workOrderId: string,
): Promise<SalesCoachScenarioContext | null> {
  if (workOrderId.startsWith(PWO_PREFIX)) {
    return fetchProtractorContext(shopId, workOrderId.slice(PWO_PREFIX.length));
  }
  const db = getDb();
  const rows: any[] = await db.execute(sql`
    SELECT wo.id, wo.shop_id, wo.work_order_number, wo.vehicle, wo.customer,
           wo.customer_concern, wo.odometer_in, wo.grand_total, wo.closed_date, wo.provenance
    FROM normalized_work_orders wo
    WHERE wo.id = ${workOrderId} AND wo.shop_id = ${shopId}
    LIMIT 1
  `);
  const row = rows[0] as CandidateRow | undefined;
  if (!row) return null;
  const jobs = await fetchJobs(row.id);
  if (!jobs.length) return null;
  return buildContext(row, jobs);
}

function contextHash(ctx: SalesCoachScenarioContext): string {
  // Hash only estimate-shaping fields so cosmetic churn doesn't bust the cache.
  const basis = JSON.stringify({
    g: ctx.grandTotal,
    j: ctx.jobs.map((j) => [j.title, j.total, j.status, j.declined]),
    c: ctx.customerConcern,
  });
  return createHash("sha256").update(basis).digest("hex").slice(0, 32);
}

const MODEL = "gpt-4o";

async function generateScript(ctx: SalesCoachScenarioContext): Promise<SalesScript> {
  const openai = getOpenAI();
  const jobs = ctx.jobs
    .map((j) =>
      `- ${j.title} — $${j.total.toFixed(2)}${j.declined ? " [DEFERRED/DECLINED]" : ""}`)
    .join("\n");
  const vehicle = ctx.vehicle
    ? `${ctx.vehicle.year ?? ""} ${ctx.vehicle.make ?? ""} ${ctx.vehicle.model ?? ""}`.trim()
    : "the vehicle";
  const start = Date.now();
  const completion = await openai.chat.completions.create({
    model: MODEL,
    messages: [
      {
        role: "system",
        content: `You are an elite automotive service-advisor sales coach. Write the exact words a service advisor should say when calling a customer to present this estimate. Warm, confident, plain-spoken — no jargon, no pressure tactics. Use the REAL jobs and prices given. Build value (safety, reliability, cost-of-delay) before or alongside price. Presenting one grand total for the visit is the default structure; mention individual prices only where it strengthens the pitch. If deferred/declined items exist, include a brief empathetic recovery attempt; otherwise omit that entirely.

Return ONLY a JSON object:
{
  "opening": "greeting + reason for the call",
  "concernAcknowledgment": "1-2 sentences addressing the customer's stated concern, or null if no concern is listed",
  "valuePoints": [{"job": "job title", "talkingPoint": "one-sentence value framing"}],
  "totalPresentation": "how to present the total",
  "deferredRecovery": "empathetic recovery of deferred/declined items, or null if there are none",
  "close": "clear next step / ask for the go-ahead",
  "fullScript": "the complete pitch as one flowing paragraph the advisor can read aloud"
}
valuePoints: only the 3-5 most important jobs.`,
      },
      {
        role: "user",
        content: [
          `Vehicle: ${vehicle}${ctx.odometerIn ? ` at ${ctx.odometerIn.toLocaleString()} miles` : ""}`,
          ctx.customerFirstName ? `Customer first name: ${ctx.customerFirstName}` : null,
          ctx.customerConcern ? `Customer's stated concern: ${ctx.customerConcern}` : "No stated concern on the RO.",
          `Estimate total: $${ctx.grandTotal.toFixed(2)}`,
          `Jobs on the estimate:\n${jobs}`,
        ].filter(Boolean).join("\n"),
      },
    ],
    temperature: 0.5,
    max_tokens: 900,
    response_format: { type: "json_object" },
  });
  trackOpenAiCall(null, ROUTE, completion, Date.now() - start);

  let parsed: any = {};
  try {
    parsed = JSON.parse(completion.choices[0]?.message?.content || "{}");
  } catch { /* defaults below */ }
  return {
    opening: String(parsed.opening ?? ""),
    concernAcknowledgment: parsed.concernAcknowledgment ? String(parsed.concernAcknowledgment) : null,
    valuePoints: Array.isArray(parsed.valuePoints)
      ? parsed.valuePoints
          .filter((v: any) => v && v.job && v.talkingPoint)
          .map((v: any) => ({ job: String(v.job), talkingPoint: String(v.talkingPoint) }))
          .slice(0, 6)
      : [],
    totalPresentation: String(parsed.totalPresentation ?? ""),
    deferredRecovery: parsed.deferredRecovery ? String(parsed.deferredRecovery) : null,
    close: String(parsed.close ?? ""),
    fullScript: String(parsed.fullScript ?? ""),
  };
}

export interface SalesScriptResult {
  workOrderId: string;
  context: SalesCoachScenarioContext;
  script: SalesScript;
  cached: boolean;
  generatedAt: string;
}

export async function getOrGenerateScript(
  shopId: number,
  workOrderId: string,
): Promise<SalesScriptResult | null> {
  const ctx = await fetchWorkOrderContext(shopId, workOrderId);
  if (!ctx) return null;
  const hash = contextHash(ctx);
  const db = getDb();

  const existing = await db
    .select()
    .from(salesScriptCache)
    .where(and(eq(salesScriptCache.workOrderId, workOrderId), eq(salesScriptCache.contextHash, hash)))
    .limit(1);
  if (existing[0]) {
    return {
      workOrderId,
      context: ctx,
      script: existing[0].script,
      cached: true,
      generatedAt: existing[0].createdAt.toISOString(),
    };
  }

  const script = await generateScript(ctx);
  await db
    .insert(salesScriptCache)
    .values({ shopId, workOrderId, contextHash: hash, script, model: MODEL })
    .onConflictDoNothing();
  return {
    workOrderId,
    context: ctx,
    script,
    cached: false,
    generatedAt: new Date().toISOString(),
  };
}
