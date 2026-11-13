import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { checkShopFeatureGate, guardExtensionShopRequest } from "@/lib/extension-route-guard";
import { readPrintJsonBody } from "./request-body";
import { getDestinationSettings, setDefaultDestination, getIppStatus, labelKind, IppRequestError, enqueueIpp } from "./ipp-repository";
import { validateStock } from "@/zink-print-agent/src/ipp/media";
import { PrintPayloadTooLargeError } from "./types";
import { isPrintBrowserOrigin } from "./browser-origin";

export const ippCors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS" };
function manager(user: { role?: string; isPlatformAdmin?: boolean }) {
  return user.isPlatformAdmin === true || ["owner", "admin", "manager", "platform_admin"].includes(user.role ?? "");
}
export function ippError(error: unknown, headers?: HeadersInit) {
  if (error instanceof IppRequestError) return NextResponse.json({ error: error.message }, { status: error.status, headers });
  if (error instanceof PrintPayloadTooLargeError) return NextResponse.json({ error: error.message }, { status: 413, headers });
  if (error instanceof SyntaxError) return NextResponse.json({ error: "Invalid JSON" }, { status: 400, headers });
  console.error("[Saved IPP] request failed"); // Never log request contents or credentials.
  return NextResponse.json({ error: "Saved printer service is unavailable" }, { status: 503, headers });
}
export async function webDestinations(req: NextRequest) {
  let session;
  try { session = await requireSession(); } catch { return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); }
  try {
    const body = req.method === "PUT" ? await readPrintJsonBody(req, 4096) : null;
    const kind = labelKind(body?.kind ?? req.nextUrl.searchParams.get("kind"));
    const gate = await checkShopFeatureGate(session.shopId, [kind === "sticker" ? "oil_sticker" : "keytags"],
      { isPlatformAdmin: session.isPlatformAdmin, featureLabel: "Saved printing" });
    if (gate) return gate;
    const canManage = manager(session);
    if (req.method === "PUT") {
      if (!canManage) throw new IppRequestError("Only shop managers can save shop defaults", 403);
      const origin = req.headers.get("origin");
      if (origin && !isPrintBrowserOrigin(req)) throw new IppRequestError("Cross-origin settings write denied", 403);
      await setDefaultDestination(session.shopId, kind, body.destinationId);
    }
    return NextResponse.json(await getDestinationSettings(session.shopId, kind, canManage), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return ippError(error); }
}
export async function webStatus(req: NextRequest) {
  let session;
  try { session = await requireSession(); } catch { return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); }
  try {
    const result = await getIppStatus(session.shopId, req.nextUrl.searchParams.get("jobId") ?? "");
    const gate = await checkShopFeatureGate(session.shopId, [result.kind === "keytag" ? "keytags" : "oil_sticker"],
      { isPlatformAdmin: session.isPlatformAdmin, featureLabel: "Saved printing" });
    return gate ?? NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return ippError(error); }
}
export async function extensionDestinations(req: NextRequest, statusOnly = false) {
  try {
    const body = req.method === "PUT" ? await readPrintJsonBody(req, 4096) : null;
    const kind = labelKind(body?.kind ?? req.nextUrl.searchParams.get("kind"));
    const guard = await guardExtensionShopRequest(req, {
      smsShopId: body?.smsShopId ?? req.nextUrl.searchParams.get("smsShopId"),
      provider: body?.provider ?? req.nextUrl.searchParams.get("provider"),
      requiredFeatures: [kind === "keytag" ? "keytags" : "oil_sticker"],
      requiredCapabilities: req.method === "PUT" ? ["write"] : [],
      featureLabel: "Saved printing", corsHeaders: ippCors,
    });
    if (!guard.ok) return guard.response;
    if (statusOnly) return NextResponse.json(await getIppStatus(guard.mosShopId, req.nextUrl.searchParams.get("jobId") ?? "", kind),
      { headers: { ...ippCors, "Cache-Control": "no-store" } });
    const canManage = guard.isPlatformAdmin || manager(guard.user);
    if (req.method === "PUT") {
      if (!canManage) throw new IppRequestError("Only shop managers can save shop defaults", 403);
      await setDefaultDestination(guard.mosShopId, kind, body.destinationId);
    }
    return NextResponse.json(await getDestinationSettings(guard.mosShopId, kind, canManage),
      { headers: { ...ippCors, "Cache-Control": "no-store" } });
  } catch (error) { return ippError(error, ippCors); }
}

/** Calibration artwork only; does not change customer sticker/keytag rendering. */
async function enqueueTest(shopId: number, body: any) {
  const kind = labelKind(body.kind);
  try { validateStock(body.stock); } catch { throw new IppRequestError("Invalid test stock size"); }
  const { createCanvas } = await import("canvas");
  const scale = Math.min(203 / 2540, 2000 / Math.max(body.stock.width, body.stock.height));
  const width = Math.max(16, Math.round(body.stock.width * scale));
  const height = Math.max(16, Math.round(body.stock.height * scale));
  const canvas = createCanvas(width, height), ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "#000"; ctx.lineWidth = 2; ctx.strokeRect(2, 2, width - 4, height - 4);
  ctx.fillStyle = "#000"; ctx.textAlign = "center";
  ctx.font = `bold ${Math.max(10, Math.round(width / 18))}px sans-serif`;
  ctx.fillText("MOS PRINT TEST", width / 2, height / 3, width - 12);
  ctx.font = `${Math.max(8, Math.round(width / 24))}px sans-serif`;
  ctx.fillText(`${body.stock.width / 100} x ${body.stock.height / 100} mm`, width / 2, height / 2, width - 12);
  ctx.fillText("Measure border and check cut", width / 2, height * 2 / 3, width - 12);
  return enqueueIpp(shopId, { ...body, type: kind, imageBase64: canvas.toBuffer("image/png").toString("base64") });
}
export async function webTest(req: NextRequest) {
  let session;
  try { session = await requireSession(); } catch { return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); }
  try {
    if (!manager(session)) throw new IppRequestError("Only shop managers can send test labels", 403);
    const origin = req.headers.get("origin");
    if (origin && !isPrintBrowserOrigin(req)) throw new IppRequestError("Cross-origin print denied", 403);
    const body = await readPrintJsonBody(req, 4096), kind = labelKind(body.kind);
    const gate = await checkShopFeatureGate(session.shopId, [kind === "keytag" ? "keytags" : "oil_sticker"],
      { isPlatformAdmin: session.isPlatformAdmin, featureLabel: "Saved printing" });
    return gate ?? NextResponse.json(await enqueueTest(session.shopId, body), { status: 201 });
  } catch (error) { return ippError(error); }
}
export async function extensionTest(req: NextRequest) {
  try {
    const body = await readPrintJsonBody(req, 4096), kind = labelKind(body.kind);
    const guard = await guardExtensionShopRequest(req, {
      smsShopId: body.smsShopId, provider: body.provider,
      requiredFeatures: [kind === "keytag" ? "keytags" : "oil_sticker"], requiredCapabilities: ["write"],
      featureLabel: "Saved printing", corsHeaders: ippCors,
    });
    if (!guard.ok) return guard.response;
    if (!guard.isPlatformAdmin && !manager(guard.user)) throw new IppRequestError("Only shop managers can send test labels", 403);
    return NextResponse.json(await enqueueTest(guard.mosShopId, body), { status: 201, headers: ippCors });
  } catch (error) { return ippError(error, ippCors); }
}
