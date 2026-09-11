/**
 * Bounded, server-side resolver for actionable Estimate Audit findings.
 *
 * The resolver is intentionally separate from the UI and the provider write
 * routes.  It reads an already-populated canned-job cache, then performs one
 * bounded history search in the caller's authorized shop scope.  It never
 * warms a catalog, performs bulk detail enrichment, or writes a provider
 * record.
 */

import { getEnterpriseByShopId } from "@/lib/enterprise";
import {
  findCannedJobsCacheByShopId,
} from "@/lib/data/repositories/protractor-canned-jobs";
import {
  findRecommendationCachedCatalogs,
  findRecommendationShopPreferences,
  searchRecommendationHistory,
} from "@/lib/data/repositories/recommendation-caches";
import { searchJobsCombined, type CombinedJobSearchResult } from "@/lib/job-search-combined";
import { buildSearchQuery, scoreJob } from "@/lib/job-scoring";
import { toKeyFromName } from "@/lib/service-keys";
import type {
  AuditSelection,
  RecommendationCandidate,
  RecommendationFinding,
  RecommendationLine,
  RecommendationLineType,
  RecommendationRelevance,
  RecommendationResolution,
  RecommendationResolveOptions,
  RecommendationSourceIdentity,
  RecommendationVehicle,
  RecommendationWarning,
} from "@/lib/estimate-assist/recommendation-types";

const MAX_CANNED_ITEMS = 500;
const MAX_HISTORY_CANDIDATES = 24;
const MAX_RETURNED_CANDIDATES = 6;
const MAX_TITLE_LENGTH = 180;

type AnyRecord = Record<string, any>;
type RecommendationDb = any;

export interface CachedRecommendationCatalog {
  /** Provider owning the catalog, e.g. protractor or tekmetric. */
  sourceSystem: string;
  /** MOS shop id, not an upstream provider location id. */
  shopId: number;
  items: AnyRecord[];
  fetchedAt?: Date | string | null;
  source?: string | null;
  listSource?: string | null;
}

export interface RecommendationResolverDeps {
  /**
   * Test seam only. Production repository calls use their own DB handle; a
   * smoke test can provide a fake handle and the default repository wrapper
   * passes it through as dbOverride.
   */
  getDb: () => Promise<RecommendationDb | null>;
  getEnterpriseByShopId: typeof getEnterpriseByShopId;
  findCannedJobsCacheByShopId: typeof findCannedJobsCacheByShopId;
  findRecommendationCachedCatalogs: typeof findRecommendationCachedCatalogs;
  findRecommendationShopPreferences: typeof findRecommendationShopPreferences;
  searchRecommendationHistory: typeof searchRecommendationHistory;
  findCannedCatalogsByShopId: (shopId: number) => Promise<CachedRecommendationCatalog[]>;
  searchJobsCombined: typeof searchJobsCombined;
  searchHistory: (
    shopIds: number[],
    query: string,
    vehicle: RecommendationVehicle,
  ) => Promise<{ ok: boolean; jobs: any[]; source?: string; error?: string }>;
  fetchCannedDetail: (
    shopId: number,
    id: string,
    listSource?: string | null,
  ) => Promise<{ ok: boolean; detail?: any; error?: string }>;
}

/**
 * Test seam.  The route-level tests can replace each dependency without
 * connecting to Mongo, Postgres, or a provider.
 */
export const __deps: RecommendationResolverDeps = {
  getDb: async () => null,
  getEnterpriseByShopId,
  findCannedJobsCacheByShopId,
  findRecommendationCachedCatalogs,
  findRecommendationShopPreferences,
  searchRecommendationHistory,
  searchJobsCombined,
  findCannedCatalogsByShopId: async (shopId) => {
    const catalogs: CachedRecommendationCatalog[] = [];
    const protractor = await __deps.findCannedJobsCacheByShopId(shopId);
    if (protractor) {
      catalogs.push({
        sourceSystem: "protractor",
        shopId,
        items: Array.isArray((protractor as AnyRecord).items)
          ? (protractor as AnyRecord).items
          : [],
        fetchedAt: protractor.fetchedAt,
        source: protractor.source || null,
        listSource: protractor.listSource || null,
      });
    }
    const db = await __deps.getDb();
    const providerCatalogs = await __deps.findRecommendationCachedCatalogs(shopId, {
      dbOverride: db || undefined,
    });
    return [...catalogs, ...providerCatalogs];
  },
  searchHistory: async (shopIds, query, vehicle) => {
    const db = await __deps.getDb();
    const { coreTokens } = buildSearchQuery(query);
    const combined: CombinedJobSearchResult = await __deps.searchRecommendationHistory(shopIds, coreTokens, {
      dbOverride: db || undefined,
      searchJobsCombined: __deps.searchJobsCombined,
      make: vehicle.make || undefined,
      model: vehicle.model || undefined,
      supabaseLimit: MAX_HISTORY_CANDIDATES,
      mongoLimit: MAX_HISTORY_CANDIDATES,
      // Service relevance is enforced below.  A model is supporting evidence,
      // not a hard filter, so a missing exact-model row can still be useful.
      strictModel: false,
    });
    const diagnostics = combined.diagnostics;
    const historyUnavailable =
      combined.jobs.length === 0 &&
      Boolean(
        diagnostics?.supabaseError ||
        diagnostics?.mongoError ||
        diagnostics?.supabaseTimedOut,
      );
    return {
      ok: !historyUnavailable,
      jobs: combined.jobs,
      source: combined.source,
      ...(historyUnavailable
        ? {
            error:
              diagnostics?.supabaseError ||
              diagnostics?.mongoError ||
              "Historical job search timed out before an authorized result was available.",
          }
        : {}),
    };
  },
  fetchCannedDetail: async (shopId, id, listSource) => {
    // Selected-job hydration is deliberately one item, not catalog
    // enrichment.  Dispatch using the list endpoint's ID namespace.
    const protractor = await import("@/lib/integrations/protractor");
    const result = await protractor.fetchCannedJobDetailForListSource(
      shopId,
      id,
      listSource as "cannedjob" | "servicepackagetemplate" | undefined,
    );
    return { ok: result.ok, detail: result.detail, error: result.error };
  },
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function firstRecord(...values: unknown[]): AnyRecord {
  return values.find((value) => value && typeof value === "object" && !Array.isArray(value)) as AnyRecord || {};
}

function unwrapItems(value: unknown): any[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    const object = value as AnyRecord;
    for (const key of ["ItemCollection", "items", "Items", "value", "lines", "LineItems"]) {
      if (Array.isArray(object[key])) return object[key];
    }
  }
  return [];
}

