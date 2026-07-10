import { NextRequest, NextResponse } from "next/server";
import { sessionCookieOptions } from "@/lib/auth";
import {
  findShopByEnrollmentCode,
  findUserByEmailLower,
  insertEnrollmentUser,
  insertEnrollmentSession,
} from "@/lib/data/repositories/enrollment";
import { assertNoLegacyPasswordField } from "@/lib/user-write-guard";
import { rateLimit, clientIp } from "@/lib/rate";
import {
  readEnrollmentConfig,
  isValidEnrollmentRole,
  emailDomainAutoApproved,
} from "@/lib/enrollment";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { dualWritePgIdentity } from "@/lib/db/wave4-write-mode";
import {
  insertSession as pgInsertSession,
  insertUser as pgInsertUser,
} from "@/lib/data/repositories/pg/identity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function findShopByCode(code: string) {
  if (!code || code.length < 12 || code.length > 64) return null;
  const shop = await findShopByEnrollmentCode(code);
  if (!shop) return null;
  const cfg = readEnrollmentConfig(shop);
  // Exact match against the CURRENT code only — a rotated code stops
  // working immediately because the query above matches the stored value.
  if (!cfg.enabled || cfg.code !== code) return null;
  return { shop, cfg };
}

/** Public: resolve a join code to shop display info. */
export async function GET(
  req: NextRequest,
  { params }: { params: { code: string } },
) {
  const rate = await rateLimit({
    id: `join-info:${clientIp(req)}`,
    limit: 30,
    windowSeconds: 60,
  });
  if (!rate.allowed) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const found = await findShopByCode(String(params.code || ""));
  if (!found) {
    return NextResponse.json(
      { error: "This enrollment link is invalid or no longer active." },
      { status: 404 },
    );
  }
  const { shop, cfg } = found;
  return NextResponse.json({
    ok: true,
    shopName: shop.name || `Shop #${shop.shopId}`,
    locationIdentifier: shop.locationIdentifier || null,
    mode: cfg.mode,
  });
}

/** Public: create an account attached to the shop behind the code. */
export async function POST(
  req: NextRequest,
  { params }: { params: { code: string } },
) {
  try {
    const ip = clientIp(req);
    const rate = await rateLimit({
      id: `join-signup:${ip}`,
      limit: 5,
      windowSeconds: 600,
    });
    if (!rate.allowed) {
      return NextResponse.json(
        { error: "Too many signup attempts. Please try again later." },
        { status: 429 },
      );
    }

    const found = await findShopByCode(String(params.code || ""));
    if (!found) {
      return NextResponse.json(
        { error: "This enrollment link is invalid or no longer active." },
        { status: 404 },
      );
    }
    const { shop, cfg } = found;

    const body = await req.json().catch(() => null);
    const name = String(body?.name || "").trim().slice(0, 120);
    const email = String(body?.email || "").trim().toLowerCase();
    const password = String(body?.password || "");

    if (!name || !email || !password) {
      return NextResponse.json({ error: "Name, email and password are required" }, { status: 400 });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: "Please enter a valid email address" }, { status: 400 });
    }
    if (password.length < 8) {
      return NextResponse.json({ error: "Password must be at least 8 characters" }, { status: 400 });
    }

    // Duplicate emails: never silently grant shop access to an existing
    // account. Existing users must be added via the admin/multi-shop path.
    const exists = await findUserByEmailLower(email);
    if (exists) {
      return NextResponse.json(
        {
          error:
            "An account with this email already exists. Please log in, or ask your shop admin to add this location to your account.",
        },
        { status: 409 },
      );
    }

    // Defense-in-depth: enrollment can never grant elevated roles.
    const role = isValidEnrollmentRole(cfg.defaultRole) ? cfg.defaultRole : "user";
    // Approval mode still auto-approves signups from an allowlisted email
    // domain (e.g. a shop's own @carexperts.com), so only outsiders wait.
    const pending =
      cfg.mode === "approval" && !emailDomainAutoApproved(email, cfg.autoApproveDomains);
    const passwordHash = await bcrypt.hash(password, 12);
    const now = new Date();

    const newUserDoc: Record<string, any> = {
      shopId: Number(shop.shopId),
      email,
      emailLower: email,
      name,
      role,
      passwordHash,
      createdAt: now,
      updatedAt: now,
      enrolledVia: "enrollment_code",
      ...(pending ? { status: "pending", pendingSince: now } : {}),
    };
    assertNoLegacyPasswordField(newUserDoc);
    const insertedId = await insertEnrollmentUser(newUserDoc);

    await dualWritePgIdentity("users.insert(join)", () =>
      pgInsertUser({
        id: String(insertedId),
        email,
        emailLower: email,
        passwordHash,
        role,
        shopId: Number(shop.shopId),
        profile: {
          name,
          enrolledVia: "enrollment_code",
          ...(pending ? { status: "pending", pendingSince: now } : {}),
        },
        createdAt: now,
        updatedAt: now,
      }),
    );

    console.log(
      `[Enrollment] New ${pending ? "pending" : "active"} signup ${email} (role=${role}) for shop ${shop.shopId} via join code`,
    );

    if (pending) {
      return NextResponse.json({
        ok: true,
        pending: true,
        message:
          "Your request has been submitted. A shop admin needs to approve it before you can log in.",
      });
    }

    // Instant mode: log them straight in.
    const sessionToken = crypto.randomBytes(32).toString("hex");
    const ttlDays = 30;
    const expiresAt = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);
    await insertEnrollmentSession({
      token: sessionToken,
      userId: insertedId,
      shopId: Number(shop.shopId),
      createdAt: now,
      expiresAt,
    });
    await dualWritePgIdentity("sessions.insert(join)", () =>
      pgInsertSession({
        token: sessionToken,
        userId: String(insertedId),
        shopId: Number(shop.shopId),
        expiresAt,
      }),
    );

    const res = NextResponse.json({ ok: true, pending: false, redirect: "/dashboard" });
    res.cookies.set("session_token", sessionToken, sessionCookieOptions(ttlDays * 24 * 60 * 60));
    return res;
  } catch (e: any) {
    console.error("Join signup error:", e);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
