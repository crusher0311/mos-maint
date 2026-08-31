// Task #991 — Auto DVI media upload (dashboard session): multipart photo or
// video attached to an inspection item. Stored in Mongo GridFS (works on
// both Replit dev and Render prod — the Replit object-storage sidecar does
// not exist on Render). Tight caps keep the shared cluster safe.

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { checkShopFeatureGate } from "@/lib/extension-route-guard";
import { storeInspectionMedia, readInspectionResults } from "@/lib/data/repositories/auto-dvi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const VIDEO_TYPES = new Set(["video/mp4", "video/webm", "video/quicktime"]);
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const MAX_VIDEO_BYTES = 40 * 1024 * 1024;
const MAX_MEDIA_PER_ITEM = 6;

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const shopId = Number(session.shopId);
  const denied = await checkShopFeatureGate(shopId, ["maintenance", "auto_dvi"], {
    isPlatformAdmin: session.role === "platform_admin" && !session.isImpersonation,
    featureLabel: "Auto DVI",
  });
  if (denied) return denied;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart form data" }, { status: 400 });
  }
  const vin = String(form.get("vin") || "").toUpperCase().trim();
  const itemId = String(form.get("itemId") || "").trim();
  const itemName = String(form.get("itemName") || "").trim();
  const file = form.get("file");
  if (!vin || !itemId || !(file instanceof File)) {
    return NextResponse.json({ error: "vin, itemId, and file are required" }, { status: 400 });
  }

  const contentType = file.type || "application/octet-stream";
  const isPhoto = PHOTO_TYPES.has(contentType);
  const isVideo = VIDEO_TYPES.has(contentType);
  if (!isPhoto && !isVideo) {
    return NextResponse.json(
      { error: "Unsupported file type — photos (jpeg/png/webp/gif) or videos (mp4/webm/mov) only" },
      { status: 400 },
    );
  }
  const maxBytes = isVideo ? MAX_VIDEO_BYTES : MAX_PHOTO_BYTES;
  if (file.size > maxBytes) {
    return NextResponse.json(
      { error: `File too large (max ${Math.round(maxBytes / 1024 / 1024)}MB for ${isVideo ? "videos" : "photos"})` },
      { status: 400 },
    );
  }

  const existing = await readInspectionResults(shopId, vin);
  const item = existing?.items.find((it) => it.itemId === itemId);
  if ((item?.media?.length || 0) >= MAX_MEDIA_PER_ITEM) {
    return NextResponse.json({ error: `Max ${MAX_MEDIA_PER_ITEM} attachments per item` }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const ref = await storeInspectionMedia({
    shopId,
    vinUpper: vin,
    itemId,
    itemName: itemName || itemId,
    kind: isVideo ? "video" : "photo",
    contentType,
    filename: file.name || null,
    buffer,
  });
  return NextResponse.json({ ok: true, media: ref, url: `/api/auto-dvi/media/${ref.mediaId}` });
}
