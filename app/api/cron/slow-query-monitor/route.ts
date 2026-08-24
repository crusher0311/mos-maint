import { NextRequest, NextResponse } from "next/server";
import { flushSlowQueryBuffer } from "@/lib/slow-query/tracker";
import { checkSlowQuerySpike } from "@/lib/slow-query/alerter";
import { purgeSlowQueries } from "@/lib/data/repositories/slow-queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const RETENTION_DAYS = 30; // matches production_logs
const MAX_ROWS = 500_000; // hard cap so the table can never grow unbounded

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    if (process.env.NODE_ENV === "production") {
      console.error("[SlowQueryMonitor] CRON_SECRET not configured");
      return NextResponse.json({ error: "Not configured" }, { status: 500 });
    }
  } else if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // Push any straggling buffered captures before measuring the window.
    await flushSlowQueryBuffer();
    const purge = await purgeSlowQueries(RETENTION_DAYS, MAX_ROWS);
    const spike = await checkSlowQuerySpike();

    console.log(
      `[SlowQueryMonitor] window=${spike.windowCount} maxMs=${Math.round(spike.windowMaxMs)} baseline=${spike.baselinePerWindow.toFixed(1)} spiking=${spike.spiking} alerted=${spike.alerted} cleared=${spike.cleared} purgedOld=${purge.purgedOld} purgedOverflow=${purge.purgedOverflow}`,
    );

    return NextResponse.json({ ok: true, purge, spike });
  } catch (error: any) {
    console.error("[SlowQueryMonitor] error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
