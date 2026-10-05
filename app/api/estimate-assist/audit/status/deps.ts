import { getSession } from "@/lib/auth";
import { validateExtensionToken } from "@/lib/extension-auth";
import { getFeatureEntitlements } from "@/lib/featureResolver";
import { getEstimateAuditStateRepository } from "@/lib/data/repositories/estimate-audit-state";

/**
 * Test seam intentionally lives outside route.ts: Next route modules may only
 * export HTTP handlers and approved route configuration symbols.
 */
export const auditStatusDeps = {
  getSession,
  getRepository: getEstimateAuditStateRepository,
  validateExtensionToken,
  getFeatureEntitlements,
};
