import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shopId = String(session.shopId);

  const countRows = await sql`
    SELECT 
      (SELECT COUNT(*)::int FROM job_index WHERE shop_id = ${shopId}) as jobs_indexed,
      (SELECT COUNT(*)::int FROM part_cross_ref WHERE shop_id = ${shopId}) as parts_indexed
  `;
  const counts = countRows[0];

  return NextResponse.json({
    ok: true,
    jobsIndexed: counts?.jobs_indexed || 0,
    partsIndexed: counts?.parts_indexed || 0,
  });
}
