import {z} from "zod";
import {sheetSchema, instanceKey, type StaffSheet} from "./model";
import {pilotConfigurationSchema} from "../pilot/model";

const rules = z.object({read: z.enum(["allow", "deny"]).optional(), edit: z.enum(["allow", "deny"]).optional(),
  sensitive: z.enum(["allow", "deny"]).optional(), publish: z.enum(["allow", "deny"]).optional()}).strict();
export const configurationSchema = z.object({
  version: z.literal(1), enabledShopIds: z.array(z.number().int().positive()).max(500),
  sheets: z.array(sheetSchema).min(1).max(200), defaultSheet: z.string().max(80),
  rules, individual: z.record(z.string(), rules).default({}),
  catalogRevision: z.number().int().nonnegative().optional(),
  archivedSheetIds: z.array(z.string().max(60)).max(200).optional(),
  catalogReceipts: z.array(z.object({
    id: z.string().uuid(), digest: z.string().length(64), actor: z.string(),
    revision: z.number().int().positive(),
  }).strict()).max(200).optional(),
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
  const defaultSheet = c.sheets.find(s => instanceKey(s) === c.defaultSheet);
  if (defaultSheet && c.archivedSheetIds?.includes(defaultSheet.id))
    ctx.addIssue({code: "custom", message: "Default inspection sheet cannot be archived"});
});
export type StaffConfiguration = z.infer<typeof configurationSchema>;

/** Existing inspection instances embed their own sheet. New selections see only
 * the latest active version; a deliberately pinned default remains selectable. */
export function selectableSheets(config: StaffConfiguration): StaffSheet[] {
  const latest = new Map<string, StaffSheet>();
  for (const sheet of config.sheets) {
    if (config.archivedSheetIds?.includes(sheet.id)) continue;
    if (!latest.has(sheet.id) || latest.get(sheet.id)!.version < sheet.version) latest.set(sheet.id, sheet);
  }
  const sheets = [...latest.values()];
  const pinned = config.sheets.find(s => instanceKey(s) === config.defaultSheet);
  if (pinned && !sheets.some(s => instanceKey(s) === instanceKey(pinned))) sheets.push(pinned);
  return sheets;
}
