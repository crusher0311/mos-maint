import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { Storage } from "@google-cloud/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";

const storage = new Storage({
  credentials: {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
    type: "external_account",
    credential_source: {
      url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
      format: {
        type: "json",
        subject_token_field_name: "access_token",
      },
    },
    universe_domain: "googleapis.com",
  },
  projectId: "",
});

export async function GET(
  req: NextRequest,
  { params }: { params: { shopId: string; filename: string } }
) {
  try {
    const shopId = Number(params.shopId);
    console.log("[Logo Proxy] Request for shopId:", shopId, "filename:", params.filename);
    
    if (!shopId || isNaN(shopId)) {
      return NextResponse.json({ error: "Invalid shop ID" }, { status: 400 });
    }

    const db = await getDb();
    const shop = await db.collection("shops").findOne({ shopId });
    
    console.log("[Logo Proxy] Shop found:", !!shop, "logoObjectPath:", shop?.stickerConfig?.logoObjectPath);

    if (!shop?.stickerConfig?.logoObjectPath) {
      return NextResponse.json({ error: "Logo not found" }, { status: 404 });
    }

    const objectPath = shop.stickerConfig.logoObjectPath;
    const pathParts = objectPath.split("/").filter(Boolean);
    
    if (pathParts.length < 2) {
      return NextResponse.json({ error: "Invalid object path" }, { status: 400 });
    }

    const bucketName = pathParts[0];
    const objectName = pathParts.slice(1).join("/");
    const bucket = storage.bucket(bucketName);
    const file = bucket.file(objectName);

    const [exists] = await file.exists();
    if (!exists) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }

    const [metadata] = await file.getMetadata();
    const contentType = metadata.contentType || "image/png";

    const [buffer] = await file.download();

    return new NextResponse(buffer, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=86400",
      },
    });
  } catch (error) {
    console.error("[Logo Proxy] Error:", error);
    return NextResponse.json(
      { error: "Failed to serve logo" },
      { status: 500 }
    );
  }
}
