import { NextRequest, NextResponse } from "next/server";
import { createExternalEndpoint } from "@/lib/external-api/middleware";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function safeInt(val: string | null, fallback: number, min: number, max: number): number {
  if (!val) return fallback;
  const parsed = parseInt(val, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export const GET = createExternalEndpoint(
  "shops:read",
  async (req: NextRequest, { shopId, isPartner }) => {
    const db = await getDb();

    if (!isPartner) {
      const shop = await db.collection("shops").findOne(
        { shopId: { $in: [String(shopId), Number(shopId)] } },
        {
          projection: {
            _id: 0,
            shopId: 1,
            name: 1,
            integrationProvider: 1,
            "tekmetric.shopId": 1,
            "shopware.swShopId": 1,
            "shopware.tenantId": 1,
            protractorConnectionId: 1,
            "autoflow.domain": 1,
            locationIdentifier: 1,
            status: 1,
          },
        }
      );

      if (!shop) {
        return NextResponse.json(
          { error: "Shop not found" },
          { status: 404 }
        );
      }

      return NextResponse.json({
        success: true,
        shops: [formatShop(shop)],
        total: 1,
      });
    }

    const page = safeInt(req.nextUrl.searchParams.get("page"), 1, 1, 1000);
    const limit = safeInt(req.nextUrl.searchParams.get("limit"), 50, 1, 100);
    const search = (req.nextUrl.searchParams.get("search") || "").trim().slice(0, 100) || null;
    const sms = req.nextUrl.searchParams.get("sms") || null;

    const conditions: any[] = [
      { $or: [{ status: "active" }, { status: { $exists: false } }] },
    ];

    if (search) {
      const escaped = escapeRegex(search);
      conditions.push({
        $or: [
          { name: { $regex: escaped, $options: "i" } },
          { locationIdentifier: { $regex: escaped, $options: "i" } },
        ],
      });
    }

    if (sms) {
      const allowed = ["tekmetric", "shopware", "protractor", "autoflow"];
      const normalized = sms.toLowerCase();
      if (!allowed.includes(normalized)) {
        return NextResponse.json(
          { error: "Invalid sms parameter", message: `Must be one of: ${allowed.join(", ")}` },
          { status: 400 }
        );
      }
      conditions.push({ integrationProvider: normalized });
    }

    const filter = conditions.length === 1 ? conditions[0] : { $and: conditions };

    const projection = {
      _id: 0,
      shopId: 1,
      name: 1,
      integrationProvider: 1,
      "tekmetric.shopId": 1,
      "shopware.swShopId": 1,
      "shopware.tenantId": 1,
      protractorConnectionId: 1,
      "autoflow.domain": 1,
      locationIdentifier: 1,
      status: 1,
    };

    const [shops, total] = await Promise.all([
      db
        .collection("shops")
        .find(filter, { projection })
        .sort({ name: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .toArray(),
      db.collection("shops").countDocuments(filter),
    ]);

    return NextResponse.json({
      success: true,
      shops: shops.map(formatShop),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  }
);

function formatShop(shop: any) {
  const result: any = {
    shopId: Number(shop.shopId),
    name: shop.name || null,
    status: shop.status || "active",
    integrationProvider: shop.integrationProvider || null,
    locationIdentifier: shop.locationIdentifier || null,
  };

  if (shop.integrationProvider) {
    const smsIds: any = {};

    switch (shop.integrationProvider) {
      case "tekmetric":
        if (shop.tekmetric?.shopId) smsIds.tekmetricShopId = shop.tekmetric.shopId;
        break;
      case "shopware":
        if (shop.shopware?.swShopId) smsIds.shopwareShopId = shop.shopware.swShopId;
        if (shop.shopware?.tenantId) smsIds.shopwareTenantId = shop.shopware.tenantId;
        break;
      case "protractor":
        if (shop.protractorConnectionId) smsIds.protractorConnectionId = shop.protractorConnectionId;
        break;
      case "autoflow":
        if (shop.autoflow?.domain) smsIds.autoflowDomain = shop.autoflow.domain;
        break;
    }

    if (Object.keys(smsIds).length > 0) {
      result.smsIds = smsIds;
    }
  }

  return result;
}
