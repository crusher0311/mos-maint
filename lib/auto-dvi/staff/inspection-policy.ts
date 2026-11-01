import { z } from "zod";

export const policyRoleSchema = z.enum(["owner", "manager", "advisor"]);
const roles = z.array(policyRoleSchema).max(3).refine(value => new Set(value).size === value.length, "Choose each role once");
export const policyDraftSchema = z.object({
  completionMode: z.enum(["required-checks", "captured-findings"]),
  publishRoles: roles,
  deliverRoles: roles,
}).strict();
export const inspectionPolicySchema = policyDraftSchema.extend({
  version: z.number().int().positive(),
  actor: z.string().min(1).max(200),
  at: z.string().datetime(),
}).strict();
export type PolicyDraft = z.infer<typeof policyDraftSchema>;
export type InspectionPolicy = z.infer<typeof inspectionPolicySchema>;

/** Policies can restrict existing server authority, never grant it. Both the
 * historical snapshot and today's policy apply to externally visible actions. */
export function policyAllows(
  action: "publish" | "deliver",
  actorRoles: readonly string[],
  pinned?: InspectionPolicy,
  current?: InspectionPolicy,
): boolean {
  const allowed = (policy?: InspectionPolicy) => actorRoles.some(role =>
    (policy?.[action === "publish" ? "publishRoles" : "deliverRoles"] ?? ["owner", "manager", "advisor"]).includes(role as z.infer<typeof policyRoleSchema>));
  return allowed(pinned) && allowed(current);
}