function normalizeLineType(value: unknown): RecommendationLineType {
  const lower = text(value).toLowerCase();
  if (lower.includes("labor") || lower.includes("labour") || lower === "time") return "labor";
  if (lower.includes("sublet")) return "sublet";
  if (lower.includes("part") || lower.includes("material") || lower.includes("product")) return "part";
  return "other";
}

function extractRawLines(raw: AnyRecord): any[] {
  const job = firstRecord(raw.job, raw.Job);
  const directLines = unwrapItems(
    raw.lines ??
    raw.Lines ??
    raw.lineItems ??
    raw.LineItems ??
    raw.ServicePackageLines ??
    raw.servicePackageLines ??
    job.lines ??
    job.lineItems ??
    job.LineItems,
  );
  if (directLines.length > 0) return directLines;

  // Extension/provider caches commonly keep labor and parts in separate
  // arrays. Preserve the source bucket as a type hint without changing the
  // cached objects that are used for source identity.
  const labor = unwrapItems(raw.labor ?? raw.Labor ?? raw.laborItems ?? raw.LaborItems)
    .map((line) => line && typeof line === "object" ? { ...line, Type: (line as AnyRecord).Type ?? "Labor" } : line);
  const parts = unwrapItems(raw.parts ?? raw.Parts ?? raw.partItems ?? raw.PartItems)
    .map((line) => line && typeof line === "object" ? { ...line, Type: (line as AnyRecord).Type ?? "Part" } : line);
  return [...labor, ...parts];
}

function extractTitle(raw: AnyRecord): string {
  const header = firstRecord(
    raw.ServicePackageHeader,
    raw.servicePackageHeader,
    raw.Header,
    raw.header,
    raw.ServicePackageFooter,
  );
  const job = firstRecord(raw.job, raw.Job);
  return text(
    raw.Title ??
    raw.title ??
    raw.name ??
    raw.Name ??
    raw.CannedJobName ??
    raw.cannedJobName ??
    header.Title ??
    header.title ??
    job.title ??
    job.name,
  );
}

function extractDescription(raw: AnyRecord): string | null {
  const header = firstRecord(raw.ServicePackageHeader, raw.servicePackageHeader, raw.Header, raw.header);
  const job = firstRecord(raw.job, raw.Job);
  const result = text(raw.Description ?? raw.description ?? header.Description ?? header.description ?? job.description);
  return result || null;
}

function extractSourceId(raw: AnyRecord): string {
  const value =
    raw.ID ??
    raw.id ??
    raw._id ??
    raw.cannedJobId ??
    raw.CannedJobID ??
    raw.ServicePackageTemplateID ??
    raw.servicePackageTemplateId ??
    raw.code ??
    raw.Code;
  return text(typeof value === "object" && value !== null && "toString" in value ? value.toString() : value);
}

function normalizeLine(raw: AnyRecord): RecommendationLine | null {
  const description = text(
    raw.Description ??
    raw.description ??
    raw.name ??
    raw.Name ??
    raw.partDescription ??
    raw.PartDescription ??
    raw.title ??
    raw.itemName ??
    raw.ItemName ??
    raw.laborName ??
    raw.LaborName ??
    raw.partName ??
    raw.PartName,
  );
  if (!description) return null;

  const sourceQuantity = finiteNumber(raw.Quantity ?? raw.quantity ?? raw.qty) ?? 1;
  const unitPrice = finiteNumber(
    raw.Price ??
    raw.price ??
    raw.UnitPrice ??
    raw.unitPrice ??
    raw.Rate ??
    raw.rate ??
    raw.LaborRate ??
    raw.laborRate ??
    raw.RetailPrice ??
    raw.retailPrice ??
    raw.SalePrice ??
    raw.salePrice ??
    raw.Amount ??
    raw.amount ??
    raw.Retail ??
    raw.retail,
  );
  const extendedPrice = finiteNumber(
    raw.ExtendedTotal ??
    raw.extendedTotal ??
    raw.Total ??
    raw.total ??
    raw.extendedPrice ??
    raw.ExtendedPrice ??
    raw.TotalPrice ??
    raw.totalPrice ??
    raw.LineTotal ??
    raw.lineTotal ??
    raw.Amount ??
    raw.amount,
  );
  const cost = finiteNumber(raw.Cost ?? raw.cost ?? raw.UnitCost ?? raw.unitCost);
  const extendedCost = finiteNumber(raw.ExtendedCost ?? raw.extendedCost ?? raw.TotalCost ?? raw.totalCost);
  const hours = finiteNumber(
    raw.TechnicianHour ??
    raw.TechnicianHours ??
    raw.technicianHour ??
    raw.LaborHours ??
    raw.Hours ??
    raw.laborHours ??
    raw.hours,
  );
  const lineType = normalizeLineType(raw.Type ?? raw.type ?? raw.LineType ?? raw.lineType);
  // Provider history often stores labor as a billed-hours field while leaving
  // quantity at its default 1.  Preserve those real hours through the write
  // contract instead of silently turning 2.5 hours into one labor unit.
  const quantity = lineType === "labor" && hours != null && hours > 0
    ? hours
    : sourceQuantity > 0 ? sourceQuantity : 1;

  return {
    lineType,
    description,
    quantity,
    unitPrice,
    extendedPrice: extendedPrice ?? (unitPrice != null ? unitPrice * quantity : null),
    ...(cost != null ? { cost } : {}),
    ...(extendedCost != null ? { extendedCost } : {}),
    partNumber: text(raw.PartNumber ?? raw.partNumber) || null,
    manufacturer: text(raw.Manufacturer ?? raw.manufacturer ?? raw.brand) || null,
    hours,
  };
}

