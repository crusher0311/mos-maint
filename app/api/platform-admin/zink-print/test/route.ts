/**
 * Platform-admin deterministic ZINK acceptance print.
 *
 * POST /api/platform-admin/zink-print/test
 *   body: { shopId, printerId?, cut?, speed? }
 *   -> { ok, jobId, status: "pending" }
 *
 * The endpoint only creates a normal queue job. It never opens a socket or
 * receives a printer-LAN address from the caller, so the shop LAN remains
 * outbound-only behind the local print agent.
 */

import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import {
  enqueuePrintJob,
  getPrinterConfig,
  resolveJobOptions,
} from "@/lib/print-queue/repository";
import { renderPilotTestJpeg } from "@/lib/print-queue/pilot-test";
import type { ZinkPrintOptions } from "@/lib/print-queue/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    await requirePlatformAdmin();

    let body: any;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const shopId = Number(body?.shopId);
    if (!Number.isSafeInteger(shopId) || shopId <= 0) {
      return NextResponse.json({ error: "shopId is required" }, { status: 400 });
    }
    if (body?.cut != null && body.cut !== 0 && body.cut !== 1) {
      return NextResponse.json({ error: "cut must be 0 or 1" }, { status: 400 });
    }
    if (body?.speed != null && body.speed !== 0 && body.speed !== 1) {
      return NextResponse.json({ error: "speed must be 0 or 1" }, { status: 400 });
    }

    const printerId =
      typeof body?.printerId === "string" && body.printerId.trim() !== ""
        ? body.printerId.trim()
        : null;
    const config = await getPrinterConfig(shopId, printerId);
    if (!config?.address) {
      return NextResponse.json(
        { error: "Configure this shop's printer address before sending a test" },
        { status: 409 },
      );
    }

    const override: ZinkPrintOptions = {};
    if (body?.cut === 0 || body?.cut === 1) override.cut = body.cut;
    if (body?.speed === 0 || body?.speed === 1) override.speed = body.speed;
    const options = resolveJobOptions(config, override);
    const imageBase64 = renderPilotTestJpeg(options).toString("base64");

    const jobId = await enqueuePrintJob({
      shopId,
      imageBase64,
      printerId,
      options,
      kind: "raw",
      meta: {
        source: "platform-admin-pilot-test",
        testPattern: "zink-pilot-v1",
        requestedBy: "platform-admin",
      },
    });

    return NextResponse.json(
      { ok: true, jobId, status: "pending" },
      { status: 201 },
    );
  } catch (error: any) {
    if (
      typeof error?.digest === "string" &&
      error.digest.startsWith("NEXT_REDIRECT")
    ) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("[Admin ZINK Print] pilot test enqueue error:", error);
    return NextResponse.json(
      { error: error?.message || "Failed to queue pilot test" },
      { status: 500 },
    );
  }
}