// app/api/jobs/stats/route.ts
// Job index statistics

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shopId = Number(session.shopId);
  const db = await getDb();

  // Wave 1 (task #342): part_cross_ref count is canonical in Postgres.
  const { pgCountPartCrossRef } = await import("@/lib/db/repositories/wave1");
  const [jobsIndexed, partsIndexed] = await Promise.all([
    db.collection("job_index").countDocuments({ shopId }),
    pgCountPartCrossRef(shopId),
  ]);

  return NextResponse.json({
    ok: true,
    jobsIndexed,
    partsIndexed,
  });
}