function moneyForSource(value: number | null, sourceSystem?: string | null): number | null {
  if (value == null) return null;
  // Tekmetric's canned-job API reports monetary amounts in cents. Protractor
  // and the normalized history/search stores report dollars, so conversion
  // must be source-aware rather than applied to every provider line.
  return text(sourceSystem).toLowerCase() === "tekmetric" ? value / 100 : value;
}

function normalizeLines(raw: AnyRecord, sourceSystem?: string | null): RecommendationLine[] {
  return extractRawLines(raw)
    .map((line) => {
      if (!line || typeof line !== "object") return null;
      const normalized = normalizeLine(line as AnyRecord);
      if (!normalized) return null;
      if (text(sourceSystem).toLowerCase() !== "tekmetric") return normalized;
      return {
        ...normalized,
        unitPrice: moneyForSource(normalized.unitPrice, sourceSystem),
        extendedPrice: moneyForSource(normalized.extendedPrice, sourceSystem),
        cost: moneyForSource(normalized.cost ?? null, sourceSystem),
        extendedCost: moneyForSource(normalized.extendedCost ?? null, sourceSystem),
      };
    })
    .filter((line): line is RecommendationLine => !!line);
}

function warning(code: string, message: string): RecommendationWarning {
  return { code, message };
}

function warningsForLines(lines: RecommendationLine[], hadRawLines: boolean): RecommendationWarning[] {
  const warnings: RecommendationWarning[] = [];
  if (!hadRawLines || lines.length === 0) {
    warnings.push(warning("missing_lines", "Source details did not include usable labor or parts lines."));
    return warnings;
  }
  if (lines.some((line) => line.unitPrice == null || line.extendedPrice == null)) {
    warnings.push(warning("missing_prices", "One or more source lines do not include a price and require review."));
  }
  if (lines.some((line) => !line.description || line.quantity <= 0)) {
    warnings.push(warning("incomplete_lines", "One or more source lines are incomplete."));
  }
  return warnings;
}

function normalizeCandidateLines(raw: AnyRecord, sourceSystem?: string | null): {
  lines: RecommendationLine[];
  warnings: RecommendationWarning[];
} {
  const rawLines = extractRawLines(raw);
  const tekmetricAggregateOnly =
    text(sourceSystem).toLowerCase() === "tekmetric" &&
    rawLines.length > 0 &&
    rawLines.every((line) => {
      const description = text(
        line?.Description ??
        line?.description ??
        line?.name ??
        line?.Name ??
        line?.title,
      ).toLowerCase().replace(/[^a-z]+/g, " ").trim();
      return /^(?:total )?(?:labor|parts?|materials?)(?: total)?$/.test(description);
    });
  if (tekmetricAggregateOnly) {
    return {
      lines: [],
      warnings: warningsForLines([], false),
    };
  }
  const lines = normalizeLines(raw, sourceSystem);
  return { lines, warnings: warningsForLines(lines, rawLines.length > 0) };
}

/**
 * Explicit service identities are intentionally stricter than generic token
 * overlap.  In particular, a brake-fluid recommendation must never resolve
 * to a pad/rotor package merely because both contain "brake".
 */
export type RecommendationServiceIdentity = string;

const SERVICE_ID_BY_JOB_ID: Record<string, RecommendationServiceIdentity> = {
  "brake-fluid-flush": "brake_fluid",
  "brakes-front-pads": "brake_front_pads",
  "brakes-rear-pads": "brake_rear_pads",
  "brakes-front-rotors": "brake_front_rotors",
  "brakes-rear-rotors": "brake_rear_rotors",
  "oil-change-conventional": "oil_change",
  "oil-change-synthetic": "oil_change",
  "coolant-flush": "coolant",
  "transmission-fluid-change": "transmission_fluid",
  "transmission-fluid-service": "transmission_fluid",
  "differential-fluid": "differential_fluid",
  "transfer-case-fluid": "transfer_case_fluid",
};

function serviceIdentity(jobId: string | null | undefined, title: string): RecommendationServiceIdentity {
  const explicit = jobId ? SERVICE_ID_BY_JOB_ID[text(jobId).toLowerCase()] : undefined;
  if (explicit) return explicit;
  const lower = text(title).toLowerCase().replace(/[-_/]+/g, " ");
  if (/\bbrake\s*(?:fluid|flush|bleed)|fluid\s*(?:flush|bleed).*brake\b/.test(lower)) return "brake_fluid";
  if (/\bfront\b.*\bbrake\b.*\bpad|\bbrake\b.*\bpad.*\bfront\b/.test(lower)) return "brake_front_pads";
  if (/\brear\b.*\bbrake\b.*\bpad|\bbrake\b.*\bpad.*\brear\b/.test(lower)) return "brake_rear_pads";
  if (/\bfront\b.*\b(?:brake\s*)?rotor|\brotor\b.*\bfront\b/.test(lower)) return "brake_front_rotors";
  if (/\brear\b.*\b(?:brake\s*)?rotor|\brotor\b.*\brear\b/.test(lower)) return "brake_rear_rotors";
  if (/\bbrake\b.*\bpad|\bpad\b.*\bbrake/.test(lower)) return "brake_front_pads";
  if (/\boil\b.*\b(?:change|service|filter)|\blube\b/.test(lower)) return "oil_change";
  if (/\bcoolant\b|\bradiator\b|\bantifreeze\b/.test(lower)) return "coolant";
  if (/\btrans(?:mission)?\b.*\bfluid|\batf\b/.test(lower)) return "transmission_fluid";
  if (/\bdifferential\b.*\bfluid|\bdiff(?:erential)?\s*fluid/.test(lower)) return "differential_fluid";
  if (/\btransfer\s*case\b/.test(lower)) return "transfer_case_fluid";
  if (/\balignment\b/.test(lower)) return "alignment";
  if (/\btire\b|\btyre\b|\brotation\b|\bbalance\b/.test(lower)) return "tire";
  // Reuse the production-configured service vocabulary after the explicit
  // safety rules above.  This covers shop/provider phrasing such as
  // "BG Brake System Service", "Align 4W", and OEM fluid names without
  // weakening the brake-fluid separation.
  const configuredKey = toKeyFromName(text(title));
  if (configuredKey) {
    const configuredIdentity: Record<string, string> = {
      oil: "oil_change",
      tire_rotation: "tire",
      coolant: "coolant",
      brake_fluid: "brake_fluid",
      trans_auto: "transmission_fluid",
      trans_manual: "transmission_fluid",
      transfer_case: "transfer_case_fluid",
      front_differential: "differential_fluid",
      rear_differential: "differential_fluid",
      wheel_alignment: "alignment",
      front_brake_pads: "brake_front_pads",
      rear_brake_pads: "brake_rear_pads",
      front_brake_rotors: "brake_front_rotors",
      rear_brake_rotors: "brake_rear_rotors",
    };
    return configuredIdentity[configuredKey] || `configured:${configuredKey}`;
  }
  return "generic";
}

