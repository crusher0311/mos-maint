import crypto from "node:crypto";
import { findShopBySmsId } from "@/lib/extension-shop-lookup";
import type { ExtensionProvider } from "@/lib/extension-session";

export interface VerifiedProviderEmployee {
  /** Provider-owned immutable account/employee identifier. */
  subject?: string;
  /** Only populated when the provider explicitly marks the address verified. */
  verifiedEmail?: string;
}

export type ProviderProofResult =
  | {
      status: "verified";
      provider: Exclude<ExtensionProvider, "protractor">;
      shopId: number;
      smsShopId: string;
      shopName: string;
      employee?: VerifiedProviderEmployee;
      verifiedAt: Date;
      expiresAt: Date;
    }
  | {
      /**
       * `unavailable` = the shop can't use bootstrap at all (lookup miss for a
       * new/unlinked shop, or not allowlisted). It is NOT a verification
       * failure — the sidepanel should render a normal "please sign in"
       * prompt, not an alarming verification error (Task #1164).
       */
      status: "unsupported" | "unavailable" | "invalid" | "expired" | "replayed";
      provider: Exclude<ExtensionProvider, "protractor">;
      reason: string;
    };

type BootstrapProvider = Exclude<ExtensionProvider, "protractor">;

const TEKMETRIC_ORIGINS = new Set([
  "https://shop.tekmetric.com",
  "https://sandbox.tekmetric.com",
  "https://cba.tekmetric.com",
]);
// Shopmonkey is a single-host SPA (app.shopmonkey.cloud) whose browser calls
// carry a per-user bearer to the public API host. The server ALWAYS probes the
// pinned public API origin; the captured origin is only accepted as context.
const SHOPMONKEY_CAPTURE_ORIGINS = new Set([
  "https://api.shopmonkey.cloud",
  "https://app.shopmonkey.cloud",
]);
const SHOPMONKEY_API_ORIGIN = "https://api.shopmonkey.cloud";
const PROOF_LIFETIME_MS = 90_000;

/** Test seams; production never mutates this object. */
export const __deps = {
  findShopBySmsId,
  fetch: globalThis.fetch,
  rateLimit: async (opts: {
    id: string;
    limit: number;
    windowSeconds: number;
  }) => (await import("@/lib/rate")).rateLimit(opts),
  now: () => Date.now(),
};

function normalizeProvider(value: unknown): BootstrapProvider | null {
  const provider = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^shop[-_]ware$/, "shopware");
  return ["tekmetric", "shopware", "shopmonkey", "autoflow"].includes(provider)
    ? (provider as BootstrapProvider)
    : null;
}

function enabledForShop(provider: BootstrapProvider, shopId: number): boolean {
  if (process.env.EXTENSION_BOOTSTRAP_DISABLED === "true") return false;
  if (
    process.env[`EXTENSION_BOOTSTRAP_${provider.toUpperCase()}_ENABLED`] !==
    "true"
  ) {
    return false;
  }
  const allowlist = process.env.EXTENSION_BOOTSTRAP_SHOPS;
  return (
    !allowlist ||
    allowlist
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean)
      .includes(String(shopId))
  );
}

function unwrapData(value: any): any {
  let current = value;
  for (let i = 0; i < 3; i += 1) {
    if (
      current &&
      typeof current === "object" &&
      !Array.isArray(current) &&
      current.data != null
    ) {
      current = current.data;
    } else {
      break;
    }
  }
  return current;
}

/**
 * Tekmetric's `/api/shops/by-employee` has used both grouped
 * `{ OWNED, EMPLOYEE }` and ordinary list/envelope response shapes. Walk only
 * known shop-list keys, and treat a bare `id` as a shop id only for an object
 * that also looks like a shop. This avoids accepting unrelated account ids.
 */
function extractTekmetricShopIds(raw: any): Set<string> {
  const ids = new Set<string>();
  const visit = (value: any, fromShopList = false) => {
    const unwrapped = unwrapData(value);
    if (Array.isArray(unwrapped)) {
      for (const item of unwrapped) visit(item, true);
      return;
    }
    if (!unwrapped || typeof unwrapped !== "object") return;
    const explicit = unwrapped.shopId ?? unwrapped.shop_id;
    if (explicit != null && explicit !== "") ids.add(String(explicit));
    if (
      fromShopList &&
      unwrapped.id != null &&
      unwrapped.id !== "" &&
      (unwrapped.name != null ||
        unwrapped.shopName != null ||
        unwrapped.shop_name != null)
    ) {
      ids.add(String(unwrapped.id));
    }
    for (const key of [
      "shops",
      "items",
      "content",
      "results",
      "OWNED",
      "EMPLOYEE",
      "owned",
      "employee",
      "ownedShops",
      "employeeShops",
      // Org-level Tekmetric users (multi-location groups) get their shops
      // under `orgShops`, with `employeeShops` empty.
      "orgShops",
    ]) {
      if (unwrapped[key] != null) visit(unwrapped[key], true);
    }
  };
  visit(raw);
  return ids;
}

