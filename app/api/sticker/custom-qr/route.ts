import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { findStickerQrShop, readCustomStickerQr, saveCustomStickerQr, deleteCustomStickerQr } from "@/lib/data/repositories/sticker-qr";
import { normalizeCustomQr, StickerQrError, MAX_QR_BYTES } from "@/lib/sticker-qr-image";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(req: NextRequest, method: "GET" | "POST" | "DELETE") {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const shopId = Number(session.shopId);
  if (!Number.isSafeInteger(shopId) || shopId <= 0) return NextResponse.json({ error: "No shop associated" }, { status: 400 });
  if (method !== "GET" && !["owner", "admin", "manager"].includes(session.role)) {
    return NextResponse.json({ error: "Manager or higher required" }, { status: 403 });
  }
  try {
    let dataUri: string | undefined;
    if (method === "POST") {
      // Bound actual streamed bytes, not just a caller-controlled content length.
      const reader = req.body?.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      if (!reader) throw new StickerQrError("Choose an image to upload.");
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > MAX_QR_BYTES * 1.4 + 1024) { await reader.cancel(); throw new StickerQrError("Choose a QR image under 500KB."); }
        chunks.push(value);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (!["image/png", "image/jpeg", "image/webp"].includes(body.contentType) ||
          typeof body.base64Data !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.base64Data)) {
        throw new StickerQrError("Choose a PNG, JPEG or WebP image.");
      }
      dataUri = await normalizeCustomQr(Buffer.from(body.base64Data, "base64"));
    }
    if (!await findStickerQrShop(shopId)) return NextResponse.json({ error: "Shop not found" }, { status: 404 });
    if (method === "GET") {
      return new NextResponse(Buffer.from((await readCustomStickerQr(shopId)).split(",")[1], "base64"), {
        headers: { "Content-Type": "image/png", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
      });
    }
    if (method === "DELETE") await deleteCustomStickerQr(shopId);
    else if (dataUri) await saveCustomStickerQr(shopId, dataUri);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof StickerQrError ? error.message : "Unable to process QR image." },
      { status: error instanceof StickerQrError || error instanceof SyntaxError ? (method === "GET" ? 404 : 400) : 500 });
  }
}
export const GET = (req: NextRequest) => handle(req, "GET");
export const POST = (req: NextRequest) => handle(req, "POST");
export const DELETE = (req: NextRequest) => handle(req, "DELETE");
