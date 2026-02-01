import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";

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

export async function GET(_req: NextRequest) {
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

    const shops = await sql`
      SELECT shop_id, name, sticker_config FROM shops
    `;

    const shopMap = new Map<string, { name: string; linkedQRId?: string }>();
    const linkedQRIds = new Set<string>();
    
    for (const shop of shops) {
      const stickerConfig = shop.sticker_config as Record<string, unknown> | null;
      shopMap.set(String(shop.shop_id), {
        name: shop.name || `Shop ${shop.shop_id}`,
        linkedQRId: stickerConfig?.hovercodeQRId as string | undefined,
      });
      if (stickerConfig?.hovercodeQRId) {
        linkedQRIds.add(stickerConfig.hovercodeQRId as string);
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

    const results: Array<{ shopId: string; hovercodeId: string; status: string }> = [];

    for (const { shopId, hovercodeId } of mappings) {
      if (dryRun) {
        const shopResult = await sql`SELECT shop_id FROM shops WHERE shop_id = ${shopId} LIMIT 1`;
        results.push({
          shopId,
          hovercodeId,
          status: shopResult.length > 0 ? "would_update" : "shop_not_found",
        });
      } else {
        const shopResult = await sql`
          SELECT sticker_config FROM shops WHERE shop_id = ${shopId} LIMIT 1
        `;
        if (shopResult.length > 0) {
          const existingConfig = (shopResult[0]?.sticker_config as Record<string, unknown>) || {};
          const updatedConfig = { ...existingConfig, hovercodeQRId: hovercodeId };
          await sql`
            UPDATE shops SET sticker_config = ${JSON.stringify(updatedConfig)}::jsonb
            WHERE shop_id = ${shopId}
          `;
          results.push({ shopId, hovercodeId, status: "updated" });
        } else {
          results.push({ shopId, hovercodeId, status: "shop_not_found" });
        }
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
