import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { collections, workerAvailable } from "@/lib/protractor-exports/store";
import { enqueueProtractorExport } from "@/lib/queue/producer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;
export async function GET(req: Request) {
  const expected = Buffer.from(process.env.CRON_SECRET ? `Bearer ${process.env.CRON_SECRET}` : "");
  const actual = Buffer.from(req.headers.get("authorization") || "");
  if (!expected.length || expected.length !== actual.length || !timingSafeEqual(expected, actual))
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (process.env.PROTRACTOR_EXPORTS_ENABLED !== "1") return NextResponse.json({ skipped: "disabled" });
  try {
    if (!await workerAvailable()) return NextResponse.json({ error: "Export worker unavailable" }, { status: 503 });
    const c = await collections();
    // Fenced scheduler already serializes this cron; durable round-robin makes
    // bounded admission fair even when the enterprise count grows.
    const meta = await c.health.findOne({ _id: "dispatcher" }) as any;
    let config = await c.configs.find({ paused: false, revoked: false,
      _id: { $gt: meta?.after || "" } }).sort({ _id: 1 }).limit(1).next();
    if (!config) config = await c.configs.find({ paused: false, revoked: false }).sort({ _id: 1 }).limit(1).next();
    if (!config) return NextResponse.json({ queued: 0 });
    // Parallel queue I/O has a per-command deadline; payloads contain IDs only.
    const results = await Promise.all(config.shopIds.map(id =>
      enqueueProtractorExport(config!._id, config!.revision, id)));
    if (results.some(r => !r.enqueued && r.reason !== "duplicate"))
      return NextResponse.json({ error: "Export queue unavailable" }, { status: 503 });
    await c.health.updateOne({ _id: "dispatcher" }, { $set: {
      seenAt: new Date(), after: config._id,
    } } as any, { upsert: true });
    return NextResponse.json({ queued: results.length });
  } catch {
    return NextResponse.json({ error: "Export scheduling unavailable" }, { status: 503 });
  }
}
