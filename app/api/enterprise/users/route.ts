import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { ObjectId } from "mongodb";
import {
  loadEnterpriseUsers,
  grantShopAccess,
  revokeShopAccess,
  type ShopInfo,
} from "@/lib/enterprise-access";

export const runtime = "nodejs";

/**
 * Authorize enterprise user management. Platform admins may manage any
 * enterprise; otherwise the caller must be an owner/admin whose session shop
 * belongs to the target enterprise (mirrors the dashboard endpoint's scoping).
 */
async function canManageEnterprise(
  db: Awaited<ReturnType<typeof getDb>>,
  session: any,
  enterprise: { _id: any },
): Promise<boolean> {
  if (session.isPlatformAdmin || session.role === "platform_admin") return true;
  if (session.role !== "owner" && session.role !== "admin") return false;
  const sessionShop = await db.collection("shops").findOne({ shopId: session.shopId });
  if (!sessionShop?.enterpriseId) return false;
  return String(sessionShop.enterpriseId) === String(enterprise._id);
}

export async function GET(req: Request) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const enterpriseId = searchParams.get("enterpriseId");

    if (!enterpriseId || !ObjectId.isValid(enterpriseId)) {
      return NextResponse.json({ error: "Valid enterprise ID required" }, { status: 400 });
    }

    const db = await getDb();

    const enterprise = await db.collection("enterprise_accounts").findOne({
      _id: new ObjectId(enterpriseId),
    });

    if (!enterprise) {
      return NextResponse.json({ error: "Enterprise not found" }, { status: 404 });
    }

    if (!(await canManageEnterprise(db, session, enterprise))) {
      return NextResponse.json({ error: "Permission denied" }, { status: 403 });
    }

    const enterpriseShopIds = (enterprise.shopIds || [])
      .map(Number)
      .filter((n: number) => Number.isFinite(n));

    const shops = await db
      .collection("shops")
      .find({ shopId: { $in: enterprise.shopIds || [] } })
      .project({ shopId: 1, name: 1, locationIdentifier: 1 })
      .toArray();

    const shopMap = new Map<number, ShopInfo>(
      shops.map((s) => [
        Number(s.shopId),
        { name: s.name || `Shop ${s.shopId}`, locationIdentifier: s.locationIdentifier || null },
      ]),
    );

    const userList = await loadEnterpriseUsers(db, enterpriseShopIds, shopMap);

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

    const { enterpriseId, email, shopId, action } = await req.json();

    if (enterpriseId && !ObjectId.isValid(enterpriseId)) {
      return NextResponse.json({ error: "Valid enterprise ID required" }, { status: 400 });
    }

    if (!enterpriseId || !email || !shopId || !action) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    const db = await getDb();

    const enterprise = await db.collection("enterprise_accounts").findOne({
      _id: new ObjectId(enterpriseId),
    });

    if (!enterprise) {
      return NextResponse.json({ error: "Enterprise not found" }, { status: 404 });
    }

    if (!(await canManageEnterprise(db, session, enterprise))) {
      return NextResponse.json({ error: "Permission denied" }, { status: 403 });
    }

    const enterpriseShopIds = (enterprise.shopIds || [])
      .map(Number)
      .filter((n: number) => Number.isFinite(n));

    if (!enterpriseShopIds.includes(Number(shopId))) {
      return NextResponse.json({ error: "Shop not in enterprise" }, { status: 400 });
    }

    const shop = await db.collection("shops").findOne({ shopId });
    const shopName = shop?.name || `Shop ${shopId}`;

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
