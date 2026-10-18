/** S1 contract only. Authority must be freshly resolved by a trusted adapter,
 * never copied from request JSON. No route is enabled by this module. */
export type InspectionPermission = "read" | "edit" | "sensitive" | "publish";
export type PermissionRule = Partial<Record<InspectionPermission, "allow" | "deny">>;
export interface InspectionAuthority {
  actorId: string;
  currentShopId: number;
  member: boolean;
  roles: ("owner" | "manager" | "advisor" | "technician")[];
  enterprise: PermissionRule;
  enterpriseGoverned: InspectionPermission[];
  local: PermissionRule;
  individual: PermissionRule;
}
export function effectiveInspectionPermission(a: InspectionAuthority, shopId: number, permission: InspectionPermission) {
  const result = (allowed: boolean, source: string) => ({ version: 1 as const, allowed, source });
  if (!a.member || a.currentShopId !== shopId) return result(false, "current-shop-membership");
  if (permission === "publish" && a.roles.includes("technician")) return result(false, "technician-publication-denial");
  // Explicit restrictions always win, including over enterprise allows.
  for (const source of ["enterprise", "local", "individual"] as const)
    if (a[source][permission] === "deny") return result(false, `${source}-restriction`);
  if (a.enterpriseGoverned.includes(permission))
    return result(a.enterprise[permission] === "allow", "enterprise-governed");
  for (const source of ["enterprise", "individual", "local"] as const)
    if (a[source][permission] === "allow") return result(true, `${source}-grant`);
  const staff = a.roles.some(r => ["owner", "manager", "advisor"].includes(r));
  return result(staff || (permission !== "sensitive" && permission !== "publish" && a.roles.includes("technician")), "role-default");
}
