import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDb } from "@/lib/mongo";
import { fetchCannedJobsWithCache } from "@/lib/integrations/protractor";

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

    const result = await fetchCannedJobsWithCache(shopId);
    if (!result.ok || !result.cannedJobs) {
      return NextResponse.json({ error: result.error || "Failed to fetch canned jobs" }, { status: 500 });
    }

    let jobs = result.cannedJobs.map((j: any) => ({
      id: j.id || j.ID || "",
      title: j.title || j.Title || "",
      description: j.description || j.Description || "",
      chapter: j.chapter || j.Chapter || "",
      code: j.code || j.Code || "",
      laborHours: j.laborHours ?? j.LaborHours ?? null,
      laborRate: j.laborRate ?? j.LaborRate ?? null,
      lines: j.lines || j.ServicePackageLines || undefined,
    }));

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
