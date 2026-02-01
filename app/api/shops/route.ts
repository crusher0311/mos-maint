import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import sql from "@/lib/db/postgres";
import { getNextShopId } from "@/lib/ids";
import { createHovercodeQR } from "@/lib/hovercode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const { name } = await req.json();
    if (!name || typeof name !== "string" || !name.trim()) {
      return NextResponse.json({ error: "Missing name" }, { status: 400 });
    }

    const webhookToken = crypto.randomBytes(12).toString("hex");
    const now = new Date();

    const MAX_TRIES = 5;
    for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
      const numericId = await getNextShopId();
      const shopId = String(numericId);
      const shopName = name.trim();

      try {
        await sql`
          INSERT INTO shops (shop_id, name, webhook_token, created_at, updated_at)
          VALUES (${shopId}, ${shopName}, ${webhookToken}, ${now}, ${now})
        `;
        
        createHovercodeQR({ shopId: numericId, shopName }).then(async (result) => {
          if (result.success && result.hovercodeId) {
            try {
              const stickerConfig = {
                hovercodeQRId: result.hovercodeId,
                hovercodeShortUrl: result.shortUrl,
                hovercodeProvisionedAt: new Date().toISOString(),
              };
              await sql`
                UPDATE shops SET settings = settings || ${JSON.stringify({ stickerConfig })}::jsonb
                WHERE shop_id = ${shopId}
              `;
              console.log(`[Shops] HoverCode QR ${result.hovercodeId} linked to shop ${numericId}`);
            } catch (updateErr) {
              console.error(`[Shops] Failed to save HoverCode ID to shop ${numericId}:`, updateErr);
            }
          }
        }).catch(err => {
          console.error(`[Shops] HoverCode provisioning error for shop ${numericId}:`, err);
        });

        return NextResponse.json({
          shop: { shopId: numericId, name: shopName, webhookToken },
        });
      } catch (err: unknown) {
        const pgErr = err as { code?: string };
        if (pgErr.code === "23505" && attempt < MAX_TRIES) {
          continue;
        }
        throw err;
      }
    }

    return NextResponse.json(
      { error: "Could not allocate a unique shopId after multiple attempts" },
      { status: 500 }
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
