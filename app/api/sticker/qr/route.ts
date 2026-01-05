import { NextRequest, NextResponse } from "next/server";
import QRCodeStyling from "qr-code-styling";
import { JSDOM } from "jsdom";
import nodeCanvas from "canvas";
import { getSession } from "@/lib/auth";
import { getStickerRedirectUrl } from "@/lib/sticker-utils";
import path from "path";
import fs from "fs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LOGO_PATH = path.join(process.cwd(), "public", "sticker-qr-logo.png");

type DotType = "rounded" | "dots" | "classy" | "classy-rounded" | "square" | "extra-rounded";

interface QROptions {
  size?: number;
  dotStyle?: DotType;
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
    color = "#000000",
    backgroundColor = "#ffffff",
    includeLogo = true,
  } = options;

  let logoBase64: string | undefined;
  if (includeLogo && fs.existsSync(DEFAULT_LOGO_PATH)) {
    const logoBuffer = fs.readFileSync(DEFAULT_LOGO_PATH);
    logoBase64 = `data:image/png;base64,${logoBuffer.toString("base64")}`;
  }

  const qrCode = new QRCodeStyling({
    jsdom: JSDOM,
    nodeCanvas,
    width: size,
    height: size,
    data: url,
    margin: 10,
    qrOptions: {
      errorCorrectionLevel: "H",
    },
    dotsOptions: {
      color: color,
      type: dotStyle,
    },
    cornersSquareOptions: {
      color: color,
      type: "extra-rounded",
    },
    cornersDotOptions: {
      color: color,
      type: "dot",
    },
    backgroundOptions: {
      color: backgroundColor,
    },
    ...(logoBase64 && {
      image: logoBase64,
      imageOptions: {
        hideBackgroundDots: true,
        imageSize: 0.35,
        margin: 5,
      },
    }),
  } as any);

  const buffer = await qrCode.getRawData("png");
  if (!buffer) {
    throw new Error("Failed to generate QR code buffer");
  }
  if (buffer instanceof Blob) {
    const arrayBuffer = await buffer.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
  return Buffer.from(buffer as Buffer);
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
  const dotStyle = (searchParams.get("dotStyle") || "rounded") as DotType;
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
      dotStyle: dotStyle as DotType,
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