function stringClaim(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const normalized = String(value).trim();
  return normalized && normalized.length <= 256 ? normalized : undefined;
}

function verifiedEmailFromProfile(raw: any): string | undefined {
  const profile = unwrapData(raw);
  if (!profile || typeof profile !== "object") return undefined;
  const email = String(
    profile.email ?? profile.emailAddress ?? profile.email_address ?? "",
  )
    .trim()
    .toLowerCase();
  // Tekmetric's /api/profile carries no emailVerified-style flag at all
  // (live-confirmed shape: id/email/firstName/...), so requiring an explicit
  // affirmative flag silently disabled email matching for the entire fleet.
  // The profile email IS the credential this authenticated session logged in
  // with, so treat it as verified unless the provider explicitly negates it.
  const explicitlyUnverified =
    profile.emailVerified === false ||
    profile.email_verified === false ||
    profile.isEmailVerified === false;
  return !explicitlyUnverified && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)
    ? email
    : undefined;
}

function employeeFromProfile(raw: any): VerifiedProviderEmployee | undefined {
  const profile = unwrapData(raw);
  if (!profile || typeof profile !== "object") return undefined;
  const subject = stringClaim(
    profile.employeeId ??
      profile.employee_id ??
      profile.accountId ??
      profile.account_id ??
      profile.subject ??
      profile.sub ??
      profile.id,
  );
  const verifiedEmail = verifiedEmailFromProfile(profile);
  return subject || verifiedEmail ? { subject, verifiedEmail } : undefined;
}

async function readJson(response: Response): Promise<any> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

// The sidepanel/background can race and fire two bootstrap exchanges for the
// same proof within the same second. Strict single-use made the losing twin
// surface "verification_needed" to a user who was actually just logged in.
// A small duplicate-exchange grace keeps the proof effectively single-use for
// abuse purposes (bounded to a few exchanges inside the short proof lifetime,
// each still live-verified against the provider) while letting a same-window
// duplicate succeed instead of erroring.
const PROOF_EXCHANGE_GRACE_LIMIT = 3;

async function claimProofOnce(
  provider: BootstrapProvider,
  smsShopId: string,
  token: string,
): Promise<"claimed" | "grace" | "replayed"> {
  const fingerprint = crypto
    .createHash("sha256")
    .update(`${provider}\0${smsShopId}\0${token}`)
    .digest("hex");
  const claimed = await __deps.rateLimit({
    // Only a one-way fingerprint is stored; provider credentials never are.
    id: `extension-bootstrap-proof:${fingerprint}`,
    limit: PROOF_EXCHANGE_GRACE_LIMIT,
    windowSeconds: Math.ceil(PROOF_LIFETIME_MS / 1000),
  });
  if (!claimed.allowed) return "replayed";
  // remaining === limit - count, so the first exchange sees limit - 1.
  return claimed.remaining === claimed.limit - 1 ? "claimed" : "grace";
}

/**
 * Validate a browser-session proof at the provider, never against MOS-held
 * partner/API credentials. A URL, DOM value, or caller-supplied shop id is only
 * context; the provider's authenticated current-employee shop response must
 * independently contain the same shop before MOS trusts it.
 *
 * Supported proofs:
 * - Tekmetric: browser `x-auth-token` probed against `/api/profile` +
 *   `/api/shops/by-employee` on the same Tekmetric origin.
 * - Shopmonkey: per-user browser bearer probed against the public API's
 *   `GET /v3/user/logged-in` (documented current-user endpoint) +
 *   `GET /v3/location` for shop membership. The stored shop-level v3 API key
 *   is never involved.
 *
 * Shop-Ware and AutoFlow intentionally remain unsupported. Shop-Ware exposes
 * no independently verifiable current-session subject at all. AutoFlow was
 * re-probed for this in depth (see docs/autoflow-bootstrap-proof-findings.md):
 * - v3 (`*.autotext.me`, PHP) is cookie-session only — no bearer/identity XHR;
 *   verifying it would require forwarding the whole session cookie, which fails
 *   the "narrow single-purpose credential, no wholesale cookie" bar.
 * - v4 (`app.autoflow.com`, Laravel + Inertia + Vue) renders the current
 *   operator from server-side page props (`$page.props.auth.user`), not a
 *   probeable XHR. Every identity route (`/api/user`, `/api/v1/me`, …) 404s.
 *   The only bearer-validating endpoint, `POST /api/broadcasting/auth`, returns
 *   a channel signature (401 on a bad token) but never discloses the operator's
 *   email or a stable subject, so it cannot drive `matched_user` elevation.
 * With no provider-attested current-user subject on either version, AutoFlow
 * keeps the calm `unsupported` outcome — never forwarding cookies or probing.
 */
