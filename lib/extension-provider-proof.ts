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
      status: "unsupported" | "invalid" | "expired" | "replayed";
      provider: Exclude<ExtensionProvider, "protractor">;
      reason: string;
    };

type BootstrapProvider = Exclude<ExtensionProvider, "protractor">;

const TEKMETRIC_ORIGINS = new Set([
  "https://shop.tekmetric.com",
  "https://sandbox.tekmetric.com",
  "https://cba.tekmetric.com",
]);
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
  const explicitlyVerified =
    profile.emailVerified === true ||
    profile.email_verified === true ||
    profile.isEmailVerified === true ||
    profile.verifiedEmail === true;
  return explicitlyVerified && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)
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

async function claimProofOnce(
  provider: BootstrapProvider,
  smsShopId: string,
  token: string,
): Promise<boolean> {
  const fingerprint = crypto
    .createHash("sha256")
    .update(`${provider}\0${smsShopId}\0${token}`)
    .digest("hex");
  const claimed = await __deps.rateLimit({
    // Only a one-way fingerprint is stored; provider credentials never are.
    id: `extension-bootstrap-proof:${fingerprint}`,
    limit: 1,
    windowSeconds: Math.ceil(PROOF_LIFETIME_MS / 1000),
  });
  return claimed.allowed;
}

/**
 * Validate a browser-session proof at the provider, never against MOS-held
 * partner/API credentials. A URL, DOM value, or caller-supplied shop id is only
 * context; the provider's authenticated current-employee shop response must
 * independently contain the same shop before MOS trusts it.
 *
 * Shop-Ware, Shopmonkey, and AutoFlow intentionally remain unsupported. Their
 * currently available APIs/cookies do not provide an independently verifiable,
 * server-probeable current browser-session subject without forwarding cookies.
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
  if (
    !shop ||
    shop.provider !== "tekmetric" ||
    !enabledForShop(provider, shop.mosShopId)
  ) {
    return {
      status: "invalid",
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