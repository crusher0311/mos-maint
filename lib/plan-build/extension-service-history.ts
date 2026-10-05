import {
  INSPECTION_SERVICE_KEYS,
  isInspectOnlyHistoryPhrase,
} from "@/lib/service-keys";

export type ExtensionTransmissionKey = "trans_auto" | "trans_manual" | "dct";

/**
 * The extension analyzer predates the shared service-key mapper and still has
 * a local pattern table. Keep the transmission distinctions explicit here:
 * CVT is serviced on the automatic-fluid clock, while manual and dual-clutch
 * services retain their own keys.
 */
export const EXTENSION_TRANSMISSION_PATTERNS: Record<
  ExtensionTransmissionKey,
  RegExp[]
> = {
  dct: [
    /\bdct\b/i,
    /\bdual[- ]clutch\b/i,
    /\bdsg\b/i,
    /\bs-?tronic\b/i,
    /\bpdk\b/i,
    /\bpowershift\b/i,
  ],
  trans_manual: [
    /\bmanual (?:transmission|trans|transaxle)\b/i,
    /\bmtf\b/i,
    /\bmanual gearbox\b/i,
  ],
  trans_auto: [
    /\bcvt(?: transmission)?\s+(?:fluid|service)\b/i,
    /\bautomatic trans/i,
    /\batf\b/i,
    /\bauto trans/i,
    /\btransmission fluid/i,
  ],
};

export function mapExtensionTransmissionServiceToKey(
  serviceName: string,
): ExtensionTransmissionKey | null {
  const name = serviceName?.toLowerCase() || "";
  // Specific technologies must win over the generic "transmission fluid"
  // pattern (for example, "manual transmission fluid").
  for (const key of ["dct", "trans_manual", "trans_auto"] as const) {
    if (EXTENSION_TRANSMISSION_PATTERNS[key].some(pattern => pattern.test(name))) {
      return key;
    }
  }
  return null;
}

/**
 * Phrase-level history guard used by the extension analyzer. CARFAX combines
 * multiple service bullets into one record, so callers split first and only
 * credit a phrase that both identifies this service and records performed
 * work. A checked/inspected phrase is not replacement history.
 */
export function isPerformedExtensionHistoryPhrase(
  phrase: string,
  serviceKey: string,
  patterns: RegExp[],
): boolean {
  if (
    serviceKey === "trans_auto" ||
    serviceKey === "trans_manual" ||
    serviceKey === "dct"
  ) {
    const transmissionKey = mapExtensionTransmissionServiceToKey(phrase);
    if (transmissionKey && transmissionKey !== serviceKey) return false;
  }
  if (!patterns.some(pattern => pattern.test(phrase))) return false;
  return (
    !isInspectOnlyHistoryPhrase(phrase) ||
    INSPECTION_SERVICE_KEYS.has(serviceKey)
  );
}

export function hasUnresolvedCvtRecommendation(
  recommendations: unknown,
): boolean {
  if (!Array.isArray(recommendations)) return false;
  return recommendations.some(item => {
    if (!item || typeof item !== "object") return false;
    const row = item as { service?: unknown; serviceKey?: unknown };
    return (
      (row.serviceKey == null || row.serviceKey === "") &&
      typeof row.service === "string" &&
      /\bcvt(?: transmission)?\s+(?:fluid|service)\b/i.test(row.service)
    );
  });
}

type PerformedCandidate = { date?: Date; mileage?: number };

export function chooseExtensionLastPerformed(
  shop: PerformedCandidate | null,
  external: PerformedCandidate | null,
): { source: "shop" | "external" | "unknown"; date?: Date; mileage?: number } {
  if (shop && external) {
    if (shop.date && external.date) {
      return shop.date >= external.date
        ? { source: "shop", ...shop }
        : { source: "external", ...external };
    }
    // Preserve the extension's established same-visit/shop precedence when
    // one source lacks a comparable date.
    return { source: "shop", ...shop };
  }
  if (shop) return { source: "shop", ...shop };
  if (external) return { source: "external", ...external };
  return { source: "unknown" };
}