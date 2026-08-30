import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import {
  loadEnterpriseUsers,
  grantShopAccess,
  revokeShopAccess,
  updateEnterpriseUserRole,
  type ShopInfo,
} from "@/lib/enterprise-access";
import { FEATURE_METADATA } from "@/lib/featureResolver";
import { FEATURE_KEYS, isFounderPlan } from "@/lib/plan-feature-tiers";
import { canManageEnterpriseSettings } from "@/lib/enterprise-settings-catalog";

export const runtime = "nodejs";

export async function GET() {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!canManageEnterpriseSettings(session)) {
      return NextResponse.json({ error: "Permission denied" }, { status: 403 });
    }

    const db = await getDb();

    const sessionShopId = Number(session.shopId);
    const shop = await db.collection("shops").findOne({
      shopId: { $in: [sessionShopId, String(sessionShopId)] },
    });

    if (!shop?.enterpriseId) {
      return NextResponse.json({ error: "Shop not part of an enterprise" }, { status: 404 });
    }

    const enterprise = await db.collection("enterprise_accounts").findOne({
      _id: shop.enterpriseId,
    });

    if (!enterprise) {
      return NextResponse.json({ error: "Enterprise not found" }, { status: 404 });
    }

    const enterpriseShopIds = (enterprise.shopIds || [])
      .map(Number)
      .filter((n: number) => Number.isFinite(n));

    const shops = await db
      .collection("shops")
      .find({
        shopId: {
          $in: [...enterpriseShopIds, ...enterpriseShopIds.map(String)],
        },
      })
      .project({ shopId: 1, name: 1, locationIdentifier: 1 })
      .toArray();

    const shopMap = new Map<number, ShopInfo>(
      shops.map((s) => [
        Number(s.shopId),
        { name: s.name || `Shop ${s.shopId}`, locationIdentifier: s.locationIdentifier || null },
      ]),
    );

    const userList = await loadEnterpriseUsers(db, enterpriseShopIds, shopMap);

    // What a NEW location would inherit: the plan/status/features of the
    // enterprise's INITIAL shop (first in shopIds), plus which features are
    // NOT already on and could be added during creation.
    let newLocationDefaults: {
      sourceShopId: number;
      sourceShopName: string;
      plan: string | null;
      status: string | null;
      enabledFeatures: Record<string, boolean>;
      availableUpgrades: Array<{ key: string; name: string; description: string }>;
    } | null = null;

    const initialShopId = Number((enterprise.shopIds || [])[0]);
    if (Number.isFinite(initialShopId)) {
      const sourceShop = await db.collection("shops").findOne(
        { shopId: { $in: [initialShopId, String(initialShopId)] } },
        { projection: { name: 1, locationIdentifier: 1, "billing.plan": 1, "billing.status": 1, enabledFeatures: 1 } }
      );
      if (sourceShop) {
        const plan = sourceShop.billing?.plan || null;
        const enabled: Record<string, boolean> = sourceShop.enabledFeatures || {};
        const founder = isFounderPlan(plan);
        const availableUpgrades = founder
          ? []
          : FEATURE_KEYS
              .filter((k) => enabled[k] !== true)
              .map((k) => ({
                key: k,
                name: FEATURE_METADATA[k]?.name || k,
                description: FEATURE_METADATA[k]?.description || "",
              }));
        newLocationDefaults = {
          sourceShopId: initialShopId,
          sourceShopName: sourceShop.locationIdentifier
            ? `${sourceShop.name || "Shop"} (${sourceShop.locationIdentifier})`
            : sourceShop.name || `Shop ${initialShopId}`,
          plan,
          status: sourceShop.billing?.status || null,
          enabledFeatures: enabled,
          availableUpgrades,
        };
      }
    }

    return NextResponse.json({
      enterprise: {
        id: enterprise._id.toString(),
        name: enterprise.name,
      },
      shops: shops.map((s) => ({
        shopId: Number(s.shopId),
        name: s.name || `Shop ${s.shopId}`,
        locationIdentifier: s.locationIdentifier || null,
      })),
      users: userList,
      newLocationDefaults,
      currentUserRole: session.role,
      canManageRoles: session.role === "owner",
    });
  } catch (err) {
    console.error("Error fetching enterprise users:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (!["owner", "admin"].includes(session.role)) {
      return NextResponse.json({ error: "Permission denied" }, { status: 403 });
    }

    const { email, shopId, action, role } = await req.json();

    if (
      typeof email !== "string" ||
      !email.trim() ||
      typeof action !== "string" ||
      !action ||
      (action !== "role" && !shopId)
    ) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    const db = await getDb();

    const sessionShopId = Number(session.shopId);
    const shop = await db.collection("shops").findOne({
      shopId: { $in: [sessionShopId, String(sessionShopId)] },
    });

    if (!shop?.enterpriseId) {
      return NextResponse.json({ error: "Shop not part of an enterprise" }, { status: 403 });
    }

    const enterprise = await db.collection("enterprise_accounts").findOne({
      _id: shop.enterpriseId,
    });

    const enterpriseShopIds = (enterprise?.shopIds || [])
      .map(Number)
      .filter((n: number) => Number.isFinite(n));

    if (!enterprise) {
      return NextResponse.json({ error: "Enterprise not found" }, { status: 404 });
    }

    if (action === "role") {
      if (session.role !== "owner") {
        return NextResponse.json({ error: "Only an owner can change user roles" }, { status: 403 });
      }
      const result = await updateEnterpriseUserRole(db, {
        enterpriseShopIds,
        email,
        role: String(role || ""),
        updatedBy: session.email,
      });
      if (!result.ok) {
        return NextResponse.json({ error: result.error }, { status: result.status || 400 });
      }
      return NextResponse.json({
        ok: true,
        message: `Role changed to ${role}`,
        matchedCount: result.matchedCount,
        updatedCount: result.updatedCount,
      });
    }

    if (!enterpriseShopIds.includes(Number(shopId))) {
      return NextResponse.json({ error: "Shop not in your enterprise" }, { status: 400 });
    }

    const targetShopId = Number(shopId);
    const targetShop = await db.collection("shops").findOne({
      shopId: { $in: [targetShopId, String(targetShopId)] },
    });
    const shopName = targetShop?.name || `Shop ${shopId}`;

    if (action === "grant") {
      const result = await grantShopAccess(db, {
        enterpriseShopIds,
        email,
        shopId: Number(shopId),
        grantedBy: session.email,
      });
      if (!result.ok) {
        return NextResponse.json({ error: result.error }, { status: result.status || 400 });
      }
      return NextResponse.json({ ok: true, message: `Access granted to ${shopName}` });
    } else if (action === "revoke") {
      const result = await revokeShopAccess(db, {
        enterpriseShopIds,
        email,
        shopId: Number(shopId),
      });
      if (!result.ok) {
        return NextResponse.json({ error: result.error }, { status: result.status || 400 });
      }
      return NextResponse.json({ ok: true, message: `Access revoked from ${shopName}` });
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (err) {
    console.error("Error managing enterprise user:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
