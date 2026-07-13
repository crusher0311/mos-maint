// Task #860.
//
// GET /api/platform-admin/dvi-links
//
// Ingestion health for the DVI share-link pipeline: per-provider counters
// (discovered / fetched / parsed / expired / failed) plus recent links and
// recent failures, so an operator can spot a provider page-format change
// (parse failures spike) or link-expiry losses (expired spike) at a glance.
//
// Placed under the /platform-admin realm (not /admin) so it uses platform
// admin auth and doesn't bounce operators to /dashboard.
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import {
  aggregateDviLinkHealth,
  findRecentDviLinkFailures,
  findRecentDviLinks,
} from "@/lib/data/repositories/dvi-links";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSession();
  if (!session?.isPlatformAdmin) {
    return NextResponse.json(
      { ok: false, error: "Platform admin access required" },
      { status: 403 },
    );
  }

  const [health, failures, recent] = await Promise.all([
    aggregateDviLinkHealth(),
    findRecentDviLinkFailures(50),
    findRecentDviLinks(100),
  ]);

  return NextResponse.json({
    ok: true,
    ingestEnabled: process.env.DVI_LINK_INGEST_ENABLED === "true",
    health,
    failures: failures.map(slimLink),
    recent: recent.map(slimLink),
  });
}

function slimLink(doc: any) {
  return {
    id: String(doc._id),
    provider: doc.provider,
    url: doc.url,
    shopId: doc.shopId,
    vin: doc.vin ?? null,
    workOrderNumber: doc.workOrderNumber ?? null,
    discoveredAt: doc.discoveredAt ?? null,
    fetchStatus: doc.fetchStatus,
    fetchAttempts: doc.fetchAttempts ?? 0,
    lastFetchAt: doc.lastFetchAt ?? null,
    lastFetchHttpStatus: doc.lastFetchHttpStatus ?? null,
    lastFetchError: doc.lastFetchError ?? null,
    parseStatus: doc.parseStatus,
    parseError: doc.parseError ?? null,
    parsedAt: doc.parsedAt ?? null,
    itemCount: doc.report?.items?.length ?? null,
    counts: doc.report?.counts ?? null,
  };
}
