import { NextRequest, NextResponse } from "next/server";
import QRCode from "qrcode";
import { getSession } from "@/lib/auth";
import { getStickerRedirectUrl } from "@/lib/sticker-utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shopId = Number(session.shopId);
  if (!shopId) {
    return NextResponse.json({ error: "No shop associated" }, { status: 400 });
  }

  const { searchParams } = new URL(req.url);
  const format = searchParams.get("format") || "png";
  const size = parseInt(searchParams.get("size") || "200", 10);

  try {
    const redirectUrl = getStickerRedirectUrl(shopId);

    if (format === "svg") {
      const svg = await QRCode.toString(redirectUrl, {
        type: "svg",
        width: size,
        margin: 1,
        color: { dark: "#000000", light: "#ffffff" },
      });
      return new NextResponse(svg, {
        headers: { "Content-Type": "image/svg+xml" },
      });
    }

    const pngBuffer = await QRCode.toBuffer(redirectUrl, {
      type: "png",
      width: size,
      margin: 1,
      color: { dark: "#000000", light: "#ffffff" },
    });

    return new NextResponse(new Uint8Array(pngBuffer), {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch (error) {
    console.error("[Sticker QR] Error:", error);
    return NextResponse.json({ error: "Failed to generate QR code" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shopId = Number(session.shopId);
  if (!shopId) {
    return NextResponse.json({ error: "No shop associated" }, { status: 400 });
  }

  try {
    const body = await req.json();
    const { customUrl, size = 200, format = "png" } = body;

    const redirectUrl = customUrl || getStickerRedirectUrl(shopId);

    if (format === "svg") {
      const svg = await QRCode.toString(redirectUrl, {
        type: "svg",
        width: size,
        margin: 1,
      });
      return NextResponse.json({ svg, url: redirectUrl });
    }

    const dataUrl = await QRCode.toDataURL(redirectUrl, {
      type: "image/png",
      width: size,
      margin: 1,
    });

    return NextResponse.json({ dataUrl, url: redirectUrl });
  } catch (error) {
    console.error("[Sticker QR POST] Error:", error);
    return NextResponse.json({ error: "Failed to generate QR code" }, { status: 500 });
  }
}
