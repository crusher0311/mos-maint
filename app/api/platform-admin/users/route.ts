import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import bcrypt from "bcryptjs";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { assertNoLegacyPasswordField } from "@/lib/user-write-guard";
import { logAdminAction } from "@/lib/audit-log";
import { dualWritePgIdentity } from "@/lib/db/wave4-write-mode";
import { insertUser as pgInsertUser } from "@/lib/data/repositories/pg/identity";
import { sendEmail, makeCredentialsWelcomeEmail } from "@/lib/email";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIN_PASSWORD_LENGTH = 12;
const VALID_ROLES = ["owner", "admin", "manager", "user", "viewer"] as const;

function validatePasswordStrength(password: string): string | null {
  if (typeof password !== "string") {
    return "Password must be a string.";
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`;
  }
  if (password.length > 200) {
    return "Password is too long.";
  }
  const classes = [
    /[a-z]/.test(password),
    /[A-Z]/.test(password),
    /[0-9]/.test(password),
    /[^a-zA-Z0-9]/.test(password),
  ].filter(Boolean).length;
  if (classes < 3) {
    return "Password must include at least 3 of: lowercase, uppercase, digits, symbols.";
  }
  return null;
}

interface ShopInfo {
  shopId: number | string;
  name: string;
  locationIdentifier?: string | null;
}

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!session.isPlatformAdmin) {
    return NextResponse.json({ error: "Forbidden - platform admin access required" }, { status: 403 });
  }

  try {
    const db = await getDb();
    
    const users = await db.collection("users")
      .find()
      .project({ email: 1, role: 1, shopId: 1, shopIds: 1, createdAt: 1, isPlatformAdmin: 1 })
      .toArray();
    
    const allShopIds = new Set<number | string>();
    for (const u of users) {
      if (u.shopId) allShopIds.add(u.shopId);
      if (u.shopIds?.length) u.shopIds.forEach((id: any) => allShopIds.add(id));
    }
    
    const shops = await db.collection("shops")
      .find({ shopId: { $in: [...allShopIds] } })
      .project({ shopId: 1, name: 1, locationIdentifier: 1 })
      .toArray();
    
    const shopDataMap = new Map<string, ShopInfo>();
    for (const s of shops) {
      const key = String(s.shopId);
      shopDataMap.set(key, { 
        shopId: s.shopId,
        name: s.name || `Shop ${s.shopId}`,
        locationIdentifier: s.locationIdentifier || null
      });
    }
    
    const usersByEmail = new Map<string, {
      _id: string;
      email: string;
      role: string;
      primaryShopId: number | string;
      shops: ShopInfo[];
      createdAt: Date | null;
      isPlatformAdmin: boolean;
    }>();
    
    for (const user of users) {
      const email = user.email?.toLowerCase();
      if (!email) continue;
      
      const primaryShopData = shopDataMap.get(String(user.shopId));
      const allUserShopIds = [user.shopId, ...(user.shopIds || [])].filter(Boolean);
      const userShops: ShopInfo[] = [];
      
      for (const sid of allUserShopIds) {
        const shopData = shopDataMap.get(String(sid));
        if (shopData) {
          userShops.push(shopData);
        } else {
          userShops.push({ shopId: sid, name: `Shop ${sid}`, locationIdentifier: null });
        }
      }
      
      const existing = usersByEmail.get(email);
      if (existing) {
        for (const shop of userShops) {
          if (!existing.shops.find(s => String(s.shopId) === String(shop.shopId))) {
            existing.shops.push(shop);
          }
        }
        if (user.role === 'owner' && existing.role !== 'owner') {
          existing.role = 'owner';
        }
        if (user.isPlatformAdmin) {
          existing.isPlatformAdmin = true;
        }
      } else {
        usersByEmail.set(email, {
          _id: user._id.toString(),
          email: user.email,
          role: user.role || "user",
          primaryShopId: user.shopId,
          shops: userShops,
          createdAt: user.createdAt || user._id.getTimestamp?.() || null,
          isPlatformAdmin: user.isPlatformAdmin || false,
        });
      }
    }
    
    const groupedUsers = Array.from(usersByEmail.values()).map(u => ({
      _id: u._id,
      email: u.email,
      role: u.role,
      primaryShopId: u.primaryShopId,
      shops: u.shops,
      locationCount: u.shops.length,
      createdAt: u.createdAt,
      isPlatformAdmin: u.isPlatformAdmin,
    }));
    
    return NextResponse.json({
      ok: true,
      users: groupedUsers.sort((a, b) => {
        if (!a.createdAt) return 1;
        if (!b.createdAt) return -1;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      }),
    });
  } catch (err: any) {
    console.error("Platform users error:", err);
    return NextResponse.json({ error: err?.message || "Unknown error" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!session.isPlatformAdmin) {
    return NextResponse.json(
      { error: "Forbidden - platform admin access required" },
      { status: 403 }
    );
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const email = String(body?.email || "").trim().toLowerCase();
  const name = String(body?.name || "").trim();
  const role = String(body?.role || "user").trim().toLowerCase();
  const password: unknown = body?.password;
  const sendWelcomeEmail = body?.sendWelcomeEmail === true;
  const shopIdRaw = body?.shopId;
  const shopIdsRaw = body?.shopIds;

  if (!email) {
    return NextResponse.json({ error: "Email is required" }, { status: 400 });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "Please enter a valid email address" }, { status: 400 });
  }
  if (!(VALID_ROLES as readonly string[]).includes(role)) {
    return NextResponse.json(
      { error: `Role must be one of: ${VALID_ROLES.join(", ")}` },
      { status: 400 }
    );
  }
  if (shopIdRaw === undefined || shopIdRaw === null || String(shopIdRaw).trim() === "") {
    return NextResponse.json({ error: "A target shop is required" }, { status: 400 });
  }
  const shopId = Number(shopIdRaw);
  if (!Number.isFinite(shopId)) {
    return NextResponse.json({ error: "Invalid shop ID" }, { status: 400 });
  }
  let extraShopIds: string[] = [];
  if (shopIdsRaw !== undefined && shopIdsRaw !== null) {
    if (!Array.isArray(shopIdsRaw)) {
      return NextResponse.json({ error: "shopIds must be an array" }, { status: 400 });
    }
    extraShopIds = Array.from(
      new Set(
        shopIdsRaw
          .map((id: any) => String(id).trim())
          .filter((id: string) => id !== "" && id !== String(shopId))
      )
    );
  }
  if (typeof password !== "string" || !password) {
    return NextResponse.json({ error: "Password is required" }, { status: 400 });
  }
  const strengthError = validatePasswordStrength(password);
  if (strengthError) {
    return NextResponse.json({ error: strengthError }, { status: 400 });
  }

  try {
    const db = await getDb();

    const existingUser = await db.collection("users").findOne({ emailLower: email });
    if (existingUser) {
      return NextResponse.json(
        { error: "A user with this email already exists" },
        { status: 409 }
      );
    }

    const shop = await db
      .collection("shops")
      .findOne({ shopId }, { projection: { shopId: 1, name: 1, locationIdentifier: 1 } });
    if (!shop) {
      return NextResponse.json({ error: "Selected shop not found" }, { status: 404 });
    }

    if (extraShopIds.length > 0) {
      const numericExtraIds = extraShopIds
        .map((id) => Number(id))
        .filter((n) => Number.isFinite(n));
      const foundExtraShops = await db
        .collection("shops")
        .find({ shopId: { $in: numericExtraIds } })
        .project({ shopId: 1 })
        .toArray();
      const foundExtraSet = new Set(foundExtraShops.map((s) => String(s.shopId)));
      const missingExtra = extraShopIds.filter((id) => !foundExtraSet.has(id));
      if (missingExtra.length > 0) {
        return NextResponse.json(
          { error: `Some selected shops were not found: ${missingExtra.join(", ")}` },
          { status: 404 }
        );
      }
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const now = new Date();
    const userDoc: Record<string, any> = {
      email,
      emailLower: email,
      passwordHash,
      name: name || email.split("@")[0],
      shopId,
      shopIds: extraShopIds,
      role,
      mustChangePassword: true,
      createdAt: now,
      updatedAt: now,
      createdByAdminEmail: session.email,
    };

    assertNoLegacyPasswordField(userDoc);
    const insertResult = await db.collection("users").insertOne(userDoc);
    const newUserId = insertResult.insertedId.toString();

    // Mirror the new user into the PG identity store so the next
    // PG-canonical `getSession()` read can find them (same dual-write
    // contract the admin reset-password route follows).
    await dualWritePgIdentity("users.insert(admin create-user)", () =>
      pgInsertUser({
        id: newUserId,
        email,
        emailLower: email,
        passwordHash,
        role,
        shopId,
        shopIds: extraShopIds,
        isPlatformAdmin: false,
        mustChangePassword: true,
        profile: { name: userDoc.name },
        createdAt: now,
        updatedAt: now,
      })
    );

    const shopName = shop.name || `Shop #${shopId}`;
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "https://mos.tools";
    const loginUrl = `${baseUrl}/login`;
    let emailSent = false;

    if (sendWelcomeEmail) {
      try {
        const emailContent = makeCredentialsWelcomeEmail(
          shopName,
          email,
          password,
          loginUrl
        );
        await sendEmail({
          to: email,
          ...emailContent,
          shopId,
          emailKind: "credentials_welcome",
        });
        emailSent = true;
        console.log(`[Platform Admin] Welcome email sent to ${email} for new user (shop ${shopId})`);
      } catch (emailErr: any) {
        console.error(`[Platform Admin] Failed to send welcome email to ${email}:`, emailErr?.message);
      }
    }

    const headerStore = await headers();
    await logAdminAction({
      action: "user_created",
      adminEmail: session.email,
      targetShopId: shopId,
      targetShopName: shopName,
      targetUserEmail: email,
      ipAddress:
        headerStore.get("x-forwarded-for") ||
        headerStore.get("x-real-ip") ||
        undefined,
      userAgent: headerStore.get("user-agent") || undefined,
      details: {
        role,
        welcomeEmailRequested: sendWelcomeEmail,
        welcomeEmailSent: emailSent,
        additionalShopIds: extraShopIds,
        additionalShopCount: extraShopIds.length,
      },
    });

    return NextResponse.json({
      ok: true,
      user: {
        _id: newUserId,
        email,
        name: userDoc.name,
        role,
        shopId,
        shopName,
      },
      emailSent,
      message: `User ${email} created${
        sendWelcomeEmail
          ? emailSent
            ? ". Welcome email sent."
            : ". Note: welcome email could not be sent."
          : "."
      }`,
    });
  } catch (err: any) {
    console.error("Platform admin create user error:", err);
    return NextResponse.json(
      { error: err?.message || "Unknown error" },
      { status: 500 }
    );
  }
}
