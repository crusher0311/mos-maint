import type { ResolvedReportingScope } from "@/lib/reporting-scope";
import type {
  CustomReportDocument,
  CustomReportScopeRequest,
} from "@/lib/data/repositories/custom-reports";
import { compileReportDefinition } from "@/lib/report-definition-compiler";

export function validateCustomReportName(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Report name is required");
  const name = value.trim();
  if (name.length > 120) throw new Error("Report name must be 120 characters or fewer");
  return name;
}

export function validateCustomReportDefinition(
  value: unknown,
  resolved: Pick<ResolvedReportingScope, "shopIds">,
): Record<string, unknown> {
  return compileReportDefinition(value, resolved).definition as unknown as Record<string, unknown>;
}

export function validateCustomReportScope(value: unknown): CustomReportScopeRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Report scope is required");
  }
  const input = value as Record<string, unknown>;
  const kind = input.kind;
  if (kind !== "shop" && kind !== "enterprise" && kind !== "platform") {
    throw new Error("Invalid report scope");
  }
  if (kind === "shop") {
    const shopId = Number(input.shopId);
    if (!Number.isSafeInteger(shopId) || shopId <= 0) throw new Error("Valid shopId is required");
    return { kind, shopId };
  }
  if (kind === "enterprise") {
    if (typeof input.enterpriseId !== "string" || !input.enterpriseId.trim()) {
      throw new Error("enterpriseId is required");
    }
    return { kind, enterpriseId: input.enterpriseId.trim() };
  }
  return { kind };
}

export function scopeRequest(value: CustomReportScopeRequest) {
  return {
    kind: value.kind,
    shopId: value.shopId?.toString(),
    enterpriseId: value.enterpriseId,
  };
}

export function validateCustomReportSharing(
  value: unknown,
  resolved: ResolvedReportingScope,
): CustomReportDocument["sharing"] {
  const input = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const visibility = input.visibility ?? "private";
  if (visibility === "private") return { visibility };
  if (visibility === "shop") {
    const requested = Array.isArray(input.shopIds)
      ? [...new Set(input.shopIds.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))]
      : resolved.shopIds;
    if (!requested.length || requested.some((id) => !resolved.shopIds.includes(id))) {
      throw new Error("Shared shops must be inside the report scope");
    }
    return { visibility, shopIds: requested };
  }
  if (visibility === "enterprise") {
    if (!resolved.enterpriseId) throw new Error("Enterprise sharing requires enterprise scope");
    if (input.enterpriseId && input.enterpriseId !== resolved.enterpriseId) {
      throw new Error("Shared enterprise must match the report scope");
    }
    return { visibility, enterpriseId: resolved.enterpriseId };
  }
  throw new Error("Invalid report visibility");
}

export function customReportJson(doc: CustomReportDocument, includeVersions = false) {
  const current = doc.versions.find((version) => version.version === doc.currentVersion);
  return {
    id: doc._id.toString(),
    name: doc.name,
    ownerEmail: doc.ownerEmail,
    scope: doc.scope,
    sharing: doc.sharing,
    currentVersion: doc.currentVersion,
    definition: current?.definition,
    ...(includeVersions ? { versions: doc.versions } : {}),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}