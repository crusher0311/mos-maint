export type CustomReportVisibility = "private" | "shop" | "enterprise";

export interface CustomReportAccessActor {
  email: string;
  isPlatformAdmin?: boolean;
}

export interface CustomReportAccessResource {
  ownerEmail: string;
  sharing: {
    visibility: CustomReportVisibility;
    shopIds?: readonly number[];
    enterpriseId?: string;
  };
}

export interface CustomReportAccessScope {
  shopIds: readonly number[];
  enterpriseId?: string;
}

export function normalizeActorEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isCustomReportOwner(
  actor: CustomReportAccessActor,
  report: CustomReportAccessResource,
): boolean {
  return normalizeActorEmail(actor.email) === normalizeActorEmail(report.ownerEmail);
}

export function canReadCustomReport(
  actor: CustomReportAccessActor,
  report: CustomReportAccessResource,
  scope: CustomReportAccessScope,
): boolean {
  if (actor.isPlatformAdmin || isCustomReportOwner(actor, report)) return true;
  if (report.sharing.visibility === "private") return false;
  if (report.sharing.visibility === "enterprise") {
    return Boolean(
      report.sharing.enterpriseId &&
      scope.enterpriseId &&
      report.sharing.enterpriseId === scope.enterpriseId,
    );
  }
  const authorized = new Set(scope.shopIds);
  return Boolean(report.sharing.shopIds?.some((shopId) => authorized.has(shopId)));
}

export function canWriteCustomReport(
  actor: CustomReportAccessActor,
  report: CustomReportAccessResource,
): boolean {
  return Boolean(actor.isPlatformAdmin || isCustomReportOwner(actor, report));
}