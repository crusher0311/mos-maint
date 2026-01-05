import { NextRequest, NextResponse } from "next/server";
import { QRCodeCanvas } from "@loskir/styled-qr-code-node";
import { getSession } from "@/lib/auth";
import { getStickerRedirectUrl } from "@/lib/sticker-utils";
import path from "path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LOGO_PATH = path.join(process.cwd(), "public", "sticker-qr-logo.svg");

interface QROptions {
  size?: number;
  format?: "png" | "svg";
  dotStyle?: "rounded" | "dots" | "classy" | "classy-rounded" | "square" | "extra-rounded";
  cornerStyle?: "square" | "dot" | "extra-rounded";
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
    dotStyle = "rounded",
    cornerStyle = "extra-rounded",
    color = "#000000",
    backgroundColor = "#ffffff",
    includeLogo = true,
  } = options;

  const qrConfig: any = {
    width: size,
    height: size,
    data: url,
    margin: 10,
    dotsOptions: {
      color: color,
      type: dotStyle,
    },
    backgroundOptions: {
      color: backgroundColor,
    },
    cornersSquareOptions: {
      color: color,
      type: cornerStyle,
    },
    cornersDotOptions: {
      color: color,
      type: "dot",
    },
    qrOptions: {
      errorCorrectionLevel: "H",
    },
  };

  if (includeLogo) {
    try {
      const fs = await import("fs");
      if (fs.existsSync(DEFAULT_LOGO_PATH)) {
        qrConfig.image = DEFAULT_LOGO_PATH;
        qrConfig.imageOptions = {
          hideBackgroundDots: true,
          imageSize: 0.4,
          margin: 5,
        };
      }
    } catch {
      // Logo not found, continue without it
    }
  }

  const qrCode = new QRCodeCanvas(qrConfig);
  return await qrCode.toBuffer("png");
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
  const dotStyle = (searchParams.get("dotStyle") || "rounded") as QROptions["dotStyle"];
  const color = searchParams.get("color") || "#000000";
  const backgroundColor = searchParams.get("backgroundColor") || "#ffffff";
  const includeLogo = searchParams.get("includeLogo") !== "false";

  try {
    const redirectUrl = getStickerRedirectUrl(shopId);

    const pngBuffer = await generateStyledQR(redirectUrl, {
      size,
      dotStyle,
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
      dotStyle = "rounded",
      color = "#000000",
      backgroundColor = "#ffffff",
      includeLogo = true,
    } = body;

    const redirectUrl = customUrl || getStickerRedirectUrl(shopId);

    const pngBuffer = await generateStyledQR(redirectUrl, {
      size,
      dotStyle,
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