export async function verifyProviderSessionProof(input: {
  provider: string;
  smsShopId: string;
  proof?: { kind?: string; token?: string; origin?: string };
}): Promise<ProviderProofResult> {
  const provider = normalizeProvider(input.provider);
  if (!provider) {
    // Use a supported value so the response never echoes arbitrary input.
    return {
      status: "unsupported",
      provider: "autoflow",
      reason: "Provider does not support passwordless access",
    };
  }
  if (provider === "shopmonkey") {
    return verifyShopmonkeySessionProof(input);
  }
  if (provider !== "tekmetric") {
    return {
      status: "unsupported",
      provider,
      reason: "No independently verifiable current-session proof",
    };
  }

  const smsShopId = String(input.smsShopId || "").trim();
  const token = input.proof?.token;
  const origin = String(input.proof?.origin || "");
  if (
    input.proof?.kind !== "tekmetric_x_auth" ||
    typeof token !== "string" ||
    token.length < 20 ||
    token.length > 4096 ||
    !smsShopId ||
    smsShopId.length > 80 ||
    !TEKMETRIC_ORIGINS.has(origin)
  ) {
    return {
      status: "invalid",
      provider,
      reason: "Missing current Tekmetric session proof",
    };
  }

  const shop = await __deps.findShopBySmsId(smsShopId, {
    isPlatformAdmin: true,
    providerHint: "tekmetric",
  });
  // A shop that can't be resolved (brand-new / not yet linked by SMS id) or
  // isn't allowlisted for bootstrap is a normal "sign in instead" situation,
  // not a failed verification of the provider session.
  if (
    !shop ||
    shop.provider !== "tekmetric" ||
    !enabledForShop(provider, shop.mosShopId)
  ) {
    return {
      status: "unavailable",
      provider,
      reason: "Bootstrap is unavailable for this shop",
    };
  }

  try {
    const requestInit: RequestInit = {
      headers: { "x-auth-token": token, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    };
    const [profileResponse, shopsResponse] = await Promise.all([
      __deps.fetch(`${origin}/api/profile`, requestInit),
      __deps.fetch(`${origin}/api/shops/by-employee`, requestInit),
    ]);
    if (
      [profileResponse.status, shopsResponse.status].some(
        (status) => status === 401 || status === 403,
      )
    ) {
      return {
        status: "expired",
        provider,
        reason: "Tekmetric session is no longer valid",
      };
    }
    if (!profileResponse.ok || !shopsResponse.ok) {
      return {
        status: "invalid",
        provider,
        reason: "Tekmetric session could not be verified",
      };
    }

    const [profileData, shopsData] = await Promise.all([
      readJson(profileResponse),
      readJson(shopsResponse),
    ]);
    if (!extractTekmetricShopIds(shopsData).has(smsShopId)) {
      return {
        status: "invalid",
        provider,
        reason: "Tekmetric session belongs to a different shop",
      };
    }

    const claim = await claimProofOnce(provider, smsShopId, token);
    if (claim === "replayed") {
      return {
        status: "replayed",
        provider,
        reason: "This proof was already exchanged",
      };
    }
    if (claim === "grace") {
      // Observability for the duplicate-bootstrap race: the twin exchange
      // succeeds instead of erroring, but we still want to see it in prod.
      console.info(
        `[Extension Bootstrap] proofStatus=duplicate_grace provider=${provider} shop=${shop.mosShopId} — duplicate exchange of the same proof within its lifetime`,
      );
    }

    const verifiedAt = new Date(__deps.now());
    return {
      status: "verified",
      provider,
      shopId: shop.mosShopId,
      smsShopId,
      shopName: String(
        shop.shopDoc?.name ||
          shop.shopDoc?.shopName ||
          shop.shopDoc?.tekmetric?.shopName ||
          `Shop ${shop.mosShopId}`,
      ),
      employee: employeeFromProfile(profileData),
      verifiedAt,
      expiresAt: new Date(verifiedAt.getTime() + PROOF_LIFETIME_MS),
    };
  } catch {
    return {
      status: "invalid",
      provider,
      reason: "Tekmetric session could not be verified",
    };
  }
}

/**
 * Shopmonkey shop membership: an MOS Shopmonkey shop's `smsShopId` is a
 * `locationId || companyId` (24-hex ObjectIds). Collect both id families from
 * the authenticated current-user profile and the session's `/v3/location`
 * list; the claimed shop must appear in that union.
 */
function extractShopmonkeyShopIds(profileRaw: any, locationsRaw: any): Set<string> {
  const ids = new Set<string>();
  const addId = (value: unknown) => {
    if (typeof value !== "string" && typeof value !== "number") return;
    const id = String(value).trim();
    if (id && id.length <= 80) ids.add(id);
  };
  const visitLocation = (value: any) => {
    if (!value || typeof value !== "object") return;
    addId(value.id ?? value.locationId ?? value.location_id);
    addId(value.companyId ?? value.company_id);
  };

  const profile = unwrapData(profileRaw);
  if (profile && typeof profile === "object") {
    addId(profile.companyId ?? profile.company_id);
    addId(profile.currentLocationId ?? profile.current_location_id);
    addId(profile.locationId ?? profile.location_id);
    for (const key of ["companyIds", "locationIds", "location_ids"]) {
      const list = profile[key];
      if (Array.isArray(list)) for (const item of list) addId(item);
    }
    if (Array.isArray(profile.locations)) {
      for (const item of profile.locations) visitLocation(item);
    }
  }

  const locations = unwrapData(locationsRaw);
  if (Array.isArray(locations)) {
    for (const item of locations) visitLocation(item);
  }
  return ids;
}

async function verifyShopmonkeySessionProof(input: {
  smsShopId: string;
  proof?: { kind?: string; token?: string; origin?: string };
}): Promise<ProviderProofResult> {
  const provider = "shopmonkey" as const;
  const smsShopId = String(input.smsShopId || "").trim();
  const token = input.proof?.token;
  const origin = String(input.proof?.origin || "");
  if (
    input.proof?.kind !== "shopmonkey_bearer" ||
    typeof token !== "string" ||
    token.length < 20 ||
    token.length > 4096 ||
    /\s/.test(token) ||
    !smsShopId ||
    smsShopId.length > 80 ||
    !SHOPMONKEY_CAPTURE_ORIGINS.has(origin)
  ) {
    return {
      status: "invalid",
      provider,
      reason: "Missing current Shopmonkey session proof",
    };
  }

  const shop = await __deps.findShopBySmsId(smsShopId, {
    isPlatformAdmin: true,
    providerHint: "shopmonkey",
  });
  if (
    !shop ||
    shop.provider !== "shopmonkey" ||
    !enabledForShop(provider, shop.mosShopId)
  ) {
    return {
      status: "unavailable",
      provider,
      reason: "Bootstrap is unavailable for this shop",
    };
  }

  try {
    // The probe host is pinned server-side; only the browser-captured bearer
    // travels. The stored shop-level API key is intentionally never used —
    // it can't attest WHO is at the keyboard.
    const requestInit: RequestInit = {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    };
    const [profileResponse, locationsResponse] = await Promise.all([
      __deps.fetch(`${SHOPMONKEY_API_ORIGIN}/v3/user/logged-in`, requestInit),
      __deps.fetch(`${SHOPMONKEY_API_ORIGIN}/v3/location`, requestInit),
    ]);
    if (
      [profileResponse.status, locationsResponse.status].some(
        (status) => status === 401 || status === 403,
      )
    ) {
      return {
        status: "expired",
        provider,
        reason: "Shopmonkey session is no longer valid",
      };
    }
    if (!profileResponse.ok || !locationsResponse.ok) {
      return {
        status: "invalid",
        provider,
        reason: "Shopmonkey session could not be verified",
      };
    }

    const [profileData, locationsData] = await Promise.all([
      readJson(profileResponse),
      readJson(locationsResponse),
    ]);
    if (!extractShopmonkeyShopIds(profileData, locationsData).has(smsShopId)) {
      return {
        status: "invalid",
        provider,
        reason: "Shopmonkey session belongs to a different shop",
      };
    }

    if (!(await claimProofOnce(provider, smsShopId, token))) {
      return {
        status: "replayed",
        provider,
        reason: "This proof was already exchanged",
      };
    }

    const verifiedAt = new Date(__deps.now());
    return {
      status: "verified",
      provider,
      shopId: shop.mosShopId,
      smsShopId,
      shopName: String(
        shop.shopDoc?.name ||
          shop.shopDoc?.shopName ||
          shop.shopDoc?.shopmonkey?.shopName ||
          `Shop ${shop.mosShopId}`,
      ),
      employee: employeeFromProfile(profileData),
      verifiedAt,
      expiresAt: new Date(verifiedAt.getTime() + PROOF_LIFETIME_MS),
    };
  } catch {
    return {
      status: "invalid",
      provider,
      reason: "Shopmonkey session could not be verified",
    };
  }
}