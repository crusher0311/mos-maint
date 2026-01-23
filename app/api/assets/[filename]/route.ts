import { NextRequest, NextResponse } from "next/server";
import { readFile } from "fs/promises";
import path from "path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_FILES: Record<string, string> = {
  "appointment-logo.png": "image/png",
  "sticker-qr-logo.png": "image/png",
};

export async function GET(
  req: NextRequest,
  { params }: { params: { filename: string } }
) {
  const { filename } = params;

  const contentType = ALLOWED_FILES[filename];
  if (!contentType) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  try {
    const filePath = path.join(process.cwd(), "public", filename);
    const fileBuffer = await readFile(filePath);

    return new NextResponse(fileBuffer, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=31536000",
      },
    });
  } catch (error) {
    console.error(`[Assets] Error serving ${filename}:`, error);
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }
}