function serviceCategory(identity: RecommendationServiceIdentity): string {
  if (identity.startsWith("brake_")) return "brake";
  if (identity.includes("fluid") || identity === "coolant" || identity === "oil_change") return "fluid";
  if (identity === "tire" || identity === "alignment") return "wheel";
  return identity;
}

function serviceMatch(
  target: RecommendationServiceIdentity,
  candidate: RecommendationServiceIdentity,
  targetTitle: string,
  candidateTitle: string,
): "exact" | "related" | "none" {
  // Unmapped services share the `generic` bucket only as a fallback.  Treating
  // that bucket itself as exact made every unknown title (for example water
  // pump) appear to be an exact match for every other unknown service.
  if (target === candidate && target !== "generic") return "exact";
  // Brake-fluid is deliberately isolated from every brake hardware job.
  if (target === "brake_fluid" || candidate === "brake_fluid") return "none";
  if (
    target !== "generic" &&
    candidate !== "generic" &&
    serviceCategory(target) === serviceCategory(candidate)
  ) {
    // Front/rear pads and front/rear rotors are related within their service
    // family, but pads and rotors are not interchangeable packages.
    if (
      (target.includes("pads") && candidate.includes("rotors")) ||
      (target.includes("rotors") && candidate.includes("pads"))
    ) return "none";
    return "related";
  }
  const targetTokens = tokenize(targetTitle);
  const candidateTokens = tokenize(candidateTitle);
  const overlap = targetTokens.filter((token) => candidateTokens.includes(token));
  return overlap.length >= Math.min(2, targetTokens.length) && targetTokens.length > 0 ? "related" : "none";
}

