/**
 * Session-authed ZINK print front door for the web app (task #543,
 * Milestone 3).
 *
 *   GET  /api/print/enqueue  -> { config, defaults, agentOnline }
 *   POST /api/print/enqueue  body -> { success, jobId, status }
 *
 * The Milestone 2 enqueue endpoint (`/api/extension/print`) authenticates
 * with a Chrome-extension token, which the web dashboard does not have.
 * This route is the SAME queue mechanics behind a session cookie instead:
 * it reuses `enqueuePrintJob` / `getPrinterConfig` / `resolveJobOptions`
 * and the shared job/config schema — it adds NO new queue behavior. The
 * shop is taken from the session, so a user can only ever print to their
 * own shop.
 *
 * The GET shape lets the sticker UI decide whether to show a "send to shop
 * printer" action: it only makes sense once a ZINK printer is configured.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { checkShopFeatureGate } from "@/lib/extension-route-guard";
import {
  enqueuePrintJob,
  getPrinterConfig,
  resolveJobOptions,
} from "@/lib/print-queue/repository";
import { toJpegBase64 } from "@/lib/print-queue/render";
import {
  AGENT_ONLINE_THRESHOLD_MS,
  PRINTER_DEFAULTS,
  type ZinkPrintOptions,
} from "@/lib/print-queue/types";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function normalizeOptions(raw: any): ZinkPrintOptions | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const opts: ZinkPrintOptions = {};
  if (raw.width != null) opts.width = Number(raw.width);
  if (raw.cut === 0 || raw.cut === 1) opts.cut = raw.cut;
  if (raw.speed === 0 || raw.speed === 1) opts.speed = raw.speed;
  return Object.keys(opts).length > 0 ? opts : undefined;
}

export async function GET() {
  let session;
  try {
    session = await requireSession();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const gate = await checkShopFeatureGate(session.shopId, ["oil_sticker"], {
    isPlatformAdmin: session.isPlatformAdmin,
    featureLabel: "ZINK Print",
  });
  if (gate) return gate;

  const config = await getPrinterConfig(session.shopId);

  // Derive a coarse "agent online" hint from the most recent poll heartbeat.
  let agentOnline = false;
  try {
    const db = await getDb();
    const hb = await db
      .collection("print_agent_heartbeats")
      .find({ shopId: session.shopId })
      .sort({ lastPollAt: -1 })
      .limit(1)
      .toArray();
    if (hb[0]?.lastPollAt) {
      agentOnline =
        Date.now() - new Date(hb[0].lastPollAt).getTime() < AGENT_ONLINE_THRESHOLD_MS;
    }
  } catch {
    // best-effort only
  }

  return NextResponse.json({
    config: config ?? null,
    defaults: PRINTER_DEFAULTS,
    configured: Boolean(config?.address),
    agentOnline,
  });
}

export async function POST(req: NextRequest) {
  let session;
  try {
    session = await requireSession();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const gate = await checkShopFeatureGate(session.shopId, ["oil_sticker"], {
    isPlatformAdmin: session.isPlatformAdmin,
    featureLabel: "ZINK Print",
  });
  if (gate) return gate;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body?.imageBase64 !== "string" || body.imageBase64.trim() === "") {
    return NextResponse.json(
      { error: "imageBase64 is required" },
      { status: 400 },
    );
  }

  const shopId = session.shopId;
  const type: "sticker" | "keytag" | "raw" =
    body?.type === "keytag" ? "keytag" : body?.type === "sticker" ? "sticker" : "raw";

  let imageBase64: string;
  try {
    imageBase64 = await toJpegBase64(body.imageBase64);
  } catch (err: any) {
    console.error("[Print Enqueue/session] image prep failed:", err?.message);
    return NextResponse.json(
      { error: "Failed to prepare print image", message: err?.message },
      { status: 500 },
    );
  }

  const config = await getPrinterConfig(shopId);
  const options = resolveJobOptions(config, normalizeOptions(body?.options));

  const printerId =
    typeof body?.printerId === "string" && body.printerId.trim() !== ""
      ? body.printerId.trim()
      : null;

  const printer = config?.address
    ? { address: config.address, port: config.port }
    : undefined;

  const jobId = await enqueuePrintJob({
    shopId,
    imageBase64,
    printerId,
    options,
    printer,
    kind: type,
    meta: {
      requestedBy: session.email ?? null,
      roNumber: body?.meta?.roNumber ?? null,
      vin: body?.meta?.vin ?? null,
      source: "web",
    },
  });

  return NextResponse.json(
    { success: true, jobId, status: "pending" },
    { status: 201 },
  );
}
