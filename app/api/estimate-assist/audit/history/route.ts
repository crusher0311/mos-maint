import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { ESTIMATE_COLLECTIONS } from "@/lib/estimate-assist/job-knowledge-base";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    const shopId = Number(session.shopId);
    const url = new URL(req.url);
    const limit = Math.min(Number(url.searchParams.get("limit")) || 20, 100);
    const offset = Number(url.searchParams.get("offset")) || 0;
    const startDate = url.searchParams.get("startDate");
    const endDate = url.searchParams.get("endDate");
    const severityFilter = url.searchParams.get("severity");

    const filter: Record<string, unknown> = { shopId };

    if (startDate || endDate) {
      const dateFilter: Record<string, Date> = {};
      if (startDate) dateFilter.$gte = new Date(startDate);
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        dateFilter.$lte = end;
      }
      filter.createdAt = dateFilter;
    }

    if (severityFilter && severityFilter !== "all") {
      filter[`report.findings.severity`] = severityFilter;
    }

    const db = await getDb();
    const collection = db.collection(ESTIMATE_COLLECTIONS.estimateAudits);

    const [audits, totalCount] = await Promise.all([
      collection
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(offset)
        .limit(limit)
        .project({
          _id: 1,
          workOrderId: 1,
          workOrderNumber: 1,
          lineItemCount: 1,
          findingCount: 1,
          score: 1,
          createdAt: 1,
          report: 1,
        })
        .toArray(),
      collection.countDocuments(filter),
    ]);

    return NextResponse.json({
      ok: true,
      audits: audits.map(a => ({
        ...a,
        _id: String(a._id),
      })),
      totalCount,
      limit,
      offset,
    });
  } catch (error: any) {
    console.error("[Estimate Audit History] Error:", error);
    return NextResponse.json({ ok: false, error: error.message || "Failed to fetch audit history" }, { status: 500 });
  }
}
