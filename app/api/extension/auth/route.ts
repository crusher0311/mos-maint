import { withExtensionErrorMarker } from "@/lib/extension-route-wrapper";
import { NextRequest, NextResponse } from "next/server";
import type { Db } from "mongodb";
import { getDb } from "@/lib/mongo";
import bcrypt from "bcryptjs";
import { isSuperAdmin } from "@/lib/super-admins";

/**
 * Test seam: tests can override `__deps.getDb` to swap in a fake DB.
 * Kept narrowly typed (`() => Promise<Db>`) so production callers still
 * get the real `Db` type and we don't leak `any` into the route.
 */
export const __deps: { getDb: () => Promise<Db> } = {
  getDb: () => getDb(),
};

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

async function _POST(request: NextRequest) {
  try {
    const { email, password } = await request.json();

    if (!email || !password) {
      return NextResponse.json(
        { error: "Email and password are required" },
        { status: 400, headers: corsHeaders }
      );
    }

    const db = await __deps.getDb();
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
      }
      // Plaintext-password fallback was removed (see task #302). Users whose
      // row has no bcrypt/scrypt hash must reset their password — we no
      // longer compare or silently rehash plaintext credentials.

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

    const allShopIds: number[] = [];
    for (const c of candidates) {
      if (c.shopId != null && !allShopIds.includes(Number(c.shopId))) {
        allShopIds.push(Number(c.shopId));
      }
      if (Array.isArray(c.shopIds)) {
        for (const sid of c.shopIds) {
          if (!allShopIds.includes(Number(sid))) {
            allShopIds.push(Number(sid));
          }
        }
      }
    }

    const extensionToken = `ext_${user._id.toString()}_${Date.now()}_${Math.random().toString(36).substring(2)}`;
    const issuedAt = new Date();

    // Task: multi-device concurrent sessions. Before this change the user doc
    // had a single `extensionToken` slot, so every re-login (or login from a
    // second tab/device) invalidated the previous device's token within
    // seconds — Detect Dog's silent re-auth would then mint a new token,
    // killing this one, and the two tabs would ping-pong forever (74x
    // `Token not found in DB` for /labor-rates etc. observed in prod).
    //
    // We now ALSO push every issued token into `extensionTokens[]` (capped,
    // pruned by age). `validateExtensionToken` checks both the legacy single
    // field AND the array, so older tokens that are still within their 30-day
    // TTL keep working until the device that issued them logs out or
    // re-auths. The legacy `extensionToken` field is still written to the
    // newest token so PG-canonical reads and back-compat code keep finding
    // the latest session.
    const MAX_TOKEN_AGE_MS = 30 * 24 * 60 * 60 * 1000;
    const MAX_CONCURRENT_TOKENS = 10;
    const existingTokens: Array<{ token?: string; createdAt?: Date | string; lastUsedAt?: Date | string }> =
      Array.isArray((user as any).extensionTokens) ? (user as any).extensionTokens : [];
    const freshTokens = existingTokens.filter((t) => {
      if (!t?.token || !t?.createdAt) return false;
      if (t.token === extensionToken) return false; // shouldn't collide, but be safe
      const age = Date.now() - new Date(t.createdAt).getTime();
      return age >= 0 && age < MAX_TOKEN_AGE_MS;
    });
    const nextTokens = [
      { token: extensionToken, createdAt: issuedAt, lastUsedAt: issuedAt },
      ...freshTokens,
    ].slice(0, MAX_CONCURRENT_TOKENS);

    await usersCollection.updateOne(
      { _id: user._id },
      {
        $set: {
          extensionToken,
          extensionTokenCreatedAt: issuedAt,
          extensionTokens: nextTokens,
          shopIds: allShopIds
        }
      }
    );

    const shopIdVariants = allShopIds.flatMap((id: number) => [id, String(id)]);
    const shopDocs = await db.collection("shops")
      .find({ shopId: { $in: shopIdVariants } })
      .project({
        shopId: 1,
        name: 1,
        shopName: 1,
        "tekmetric.shopId": 1,
        "tekmetric.shopName": 1,
        tekmetricShopId: 1,
        "protractor.connectionId": 1,
        protractorConnectionId: 1,
        "shopware.tenantSubdomain": 1,
        "shopware.tenantId": 1,
        "autoflow.domain": 1,
        "autoflow.subdomain": 1,
        "autoflow.shopId": 1,
        autoflowDomain: 1,
        integrationProvider: 1,
        "billing.plan": 1,
        "billing.status": 1,
        enabledFeatures: 1,
        "preferences.shopwareAddMode": 1,
      })
      .toArray();

    const shops = shopDocs.map((s: any) => {
      const provider = s.integrationProvider
        || (s.tekmetric?.shopId ? "tekmetric"
          : s.protractor?.connectionId ? "protractor"
          : s.shopware?.tenantId ? "shopware"
          : s.autoflow?.domain ? "autoflow"
          : "unknown");

      let smsShopId: string | null = null;
      if (provider === "tekmetric") {
        smsShopId = String(s.tekmetric?.shopId || s.tekmetricShopId || "");
      } else if (provider === "protractor") {
        smsShopId = s.protractor?.connectionId || s.protractorConnectionId || null;
      } else if (provider === "shopware") {
        smsShopId = s.shopware?.tenantSubdomain || s.shopware?.tenantId || null;
      } else if (provider === "autoflow") {
        smsShopId = s.autoflow?.subdomain || s.autoflow?.shopId || s.autoflow?.domain || null;
      }

      const integrations: string[] = [];
      if (s.tekmetric?.shopId || s.tekmetricShopId) integrations.push("tekmetric");
      if (s.protractor?.connectionId || s.protractorConnectionId) integrations.push("protractor");
      if (s.shopware?.tenantId) integrations.push("shopware");
      if (s.autoflow?.domain || s.autoflow?.subdomain || s.autoflow?.shopId) integrations.push("autoflow");

      let writeProvider: string | null = null;
      if (provider === "autoflow") {
        const writeIntegration = integrations.find(i => i !== "autoflow");
        if (writeIntegration) writeProvider = writeIntegration;
      }

      // AutoFlow subdomain for client-side shop matching. Dual shops (an
      // AutoFlow on-screen system backed by Protractor/Tekmetric) carry the
      // legacy top-level `autoflowDomain` and have `provider` = the back-end,
      // NOT "autoflow" — so the extension can't match them by provider. Expose
      // the bare subdomain (no `.autotext.me`) so the side panel resolves them.
      const stripAutotext = (v: any): string | null =>
        typeof v === "string" && v.trim()
          ? v.trim().replace(/\.autotext\.me$/i, "").toLowerCase()
          : null;
      const autoflowSubdomain =
        stripAutotext(s.autoflow?.subdomain) ||
        stripAutotext(s.autoflow?.domain) ||
        stripAutotext(s.autoflowDomain) ||
        null;

      return {
        shopId: s.shopId,
        name: s.name || s.shopName || s.tekmetric?.shopName || `Shop ${s.shopId}`,
        provider,
        smsShopId,
        autoflowSubdomain,
        integrations,
        writeProvider,
        plan: s.billing?.plan || "trial",
        status: s.billing?.status || "trial",
      };
    });

    const primaryShop = shopDocs.find((s: any) => s.shopId === user.shopId);
    const effectiveSwMode = user.shopwareAddMode || primaryShop?.preferences?.shopwareAddMode || "finding-published";

    return NextResponse.json({
      token: extensionToken,
      user: {
        id: user._id.toString(),
        email: user.email,
        name: user.name,
        shopId: user.shopId,
        shopIds: allShopIds,
        role: user.role,
        isPlatformAdmin: user.isPlatformAdmin === true || user.role === 'platform_admin',
        isSuperAdmin: isSuperAdmin(user.email),
        defaultExtensionTab: user.defaultExtensionTab || null,
        shopwareAddMode: effectiveSwMode
      },
      shops
    }, { headers: corsHeaders });
  } catch (error: any) {
    console.error("[Extension Auth] Error:", error);
    return NextResponse.json(
      { error: "Authentication failed" },
      { status: 500, headers: corsHeaders }
    );
  }
}

// Task #510: per-shop error-rate alerting — wrap all extension handlers
export const POST = withExtensionErrorMarker(_POST as any);
