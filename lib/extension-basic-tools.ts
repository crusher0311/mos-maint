import type { ExtensionSessionPrincipal } from "@/lib/extension-session";

/**
 * Basic shop tools may render and enqueue a print for the session-bound shop,
 * but they must not trigger persisted sticker telemetry or auto-booking.
 */
export function shouldRunStickerSideEffects(
  principal: Pick<ExtensionSessionPrincipal, "assurance"> | undefined,
): boolean {
  return principal?.assurance !== "basic";
}

function normalizeProvider(provider: string | null | undefined): string | null {
  const normalized = String(provider || "")
    .trim()
    .toLowerCase()
    .replace(/^shop[-_]ware$/, "shopware");
  return normalized || null;
}

export function resolveGuardProvider(
  principal:
    | Pick<ExtensionSessionPrincipal, "provider" | "isLegacy">
    | undefined,
  requestedProvider: string | null | undefined,
):
  | { ok: true; provider: string | null; authoritative: boolean }
  | { ok: false } {
  const requested = normalizeProvider(requestedProvider);
  const principalProvider =
    principal?.isLegacy !== true
      ? normalizeProvider(principal?.provider)
      : null;
  if (principalProvider && requested && principalProvider !== requested) {
    return { ok: false };
  }
  return {
    ok: true,
    provider: principalProvider || requested,
    authoritative: Boolean(principalProvider),
  };
}

export function printRequestRequiresWrite(body: {
  type?: unknown;
  imageBase64?: unknown;
}): boolean {
  const hasClientImage =
    typeof body.imageBase64 === "string" && body.imageBase64.trim() !== "";
  const isConstrainedServerRender =
    body.type === "keytag" && !hasClientImage;
  return !isConstrainedServerRender;
}
