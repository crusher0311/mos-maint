import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { getCannedJobs } from "@/lib/integrations/tekmetric/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CANNED_JOBS_CACHE_TTL_MS = 20 * 60 * 1000;

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

  const tekShopId = shop.integrations.tekmetric.shopId || shopId;

  try {
    const cached = await db.collection("tekmetric_canned_jobs_cache").findOne({
      tekShopId,
      cachedAt: { $gt: new Date(Date.now() - CANNED_JOBS_CACHE_TTL_MS) }
    });

    if (cached?.categories) {
      return NextResponse.json({ categories: cached.categories });
    }

    const data = await getCannedJobs(tekShopId);
    const jobs = data.content || [];

    const categorySet = new Set<string>();
    for (const job of Array.isArray(jobs) ? jobs : []) {
      if (job.category) categorySet.add(job.category);
      if (job.type) categorySet.add(job.type);
    }

    const categories = Array.from(categorySet).sort();

    await db.collection("tekmetric_canned_jobs_cache").updateOne(
      { tekShopId },
      {
        $set: {
          tekShopId,
          categories,
          cachedAt: new Date()
        }
      },
      { upsert: true }
    ).catch((e: any) => console.warn("[TekJobCategories] Cache write failed:", e.message));

    return NextResponse.json({ categories });
  } catch (err) {
    console.error("[TekJobCategories] Error:", err);
    return NextResponse.json({ categories: [] });
  }
}
