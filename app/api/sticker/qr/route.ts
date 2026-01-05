import { NextRequest, NextResponse } from "next/server";
import QRCode from "qrcode";
import { createCanvas, loadImage } from "canvas";
import { getSession } from "@/lib/auth";
import { getStickerRedirectUrl } from "@/lib/sticker-utils";
import path from "path";
import fs from "fs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LOGO_PATH = path.join(process.cwd(), "public", "sticker-qr-logo.png");

interface QROptions {
  size?: number;
  color?: string;
  backgroundColor?: string;
  includeLogo?: boolean;
}

async function generateStyledQR(
  url: string,
  options: QROptions = {}
): Promise<Buffer> {
  const {
    size = 300,
    color = "#000000",
    backgroundColor = "#ffffff",
    includeLogo = true,
  } = options;

  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = backgroundColor;
  ctx.fillRect(0, 0, size, size);

  const qrDataUrl = await QRCode.toDataURL(url, {
    width: size,
    margin: 1,
    color: { dark: color, light: backgroundColor },
    errorCorrectionLevel: "H",
  });

  const qrImage = await loadImage(qrDataUrl);
  ctx.drawImage(qrImage, 0, 0, size, size);

  if (includeLogo && fs.existsSync(DEFAULT_LOGO_PATH)) {
    try {
      const logo = await loadImage(DEFAULT_LOGO_PATH);
      const logoSize = size * 0.25;
      const logoX = (size - logoSize) / 2;
      const logoY = (size - logoSize) / 2;

      const padding = logoSize * 0.15;
      ctx.fillStyle = backgroundColor;
      ctx.beginPath();
      ctx.roundRect(
        logoX - padding,
        logoY - padding,
        logoSize + padding * 2,
        logoSize + padding * 2,
        8
      );
      ctx.fill();

      ctx.drawImage(logo, logoX, logoY, logoSize, logoSize);
    } catch (err) {
      console.error("[Sticker QR] Logo loading failed:", err);
    }
  }

  return canvas.toBuffer("image/png");
}

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
  const size = parseInt(searchParams.get("size") || "300", 10);
  const color = searchParams.get("color") || "#000000";
  const backgroundColor = searchParams.get("backgroundColor") || "#ffffff";
  const includeLogo = searchParams.get("includeLogo") !== "false";

  try {
    const redirectUrl = getStickerRedirectUrl(shopId);

    const pngBuffer = await generateStyledQR(redirectUrl, {
      size,
      color,
      backgroundColor,
      includeLogo,
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
    const {
      customUrl,
      size = 300,
      color = "#000000",
      backgroundColor = "#ffffff",
      includeLogo = true,
    } = body;

    const redirectUrl = customUrl || getStickerRedirectUrl(shopId);

    const pngBuffer = await generateStyledQR(redirectUrl, {
      size,
      color,
      backgroundColor,
      includeLogo,
    });

    const base64 = pngBuffer.toString("base64");
    const dataUrl = `data:image/png;base64,${base64}`;

    return NextResponse.json({ dataUrl, url: redirectUrl });
  } catch (error) {
    console.error("[Sticker QR POST] Error:", error);
    return NextResponse.json({ error: "Failed to generate QR code" }, { status: 500 });
  }
}