function tokenize(value: string): string[] {
  return Array.from(new Set(
    text(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .filter((token) => token.length >= 3 && !["the", "and", "for", "with", "service", "replace"].includes(token)),
  ));
}

function vehicleRelevance(
  target: RecommendationVehicle,
  candidate: AnyRecord,
): { kind: RecommendationRelevance["vehicleMatch"]; score: number } {
  const vehicle = firstRecord(candidate.vehicle, candidate.Vehicle);
  const targetVin = text(target.vin).toUpperCase();
  const candidateVin = text(candidate.vin ?? vehicle.vin).toUpperCase();
  if (targetVin && candidateVin && targetVin === candidateVin) return { kind: "vin", score: 38 };

  const targetYear = text(target.year);
  const candidateYear = text(candidate.vehicleYear ?? vehicle.year);
  const targetMake = text(target.make).toLowerCase();
  const candidateMake = text(candidate.vehicleMake ?? vehicle.make).toLowerCase();
  const targetModel = text(target.model).toLowerCase();
  const candidateModel = text(candidate.vehicleModel ?? vehicle.model).toLowerCase();
  if (targetYear && targetMake && targetModel && targetYear === candidateYear && targetMake === candidateMake && targetModel === candidateModel) {
    return { kind: "exact", score: 34 };
  }
  if (targetMake && targetModel && targetMake === candidateMake && targetModel === candidateModel) {
    return { kind: "make_model", score: 27 };
  }
  if (targetMake && targetMake === candidateMake) return { kind: "make", score: 17 };
  return { kind: "unknown", score: 4 };
}

function candidateRelevance(
  targetIdentity: RecommendationServiceIdentity,
  targetTitle: string,
  targetVehicle: RecommendationVehicle,
  candidateIdentity: RecommendationServiceIdentity,
  candidateTitle: string,
  rawCandidate: AnyRecord,
  useHistoricalScoring = false,
): RecommendationRelevance | null {
  const match = serviceMatch(targetIdentity, candidateIdentity, targetTitle, candidateTitle);
  if (match === "none") return null;
  const vehicle = vehicleRelevance(targetVehicle, rawCandidate);
  const titleTokens = tokenize(targetTitle);
  const candidateTokens = tokenize(candidateTitle);
  const tokenOverlap = titleTokens.filter((token) => candidateTokens.includes(token)).length;
  const titleScore = titleTokens.length ? Math.min(12, Math.round((tokenOverlap / titleTokens.length) * 12)) : 0;
  let score = (match === "exact" ? 52 : 28) + titleScore + vehicle.score;
  let historicalScore: number | undefined;
  if (useHistoricalScoring) {
    try {
      // Keep the existing job scorer as the vehicle/history signal.  The
      // explicit service identity gate above still owns false-match
      // prevention (notably brake fluid versus pads/rotors).
      const scored = scoreJob(
        rawCandidate,
        {
          vin: targetVehicle.vin,
          year: targetVehicle.year,
          make: targetVehicle.make,
          model: targetVehicle.model,
          engine: targetVehicle.engine,
        },
        null,
        null,
        targetTitle,
        { currentShopId: rawCandidate.shopId },
      );
      // scoreJob's fuel/class safety gate is authoritative for historical
      // vehicle fit. A failed gate (for example a gas F-150 against a diesel
      // F-250 water-pump job) must never be surfaced as a usable history
      // candidate merely because its title matches.
      if (!scored.gatePass) return null;
      if (scored.gatePass) {
        historicalScore = scored.matchScore;
        score = Math.max(score, historicalScore);
      }
    } catch {
      // History relevance remains bounded by the resolver's local score if a
      // legacy row has an unexpected vehicle shape.
    }
  }
  score = Math.min(100, score);
  const band = score >= 72 ? "strong" : score >= 48 ? "likely" : "possible";
  return {
    score,
    band,
    serviceMatch: match,
    vehicleMatch: vehicle.kind,
    ...(historicalScore == null ? {} : { historicalScore }),
    reason: `${match === "exact" ? "Exact service identity" : "Related service"}; ${vehicle.kind.replace("_", " ")} vehicle relevance`,
  };
}

function cannedCandidate(
  shopId: number,
  raw: AnyRecord,
  sourceSystem: string,
  listSource: string | null | undefined,
  targetIdentity: RecommendationServiceIdentity,
  targetTitle: string,
  vehicle: RecommendationVehicle,
): RecommendationCandidate | null {
  const title = extractTitle(raw);
  const id = extractSourceId(raw);
  if (!title || !id) return null;
  const candidateIdentity = serviceIdentity(null, title);
  const relevance = candidateRelevance(targetIdentity, targetTitle, vehicle, candidateIdentity, title, raw);
  if (!relevance) return null;
  const normalized = normalizeCandidateLines(raw, sourceSystem);
  const source: RecommendationSourceIdentity = {
    kind: "canned",
    shopId,
    id,
    sourceSystem,
    title,
    listSource: listSource || null,
  };
  return {
    source,
    sourceIdentity: source,
    title,
    description: extractDescription(raw),
    lines: normalized.lines,
    warnings: normalized.warnings,
    relevance,
  };
}

function canHydrateCannedSource(sourceSystem: string | null | undefined): boolean {
  // Protractor is the only provider with a bounded selected-detail adapter.
  // Other providers' cached rows must already contain real estimate lines.
  return text(sourceSystem).toLowerCase() === "protractor";
}

function isThinAggregateCatalogCandidate(candidate: RecommendationCandidate): boolean {
  return candidate.lines.length === 0 && !canHydrateCannedSource(candidate.source.sourceSystem);
}

function historyCandidate(
  shopId: number,
  raw: AnyRecord,
  targetIdentity: RecommendationServiceIdentity,
  targetTitle: string,
  vehicle: RecommendationVehicle,
): RecommendationCandidate | null {
  const title = text(raw.job?.title ?? raw.job?.name ?? raw.title ?? raw.name);
  if (!title) return null;
  const candidateIdentity = serviceIdentity(null, title);
  const relevance = candidateRelevance(targetIdentity, targetTitle, vehicle, candidateIdentity, title, raw, true);
  if (!relevance) return null;
  const normalized = normalizeCandidateLines(raw);
  const source: RecommendationSourceIdentity = {
    kind: "history",
    shopId,
    id: text(raw._id ?? raw.id ?? raw.serviceJobId ?? raw.workOrderId ?? `${shopId}:${title}`),
    sourceSystem: text(raw.sourceSystem ?? raw.provenance?.sourceSystem) || null,
    workOrderId: text(raw.workOrderId ?? raw.job?.workOrderId) || null,
    workOrderNumber: text(raw.workOrderNumber ?? raw.woNumber) || null,
    title,
  };
  if (!source.id) return null;
  if (source.workOrderId && source.id === source.workOrderId) source.id = source.workOrderId;
  return {
    source,
    sourceIdentity: source,
    title,
    description: text(raw.job?.description ?? raw.description) || null,
    lines: normalized.lines,
    warnings: normalized.warnings,
    relevance,
  };
}

function sortCandidates(candidates: RecommendationCandidate[]): RecommendationCandidate[] {
  return candidates
    .sort((a, b) => b.relevance.score - a.relevance.score || a.title.localeCompare(b.title))
    .slice(0, MAX_RETURNED_CANDIDATES);
}

function dedupeCandidates(candidates: RecommendationCandidate[]): RecommendationCandidate[] {
  const bySource = new Map<string, RecommendationCandidate>();
  for (const candidate of candidates) {
    const key = [
      candidate.source.kind,
      candidate.source.sourceSystem || "",
      candidate.source.shopId,
      candidate.source.id,
    ].join(":");
    const previous = bySource.get(key);
    if (!previous || candidate.lines.length > previous.lines.length) bySource.set(key, candidate);
  }
  return Array.from(bySource.values());
}

function scopeWarning(): RecommendationWarning {
  return warning(
    "history_scope_unavailable",
    "Enterprise history scope could not be verified; only the current shop was searched.",
  );
}

/**
 * Return the current shop plus only the enterprise locations selected by the
 * target shop's job-history preference.  A preference can never grant access
 * to a shop outside the enterprise account.
 */
export async function resolveAuthorizedHistoryShopIds(shopId: number): Promise<{
  shopIds: number[];
  warnings: RecommendationWarning[];
}> {
  const warnings: RecommendationWarning[] = [];
  try {
    const enterprise = await __deps.getEnterpriseByShopId(shopId);
    if (!enterprise?.shopIds?.length) return { shopIds: [shopId], warnings };

    const enterpriseIds = new Set(enterprise.shopIds.map(Number).filter(Number.isFinite));
    const db = await __deps.getDb();
    const preferences = await __deps.findRecommendationShopPreferences(shopId, {
      dbOverride: db || undefined,
    });
    const configured = preferences?.jobHistoryShopIds;
    if (Array.isArray(configured) && configured.length > 0) {
      const selected = configured
        .map(Number)
        .filter((id: number) => Number.isFinite(id) && enterpriseIds.has(id));
      if (!selected.includes(shopId)) selected.push(shopId);
      return { shopIds: Array.from(new Set(selected)), warnings };
    }
    return { shopIds: Array.from(new Set([shopId, ...enterpriseIds])), warnings };
  } catch (error) {
    // Fail closed for cross-shop history.  Current-shop history is still
    // useful and does not depend on enterprise metadata being available.
    console.warn("[Recommendation Resolver] history scope lookup failed:", error);
    warnings.push(scopeWarning());
    return { shopIds: [shopId], warnings };
  }
}

function normalizeFinding(finding: RecommendationFinding): { title: string; jobId: string | null } {
  return {
    title: text(finding?.suggestedJobTitle).slice(0, MAX_TITLE_LENGTH),
    jobId: text(finding?.suggestedJobId).toLowerCase() || null,
  };
}

async function previewRecommendationSelection(
  shopId: number,
  targetIdentity: RecommendationServiceIdentity,
  targetTitle: string,
  vehicle: RecommendationVehicle,
  selection: RecommendationResolveOptions["selection"],
): Promise<RecommendationResolution> {
  if (!selection?.source) {
    return {
      status: "unavailable",
      candidates: [],
      warnings: [warning("detail_unavailable", "A selected source identity is required to load job details.")],
    };
  }

  // Preview deliberately allows an empty line set so the UI can distinguish
  // "detail was checked but unusable" from "the source could not be
  // revalidated". The write route keeps its strict non-empty-line behavior.
  const hydrated = await rehydrateRecommendationSelection(
    shopId,
    selection,
    vehicle,
    { allowEmpty: true },
  );
  if (!hydrated.ok) {
    return {
      status: hydrated.code === "UNAVAILABLE" ? "unavailable" : "no_match",
      candidates: [],
      warnings: [warning("detail_unavailable", hydrated.error)],
    };
  }

  const recommendation = hydrated.recommendation;
  // The rehydrated source title is authoritative for candidate identity.
  // Never classify it using the browser-supplied finding job id: doing so
  // could make a selected brake-pad source look like a brake-fluid match.
  const candidateIdentity = serviceIdentity(null, recommendation.title);
  const relevance = candidateRelevance(
    targetIdentity,
    targetTitle,
    vehicle,
    candidateIdentity,
    recommendation.title,
    {},
  );
  if (!relevance) {
    return {
      status: "no_match",
      candidates: [],
      warnings: [warning("detail_unavailable", "The selected job no longer matches this audit recommendation.")],
    };
  }

  const candidate: RecommendationCandidate = {
    source: recommendation.source,
    sourceIdentity: recommendation.source,
    title: recommendation.title,
    description: recommendation.description,
    lines: recommendation.lines,
    warnings: recommendation.warnings,
    relevance,
  };
  return {
    status: "candidates",
    candidates: [candidate],
    warnings: recommendation.warnings,
  };
}

export async function resolveRecommendation(
  shopId: number,
  finding: RecommendationFinding,
  vehicle: RecommendationVehicle = {},
  options: RecommendationResolveOptions = {},
): Promise<RecommendationResolution> {
  const normalizedFinding = normalizeFinding(finding);
  const targetTitle = normalizedFinding.title;
  if (!targetTitle) {
    return {
      status: "no_match",
      candidates: [],
      warnings: [warning("invalid_finding", "A suggested job title is required.")],
    };
  }
  const targetIdentity = serviceIdentity(normalizedFinding.jobId, targetTitle);

  // A selected thin row is not an estimate. Hydrate only that source identity
  // before allowing the panel to confirm it; this path never broadens into a
  // catalog/history search and is also used for the one-item detail preview.
  if (options.mode === "preview") {
    return previewRecommendationSelection(
      shopId,
      targetIdentity,
      targetTitle,
      vehicle,
      options.selection,
    );
  }

  const warnings: RecommendationWarning[] = [];

  // Canned precedence: read only existing enriched/basic caches. Never call a
  // provider list or bulk-enrichment endpoint from this resolver.
  let cannedCatalogs: CachedRecommendationCatalog[] = [];
  let cannedCacheUnavailable = false;
  try {
    cannedCatalogs = await __deps.findCannedCatalogsByShopId(shopId);
  } catch (error) {
    console.warn("[Recommendation Resolver] canned cache lookup failed:", error);
    cannedCacheUnavailable = true;
    warnings.push(warning("canned_cache_unavailable", "Shop canned jobs could not be looked up."));
  }

  if (cannedCatalogs.length > 0) {
    const allCannedCandidates = sortCandidates(
      dedupeCandidates(cannedCatalogs.flatMap((catalog) =>
        (Array.isArray(catalog.items) ? catalog.items : [])
          .slice(0, MAX_CANNED_ITEMS)
          .map((item) => item && typeof item === "object"
            ? cannedCandidate(shopId, item as AnyRecord, catalog.sourceSystem, catalog.listSource, targetIdentity, targetTitle, vehicle)
            : null)
          .filter((candidate): candidate is RecommendationCandidate => !!candidate),
      )),
    );
    const excludedThinCandidates = allCannedCandidates.filter(isThinAggregateCatalogCandidate);
    const cannedCandidates = allCannedCandidates.filter((candidate) => !isThinAggregateCatalogCandidate(candidate));
    if (excludedThinCandidates.length > 0) {
      const providers = Array.from(new Set(
        excludedThinCandidates
          .map((candidate) => text(candidate.source.sourceSystem).toLowerCase())
          .filter(Boolean),
      )).join(", ");
      warnings.push(warning(
        "incomplete_canned_catalog",
        `Some cached ${providers || "provider"} canned jobs contain only aggregate pricing and cannot be hydrated; historical jobs were searched instead.`,
      ));
    }
    if (cannedCandidates.length > 0) {
      const oldestFetchedAt = cannedCatalogs
        .map((catalog) => catalog.fetchedAt ? new Date(catalog.fetchedAt).getTime() : 0)
        .filter((timestamp) => timestamp > 0)
        .sort((a, b) => a - b)[0] || 0;
      if (oldestFetchedAt && Date.now() - oldestFetchedAt > 7 * 24 * 60 * 60 * 1000) {
        warnings.push(warning("stale_cache", "Canned-job cache is older than seven days; confirm current shop pricing."));
      }
      return { status: "candidates", candidates: cannedCandidates, warnings };
    }
  }

  const scope = await resolveAuthorizedHistoryShopIds(shopId);
  warnings.push(...scope.warnings);
  let historyResult: { ok: boolean; jobs: any[]; source?: string; error?: string };
  try {
    historyResult = await __deps.searchHistory(scope.shopIds, targetTitle, vehicle);
  } catch (error) {
    historyResult = { ok: false, jobs: [], error: text((error as Error)?.message || error) };
  }
  if (!historyResult.ok) {
    warnings.push(warning("history_unavailable", "Historical job lookup is temporarily unavailable."));
    return { status: "unavailable", candidates: [], warnings };
  }
  if (cannedCacheUnavailable && (historyResult.jobs || []).length === 0) {
    warnings.push(warning(
      "recommendation_sources_unavailable",
      "Canned jobs could not be read and no historical jobs were available to compare.",
    ));
    return { status: "unavailable", candidates: [], warnings };
  }

  const historyCandidates = sortCandidates(
    (historyResult.jobs || [])
      .slice(0, MAX_HISTORY_CANDIDATES)
      .map((job) => {
        const shop = Number(job?.shopId);
        return Number.isFinite(shop) && scope.shopIds.includes(shop)
          ? historyCandidate(shop, job as AnyRecord, targetIdentity, targetTitle, vehicle)
          : null;
      })
      .filter((candidate): candidate is RecommendationCandidate => !!candidate),
  );
  if (historyCandidates.length > 0) {
    return { status: "candidates", candidates: historyCandidates, warnings };
  }
  return { status: "no_match", candidates: [], warnings };
}

function sourceMatches(a: RecommendationSourceIdentity, b: RecommendationSourceIdentity): boolean {
  if (a.kind !== b.kind || Number(a.shopId) !== Number(b.shopId) || text(a.id) !== text(b.id)) return false;
  if (a.kind === "history" && a.workOrderId && b.workOrderId && text(a.workOrderId) !== text(b.workOrderId)) return false;
  return true;
}

function usableWriteLines(lines: RecommendationLine[]): Array<RecommendationLine & {
  unitPrice: number;
  extendedPrice: number;
}> {
  return lines
    .filter((line) => line.lineType === "labor" || line.unitPrice != null || line.extendedPrice != null)
    .filter((line) => line.description)
    .map((line) => ({
      ...line,
      // A labor source can omit its rate while still carrying a real labor
      // operation.  The add route resolves the shop/RO labor rate for that
      // line and the hydration warning remains visible to the caller.
      unitPrice: line.unitPrice ?? (
        line.extendedPrice != null && line.quantity > 0
          ? line.extendedPrice / line.quantity
          : 0
      ),
      extendedPrice: line.extendedPrice ?? (
        line.unitPrice != null ? line.unitPrice * line.quantity : 0
      ),
    }));
}

export interface RehydratedRecommendation {
  source: RecommendationSourceIdentity;
  title: string;
  description?: string | null;
  code?: string | null;
  lines: Array<RecommendationLine & { unitPrice: number; extendedPrice: number }>;
  warnings: RecommendationWarning[];
}

/**
 * Rehydrate a selected source identity for the add-to-RO route.  Browser
 * supplied title/lines are never used.  Every source is checked against the
 * current shop or the authorized enterprise-history scope first.
 */
export async function rehydrateRecommendationSelection(
  shopId: number,
  selection: AuditSelection,
  vehicle: RecommendationVehicle = {},
  options: { allowEmpty?: boolean; expectedTitle?: string } = {},
): Promise<
  | { ok: true; recommendation: RehydratedRecommendation }
  | { ok: false; code: "FORBIDDEN" | "NOT_FOUND" | "UNAVAILABLE"; error: string }
> {
  const source = selection?.source;
  if (!source || (source.kind !== "canned" && source.kind !== "history") || !text(source.id)) {
    return { ok: false, code: "NOT_FOUND", error: "A valid audit selection source is required." };
  }

  if (source.kind === "canned") {
    // Canned catalogs are location-owned.  Enterprise history sharing never
    // grants access to another location's templates.
    if (Number(source.shopId) !== shopId) {
      return { ok: false, code: "FORBIDDEN", error: "That canned job is not owned by this shop." };
    }
    let catalogs: CachedRecommendationCatalog[] = [];
    try {
      catalogs = await __deps.findCannedCatalogsByShopId(shopId);
    } catch {
      return { ok: false, code: "UNAVAILABLE", error: "Shop canned-job cache is unavailable." };
    }
    const matchingCatalog = catalogs.find((catalog) =>
      (!source.sourceSystem || source.sourceSystem === catalog.sourceSystem) &&
      catalog.items.some((item) => extractSourceId(item || {}) === text(source.id)),
    );
    const detailSourceSystem = matchingCatalog?.sourceSystem || source.sourceSystem || "protractor";
    const cachedItem = matchingCatalog?.items.find((item: any) => extractSourceId(item || {}) === text(source.id));
    let detail = cachedItem && typeof cachedItem === "object" ? cachedItem as AnyRecord : null;
    let detailWarnings: RecommendationWarning[] = [];
    const fetchDetail = async () => {
      try {
        return await __deps.fetchCannedDetail(
          shopId,
          text(source.id),
          source.listSource || matchingCatalog?.listSource,
        );
      } catch (error) {
        return {
          ok: false,
          error: text((error as Error)?.message || error) || "Selected canned-job details could not be hydrated.",
        };
      }
    };
    if (detail) {
      const normalized = normalizeCandidateLines(detail, detailSourceSystem);
      detailWarnings = normalized.warnings;
      if (normalized.lines.length === 0 && canHydrateCannedSource(detailSourceSystem)) {
        // Hydrate only this selected item through the supported adapter.  This
        // is not the catalog enrichment path and is bounded to one request.
        const hydrated = await fetchDetail();
        if (hydrated.ok && hydrated.detail) {
          detail = hydrated.detail as AnyRecord;
          detailWarnings = [];
        } else {
          return {
            ok: false,
            code: "UNAVAILABLE",
            error: hydrated.error || "Selected canned-job details could not be hydrated.",
          };
        }
      }
    } else {
      if (source.sourceSystem && source.sourceSystem !== "protractor") {
        return { ok: false, code: "NOT_FOUND", error: "Selected provider catalog item is no longer available in cache." };
      }
      const hydrated = await fetchDetail();
      if (!hydrated.ok || !hydrated.detail) {
        return { ok: false, code: "UNAVAILABLE", error: hydrated.error || "Selected canned-job details could not be hydrated." };
      }
      detail = hydrated.detail as AnyRecord;
    }
    const normalized = normalizeCandidateLines(detail || {}, detailSourceSystem);
    const lines = usableWriteLines(normalized.lines);
    const warnings = [...detailWarnings, ...normalized.warnings];
    if (lines.length === 0 && !canHydrateCannedSource(detailSourceSystem)) {
      return {
        ok: false,
        code: "UNAVAILABLE",
        error: "Selected provider catalog contains no usable estimate lines and cannot be hydrated.",
      };
    }
    if (lines.length === 0 && !options.allowEmpty) {
      return { ok: false, code: "NOT_FOUND", error: "Selected canned job has no usable estimate lines." };
    }
    const resolvedSource: RecommendationSourceIdentity = {
      ...source,
      shopId,
      id: text(source.id),
      sourceSystem: source.sourceSystem || matchingCatalog?.sourceSystem || "protractor",
      listSource: source.listSource || matchingCatalog?.listSource || null,
    };
    if (options.expectedTitle && serviceMatch(
      serviceIdentity(null, options.expectedTitle),
      serviceIdentity(null, extractTitle(detail || {}) || text(source.title)),
      options.expectedTitle,
      extractTitle(detail || {}) || text(source.title),
    ) === "none") {
      return { ok: false, code: "FORBIDDEN", error: "Selected source does not match the audit finding." };
    }
    return {
      ok: true,
      recommendation: {
        source: resolvedSource,
        title: extractTitle(detail || {}) || text(source.title) || "Selected canned job",
        description: extractDescription(detail || {}),
        code: text(detail?.Code ?? detail?.code) || null,
        lines,
        warnings,
      },
    };
  }

  const scope = await resolveAuthorizedHistoryShopIds(shopId);
  if (!scope.shopIds.includes(Number(source.shopId))) {
    return { ok: false, code: "FORBIDDEN", error: "That historical job is outside the authorized history scope." };
  }
  const title = text(source.title);
  if (!title) return { ok: false, code: "NOT_FOUND", error: "Selected historical job has no source title." };
  let history: { ok: boolean; jobs: any[]; error?: string };
  try {
    history = await __deps.searchHistory([Number(source.shopId)], title, vehicle);
  } catch {
    history = { ok: false, jobs: [] };
  }
  if (!history.ok) return { ok: false, code: "UNAVAILABLE", error: "Historical job details are unavailable." };
  const match = (history.jobs || []).find((job) => {
    const candidate = historyCandidate(Number(source.shopId), job as AnyRecord, serviceIdentity(null, title), title, vehicle);
    if (!candidate || !sourceMatches(source, candidate.source)) return false;
    return true;
  }) as AnyRecord | undefined;
  if (!match) return { ok: false, code: "NOT_FOUND", error: "Selected historical job is no longer available in the authorized history." };
  const normalized = normalizeCandidateLines(match);
  const lines = usableWriteLines(normalized.lines);
  if (lines.length === 0 && !options.allowEmpty) {
    return { ok: false, code: "NOT_FOUND", error: "Selected historical job has no usable estimate lines." };
  }
  const resolvedSource: RecommendationSourceIdentity = {
    ...source,
    shopId: Number(source.shopId),
    id: text(source.id),
  };
  if (options.expectedTitle && serviceMatch(
    serviceIdentity(null, options.expectedTitle),
    serviceIdentity(null, text(match.job?.title ?? match.title) || title),
    options.expectedTitle,
    text(match.job?.title ?? match.title) || title,
  ) === "none") {
    return { ok: false, code: "FORBIDDEN", error: "Selected source does not match the audit finding." };
  }
  return {
    ok: true,
    recommendation: {
      source: resolvedSource,
      title: text(match.job?.title ?? match.title) || title,
      description: text(match.job?.description ?? match.description) || null,
      code: text(match.job?.code ?? match.code) || null,
      lines,
      warnings: [...scope.warnings, ...normalized.warnings, warning("historical_pricing_review", "Historical pricing is retained for review before adding to the estimate.")],
    },
  };
}

export {
  extractTitle,
  extractSourceId,
  normalizeCandidateLines,
  serviceIdentity,
  serviceMatch,
};

// Descriptive aliases for callers that use the audit terminology.  Keep the
// shorter names above as the primary API, but avoid forcing UI/route clients
// to duplicate the resolver's naming choice.
export const resolveAuditRecommendation = resolveRecommendation;
export const rehydrateAuditSelection = rehydrateRecommendationSelection;
