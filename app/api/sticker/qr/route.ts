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

function drawRoundedRect(
  ctx: any,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
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

  const scale = 4;
  const scaledSize = size * scale;

  const qrMatrix = await QRCode.create(url, { errorCorrectionLevel: "H" });
  const modules = qrMatrix.modules;
  const moduleCount = modules.size;

  const margin = 4;
  const moduleSize = scaledSize / (moduleCount + margin * 2);
  const actualSize = moduleSize * (moduleCount + margin * 2);
  const offset = moduleSize * margin;

  const canvas = createCanvas(actualSize, actualSize);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = backgroundColor;
  ctx.fillRect(0, 0, actualSize, actualSize);
  ctx.fillStyle = color;

  const dotPadding = moduleSize * 0.18;
  const dotSize = moduleSize - dotPadding * 2;
  const cornerRadius = dotSize * 0.2;

  for (let row = 0; row < moduleCount; row++) {
    for (let col = 0; col < moduleCount; col++) {
      if (modules.get(row, col)) {
        const x = offset + col * moduleSize + dotPadding;
        const y = offset + row * moduleSize + dotPadding;
        const isFinderPattern =
          (row < 7 && col < 7) ||
          (row < 7 && col >= moduleCount - 7) ||
          (row >= moduleCount - 7 && col < 7);

        if (!isFinderPattern) {
          drawRoundedRect(ctx, x, y, dotSize, dotSize, cornerRadius);
          ctx.fill();
        }
      }
    }
  }

  const finderSize = 7 * moduleSize;
  const finderPositions = [
    { x: offset, y: offset },
    { x: offset + (moduleCount - 7) * moduleSize, y: offset },
    { x: offset, y: offset + (moduleCount - 7) * moduleSize },
  ];

  ctx.fillStyle = backgroundColor;
  for (const pos of finderPositions) {
    ctx.fillRect(pos.x, pos.y, finderSize, finderSize);
  }

  ctx.fillStyle = color;
  for (const pos of finderPositions) {
    drawRoundedRect(ctx, pos.x, pos.y, finderSize, finderSize, moduleSize);
    ctx.fill();

    ctx.fillStyle = backgroundColor;
    const inner1 = moduleSize;
    drawRoundedRect(
      ctx,
      pos.x + inner1,
      pos.y + inner1,
      finderSize - inner1 * 2,
      finderSize - inner1 * 2,
      moduleSize * 0.6
    );
    ctx.fill();

    ctx.fillStyle = color;
    const inner2 = moduleSize * 2;
    drawRoundedRect(
      ctx,
      pos.x + inner2,
      pos.y + inner2,
      finderSize - inner2 * 2,
      finderSize - inner2 * 2,
      moduleSize * 0.4
    );
    ctx.fill();
  }

  if (includeLogo && fs.existsSync(DEFAULT_LOGO_PATH)) {
    try {
      const logo = await loadImage(DEFAULT_LOGO_PATH);
      const logoSize = actualSize * 0.22;
      const logoX = (actualSize - logoSize) / 2;
      const logoY = (actualSize - logoSize) / 2;
      const padding = logoSize * 0.12;

      ctx.fillStyle = backgroundColor;
      ctx.beginPath();
      ctx.arc(actualSize / 2, actualSize / 2, logoSize / 2 + padding, 0, Math.PI * 2);
      ctx.fill();

      ctx.drawImage(logo, logoX, logoY, logoSize, logoSize);
    } catch (err) {
      console.error("[Sticker QR] Logo loading failed:", err);
    }
  }

  const outputCanvas = createCanvas(size, size);
  const outputCtx = outputCanvas.getContext("2d");
  (outputCtx as any).imageSmoothingEnabled = true;
  (outputCtx as any).imageSmoothingQuality = "high";
  outputCtx.drawImage(canvas, 0, 0, size, size);

  return outputCanvas.toBuffer("image/png");
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
        "Cache-Control": "no-cache",
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
