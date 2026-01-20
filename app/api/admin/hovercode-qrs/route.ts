import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";

interface HovercodeQR {
  id: string;
  destination: string;
  total_scans: number;
  unique_scans: number;
  created_at: string;
  updated_at: string;
  qr_code: string;
  short_url: string;
}

interface HovercodeListResponse {
  count: number;
  next: string | null;
  previous: string | null;
  results: HovercodeQR[];
}

interface MappedQR {
  hovercodeId: string;
  destination: string;
  shopId: string | null;
  shopName: string | null;
  totalScans: number;
  uniqueScans: number;
  createdAt: string;
  alreadyLinked: boolean;
}

function extractShopIdFromUrl(url: string): string | null {
  try {
    const patterns = [
      /\/sticker\/redirect\/([^\/\?]+)/,
      /shopId=([^&]+)/,
      /shop[_-]?id[=\/]([^\/\?&]+)/i,
    ];
    
    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match && match[1]) {
        return match[1];
      }
    }
    return null;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!session.isPlatformAdmin) {
    return NextResponse.json({ error: "Forbidden - platform admin access required" }, { status: 403 });
  }

  const apiToken = process.env.HOVERCODE_API_TOKEN;
  const workspaceId = process.env.HOVERCODE_WORKSPACE_ID;

  if (!apiToken || !workspaceId) {
    return NextResponse.json(
      { error: "HoverCode API not configured" },
      { status: 500 }
    );
  }

  try {
    const allQRs: HovercodeQR[] = [];
    let nextUrl: string | null = `https://hovercode.com/api/v2/workspace/${workspaceId}/hovercodes/?page_size=200`;

    while (nextUrl) {
      const response = await fetch(nextUrl, {
        headers: {
          Authorization: `Token ${apiToken}`,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error("HoverCode API error:", response.status, errorText);
        return NextResponse.json(
          { error: `HoverCode API error: ${response.status}` },
          { status: 502 }
        );
      }

      const data: HovercodeListResponse = await response.json();
      allQRs.push(...data.results);
      nextUrl = data.next;
    }

    const db = await getDb();
    const shops = await db.collection("shops").find(
      {},
      { projection: { shopId: 1, name: 1, "stickerConfig.hovercodeQRId": 1 } }
    ).toArray();

    const shopMap = new Map<string, { name: string; linkedQRId?: string }>();
    const linkedQRIds = new Set<string>();
    
    for (const shop of shops) {
      shopMap.set(String(shop.shopId), {
        name: shop.name || `Shop ${shop.shopId}`,
        linkedQRId: shop.stickerConfig?.hovercodeQRId,
      });
      if (shop.stickerConfig?.hovercodeQRId) {
        linkedQRIds.add(shop.stickerConfig.hovercodeQRId);
      }
    }

    const mappedQRs: MappedQR[] = allQRs.map((qr) => {
      const shopId = extractShopIdFromUrl(qr.destination);
      const shopInfo = shopId ? shopMap.get(shopId) : null;
      
      return {
        hovercodeId: qr.id,
        destination: qr.destination,
        shopId,
        shopName: shopInfo?.name || null,
        totalScans: qr.total_scans,
        uniqueScans: qr.unique_scans,
        createdAt: qr.created_at,
        alreadyLinked: linkedQRIds.has(qr.id),
      };
    });

    const matched = mappedQRs.filter((q) => q.shopId && q.shopName);
    const unmatched = mappedQRs.filter((q) => !q.shopId || !q.shopName);
    const alreadyLinked = mappedQRs.filter((q) => q.alreadyLinked);

    return NextResponse.json({
      total: allQRs.length,
      matched: matched.length,
      unmatched: unmatched.length,
      alreadyLinked: alreadyLinked.length,
      qrCodes: mappedQRs,
    });
  } catch (error) {
    console.error("Error fetching HoverCode QRs:", error);
    return NextResponse.json(
      { error: "Failed to fetch QR codes" },
      { status: 500 }
    );
  }
}

const HOVERCODE_API_BASE = "https://hovercode.com/api/v2/hovercode";

async function createHovercodeQRWithLogo(
  url: string,
  displayName: string
): Promise<{ id: string; error?: string } | null> {
  const apiToken = process.env.HOVERCODE_API_TOKEN;
  const workspaceId = process.env.HOVERCODE_WORKSPACE_ID;

  if (!apiToken || !workspaceId) {
    return null;
  }

  try {
    const response = await fetch(`${HOVERCODE_API_BASE}/create/`, {
      method: "POST",
      headers: {
        Authorization: `Token ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        workspace: workspaceId,
        qr_data: url,
        qr_type: "Link",
        dynamic: true,
        display_name: displayName,
        pattern: "Squares",
        background_color: "#ffffff",
        logo_url: "https://mos-maintenance-mvp.replit.app/appointment.png",
        generate_png: true,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[HoverCode] Create error:", response.status, errorText);
      return { id: "", error: errorText };
    }

    const data = await response.json();
    return { id: data.id };
  } catch (error) {
    console.error("[HoverCode] Create failed:", error);
    return null;
  }
}

export async function PUT(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!session.isPlatformAdmin) {
    return NextResponse.json({ error: "Forbidden - platform admin access required" }, { status: 403 });
  }

  try {
    const body = await req.json();
    const { shopId } = body as { shopId: string | number };

    if (!shopId) {
      return NextResponse.json({ error: "shopId required" }, { status: 400 });
    }

    const db = await getDb();
    const shopIdVariants = [shopId, Number(shopId), String(shopId)];
    const shop = await db.collection("shops").findOne({ shopId: { $in: shopIdVariants } });

    if (!shop) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 });
    }

    const redirectUrl = `https://app.myoilsticker.com/sticker/redirect/${shopId}`;
    const displayName = `${shop.name || `Shop ${shopId}`} - Oil Sticker`;

    const result = await createHovercodeQRWithLogo(redirectUrl, displayName);

    if (!result || !result.id) {
      return NextResponse.json(
        { error: result?.error || "Failed to create HoverCode QR" },
        { status: 500 }
      );
    }

    await db.collection("shops").updateOne(
      { shopId: { $in: shopIdVariants } },
      { $set: { "stickerConfig.hovercodeQRId": result.id } }
    );

    return NextResponse.json({
      ok: true,
      shopId: String(shopId),
      hovercodeId: result.id,
      message: "New QR code created with logo and assigned to shop",
    });
  } catch (error) {
    console.error("Error regenerating QR:", error);
    return NextResponse.json({ error: "Failed to regenerate QR" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!session.isPlatformAdmin) {
    return NextResponse.json({ error: "Forbidden - platform admin access required" }, { status: 403 });
  }

  try {
    const body = await req.json();
    const { mappings, dryRun = true } = body as {
      mappings: Array<{ shopId: string; hovercodeId: string }>;
      dryRun?: boolean;
    };

    if (!mappings || !Array.isArray(mappings)) {
      return NextResponse.json(
        { error: "mappings array required" },
        { status: 400 }
      );
    }

    const db = await getDb();
    const results: Array<{ shopId: string; hovercodeId: string; status: string }> = [];

    for (const { shopId, hovercodeId } of mappings) {
      // Try both string and number versions of shopId
      const shopIdVariants = [shopId, Number(shopId), String(shopId)];
      
      if (dryRun) {
        const shop = await db.collection("shops").findOne({ 
          shopId: { $in: shopIdVariants } 
        });
        results.push({
          shopId,
          hovercodeId,
          status: shop ? "would_update" : "shop_not_found",
        });
      } else {
        const result = await db.collection("shops").updateOne(
          { shopId: { $in: shopIdVariants } },
          { $set: { "stickerConfig.hovercodeQRId": hovercodeId } }
        );
        results.push({
          shopId,
          hovercodeId,
          status: result.matchedCount > 0 ? "updated" : "shop_not_found",
        });
      }
    }

    return NextResponse.json({
      dryRun,
      processed: results.length,
      results,
    });
  } catch (error) {
    console.error("Error applying QR mappings:", error);
    return NextResponse.json(
      { error: "Failed to apply mappings" },
      { status: 500 }
    );
  }
}
