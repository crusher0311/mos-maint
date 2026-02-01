import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { sql } from "@/lib/db/postgres";
import { Storage } from "@google-cloud/storage";
import { createCanvas, loadImage } from "canvas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function trimWhitespace(imageBuffer: Buffer): Promise<Buffer> {
  try {
    const image = await loadImage(imageBuffer);
    const canvas = createCanvas(image.width, image.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0);
    
    const imageData = ctx.getImageData(0, 0, image.width, image.height);
    const { data, width, height } = imageData;
    
    let top = height, left = width, right = 0, bottom = 0;
    const threshold = 250;
    
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 4;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];
        const a = data[idx + 3];
        
        const isTransparent = a < 10;
        const isWhite = r > threshold && g > threshold && b > threshold && a > 200;
        
        if (!isTransparent && !isWhite) {
          if (x < left) left = x;
          if (x > right) right = x;
          if (y < top) top = y;
          if (y > bottom) bottom = y;
        }
      }
    }
    
    if (left > right || top > bottom) {
      return imageBuffer;
    }
    
    const padding = 2;
    left = Math.max(0, left - padding);
    top = Math.max(0, top - padding);
    right = Math.min(width - 1, right + padding);
    bottom = Math.min(height - 1, bottom + padding);
    
    const croppedWidth = right - left + 1;
    const croppedHeight = bottom - top + 1;
    
    if (croppedWidth >= width * 0.9 && croppedHeight >= height * 0.9) {
      return imageBuffer;
    }
    
    const croppedCanvas = createCanvas(croppedWidth, croppedHeight);
    const croppedCtx = croppedCanvas.getContext("2d");
    croppedCtx.drawImage(
      image,
      left, top, croppedWidth, croppedHeight,
      0, 0, croppedWidth, croppedHeight
    );
    
    return croppedCanvas.toBuffer("image/png");
  } catch (error) {
    console.error("[Logo Trim] Error trimming whitespace:", error);
    return imageBuffer;
  }
}

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

    const [originalBuffer] = await file.download();
    const trimmedBuffer = await trimWhitespace(originalBuffer);
    
    if (trimmedBuffer.length !== originalBuffer.length) {
      await file.save(trimmedBuffer, {
        contentType: "image/png",
        metadata: {
          metadata: {
            "custom:aclPolicy": JSON.stringify({
              owner: String(shopId),
              visibility: "public",
            }),
          },
        },
      });
      console.log(`[Logo Trim] Trimmed logo from ${originalBuffer.length} to ${trimmedBuffer.length} bytes`);
    } else {
      await file.setMetadata({
        metadata: {
          "custom:aclPolicy": JSON.stringify({
            owner: String(shopId),
            visibility: "public",
          }),
        },
      });
    }

    const proxyUrl = `/api/sticker/logo/${shopId}/${objectName.split("/").pop()}`;

    const shopRows = await sql`
      SELECT sticker_config FROM shops WHERE shop_id = ${String(shopId)} LIMIT 1
    `;
    const existingConfig = (shopRows[0]?.sticker_config as any) || {};
    const updatedConfig = { 
      ...existingConfig, 
      logo: proxyUrl,
      logoObjectPath: objectPath
    };
    
    await sql`
      UPDATE shops SET sticker_config = ${JSON.stringify(updatedConfig)}::jsonb, updated_at = NOW()
      WHERE shop_id = ${String(shopId)}
    `;

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
