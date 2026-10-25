import { findShopBySmsIdDetailed } from "./extension-shop-lookup";
import { requireExtensionPrincipalScope, type ExtensionAuthResult } from "./extension-auth";

// Keytags historically use the token's primary shop. Shopmonkey must prove the
// requested canonical location before reading either configuration or branding.
export async function checkShopmonkeyPrintTarget(auth: ExtensionAuthResult, provider: unknown, smsShopId: unknown) {
  if (provider !== "shopmonkey" && auth.principal?.provider !== "shopmonkey") return null;
  if (provider !== "shopmonkey" || typeof smsShopId !== "string" || !smsShopId) {
    return { status: 400, error: "Open Print from the current Shopmonkey order and location." };
  }
  const target = await findShopBySmsIdDetailed(smsShopId, {
    providerHint: "shopmonkey", providerHintIsAuthoritative: true,
    userShopIds: [Number(auth.user?.shopId)],
  });
  if (target.status !== "resolved") return {
    status: target.status === "conflict" ? 409 : target.status === "access_denied" ? 403 : 404,
    error: "Shopmonkey location is missing, inaccessible, or ambiguously mapped. Ask your administrator to check its MOS mapping.",
  };
  if (requireExtensionPrincipalScope(auth, { provider: "shopmonkey", shopId: target.mosShopId })) {
    return { status: 403, error: "Sign in to MOS for this Shopmonkey location before printing." };
  }
  return null;
}
