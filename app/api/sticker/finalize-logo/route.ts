import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
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

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shopId = Number(session.shopId);
  if (!shopId) {
    return NextResponse.json({ error: "No shop associated" }, { status: 400 });
  }

  if (!["owner", "admin", "manager"].includes(session.role)) {
    return NextResponse.json(
      { error: "Insufficient permissions" },
      { status: 403 }
    );
  }

  try {
    const { objectPath, publicURL } = await req.json();

    if (!objectPath || !publicURL) {
      return NextResponse.json(
        { error: "Missing objectPath or publicURL" },
        { status: 400 }
      );
    }

    const pathParts = objectPath.split("/").filter(Boolean);
    if (pathParts.length < 2) {
      return NextResponse.json(
        { error: "Invalid object path" },
        { status: 400 }
      );
    }

    const bucketName = pathParts[0];
    const objectName = pathParts.slice(1).join("/");
    const bucket = storage.bucket(bucketName);
    const file = bucket.file(objectName);

    const [exists] = await file.exists();
    if (!exists) {
      return NextResponse.json(
        { error: "Uploaded file not found" },
        { status: 404 }
      );
    }

    await file.setMetadata({
      metadata: {
        "custom:aclPolicy": JSON.stringify({
          owner: String(shopId),
          visibility: "public",
        }),
      },
    });

    const proxyUrl = `/api/sticker/logo/${shopId}/${objectName.split("/").pop()}`;

    const db = await getDb();
    await db.collection("shops").updateOne(
      { id: shopId },
      {
        $set: {
          "stickerConfig.logo": proxyUrl,
          "stickerConfig.logoObjectPath": objectPath,
          updatedAt: new Date(),
        },
      }
    );

    return NextResponse.json({
      success: true,
      logoUrl: proxyUrl,
    });
  } catch (error) {
    console.error("[Finalize Logo] Error:", error);
    return NextResponse.json(
      { error: "Failed to finalize logo upload" },
      { status: 500 }
    );
  }
}
