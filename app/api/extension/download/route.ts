import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

export async function GET() {
  try {
    const zipPath = path.join(process.cwd(), "public", "mos-tools-extension.zip");
    
    if (!fs.existsSync(zipPath)) {
      return NextResponse.json({ error: "Extension package not found" }, { status: 404 });
    }
    
    const fileBuffer = fs.readFileSync(zipPath);
    
    return new NextResponse(fileBuffer, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": "attachment; filename=mos-tools-extension.zip",
        "Content-Length": fileBuffer.length.toString()
      }
    });
  } catch (error) {
    console.error("Download error:", error);
    return NextResponse.json({ error: "Failed to download extension" }, { status: 500 });
  }
}
