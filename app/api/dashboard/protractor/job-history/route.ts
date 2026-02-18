import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDb } from "@/lib/mongo";

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

    const vin = req.nextUrl.searchParams.get("vin");
    if (!vin) {
      return NextResponse.json({ error: "vin is required" }, { status: 400 });
    }

    const q = req.nextUrl.searchParams.get("q")?.trim() || "";
    const shopId = Number(user.shopId);

    const query: any = { shopId: shopId, 'vehicle.vin': vin.toUpperCase() };
    if (q) {
      query.$or = [
        { 'job.title': { $regex: q, $options: 'i' } },
        { 'job.code': { $regex: q, $options: 'i' } },
      ];
    }

    const results = await db.collection("job_index").find(query).sort({ performedAt: -1 }).limit(30).toArray();

    const jobs: any[] = [];
    for (const doc of results) {
      const rawLines = doc.lines || [];
      jobs.push({
        title: doc.job?.title || "",
        description: doc.job?.description || "",
        code: doc.job?.code || "",
        chapter: doc.job?.chapter || "",
        workOrderNumber: doc.workOrderNumber || null,
        performedAt: doc.performedAt || null,
        lines: rawLines.map((l: any) => ({
          description: l.Description || l.description || "",
          lineType: l.Type || l.LineType || l.lineType || "Labor",
          quantity: l.Quantity ?? l.quantity ?? 1,
          unitPrice: l.Price ?? l.UnitPrice ?? l.unitPrice ?? 0,
          partNumber: l.PartNumber || l.partNumber || "",
          manufacturer: l.Manufacturer || l.manufacturer || "",
        })),
      });
    }

    return NextResponse.json({ ok: true, jobs });
  } catch (err: any) {
    console.error("[Job History Search] Error:", err.message);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
