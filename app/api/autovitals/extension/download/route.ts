import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import * as fs from "fs";
import * as path from "path";
import archiver from "archiver";
// @ts-ignore - archiver types
import { Readable } from "stream";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    await requireSession();
    
    const extensionDir = path.join(process.cwd(), "chrome-extension");
    
    if (!fs.existsSync(extensionDir)) {
      return NextResponse.json(
        { error: "Extension files not found" },
        { status: 404 }
      );
    }

    const chunks: Buffer[] = [];
    const archive = archiver("zip", { zlib: { level: 9 } });
    
    archive.on("data", (chunk: Buffer) => chunks.push(chunk));
    
    const filesToInclude = [
      "manifest.json",
      "popup.html",
      "popup.js",
      "content.js",
      "background.js",
      "sidepanel.html",
      "sidepanel.js",
      "inject.js",
    ];
    
    for (const file of filesToInclude) {
      const filePath = path.join(extensionDir, file);
      if (fs.existsSync(filePath)) {
        archive.file(filePath, { name: file });
      }
    }
    
    const iconsDir = path.join(extensionDir, "icons");
    if (fs.existsSync(iconsDir)) {
      archive.directory(iconsDir, "icons");
    }
    
    await archive.finalize();
    
    const buffer = Buffer.concat(chunks);

    return new NextResponse(buffer, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": 'attachment; filename="mos-autovitals-extension.zip"',
        "Content-Length": buffer.length.toString(),
      },
    });
  } catch (error: any) {
    console.error("[AutoVitals Extension] Download error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to download extension" },
      { status: 500 }
    );
  }
}
