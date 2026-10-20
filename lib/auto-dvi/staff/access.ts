import { z } from "zod";
import { createHash } from "node:crypto";
import { getSession } from "@/lib/auth";
import { cookies } from "next/headers";
import { listUsers } from "@/lib/data/repositories/users";
import { getEnterpriseByShopId } from "@/lib/enterprise";
import { getFeatureEntitlements } from "@/lib/featureResolver";
import { readStaffConfiguration } from "@/lib/data/repositories/workflow-inspections";
import { effectiveInspectionPermission, type InspectionAuthority } from "../workflow-policy";
import { sheetSchema, instanceKey } from "./model";
import { requireThat } from "@/lib/shop-dispatch/model";
import { pilotConfigurationSchema } from "../pilot/model";

const rules = z.object({read: z.enum(["allow", "deny"]).optional(), edit: z.enum(["allow", "deny"]).optional(),
  sensitive: z.enum(["allow", "deny"]).optional(), publish: z.enum(["allow", "deny"]).optional()}).strict();
export const configurationSchema = z.object({
  version: z.literal(1), enabledShopIds: z.array(z.number().int().positive()).max(500),
  sheets: z.array(sheetSchema).min(1).max(20), defaultSheet: z.string().max(80),
  rules, individual: z.record(z.string(), rules).default({}),
  pilot: pilotConfigurationSchema.optional(),
  release: z.object({
    enabledShopIds: z.array(z.number().int().positive()).max(500),
    publicPhone: z.string().max(40),
    defaultExpiryDays: z.number().int().min(1).max(365),
  }).strict().optional(),
}).strict().superRefine((c, ctx) => {
  if (!c.sheets.some(s => instanceKey(s) === c.defaultSheet) ||
    new Set(c.sheets.map(instanceKey)).size !== c.sheets.length)
    ctx.addIssue({code: "custom", message: "A unique approved default sheet is required"});
});
export async function staffAccess() {
  const cookieToken = (await cookies()).get("session_token")?.value;
  requireThat(cookieToken && !/^exts?_/.test(cookieToken), "Dashboard cookie session required", 401);
  const session = await getSession();
  requireThat(session?.email && session.token === cookieToken && !session.isTestAuth && session.token !== "dev-auto-login" && !session.mustChangePassword, "Verified sign-in required", 401);
  const shopId = Number(session.shopId), email = session.email.toLowerCase();
  requireThat(Number.isSafeInteger(shopId) && shopId > 0, "Current shop required", 403);
  const [users, entitlements, enterprise] = await Promise.all([
    listUsers({email}), getFeatureEntitlements(shopId), getEnterpriseByShopId(shopId),
  ]);
  const members = users.filter(u => u.status !== "inactive" && u.disabled !== true && u.active !== false && u.mustChangePassword !== true &&
    [u.shopId, ...(Array.isArray(u.shopIds) ? u.shopIds : [])].some(id => String(id) === String(shopId)));
  requireThat(members.length > 0 && entitlements.isFeatureEnabled("shop_workflow") && entitlements.isFeatureEnabled("auto_dvi"),
    "Current-shop workflow and inspection access required", 403);
  // Enterprise settings are authoritative. Never fall back to local configuration
  // when an enterprise policy is missing or unavailable.
  const enterpriseId = enterprise?._id ? String(enterprise._id) : null;
  requireThat(!enterpriseId || enterprise!.shopIds.map(Number).includes(shopId), "Enterprise membership changed", 403);
  const raw = await readStaffConfiguration(enterpriseId ? `enterprise:${enterpriseId}` : `shop:${shopId}`);
  const {_id, ...document} = raw ?? {};
  const config = raw ? configurationSchema.parse(document) : null;
  const roleMap = {owner: "owner", admin: "manager", manager: "manager", advisor: "advisor", technician: "technician", tech: "technician"} as const;
  // Use current membership documents, never a browser role or stale session role.
  const roles = [...new Set(members.map(m => roleMap[m.role as keyof typeof roleMap]).filter(Boolean))];
  const actor = createHash("sha256").update(`staff|${shopId}|${email}`).digest("hex");
  const authority: InspectionAuthority = {actorId: actor, currentShopId: shopId, member: true, roles,
    enterprise: enterpriseId ? config?.rules ?? {} : {}, enterpriseGoverned: enterpriseId ? ["read", "edit", "sensitive", "publish"] : [],
    local: enterpriseId ? {} : config?.rules ?? {}, individual: config?.individual[actor] ?? {}};
  requireThat(effectiveInspectionPermission(authority, shopId, "read").allowed, "Inspection read permission required", 403);
  const enabled = !!config?.enabledShopIds.includes(shopId);
  return {shopId, actor, email, authority, config, enabled,
    canEdit: enabled && effectiveInspectionPermission(authority, shopId, "edit").allowed,
    canReview: roles.some(r => ["owner", "manager", "advisor"].includes(r)) &&
      effectiveInspectionPermission(authority, shopId, "edit").allowed,
  };
}
export type StaffAccess = Awaited<ReturnType<typeof staffAccess>>;
