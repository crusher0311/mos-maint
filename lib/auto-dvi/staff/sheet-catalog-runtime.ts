import {createHash} from "node:crypto";
import {cookies} from "next/headers";
import {getSession} from "@/lib/auth";
import {listUsers} from "@/lib/data/repositories/users";
import {getFeatureEntitlements} from "@/lib/featureResolver";
import {getEnterpriseByShopId} from "@/lib/enterprise";
import {requireThat} from "@/lib/shop-dispatch/model";
import {MongoSheetCatalog} from "@/lib/data/repositories/inspection-sheet-catalog";
import type {CatalogAccess, CatalogDependencies} from "./sheet-catalog";
import {effectiveInspectionPermission, type InspectionAuthority} from "../workflow-policy";

const store = new MongoSheetCatalog();
export async function sheetCatalogAccess(): Promise<CatalogAccess> {
  const token = (await cookies()).get("session_token")?.value;
  const session = await getSession();
  requireThat(token && !/^exts?_/.test(token) && session?.token === token && session.email &&
    !session.isTestAuth && session.token !== "dev-auto-login" && !session.mustChangePassword, "Verified dashboard sign-in required", 401);
  const shopId = Number(session.shopId), email = session.email.toLowerCase();
  requireThat(Number.isSafeInteger(shopId) && shopId > 0, "Current shop required", 403);
  const [users, features, enterprise] = await Promise.all([
    listUsers({email}), getFeatureEntitlements(shopId), getEnterpriseByShopId(shopId),
  ]);
  requireThat(features.isFeatureEnabled("auto_dvi"), "DVI is not enabled for this location", 403);
  const members = users.filter(u => u.status !== "inactive" && u.disabled !== true && u.active !== false &&
    u.mustChangePassword !== true && [u.shopId, ...(Array.isArray(u.shopIds) ? u.shopIds : [])].some(id => String(id) === String(shopId)));
  requireThat(members.length > 0, "Current shop membership required", 403);
  const enterpriseId = enterprise?._id ? String(enterprise._id) : null;
  requireThat(!enterpriseId || enterprise!.shopIds.map(Number).includes(shopId), "Enterprise membership changed", 403);
  const key = enterpriseId ? `enterprise:${enterpriseId}` : `shop:${shopId}`;
  const config = await store.read(key);
  const actor = createHash("sha256").update(`staff|${shopId}|${email}`).digest("hex");
  const roleMap = {owner: "owner", admin: "manager", manager: "manager", advisor: "advisor", technician: "technician", tech: "technician"} as const;
  const roles = [...new Set(members.map(u => roleMap[u.role as keyof typeof roleMap]).filter(Boolean))];
  const authority: InspectionAuthority = {actorId: actor, currentShopId: shopId, member: true, roles,
    enterprise: enterpriseId ? config?.rules ?? {} : {}, enterpriseGoverned: [],
    local: enterpriseId ? {} : config?.rules ?? {}, individual: config?.individual[actor] ?? {}};
  requireThat(effectiveInspectionPermission(authority, shopId, "read").allowed, "DVI read permission required", 403);
  // Match the product's enterprise-settings owner/admin authority, using fresh
  // membership rather than a role supplied by a client or stale session.
  const manager = members.some(u => (enterpriseId ? ["owner", "admin"] : ["owner", "admin", "manager"]).includes(u.role ?? ""));
  const canManage = manager && effectiveInspectionPermission(authority, shopId, "edit").allowed;
  return {key, actor, shopId, scope: enterpriseId ? "enterprise" : "shop",
    scopeLabel: enterpriseId ? enterprise!.name : "This location", canManage};
}
export const sheetCatalogDependencies: CatalogDependencies = {access: sheetCatalogAccess, store};
