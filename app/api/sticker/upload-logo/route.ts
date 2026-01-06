import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";

async function signObjectURL({
  bucketName,
  objectName,
  method,
  ttlSec,
}: {
  bucketName: string;
  objectName: string;
  method: "GET" | "PUT" | "DELETE" | "HEAD";
  ttlSec: number;
}): Promise<string> {
  const request = {
    bucket_name: bucketName,
    object_name: objectName,
    method,
    expires_at: new Date(Date.now() + ttlSec * 1000).toISOString(),
  };
  const response = await fetch(
    `${REPLIT_SIDECAR_ENDPOINT}/object-storage/signed-object-url`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    }
  );
  if (!response.ok) {
    throw new Error(`Failed to sign object URL: ${response.status}`);
  }
  const { signed_url: signedURL } = await response.json();
  return signedURL;
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

  if (!["owner", "admin", "manager"].includes(session.role)) {
    return NextResponse.json(
      { error: "Insufficient permissions" },
      { status: 403 }
    );
  }

  try {
    const { name, contentType } = await req.json();

    if (!name || !contentType) {
      return NextResponse.json(
        { error: "Missing name or contentType" },
        { status: 400 }
      );
    }

    if (!contentType.startsWith("image/")) {
      return NextResponse.json(
        { error: "Only image files are allowed" },
        { status: 400 }
      );
    }

    const publicPaths = process.env.PUBLIC_OBJECT_SEARCH_PATHS || "";
    const publicPath = publicPaths.split(",")[0]?.trim();

    if (!publicPath) {
      return NextResponse.json(
        { error: "Object storage not configured" },
        { status: 500 }
      );
    }

    const ext = name.split(".").pop() || "png";
    const objectName = `shop-logos/${shopId}/logo-${Date.now()}.${ext}`;
    const fullPath = `${publicPath}/${objectName}`;

    const pathParts = fullPath.split("/").filter(Boolean);
    const bucketName = pathParts[0];
    const objectPath = pathParts.slice(1).join("/");

    const uploadURL = await signObjectURL({
      bucketName,
      objectName: objectPath,
      method: "PUT",
      ttlSec: 900,
    });

    const publicURL = `https://storage.googleapis.com/${bucketName}/${objectPath}`;

    return NextResponse.json({
      uploadURL,
      publicURL,
      objectPath: `/${bucketName}/${objectPath}`,
    });
  } catch (error) {
    console.error("[Upload Logo] Error:", error);
    return NextResponse.json(
      { error: "Failed to generate upload URL" },
      { status: 500 }
    );
  }
}
