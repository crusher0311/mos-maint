import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDb } from "@/lib/mongo";
import { fetchCannedJobsWithCache } from "@/lib/integrations/protractor";

function extractLines(raw: any): any[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (raw?.ItemCollection) return raw.ItemCollection;
  return [];
}

function normalizeLines(lines: any[]): any[] {
  return lines.map((l: any) => ({
    description: l.Description || l.description || "",
    lineType: l.Type || l.LineType || l.lineType || "Labor",
    quantity: l.Quantity ?? l.quantity ?? 1,
    unitPrice: l.Price ?? l.UnitPrice ?? l.unitPrice ?? 0,
    partNumber: l.PartNumber || l.partNumber || "",
    manufacturer: l.Manufacturer || l.manufacturer || "",
    rank: l.Rank ?? undefined,
  }));
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

    const shopId = Number(user.shopId);
    const q = req.nextUrl.searchParams.get("q")?.trim() || "";

    const rawCache = await db.collection("protractor_canned_jobs").findOne({ shopId });
    const rawItems = rawCache?.items || [];

    let useRaw = rawItems.length > 0;

    let jobs: any[];
    if (useRaw) {
      jobs = rawItems.map((j: any) => {
        const rawLines = extractLines(j.ServicePackageLines);
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
        lines: [],
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
