import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { getCannedJobs } from "@/lib/integrations/tekmetric/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const shopId = Number(session.shopId);

  const db = await getDb();
  const shop = await db.collection("shops").findOne(
    { shopId },
    { projection: { "integrations.tekmetric": 1 } }
  );

  if (!shop?.integrations?.tekmetric?.configured) {
    return NextResponse.json({ categories: [] });
  }

  try {
    const tekmetricShopId = shop.integrations.tekmetric.shopId || shopId;

    const data = await getCannedJobs(tekmetricShopId);
    const jobs = data.content || [];

    const categorySet = new Set<string>();
    for (const job of Array.isArray(jobs) ? jobs : []) {
      if (job.category) categorySet.add(job.category);
      if (job.type) categorySet.add(job.type);
    }

    const categories = Array.from(categorySet).sort();

    return NextResponse.json({ categories });
  } catch (err) {
    console.error("[TekJobCategories] Error:", err);
    return NextResponse.json({ categories: [] });
  }
}
