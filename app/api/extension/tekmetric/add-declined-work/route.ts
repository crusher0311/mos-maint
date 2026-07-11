// Task #808: "Add all declined work to RO" for Tekmetric.
//
// The public Tekmetric API has no arbitrary job-create endpoint, so the
// actual writes happen extension-side (background CREATE_TEKMETRIC_JOB using
// the page session). This route does everything the server CAN do safely:
//   1. Lists the vehicle's declined/unauthorized jobs (job_index rows with
//      authorized === false — the same source the VHI plan build uses).
//   2. Resolves the target open repair order (explicit roId from the panel
//      context wins; otherwise the newest non-terminal cached RO by VIN,
//      mirroring /api/tekmetric/apply-canned-job).
//   3. Dedupes against jobs already on that RO (cached RO row's job names,
//      normalized) so "add all" never double-adds work.
// The response is a per-job list the sidepanel loops through, one
// CREATE_TEKMETRIC_JOB per non-duplicate item, reporting per-job results.
import { withExtensionErrorMarker } from "@/lib/extension-route-wrapper";
import { NextRequest, NextResponse } from "next/server";
import { guardExtensionShopRequest } from "@/lib/extension-route-guard";
import { listTekmetricDeferredWorkByVin } from "@/lib/data/repositories/tekmetric-deferred-work";
import {
  findTekmetricWorkOrderByRoId,
  findLatestOpenTekmetricWorkOrderByVin,
} from "@/lib/data/repositories/tekmetric-work-orders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}


function normalizeTitle(s: string): string {
  return (s || "").toLowerCase().replace(/\s+/g, " ").trim();
}

async function _POST(req: NextRequest) {
  try {
    let body: {
      shopId?: string | number;
      vin?: string;
      roId?: string | number;
      jobIds?: string[];
    };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400, headers: corsHeaders });
    }

    const { shopId, vin, roId, jobIds } = body;
    if (!shopId) {
      return NextResponse.json({ error: "shopId is required" }, { status: 400, headers: corsHeaders });
    }
    if (!vin) {
      return NextResponse.json({ error: "vin is required" }, { status: 400, headers: corsHeaders });
    }

    const guard = await guardExtensionShopRequest(req, {
      smsShopId: shopId,
      provider: "tekmetric",
      corsHeaders,
    });
    if (!guard.ok) return guard.response;

    const vinUpper = vin.toUpperCase();
    const declined = await listTekmetricDeferredWorkByVin(guard.mosShopId, vinUpper);
    // Optional subset: the panel can pass the exact jobs the user saw so a
    // freshly-synced decline that arrived after render is never added blind.
    const wantedIds = Array.isArray(jobIds) && jobIds.length > 0 ? new Set(jobIds.map(String)) : null;
    const candidates = wantedIds ? declined.filter((j) => wantedIds.has(String(j.id))) : declined;

    if (candidates.length === 0) {
      return NextResponse.json(
        { ok: true, repairOrderId: null, jobs: [], message: "No declined work found for this vehicle" },
        { headers: corsHeaders },
      );
    }

    // Resolve the target RO. The explicit roId from the sidepanel context is
    // authoritative (it's the RO on screen); the VIN fallback mirrors
    // /api/tekmetric/apply-canned-job's newest-non-terminal cache lookup.
    let targetRoId: number | null = null;
    let cachedRo: any = null;
    if (roId != null && String(roId).trim() !== "" && !isNaN(Number(roId))) {
      targetRoId = Number(roId);
      cachedRo = await findTekmetricWorkOrderByRoId(guard.mosShopId, targetRoId);
    } else {
      cachedRo = await findLatestOpenTekmetricWorkOrderByVin(guard.mosShopId, vinUpper);
      if (cachedRo) {
        const fromWorkOrderId = cachedRo.workOrderId ? Number(cachedRo.workOrderId) : NaN;
        const fromData = cachedRo.data?.id ? Number(cachedRo.data.id) : NaN;
        targetRoId = !isNaN(fromWorkOrderId) ? fromWorkOrderId : !isNaN(fromData) ? fromData : null;
      }
    }

    if (!targetRoId) {
      return NextResponse.json(
        {
          error: "No open repair order found for this vehicle. Open the RO in Tekmetric first.",
          requiresManualEntry: true,
        },
        { status: 404, headers: corsHeaders },
      );
    }

    // Dedup against jobs already on the RO. Fail-open: if the cache row has
    // no job list we return everything and rely on the tech's review — never
    // block the flow on a stale cache.
    const existingNames = new Set<string>();
    const roJobs: any[] = Array.isArray(cachedRo?.data?.jobs) ? cachedRo.data.jobs : [];
    for (const j of roJobs) {
      const name = normalizeTitle(j?.name || j?.title || "");
      if (name) existingNames.add(name);
    }

    const seenTitles = new Set<string>();
    const jobs = candidates.map((j) => {
      const norm = normalizeTitle(j.title);
      let skipped: string | null = null;
      if (existingNames.has(norm)) skipped = "already_on_ro";
      else if (seenTitles.has(norm)) skipped = "duplicate_declined_entry";
      seenTitles.add(norm);
      return {
        id: j.id,
        title: j.title,
        description: j.description,
        originalWorkOrderNumber: j.originalWorkOrderNumber,
        date: j.date,
        lines: j.lines,
        skipped,
      };
    });

    return NextResponse.json(
      {
        ok: true,
        repairOrderId: targetRoId,
        jobs,
        addableCount: jobs.filter((j) => !j.skipped).length,
      },
      { headers: corsHeaders },
    );
  } catch (err: any) {
    console.error("[Extension Add Declined Work] Error:", err?.message);
    return NextResponse.json({ error: "Internal server error" }, { status: 500, headers: corsHeaders });
  }
}

// Task #510: per-shop error-rate alerting — wrap all extension handlers
export const POST = withExtensionErrorMarker(_POST as any);
