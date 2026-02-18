import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDb } from "@/lib/mongo";

function normalizeLine(l: any) {
  return {
    description: l.Description || l.description || "",
    lineType: l.Type || l.LineType || l.lineType || "Labor",
    quantity: l.Quantity ?? l.quantity ?? 1,
    unitPrice: l.Price ?? l.UnitPrice ?? l.unitPrice ?? 0,
    partNumber: l.PartNumber || l.partNumber || "",
    manufacturer: l.Manufacturer || l.manufacturer || "",
  };
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

    const vin = req.nextUrl.searchParams.get("vin");
    if (!vin) {
      return NextResponse.json({ error: "vin is required" }, { status: 400 });
    }

    const make = req.nextUrl.searchParams.get("make") || "";
    const model = req.nextUrl.searchParams.get("model") || "";
    const engine = req.nextUrl.searchParams.get("engine") || "";
    const q = req.nextUrl.searchParams.get("q")?.trim() || "";
    const shopId = Number(user.shopId);

    const vinResults = await db.collection("job_index").find({
      shopId,
      'vehicle.vin': vin.toUpperCase(),
      ...(q ? { $or: [
        { 'job.title': { $regex: q, $options: 'i' } },
        { 'job.code': { $regex: q, $options: 'i' } },
      ]} : {}),
    }).sort({ performedAt: -1 }).limit(30).toArray();

    let similarResults: any[] = [];
    if (make && model) {
      const similarQuery: any = {
        shopId,
        'vehicle.vin': { $ne: vin.toUpperCase() },
        'vehicle.make': { $regex: `^${make}$`, $options: 'i' },
        'vehicle.model': { $regex: `^${model}$`, $options: 'i' },
      };
      if (engine) {
        const engineBase = engine.split(' ').slice(0, 2).join(' ');
        if (engineBase.length >= 3) {
          similarQuery['vehicle.engine'] = { $regex: engineBase, $options: 'i' };
        }
      }
      if (q) {
        similarQuery.$or = [
          { 'job.title': { $regex: q, $options: 'i' } },
          { 'job.code': { $regex: q, $options: 'i' } },
        ];
      }
      similarResults = await db.collection("job_index").find(similarQuery)
        .sort({ performedAt: -1 }).limit(30).toArray();
    }

    const seenTitles = new Set<string>();
    const jobs: any[] = [];

    for (const doc of vinResults) {
      const title = doc.job?.title || "";
      const key = title.toLowerCase();
      seenTitles.add(key);
      jobs.push({
        title,
        description: doc.job?.description || "",
        code: doc.job?.code || "",
        chapter: doc.job?.chapter || "",
        workOrderNumber: doc.workOrderNumber || null,
        performedAt: doc.performedAt || null,
        vehicleVin: doc.vehicle?.vin || "",
        vehicleLabel: [doc.vehicle?.year, doc.vehicle?.make, doc.vehicle?.model].filter(Boolean).join(" "),
        matchType: "exact",
        lines: (doc.lines || []).map(normalizeLine),
      });
    }

    for (const doc of similarResults) {
      const title = doc.job?.title || "";
      const key = title.toLowerCase();
      if (seenTitles.has(key)) continue;
      seenTitles.add(key);
      jobs.push({
        title,
        description: doc.job?.description || "",
        code: doc.job?.code || "",
        chapter: doc.job?.chapter || "",
        workOrderNumber: doc.workOrderNumber || null,
        performedAt: doc.performedAt || null,
        vehicleVin: doc.vehicle?.vin || "",
        vehicleLabel: [doc.vehicle?.year, doc.vehicle?.make, doc.vehicle?.model].filter(Boolean).join(" "),
        matchType: "similar",
        lines: (doc.lines || []).map(normalizeLine),
      });
    }

    return NextResponse.json({ ok: true, jobs });
  } catch (err: any) {
    console.error("[Job History Search] Error:", err.message);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
