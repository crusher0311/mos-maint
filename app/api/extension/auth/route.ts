import { withExtensionErrorMarker } from "@/lib/extension-route-wrapper";
import { NextRequest, NextResponse } from "next/server";
import type { Db } from "mongodb";
import { getDb } from "@/lib/mongo";
import bcrypt from "bcryptjs";
import { isSuperAdmin } from "@/lib/super-admins";
import {
  issueExtensionSession,
  lookupExtensionSession,
  revokeExtensionSession,
  type ExtensionProvider,
} from "@/lib/extension-session";

/**
 * Test seam: tests can override `__deps.getDb` to swap in a fake DB.
 * Kept narrowly typed (`() => Promise<Db>`) so production callers still
 * get the real `Db` type and we don't leak `any` into the route.
 */
export const __deps: {
  getDb: () => Promise<Db>;
  issueExtensionSession: typeof issueExtensionSession;
  lookupExtensionSession: typeof lookupExtensionSession;
  revokeExtensionSession: typeof revokeExtensionSession;
} = {
  getDb: () => getDb(),
  issueExtensionSession,
  lookupExtensionSession,
  revokeExtensionSession,
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
    const {
      email,
      password,
      shopId: requestedShopId,
      smsShopId: requestedSmsShopId,
      provider: requestedProvider,
    } = await request.json();

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
        "shopmonkey.locationId": 1,
        "shopmonkey.companyId": 1,
        "autoflow.domain": 1,
        "autoflow.subdomain": 1,
        "autoflow.shopId": 1,
        "autoflow.shopNumbers": 1,
        autoflowDomain: 1,
        integrationProvider: 1,
        "billing.plan": 1,
        "billing.status": 1,
        enabledFeatures: 1,
        "preferences.shopwareAddMode": 1,
      })
      .toArray();

    const detectProvider = (s: any): ExtensionProvider | null => {
      let raw = String(
        s?.integrationProvider ||
          (s?.tekmetric?.shopId || s?.tekmetricShopId
            ? "tekmetric"
            : s?.protractor?.connectionId || s?.protractorConnectionId
              ? "protractor"
              : s?.shopware?.tenantId
                ? "shopware"
                : s?.shopmonkey?.locationId || s?.shopmonkey?.companyId
                  ? "shopmonkey"
                  : s?.autoflow?.domain || s?.autoflow?.subdomain || s?.autoflow?.shopId
                    ? "autoflow"
                    : ""),
      ).toLowerCase();
      if (raw === "shop-ware" || raw === "shop_ware") raw = "shopware";
      return ["tekmetric", "protractor", "shopware", "shopmonkey", "autoflow"].includes(raw)
        ? (raw as ExtensionProvider)
        : null;
    };

    const smsIdsForShop = (s: any, provider: ExtensionProvider): string[] => {
      const values =
        provider === "tekmetric"
          ? [s?.tekmetric?.shopId, s?.tekmetricShopId]
          : provider === "protractor"
            ? [s?.protractor?.connectionId, s?.protractorConnectionId]
            : provider === "shopware"
              ? [s?.shopware?.tenantId, s?.shopware?.tenantSubdomain]
              : provider === "shopmonkey"
                ? [s?.shopmonkey?.locationId, s?.shopmonkey?.companyId]
                : [
                    s?.autoflow?.shopId,
                    s?.autoflow?.subdomain,
                    s?.autoflow?.domain,
                    s?.autoflowDomain,
                    ...(Array.isArray(s?.autoflow?.shopNumbers)
                      ? s.autoflow.shopNumbers
                      : [s?.autoflow?.shopNumbers]),
                  ];
      return values
        .filter((value) => value != null && value !== "")
        .map((value) => String(value).replace(/\.autotext\.me$/i, ""));
    };
    const shopSupportsProvider = (s: any, provider: ExtensionProvider): boolean =>
      provider === "tekmetric"
        ? Boolean(s?.tekmetric?.shopId || s?.tekmetricShopId)
        : provider === "protractor"
          ? Boolean(s?.protractor?.connectionId || s?.protractorConnectionId)
          : provider === "shopware"
            ? Boolean(s?.shopware?.tenantId || s?.shopware?.tenantSubdomain)
            : provider === "shopmonkey"
              ? Boolean(s?.shopmonkey?.locationId || s?.shopmonkey?.companyId)
              : Boolean(
                  s?.autoflow?.shopId ||
                    s?.autoflow?.subdomain ||
                    s?.autoflow?.domain ||
                    s?.autoflowDomain ||
                    s?.autoflow?.shopNumbers,
                );

    const requestedId =
      requestedShopId == null || requestedShopId === ""
        ? null
        : Number(requestedShopId);
    if (requestedId != null && !allShopIds.includes(requestedId)) {
      return NextResponse.json(
        { error: "Requested shop is not assigned to this account" },
        { status: 403, headers: corsHeaders },
      );
    }
    const normalizedRequestedProvider = requestedProvider
      ? String(requestedProvider).toLowerCase().replace(/^shop[-_]ware$/, "shopware")
      : null;
    const normalizedSmsShopId =
      requestedSmsShopId == null || requestedSmsShopId === ""
        ? null
        : String(requestedSmsShopId).replace(/\.autotext\.me$/i, "");
    const candidateProviders: ExtensionProvider[] = normalizedRequestedProvider
      ? [normalizedRequestedProvider as ExtensionProvider]
      : ["tekmetric", "protractor", "shopware", "shopmonkey", "autoflow"];
    const contextMatches = normalizedSmsShopId
      ? shopDocs.flatMap((shop: any) =>
          candidateProviders
            .filter(
              (provider) =>
                shopSupportsProvider(shop, provider) &&
                smsIdsForShop(shop, provider).includes(normalizedSmsShopId),
            )
            .map((provider) => ({ shop, provider })),
        )
      : [];
    // Tab-supplied provider/smsShopId context is ADVISORY scoping only, never
    // a gate for a credentialed login (Task #1164). The bootstrap rollout made
    // the sidepanel forward the active tab's context on manual sign-in, and a
    // context that failed to resolve to exactly one assigned shop (new shop
    // not yet resolvable by SMS id, ambiguous, stale, or unassigned) used to
    // 403 a login whose credentials were valid. Now: a resolvable context
    // scopes the session; an unresolvable/ambiguous one is logged and ignored,
    // and the login falls back to the user's assigned shops. The only hard
    // gate kept is the EXPLICIT requestedShopId check above — the user asking
    // for a shop they aren't assigned to is a genuine security boundary.
    let contextMatch = contextMatches.length === 1 ? contextMatches[0] : null;
    if (normalizedSmsShopId && contextMatches.length !== 1) {
      console.info(
        `[Extension Auth] context advisory-miss smsShopId=${normalizedSmsShopId} matches=${contextMatches.length} provider=${normalizedRequestedProvider || "any"} — signing in without tab-context scoping`,
      );
    }
    // An explicit requestedShopId (already verified as assigned) wins over a
    // conflicting tab context — the user made a deliberate choice.
    if (
      contextMatch &&
      requestedId != null &&
      Number(contextMatch.shop.shopId) !== requestedId
    ) {
      console.info(
        `[Extension Auth] context conflicts with requested shop ${requestedId} — using requested shop`,
      );
      contextMatch = null;
    }
    const contextShop = contextMatch?.shop ?? null;
    const defaultShopId = allShopIds.includes(Number(user.shopId))
      ? Number(user.shopId)
      : allShopIds[0];
    let scopeShopId = Number(contextShop?.shopId ?? requestedId ?? defaultShopId);
    let scopeShop =
      contextShop ?? shopDocs.find((s: any) => Number(s.shopId) === scopeShopId);
    let scopeProvider: ExtensionProvider | null =
      contextMatch?.provider ?? detectProvider(scopeShop);
    // If the chosen shop has no detectable provider configuration, fall back
    // to any assigned shop that does — valid credentials plus at least one
    // configured shop must always produce a session.
    if (!scopeShop || !scopeProvider || !shopSupportsProvider(scopeShop, scopeProvider)) {
      const fallback = shopDocs
        .map((s: any) => ({ shop: s, provider: detectProvider(s) }))
        .find(
          (entry: any) =>
            entry.provider && shopSupportsProvider(entry.shop, entry.provider),
        );
      if (fallback) {
        scopeShop = fallback.shop;
        scopeShopId = Number(fallback.shop.shopId);
        scopeProvider = fallback.provider;
      }
    }
    if (
      !scopeShopId ||
      !scopeShop ||
      !scopeProvider ||
      !shopSupportsProvider(scopeShop, scopeProvider)
    ) {
      return NextResponse.json(
        { error: "A configured shop is required for extension access" },
        { status: 403, headers: corsHeaders },
      );
    }
    // New logins use first-class, revocable sessions. The returned token is
    // opaque; only its SHA-256 hash is persisted. Existing ext_ tokens remain
    // readable by the validator for the bounded compatibility window.
    const issued = await __deps.issueExtensionSession({
      shopId: scopeShopId,
      provider: scopeProvider,
      assurance: "verified",
      userId: user._id.toString(),
      isAdmin:
        user.isPlatformAdmin === true ||
        user.role === "platform_admin" ||
        isSuperAdmin(user.email),
      canWrite:
        user.readOnly !== true &&
        !["viewer", "read_only", "readonly"].includes(
          String(user.role || "").toLowerCase(),
        ),
    });
    console.info(
      `[Extension Session] issued assurance=verified shop=${scopeShopId} provider=${scopeProvider}`,
    );

    // Password verification upgrades a Basic principal by rotating to this
    // verified token and revoking the lower-assurance session. Legacy ext_
    // user-document tokens remain untouched during the compatibility window.
    const priorToken = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (priorToken?.startsWith("exts_")) {
      try {
        const prior = await __deps.lookupExtensionSession(priorToken);
        if (
          prior.status === "active" &&
          prior.principal.assurance === "basic" &&
          prior.principal.shopId === scopeShopId &&
          prior.principal.provider === scopeProvider
        ) {
          await __deps.revokeExtensionSession(prior.principal.sessionId);
          console.info(
            `[Extension Session] rotated assurance=basic->verified shop=${scopeShopId}`,
          );
        }
      } catch (error) {
        console.warn(
          "[Extension Session] unable to revoke upgraded Basic session",
          error,
        );
      }
    }

    const shops = shopDocs.map((s: any) => {
      const provider = detectProvider(s) || "unknown";

      let smsShopId: string | null = null;
      if (provider === "tekmetric") {
        smsShopId = String(s.tekmetric?.shopId || s.tekmetricShopId || "");
      } else if (provider === "protractor") {
        smsShopId = s.protractor?.connectionId || s.protractorConnectionId || null;
      } else if (provider === "shopware") {
        smsShopId = s.shopware?.tenantSubdomain || s.shopware?.tenantId || null;
      } else if (provider === "shopmonkey") {
        smsShopId = s.shopmonkey?.locationId || s.shopmonkey?.companyId || null;
      } else if (provider === "autoflow") {
        smsShopId = s.autoflow?.subdomain || s.autoflow?.shopId || s.autoflow?.domain || null;
      }

      const integrations: string[] = [];
      if (s.tekmetric?.shopId || s.tekmetricShopId) integrations.push("tekmetric");
      if (s.protractor?.connectionId || s.protractorConnectionId) integrations.push("protractor");
      if (s.shopware?.tenantId) integrations.push("shopware");
      if (s.shopmonkey?.locationId || s.shopmonkey?.companyId) integrations.push("shopmonkey");
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

      // Learned v4 AutoFlow shop numbers (app.autoflow.com/shop/<number>), so
      // the side panel resolves dual shops on the new URL shape too.
      const autoflowShopNumbers = Array.isArray(s.autoflow?.shopNumbers)
        ? s.autoflow.shopNumbers
            .filter((x: any) => typeof x === "string" && x.trim())
            .map((x: string) => x.trim())
        : [];

      return {
        shopId: s.shopId,
        name: s.name || s.shopName || s.tekmetric?.shopName || `Shop ${s.shopId}`,
        provider,
        smsShopId,
        autoflowSubdomain,
        autoflowShopNumbers,
        integrations,
        writeProvider,
        plan: s.billing?.plan || "trial",
        status: s.billing?.status || "trial",
      };
    });

    const primaryShop = shopDocs.find((s: any) => Number(s.shopId) === scopeShopId);
    const effectiveSwMode = user.shopwareAddMode || primaryShop?.preferences?.shopwareAddMode || "finding-published";

    return NextResponse.json({
      token: issued.token,
      assurance: issued.principal.assurance,
      capabilities: issued.principal.capabilities,
      expiresAt: issued.principal.expiresAt.toISOString(),
      session: {
        assurance: issued.principal.assurance,
        capabilities: issued.principal.capabilities,
        shopId: issued.principal.shopId,
        provider: issued.principal.provider,
        // Only echo the tab-supplied sms id when it actually resolved to the
        // scoped shop; an ignored advisory context must not mislabel the
        // session's shop identity.
        smsShopId:
          (contextMatch ? normalizedSmsShopId : null) ??
          smsIdsForShop(scopeShop, scopeProvider)[0] ??
          null,
        expiresAt: issued.principal.expiresAt.toISOString(),
      },
      user: {
        id: user._id.toString(),
        email: user.email,
        name: user.name,
        shopId: scopeShopId,
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
