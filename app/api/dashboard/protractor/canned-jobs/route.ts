import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDb } from "@/lib/mongo";
import { fetchCannedJobsWithCache, normalizeProtractorPackageLine, isCannedJobsCacheContentBlank } from "@/lib/integrations/protractor";

function extractLines(raw: any): any[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (raw?.ItemCollection) return raw.ItemCollection;
  return [];
}

function normalizeLines(lines: any[]): any[] {
  // Use the shared Protractor line normalizer so canned-job pricing carried
  // under PriceSummary.SellPrice or labor Rate/Hours isn't zeroed here before
  // it reaches the New Work Order modal and the create-work-order push.
  return lines.map((l: any) => normalizeProtractorPackageLine(l));
}

export async function GET(req: NextRequest) {
  try {
    const store = await cookies();
    const sid = store.get("sid")?.value ?? store.get("session_token")?.value;
    if (!sid) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const db = await getDb();
    const sess = await db.collection("sessions").findOne({ token: sid, expiresAt: { $gt: new Date() } });
    if (!sess) {
      return NextResponse.json({ error: "Session expired" }, { status: 401 });
    }

    const user = await db.collection("users").findOne({ _id: sess.userId });
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const shopId = Number(sess.shopId);
    const q = req.nextUrl.searchParams.get("q")?.trim() || "";

    const rawCache = await db.collection("protractor_canned_jobs").findOne({ shopId });
    const rawItems = rawCache?.items || [];

    // Task #891: never serve a cache whose items are (nearly) all blank —
    // shop 66 had 735 title-less, line-less items stamped "enriched", so
    // this route matched nothing by name and add pushed empty "Untitled"
    // shells. Fall through to fetchCannedJobsWithCache, which now detects
    // the poisoned cache itself and re-fetches + re-enriches.
    const useRaw = rawItems.length > 0 && !isCannedJobsCacheContentBlank(rawItems);

    let jobs: any[];
    if (useRaw) {
      jobs = rawItems.map((j: any) => {
        const rawLines = Array.isArray(j.lines) ? j.lines : extractLines(j.ServicePackageLines);
        return {
          id: j.ID || j.id || j.Code || "",
          title: j.ServicePackageHeader?.Title || j.Title || j.title || "",
          description: j.ServicePackageHeader?.Description || j.Description || j.description || "",
          chapter: j.Chapter || j.chapter || "",
          code: j.Code || j.code || "",
          laborHours: j.LaborHours ?? j.laborHours ?? null,
          laborRate: j.LaborRate ?? j.laborRate ?? null,
          lines: normalizeLines(rawLines),
        };
      });
    } else {
      const result = await fetchCannedJobsWithCache(shopId);
      if (!result.ok || !result.cannedJobs) {
        return NextResponse.json({ error: result.error || "Failed to fetch canned jobs" }, { status: 500 });
      }
      jobs = result.cannedJobs.map((j: any) => ({
        id: j.id || j.ID || "",
        title: j.title || j.Title || "",
        description: j.description || j.Description || "",
        chapter: j.chapter || j.Chapter || "",
        code: j.code || j.Code || "",
        laborHours: j.laborHours ?? j.LaborHours ?? null,
        laborRate: j.laborRate ?? j.LaborRate ?? null,
        // fetchCannedJobsWithCache now carries normalized lines through
        // (task #891) so add-to-work-order can push a fully-populated job.
        lines: Array.isArray(j.lines) ? j.lines : [],
      }));
    }

    if (q) {
      const lower = q.toLowerCase();
      jobs = jobs.filter((j: any) =>
        (j.title && j.title.toLowerCase().includes(lower)) ||
        (j.description && j.description.toLowerCase().includes(lower)) ||
        (j.code && j.code.toLowerCase().includes(lower))
      );
    }

    jobs = jobs.slice(0, 50);

    return NextResponse.json({ ok: true, jobs });
  } catch (err: any) {
    console.error("[Canned Jobs Search] Error:", err.message);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
