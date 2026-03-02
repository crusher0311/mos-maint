import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
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

    const db = await getDb();
    const usersCollection = db.collection("users");

    const candidates = await usersCollection.find({ 
      email: email.toLowerCase().trim() 
    }).toArray();

    if (candidates.length === 0) {
      return NextResponse.json(
        { error: "Invalid email or password" },
        { status: 401, headers: corsHeaders }
      );
    }

    let user: any = null;

    for (const candidate of candidates) {
      const dbHash = candidate.passwordHash;
      const legacyPlain = candidate.password;
      let passOk = false;

      if (looksLikeBcrypt(dbHash)) {
        passOk = await bcrypt.compare(String(password), String(dbHash));
      } else if (looksLikeScrypt(dbHash)) {
        passOk = await verifyScrypt(String(password), String(dbHash));
        if (passOk) {
          const newHash = await bcrypt.hash(String(password), 12);
          await usersCollection.updateOne(
            { _id: candidate._id },
            { $set: { passwordHash: newHash } }
          );
        }
      } else if (legacyPlain) {
        passOk = String(password) === String(legacyPlain);
        if (passOk) {
          const newHash = await bcrypt.hash(String(password), 12);
          await usersCollection.updateOne(
            { _id: candidate._id },
            { $set: { passwordHash: newHash }, $unset: { password: "" } }
          );
        }
      }

      if (passOk) {
        user = candidate;
        break;
      }
    }

    if (!user) {
      return NextResponse.json(
        { error: "Invalid email or password" },
        { status: 401, headers: corsHeaders }
      );
    }

    const extensionToken = `ext_${user._id.toString()}_${Date.now()}_${Math.random().toString(36).substring(2)}`;
    
    await usersCollection.updateOne(
      { _id: user._id },
      { 
        $set: { 
          extensionToken,
          extensionTokenCreatedAt: new Date()
        } 
      }
    );

    const shop = await db.collection("shops").findOne({ shopId: user.shopId });
    const effectiveSwMode = user.shopwareAddMode || shop?.preferences?.shopwareAddMode || "finding-published";

    return NextResponse.json({
      token: extensionToken,
      user: {
        id: user._id.toString(),
        email: user.email,
        name: user.name,
        shopId: user.shopId,
        role: user.role,
        defaultExtensionTab: user.defaultExtensionTab || null,
        shopwareAddMode: effectiveSwMode
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
