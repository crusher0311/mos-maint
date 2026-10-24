import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { customStickerQr, styleStickerQr, StickerQrError } from "./sticker-qr-image";
import { validQrPreferences } from "./sticker-qr-appearance";

/** Resolve source BEFORE invoking any legacy generated/provider path. */
export async function stickerQrResponse(req: NextRequest, generated: () => Promise<Response>, json = false, managerOnly = false): Promise<Response> {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const shopId = Number(session.shopId);
  if (!Number.isSafeInteger(shopId) || shopId <= 0) return NextResponse.json({ error: "No shop associated" }, { status: 400 });
  if (managerOnly && !["owner", "admin", "manager"].includes(session.role)) return NextResponse.json({ error: "Manager or higher required" }, { status: 403 });
  try {
    const db = await getDb();
    const shop = await db.collection("shops").findOne({ shopId }, { projection: { stickerConfig: 1 } });
    if (!shop) return NextResponse.json({ error: "Shop not found" }, { status: 404 });
    const config = shop.stickerConfig || {};
    const p = req.nextUrl.searchParams;
    const prefs = { qrSource: p.get("source") ?? config.qrSource, qrBackgroundMode: p.get("backgroundMode") ?? config.qrBackgroundMode };
    if (!validQrPreferences(prefs)) return NextResponse.json({ error: "Invalid QR preferences" }, { status: 400 });
    let dataUri: string;
    let payload: any;
    if (prefs.qrSource === "custom") dataUri = await customStickerQr(db, shopId);
    else {
      const response = await generated();
      if (!response.ok) return response;
      if (json) {
        payload = await response.json();
        dataUri = payload.dataUrl;
        // Refresh endpoints without an image need no styling.
        if (!dataUri) return NextResponse.json(payload);
      } else dataUri = `data:${response.headers.get("Content-Type") || "image/png"};base64,${Buffer.from(await response.arrayBuffer()).toString("base64")}`;
    }
    const styled = await styleStickerQr(dataUri, prefs, p.get("background") ?? config.designerLayout?.backgroundColor ?? config.colors?.background);
    if (json) return NextResponse.json({ ...payload, dataUrl: styled }, { headers: { "Cache-Control": "private, no-store" } });
    return new NextResponse(Buffer.from(styled.split(",")[1], "base64"), { headers: { "Content-Type": "image/png", "Cache-Control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof StickerQrError ? error.message : "QR image unavailable. Please try again." }, { status: error instanceof StickerQrError ? 409 : 500 });
  }
}
