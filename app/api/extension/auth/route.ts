import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db/postgres";
import bcrypt from "bcryptjs";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function looksLikeBcrypt(s: unknown) {
  return typeof s === "string" && /^\$2[aby]\$/.test(s);
}

function looksLikeScrypt(s: unknown) {
  return typeof s === "string" && s.startsWith("scrypt:");
}

async function verifyScrypt(password: string, hash: string): Promise<boolean> {
  const parts = hash.split(":");
  if (parts.length < 4) return false;
  const salt = parts[2];
  const storedDerived = parts[3];
  const crypto = await import("crypto");
  return new Promise((resolve) => {
    crypto.scrypt(password, salt, 64, (err, buf) => {
      if (err) return resolve(false);
      resolve(buf.toString("hex") === storedDerived);
    });
  });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

export async function POST(request: NextRequest) {
  try {
    const { email, password } = await request.json();

    if (!email || !password) {
      return NextResponse.json(
        { error: "Email and password are required" },
        { status: 400, headers: corsHeaders }
      );
    }

    const userRows = await sql`
      SELECT u.id, u.email, u.name, u.role, u.password_hash, s.shop_id
      FROM users u
      LEFT JOIN shops s ON u.shop_id = s.id
      WHERE LOWER(u.email) = ${email.toLowerCase().trim()}
      LIMIT 1
    `;

    if (userRows.length === 0) {
      return NextResponse.json(
        { error: "Invalid email or password" },
        { status: 401, headers: corsHeaders }
      );
    }

    const user = userRows[0];
    const dbHash = user.password_hash;

    let passOk = false;

    if (looksLikeBcrypt(dbHash)) {
      passOk = await bcrypt.compare(String(password), String(dbHash));
    } else if (looksLikeScrypt(dbHash)) {
      passOk = await verifyScrypt(String(password), String(dbHash));
      if (passOk) {
        const newHash = await bcrypt.hash(String(password), 12);
        await sql`UPDATE users SET password_hash = ${newHash} WHERE id = ${user.id}`;
      }
    }

    if (!passOk) {
      return NextResponse.json(
        { error: "Invalid email or password" },
        { status: 401, headers: corsHeaders }
      );
    }

    const extensionToken = `ext_${user.id}_${Date.now()}_${Math.random().toString(36).substring(2)}`;
    
    await sql`
      UPDATE users 
      SET extension_token = ${extensionToken}, extension_token_created_at = NOW()
      WHERE id = ${user.id}
    `;

    return NextResponse.json({
      token: extensionToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        shopId: user.shop_id ? Number(user.shop_id) : null,
        role: user.role
      }
    }, { headers: corsHeaders });
  } catch (error: any) {
    console.error("[Extension Auth] Error:", error);
    return NextResponse.json(
      { error: "Authentication failed" },
      { status: 500, headers: corsHeaders }
    );
  }
}
